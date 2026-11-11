import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import type { Tx } from "@/server/db";
import { assertCan, auditInStaffTx, fail, guarded, isUuid, localDateTime, localDateTimeToUtc, ok, requiredText, staffTx, systemTx, zodFail, type ActionResult } from "./common";

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
  const result = await guarded(() =>
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
  if (!result.ok || d.severity !== "closed" || !result.data) return result;
  const warning = await closureImpactWarning(trailId, result.data.id).catch(() => null);
  return warning ? { ...result, warnings: [...(result.warnings ?? []), warning] } : result;
}

/**
 * Count of paid bookings on the days a new full closure covers. Counts only
 * (no customer details), so every closures.manage role may see it; computed
 * by trusted code after the permission check because content editors cannot
 * read bookings under RLS.
 */
async function closureImpactWarning(trailId: string, closureId: string): Promise<string | null> {
  const impact = await systemTx((tx) => affectedBookingRows(tx, trailId, [closureId]));
  if (!impact.length) return null;
  const hikers = impact.reduce((n, b) => n + b.partySize, 0);
  const one = impact.length === 1;
  return `${impact.length} upcoming paid ${one ? "booking" : "bookings"} (${hikers} ${hikers === 1 ? "hiker" : "hikers"}) ${one ? "falls" : "fall"} on days this closure covers. ${one ? "It is" : "They are"} not cancelled automatically: see the list under the closure.`;
}

// ---------------------------------------------------------------------------
// Bookings affected by a full closure
// ---------------------------------------------------------------------------
/** Paid bookings that still need a decision when their hike day is closed. */
export const AFFECTED_BOOKING_STATUSES = ["confirmed", "cancellation_requested", "needs_attention"] as const;

export interface AffectedBooking {
  closureId: string;
  id: string;
  hikeDate: string;
  partySize: number;
  status: string;
  customerEmail: string | null;
}

export interface ClosureImpact {
  count: number;
  hikers: number;
  /** null when the viewer may not see bookings (bookings.view): count only */
  bookings: AffectedBooking[] | null;
}

/**
 * Upcoming paid bookings whose hike day (a local calendar day in the trail's
 * region) overlaps an active or scheduled `closed` closure. A day overlaps
 * when [day 00:00, next day 00:00) in the region's zone intersects
 * [starts_at, ends_at); open-ended closures run until further notice.
 */
async function affectedBookingRows(tx: Tx, trailId: string, closureIds: string[] | null): Promise<AffectedBooking[]> {
  return tx<AffectedBooking[]>`
    select c.id as closure_id, b.id, to_char(b.hike_date, 'YYYY-MM-DD') as hike_date, b.party_size, b.status, p.email as customer_email
    from public.trail_closures c
    join public.trails t on t.id = c.trail_id
    join public.regions r on r.id = t.region_id
    join public.bookings b on b.trail_id = c.trail_id
    left join public.profiles p on p.id = b.user_id
    where c.trail_id = ${trailId}
      and (${closureIds}::uuid[] is null or c.id = any(${closureIds}::uuid[]))
      and c.severity = 'closed'
      and (c.ends_at is null or c.ends_at > now())
      and b.status::text = any(${[...AFFECTED_BOOKING_STATUSES]}::text[])
      and b.hike_date >= (now() at time zone r.timezone)::date
      and (b.hike_date::timestamp at time zone r.timezone) < coalesce(c.ends_at, 'infinity'::timestamptz)
      and ((b.hike_date + 1)::timestamp at time zone r.timezone) > c.starts_at
    order by b.hike_date, b.created_at
    limit 500`;
}

/**
 * Impact of each active/scheduled full closure of a trail, keyed by closure
 * id. Staff with bookings.view get the bookings (to open, cancel or refund
 * them on the booking page); other closures.manage roles get counts only.
 */
export async function listClosureImpacts(user: SessionUser, trailId: string): Promise<Record<string, ClosureImpact>> {
  assertCan(user, "closures.manage");
  if (!isUuid(trailId)) return {};
  const canSeeBookings = can(user.roles, "bookings.view");
  // bookings.view roles read under RLS; others get counts computed by
  // trusted code after the permission check (no customer details leave it).
  const rows = canSeeBookings ? await staffTx(user, (tx) => affectedBookingRows(tx, trailId, null)) : await systemTx((tx) => affectedBookingRows(tx, trailId, null));
  const out: Record<string, ClosureImpact> = {};
  for (const b of rows) {
    const imp = (out[b.closureId] ??= { count: 0, hikers: 0, bookings: canSeeBookings ? [] : null });
    imp.count++;
    imp.hikers += b.partySize;
    imp.bookings?.push(b);
  }
  return out;
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
