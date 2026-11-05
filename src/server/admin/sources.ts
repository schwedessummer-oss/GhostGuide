import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import type { Source } from "@/domain/types";
import { assertCan, auditInStaffTx, fail, guarded, httpUrl, isUuid, isoDate, ok, optionalText, requiredText, staffTx, zodFail, type ActionResult } from "./common";

export const SOURCE_TYPES = ["official", "land_manager", "field_survey", "publication", "operator", "demo"] as const;

export interface SourceRow extends Source {
  trailCount: number;
  createdAt: Date;
}

export async function listSources(user: SessionUser): Promise<SourceRow[]> {
  assertCan(user, "trails.manage");
  return staffTx(user, (tx) => tx<SourceRow[]>`
    select s.id, s.label, s.url, s.publisher, s.source_type, s.retrieved_at, s.notes, s.created_at,
           (select count(*)::int from public.trail_sources ts where ts.source_id = s.id) as trail_count
    from public.sources s order by s.label`);
}

const sourceSchema = z.object({
  label: requiredText(3, 200, "Label"),
  url: z.union([httpUrl, z.literal("")]).transform((v) => (v === "" ? null : v)),
  publisher: optionalText(200),
  sourceType: z.enum(SOURCE_TYPES),
  retrievedAt: z.union([isoDate, z.literal("")]).transform((v) => (v === "" ? null : v)),
  notes: optionalText(2000),
});
export type SourceInput = z.input<typeof sourceSchema>;

const asTimestamp = (d: string | null) => (d ? `${d}T12:00:00Z` : null);

/** Create a source; optionally link it to a trail in the same transaction. */
export async function createSource(user: SessionUser, input: SourceInput, linkTrailId?: string): Promise<ActionResult<{ id: string }>> {
  assertCan(user, "trails.manage");
  const p = sourceSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  if (linkTrailId !== undefined && !isUuid(linkTrailId)) return fail("Trail not found.");
  const d = p.data;
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into public.sources (label, url, publisher, source_type, retrieved_at, notes)
        values (${d.label}, ${d.url}, ${d.publisher}, ${d.sourceType}, ${asTimestamp(d.retrievedAt)}::timestamptz, ${d.notes})
        returning id`;
      if (linkTrailId) await tx`insert into public.trail_sources (trail_id, source_id) values (${linkTrailId}, ${row.id}) on conflict do nothing`;
      await auditInStaffTx(tx, user, "source.created", "source", row.id, { label: d.label, sourceType: d.sourceType, linkedTrailId: linkTrailId ?? null });
      return ok(linkTrailId ? "Source created and linked to this trail." : "Source created.", { data: { id: row.id } });
    }),
  );
}

export async function updateSource(user: SessionUser, sourceId: string, input: SourceInput): Promise<ActionResult> {
  assertCan(user, "trails.manage");
  if (!isUuid(sourceId)) return fail("Source not found.");
  const p = sourceSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const d = p.data;
  return guarded(() =>
    staffTx(user, async (tx) => {
      const rows = await tx`
        update public.sources set label = ${d.label}, url = ${d.url}, publisher = ${d.publisher}, source_type = ${d.sourceType},
          retrieved_at = ${asTimestamp(d.retrievedAt)}::timestamptz, notes = ${d.notes}
        where id = ${sourceId} returning id`;
      if (!rows.length) return fail("Source not found.");
      await auditInStaffTx(tx, user, "source.updated", "source", sourceId, { label: d.label });
      return ok("Source saved.");
    }),
  );
}

export async function deleteSource(user: SessionUser, sourceId: string): Promise<ActionResult> {
  assertCan(user, "trails.manage");
  if (!isUuid(sourceId)) return fail("Source not found.");
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [use] = await tx<{ n: number }[]>`
        select (select count(*) from public.trail_field_provenance where source_id = ${sourceId})
             + (select count(*) from public.narrations where source_id = ${sourceId})
             + (select count(*) from public.trail_closures where source_id = ${sourceId})
             + (select count(*) from public.permit_requirements where source_id = ${sourceId})
             + (select count(*) from public.trails where geometry_source_id = ${sourceId}) as n`;
      if (use.n > 0) return fail("This source is cited by facts, narration, closures or permits. Edit it instead of deleting it.");
      const rows = await tx`delete from public.sources where id = ${sourceId} returning id`;
      if (!rows.length) return fail("Source not found.");
      await auditInStaffTx(tx, user, "source.deleted", "source", sourceId);
      return ok("Source deleted.");
    }),
  );
}

export async function linkSource(user: SessionUser, trailId: string, sourceId: string, link: boolean): Promise<ActionResult> {
  assertCan(user, "trails.manage");
  if (!isUuid(trailId) || !isUuid(sourceId)) return fail("Trail or source not found.");
  return guarded(() =>
    staffTx(user, async (tx) => {
      if (link) {
        const [s] = await tx`select 1 from public.sources where id = ${sourceId}`;
        if (!s) return fail("Source not found.");
        await tx`insert into public.trail_sources (trail_id, source_id) values (${trailId}, ${sourceId}) on conflict do nothing`;
      } else {
        await tx`delete from public.trail_sources where trail_id = ${trailId} and source_id = ${sourceId}`;
      }
      await auditInStaffTx(tx, user, link ? "trail.source_linked" : "trail.source_unlinked", "trail", trailId, { sourceId });
      return ok(link ? "Source linked." : "Source unlinked.");
    }),
  );
}
