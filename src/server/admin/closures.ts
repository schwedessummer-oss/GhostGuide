import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import { assertCan, auditInStaffTx, fail, guarded, isUuid, localDateTime, localDateTimeToUtc, ok, requiredText, staffTx, zodFail, type ActionResult } from "./common";

/**
 * Trail closures. Recommendations, trail pages and checkout read active
 * closures at request time (src/server/catalog/trails.ts), so a new
 * `closed` closure makes the trail unavailable immediately.
 */
export const CLOSURE_SEVERITIES = ["closed", "partial", "advisory"] as const;

export interface ClosureRow {
  id: string;
  trailId: string;
  severity: (typeof CLOSURE_SEVERITIES)[number];
  reason: string;
  sourceId: string | null;
  sourceLabel: string | null;
  startsAt: Date;
  endsAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  state: "active" | "scheduled" | "ended";
}

export async function listClosures(user: SessionUser, trailId: string): Promise<ClosureRow[]> {
  assertCan(user, "closures.manage");
  if (!isUuid(trailId)) return [];
  return staffTx(user, (tx) => tx<ClosureRow[]>`
    select c.id, c.trail_id, c.severity, c.reason, c.source_id, s.label as source_label, c.starts_at, c.ends_at, c.created_by, c.created_at,
           case when c.ends_at is not null and c.ends_at <= now() then 'ended'
                when c.starts_at > now() then 'scheduled' else 'active' end as state
    from public.trail_closures c left join public.sources s on s.id = c.source_id
    where c.trail_id = ${trailId}
    order by (c.ends_at is not null and c.ends_at <= now()), c.starts_at desc`);
}

const closureSchema = z
  .object({
    severity: z.enum(CLOSURE_SEVERITIES),
    reason: requiredText(5, 1000, "Reason"),
    sourceId: z.union([z.uuid(), z.literal("")]).transform((v) => (v === "" ? null : v)),
    startsAt: z.union([localDateTime, z.literal("")]),
    endsAt: z.union([localDateTime, z.literal("")]),
  });
export type ClosureInput = z.input<typeof closureSchema>;

async function regionTz(user: SessionUser, trailId: string): Promise<string | null> {
  const [r] = await staffTx(user, (tx) => tx<{ timezone: string }[]>`
    select r.timezone from public.trails t join public.regions r on r.id = t.region_id where t.id = ${trailId}`);
  return r?.timezone ?? null;
}

function resolveWindow(d: z.output<typeof closureSchema>, tz: string) {
  const startsAt = d.startsAt ? localDateTimeToUtc(d.startsAt, tz) : new Date();
  const endsAt = d.endsAt ? localDateTimeToUtc(d.endsAt, tz) : null;
  if (!startsAt || (d.endsAt && !endsAt)) return { error: "Enter valid start and end times." } as const;
  if (endsAt && endsAt <= startsAt) return { error: "The end must be after the start." } as const;
  return { startsAt, endsAt } as const;
}

export async function createClosure(user: SessionUser, trailId: string, input: ClosureInput): Promise<ActionResult<{ id: string }>> {
  assertCan(user, "closures.manage");
  if (!isUuid(trailId)) return fail("Trail not found.");
  const p = closureSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const tz = await regionTz(user, trailId);
  if (!tz) return fail("Trail not found.");
  const w = resolveWindow(p.data, tz);
  if ("error" in w) return fail(w.error as string);
  const d = p.data;
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into public.trail_closures (trail_id, severity, reason, source_id, starts_at, ends_at, created_by)
        values (${trailId}, ${d.severity}, ${d.reason}, ${d.sourceId}, ${w.startsAt}::timestamptz, ${w.endsAt}::timestamptz, ${user.id})
        returning id`;
      await auditInStaffTx(tx, user, "closure.created", "trail", trailId, { closureId: row.id, severity: d.severity, startsAt: w.startsAt, endsAt: w.endsAt });
      const effect =
        d.severity === "closed"
          ? "The trail is unavailable for recommendations and new bookings while this closure is active. Review existing bookings for affected dates."
          : "Customers will see this notice on the trail page and in their trip.";
      return ok(`Closure saved. ${effect}`, { data: { id: row.id } });
    }),
  );
}

export async function updateClosure(user: SessionUser, closureId: string, input: ClosureInput): Promise<ActionResult> {
  assertCan(user, "closures.manage");
  if (!isUuid(closureId)) return fail("Closure not found.");
  const p = closureSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const [c] = await staffTx(user, (tx) => tx<{ trailId: string }[]>`select trail_id from public.trail_closures where id = ${closureId}`);
  if (!c) return fail("Closure not found.");
  const tz = (await regionTz(user, c.trailId)) ?? "UTC";
  const w = resolveWindow(p.data, tz);
  if ("error" in w) return fail(w.error as string);
  const d = p.data;
  return guarded(() =>
    staffTx(user, async (tx) => {
      await tx`
        update public.trail_closures set severity = ${d.severity}, reason = ${d.reason}, source_id = ${d.sourceId},
          starts_at = ${w.startsAt}::timestamptz, ends_at = ${w.endsAt}::timestamptz
        where id = ${closureId}`;
      await auditInStaffTx(tx, user, "closure.updated", "trail", c.trailId, { closureId, severity: d.severity, startsAt: w.startsAt, endsAt: w.endsAt });
      return ok("Closure updated.");
    }),
  );
}

/** End a closure now (keeps it in the history). */
export async function endClosure(user: SessionUser, closureId: string): Promise<ActionResult> {
  assertCan(user, "closures.manage");
  if (!isUuid(closureId)) return fail("Closure not found.");
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [c] = await tx<{ trailId: string }[]>`
        update public.trail_closures set ends_at = now(), starts_at = least(starts_at, now())
        where id = ${closureId} and (ends_at is null or ends_at > now()) returning trail_id`;
      if (!c) return fail("Closure not found or already ended.");
      await auditInStaffTx(tx, user, "closure.ended", "trail", c.trailId, { closureId });
      return ok("Closure ended.");
    }),
  );
}

/** Delete a closure entered by mistake. */
export async function deleteClosure(user: SessionUser, closureId: string): Promise<ActionResult> {
  assertCan(user, "closures.manage");
  if (!isUuid(closureId)) return fail("Closure not found.");
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [c] = await tx<{ trailId: string; severity: string }[]>`delete from public.trail_closures where id = ${closureId} returning trail_id, severity`;
      if (!c) return fail("Closure not found.");
      await auditInStaffTx(tx, user, "closure.deleted", "trail", c.trailId, { closureId, severity: c.severity });
      return ok("Closure deleted.");
    }),
  );
}
