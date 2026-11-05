import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import {
  assertCan,
  auditInStaffTx,
  fail,
  guarded,
  hasRole,
  isUuid,
  ok,
  optionalText,
  requiredText,
  staffTx,
  zodFail,
  type ActionResult,
  type Page,
  type Paged,
} from "./common";

/**
 * Narration review workflow: draft → in_review → approved | rejected; approved → retired.
 *
 * Versioning: editing an APPROVED narration never changes what customers
 * hear. It creates a new row (version + 1, status in_review,
 * supersedes_id = old id). The old row stays approved until the new version
 * is approved; approving it retires the old row in the same transaction.
 * Rejecting the revision leaves the approved original untouched.
 *
 * Transcripts may come from imported/untrusted text: they are stored and
 * rendered strictly as plain text.
 */
export const NARRATION_STATUSES = ["draft", "in_review", "approved", "rejected", "retired"] as const;
export type NarrationStatus = (typeof NARRATION_STATUSES)[number];

export interface NarrationRow {
  id: string;
  trailId: string;
  trailName: string;
  trailIsDemo: boolean;
  poiId: string | null;
  poiName: string | null;
  title: string;
  transcript: string;
  audioPath: string | null;
  durationSec: number | null;
  status: NarrationStatus;
  sourceId: string | null;
  sourceLabel: string | null;
  sourceCitation: string | null;
  version: number;
  supersedesId: string | null;
  reviewNote: string | null;
  submittedBy: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

const SELECT = `
  n.id, n.trail_id, t.name as trail_name, t.is_demo as trail_is_demo, n.poi_id, p.name as poi_name, n.title, n.transcript,
  n.audio_path, n.duration_sec, n.status, n.source_id, s.label as source_label, n.source_citation, n.version, n.supersedes_id,
  n.review_note, n.submitted_by, n.approved_by, n.approved_at, n.updated_at, n.created_at`;

/** Content editors and admins may write narration (RLS: narrations_editor_write). */
export function canEditNarration(user: SessionUser): boolean {
  return hasRole(user, "admin", "content_editor");
}

export async function listNarrations(
  user: SessionUser,
  filters: { status?: string; trailId?: string },
  page: Page,
): Promise<Paged<NarrationRow>> {
  assertCan(user, "trails.manage");
  const status = z.enum(NARRATION_STATUSES).safeParse(filters.status).data ?? null;
  const trailId = filters.trailId && isUuid(filters.trailId) ? filters.trailId : null;
  const rows = await staffTx(user, (tx) => tx<(NarrationRow & { total: number })[]>`
    select ${tx.unsafe(SELECT)}, count(*) over()::int as total
    from public.narrations n join public.trails t on t.id = n.trail_id
    left join public.trail_pois p on p.id = n.poi_id left join public.sources s on s.id = n.source_id
    where (${status}::public.content_status is null or n.status = ${status}::public.content_status)
      and (${trailId}::uuid is null or n.trail_id = ${trailId}::uuid)
    order by case n.status when 'in_review' then 0 when 'draft' then 1 when 'rejected' then 2 when 'approved' then 3 else 4 end,
             n.updated_at desc
    limit ${page.limit} offset ${page.offset}`);
  return { rows, total: rows[0]?.total ?? 0, ...page };
}

export async function getNarration(user: SessionUser, id: string): Promise<{ narration: NarrationRow; versions: NarrationRow[] } | null> {
  assertCan(user, "trails.manage");
  if (!isUuid(id)) return null;
  return staffTx(user, async (tx) => {
    const [narration] = await tx<NarrationRow[]>`
      select ${tx.unsafe(SELECT)} from public.narrations n join public.trails t on t.id = n.trail_id
      left join public.trail_pois p on p.id = n.poi_id left join public.sources s on s.id = n.source_id
      where n.id = ${id}`;
    if (!narration) return null;
    // whole version chain (ancestors and descendants)
    const versions = await tx<NarrationRow[]>`
      with recursive up as (
        select id, supersedes_id from public.narrations where id = ${id}
        union select n.id, n.supersedes_id from public.narrations n join up on n.id = up.supersedes_id
      ), down as (
        select id from public.narrations where id = ${id}
        union select n.id from public.narrations n join down on n.supersedes_id = down.id
      )
      select ${tx.unsafe(SELECT)} from public.narrations n join public.trails t on t.id = n.trail_id
      left join public.trail_pois p on p.id = n.poi_id left join public.sources s on s.id = n.source_id
      where n.id in (select id from up union select id from down)
      order by n.version desc, n.created_at desc`;
    return { narration, versions };
  });
}

const contentSchema = z.object({
  title: requiredText(3, 200, "Title"),
  transcript: requiredText(10, 20_000, "Transcript"),
  poiId: z.union([z.uuid(), z.literal("")]).transform((v) => (v === "" ? null : v)),
  sourceId: z.union([z.uuid(), z.literal("")]).transform((v) => (v === "" ? null : v)),
  sourceCitation: optionalText(500),
});
export type NarrationContentInput = z.input<typeof contentSchema>;

export async function createNarration(
  user: SessionUser,
  trailId: string,
  input: NarrationContentInput & { submit?: boolean },
): Promise<ActionResult<{ id: string }>> {
  assertCan(user, "trails.manage");
  if (!canEditNarration(user)) return fail("Only content editors and admins can write narration.");
  if (!isUuid(trailId)) return fail("Trail not found.");
  const p = contentSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const d = p.data;
  return guarded(() =>
    staffTx(user, async (tx) => {
      if (d.poiId) {
        const [poi] = await tx`select 1 from public.trail_pois where id = ${d.poiId} and trail_id = ${trailId}`;
        if (!poi) return fail("That POI does not belong to this trail.");
      }
      const status = input.submit ? "in_review" : "draft";
      const [row] = await tx<{ id: string }[]>`
        insert into public.narrations (trail_id, poi_id, title, transcript, status, source_id, source_citation, submitted_by)
        values (${trailId}, ${d.poiId}, ${d.title}, ${d.transcript}, ${status}, ${d.sourceId}, ${d.sourceCitation}, ${user.id})
        returning id`;
      await auditInStaffTx(tx, user, "narration.created", "narration", row.id, { trailId, status });
      return ok(status === "in_review" ? "Narration submitted for review." : "Draft saved.", { data: { id: row.id } });
    }),
  );
}

/** Edit narration. Approved narration gets a NEW version (in review); others are edited in place. */
export async function editNarration(user: SessionUser, id: string, input: NarrationContentInput): Promise<ActionResult<{ id: string }>> {
  assertCan(user, "trails.manage");
  if (!canEditNarration(user)) return fail("Only content editors and admins can edit narration.");
  if (!isUuid(id)) return fail("Narration not found.");
  const p = contentSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const d = p.data;
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [cur] = await tx<{ id: string; trailId: string; status: NarrationStatus; version: number; audioPath: string | null; durationSec: number | null }[]>`
        select id, trail_id, status, version, audio_path, duration_sec from public.narrations where id = ${id} for update`;
      if (!cur) return fail("Narration not found.");
      if (d.poiId) {
        const [poi] = await tx`select 1 from public.trail_pois where id = ${d.poiId} and trail_id = ${cur.trailId}`;
        if (!poi) return fail("That POI does not belong to this trail.");
      }
      if (cur.status === "retired") return fail("Retired narration cannot be edited. Create a new narration instead.");
      if (cur.status === "approved") {
        const [open] = await tx<{ id: string }[]>`
          select id from public.narrations where supersedes_id = ${id} and status in ('draft', 'in_review') limit 1`;
        if (open) return fail("A revision of this narration is already awaiting review. Edit that revision instead (see Versions).");
        const [row] = await tx<{ id: string }[]>`
          insert into public.narrations (trail_id, poi_id, title, transcript, audio_path, duration_sec, status, source_id, source_citation,
                                         version, supersedes_id, submitted_by)
          values (${cur.trailId}, ${d.poiId}, ${d.title}, ${d.transcript}, null, null, 'in_review', ${d.sourceId}, ${d.sourceCitation},
                  ${cur.version + 1}, ${id}, ${user.id})
          returning id`;
        await auditInStaffTx(tx, user, "narration.revision_created", "narration", row.id, { supersedes: id, version: cur.version + 1 });
        return ok(`Created version ${cur.version + 1} for review. Customers keep hearing the approved version until this one is approved.`, {
          data: { id: row.id },
          warnings: cur.audioPath ? ["The recorded audio belongs to the old version; the new version uses device text-to-speech until new audio is attached."] : [],
        });
      }
      const nextStatus = cur.status === "rejected" ? "draft" : cur.status;
      await tx`
        update public.narrations set title = ${d.title}, transcript = ${d.transcript}, poi_id = ${d.poiId}, source_id = ${d.sourceId},
          source_citation = ${d.sourceCitation}, status = ${nextStatus}
        where id = ${id}`;
      await auditInStaffTx(tx, user, "narration.edited", "narration", id, { from: cur.status, to: nextStatus });
      return ok(nextStatus === "draft" && cur.status === "rejected" ? "Saved as a draft. Submit it for review when ready." : "Narration saved.", { data: { id } });
    }),
  );
}

