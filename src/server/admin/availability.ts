import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import { localDateInZone } from "@/lib/time";
import { assertCan, auditInStaffTx, fail, guarded, isUuid, isoDate, ok, optionalText, staffTx, zodFail, type ActionResult } from "./common";

/**
 * Trail-day inventory. Booked = confirmed / cancellation_requested /
 * needs_attention; held = pending_payment with an unexpired hold (same rules
 * as checkout, see src/server/commerce/inventory.ts). Checkout re-checks
 * capacity under a row lock, so edits here apply to the next reservation.
 */
export interface DayRow {
  day: string;
  capacityOverride: number | null;
  capacity: number;
  blocked: boolean;
  note: string | null;
  booked: number;
  held: number;
  remaining: number;
}

export async function getAvailability(user: SessionUser, trailId: string, days = 30): Promise<{ trail: { id: string; name: string; dailyCapacity: number; timezone: string; status: string }; today: string; rows: DayRow[] } | null> {
  assertCan(user, "inventory.manage");
  if (!isUuid(trailId)) return null;
  const n = Math.min(Math.max(days, 1), 90);
  return staffTx(user, async (tx) => {
    const [trail] = await tx<{ id: string; name: string; dailyCapacity: number; timezone: string; status: string }[]>`
      select t.id, t.name, t.daily_capacity, r.timezone, t.status from public.trails t join public.regions r on r.id = t.region_id where t.id = ${trailId}`;
    if (!trail) return null;
    const today = localDateInZone(new Date(), trail.timezone);
    const rows = await tx<Omit<DayRow, "remaining">[]>`
      select to_char(d.day, 'YYYY-MM-DD') as day, i.capacity as capacity_override, coalesce(i.capacity, ${trail.dailyCapacity}::int) as capacity,
             coalesce(i.blocked, false) as blocked, i.note,
             coalesce((select sum(b.party_size) from public.bookings b where b.trail_id = ${trailId} and b.hike_date = d.day
                        and b.status in ('confirmed', 'cancellation_requested', 'needs_attention')), 0)::int as booked,
             coalesce((select sum(b.party_size) from public.bookings b where b.trail_id = ${trailId} and b.hike_date = d.day
                        and b.status = 'pending_payment' and b.hold_expires_at > now()), 0)::int as held
      from generate_series(${today}::date, ${today}::date + ${n - 1}::int, interval '1 day') as d(day)
      left join public.trail_day_inventory i on i.trail_id = ${trailId} and i.day = d.day::date
      order by d.day`;
    return {
      trail,
      today,
      rows: rows.map((r) => ({ ...r, remaining: r.blocked ? 0 : Math.max(0, r.capacity - r.booked - r.held) })),
    };
  });
}

const daySchema = z.object({
  day: isoDate,
  capacity: z.union([z.coerce.number().int().min(0, "Capacity cannot be negative").max(1000), z.literal("")]).transform((v) => (v === "" ? null : v)),
  blocked: z.boolean(),
  note: optionalText(300),
});

export async function setDayInventory(user: SessionUser, trailId: string, input: z.input<typeof daySchema>): Promise<ActionResult> {
  assertCan(user, "inventory.manage");
  if (!isUuid(trailId)) return fail("Trail not found.");
  const p = daySchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const d = p.data;
  if (d.blocked && !d.note) return fail("Add a short note explaining why the day is blocked.");
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [t] = await tx<{ dailyCapacity: number }[]>`select daily_capacity from public.trails where id = ${trailId}`;
      if (!t) return fail("Trail not found.");
      const [before] = await tx<{ capacity: number | null; blocked: boolean; note: string | null }[]>`
        select capacity, blocked, note from public.trail_day_inventory where trail_id = ${trailId} and day = ${d.day}::date for update`;
      await tx`
        insert into public.trail_day_inventory (trail_id, day, capacity, blocked, note)
        values (${trailId}, ${d.day}::date, ${d.capacity}, ${d.blocked}, ${d.note})
        on conflict (trail_id, day) do update set capacity = excluded.capacity, blocked = excluded.blocked, note = excluded.note`;
      const [{ used }] = await tx<{ used: number }[]>`
        select coalesce(sum(party_size), 0)::int as used from public.bookings
        where trail_id = ${trailId} and hike_date = ${d.day}::date
          and (status in ('confirmed', 'cancellation_requested', 'needs_attention') or (status = 'pending_payment' and hold_expires_at > now()))`;
      const action = before?.blocked !== d.blocked ? (d.blocked ? "inventory.day_blocked" : "inventory.day_unblocked") : "inventory.capacity_updated";
      await auditInStaffTx(tx, user, action, "trail", trailId, {
        day: d.day,
        before: before ?? null,
        after: { capacity: d.capacity, blocked: d.blocked, note: d.note },
      });
      const effective = d.capacity ?? t.dailyCapacity;
      const warnings: string[] = [];
      if (used > 0 && (d.blocked || used > effective)) {
        warnings.push(`${used} hiker(s) already hold bookings for ${d.day}. Existing bookings are not cancelled automatically; review them in Bookings.`);
      }
      return ok(d.blocked ? `${d.day} blocked for new bookings.` : `${d.day} saved (capacity ${effective}).`, { warnings });
    }),
  );
}

export async function availabilityTrailOptions(user: SessionUser): Promise<{ id: string; name: string; status: string }[]> {
  assertCan(user, "inventory.manage");
  return staffTx(user, (tx) => tx<{ id: string; name: string; status: string }[]>`
    select id, name, status from public.trails where status in ('published', 'closed', 'draft') order by status <> 'published', name`);
}