export async function submitNarration(user: SessionUser, id: string): Promise<ActionResult> {
  assertCan(user, "trails.manage");
  if (!canEditNarration(user)) return fail("Only content editors and admins can submit narration.");
  if (!isUuid(id)) return fail("Narration not found.");
  return guarded(() =>
    staffTx(user, async (tx) => {
      const rows = await tx`update public.narrations set status = 'in_review', submitted_by = ${user.id} where id = ${id} and status = 'draft' returning id`;
      if (!rows.length) return fail("Only drafts can be submitted for review.");
      await auditInStaffTx(tx, user, "narration.submitted", "narration", id);
      return ok("Submitted for review.");
    }),
  );
}

const approveSchema = z.object({
  sourceId: z.uuid("Choose the source this narration is based on."),
  sourceCitation: requiredText(3, 500, "Citation"),
});

/** Approve (content.approve). Requires a source + citation; the DB check enforces source + approved_at. */
export async function approveNarration(user: SessionUser, id: string, input: { sourceId?: unknown; sourceCitation?: unknown }): Promise<ActionResult> {
  assertCan(user, "content.approve");
  if (!isUuid(id)) return fail("Narration not found.");
  const p = approveSchema.safeParse({ sourceId: input.sourceId ?? "", sourceCitation: input.sourceCitation ?? "" });
  if (!p.success) return zodFail(p.error);
  const d = p.data;
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [cur] = await tx<{ status: NarrationStatus; supersedesId: string | null; trailId: string }[]>`
        select status, supersedes_id, trail_id from public.narrations where id = ${id} for update`;
      if (!cur) return fail("Narration not found.");
      if (cur.status === "approved") return ok("Already approved.");
      if (cur.status !== "in_review" && cur.status !== "draft") return fail(`Narration that is ${cur.status} cannot be approved.`);
      const [src] = await tx`select 1 from public.sources where id = ${d.sourceId}`;
      if (!src) return fail("Source not found.");
      await tx`
        update public.narrations set status = 'approved', source_id = ${d.sourceId}, source_citation = ${d.sourceCitation},
          approved_by = ${user.id}, approved_at = now(), review_note = null
        where id = ${id}`;
      let retired = 0;
      if (cur.supersedesId) {
        const r = await tx`update public.narrations set status = 'retired' where id = ${cur.supersedesId} and status = 'approved' returning id`;
        retired = r.length;
      }
      await auditInStaffTx(tx, user, "narration.approved", "narration", id, { sourceId: d.sourceId, retiredPrevious: cur.supersedesId && retired ? cur.supersedesId : null });
      return ok(retired ? "Approved. The previous version was retired and customers now hear this version." : "Approved. Customers can now hear this narration.");
    }),
  );
}

export async function rejectNarration(user: SessionUser, id: string, reason: unknown): Promise<ActionResult> {
  assertCan(user, "content.approve");
  if (!isUuid(id)) return fail("Narration not found.");
  const r = requiredText(3, 1000, "Reason").safeParse(reason ?? "");
  if (!r.success) return zodFail(r.error);
  return guarded(() =>
    staffTx(user, async (tx) => {
      const rows = await tx`
        update public.narrations set status = 'rejected', review_note = ${r.data}
        where id = ${id} and status in ('draft', 'in_review') returning id`;
      if (!rows.length) return fail("Only drafts or narration in review can be rejected.");
      await auditInStaffTx(tx, user, "narration.rejected", "narration", id, { reason: r.data });
      return ok("Rejected. The editor can see your reason.");
    }),
  );
}

export async function retireNarration(user: SessionUser, id: string): Promise<ActionResult> {
  assertCan(user, "content.approve");
  if (!isUuid(id)) return fail("Narration not found.");
  return guarded(() =>
    staffTx(user, async (tx) => {
      const rows = await tx`update public.narrations set status = 'retired' where id = ${id} and status = 'approved' returning id`;
      if (!rows.length) return fail("Only approved narration can be retired.");
      await auditInStaffTx(tx, user, "narration.retired", "narration", id);
      return ok("Retired. Customers will no longer hear this narration.");
    }),
  );
}

export interface NarrationFormOptions {
  trails: { id: string; name: string }[];
  pois: { id: string; trailId: string; name: string; seq: number }[];
  sources: { id: string; label: string }[];
}

export async function narrationFormOptions(user: SessionUser): Promise<NarrationFormOptions> {
  assertCan(user, "trails.manage");
  return staffTx(user, async (tx) => {
    const [trails, pois, sources] = await Promise.all([
      tx<NarrationFormOptions["trails"]>`select id, name from public.trails where status <> 'archived' order by name`,
      tx<NarrationFormOptions["pois"]>`select id, trail_id, name, seq from public.trail_pois order by trail_id, seq`,
      tx<NarrationFormOptions["sources"]>`select id, label from public.sources order by label`,
    ]);
    return { trails, pois, sources };
  });
}
