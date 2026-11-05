import "server-only";
import { withAnon, withSystem, type Tx } from "@/server/db";

/**
 * Trail-day and add-on capacity.
 *
 * A booking consumes capacity when it is confirmed / cancellation_requested /
 * needs_attention, or pending_payment with an unexpired hold. Reservations
 * serialize on the trail_day_inventory row (SELECT … FOR UPDATE) and, for
 * add-ons with a daily limit, on a transaction-scoped advisory lock.
 */
export interface DayCapacity {
  capacity: number;
  blocked: boolean;
  note: string | null;
}

/** Insert-if-missing + lock the (trail, day) inventory row. Call inside withSystem. */
export async function lockTrailDay(tx: Tx, trailId: string, day: string): Promise<DayCapacity> {
  await tx`insert into public.trail_day_inventory (trail_id, day) values (${trailId}, ${day}::date) on conflict do nothing`;
  const [row] = await tx<DayCapacity[]>`
    select coalesce(i.capacity, t.daily_capacity) as capacity, i.blocked, i.note
    from public.trail_day_inventory i join public.trails t on t.id = i.trail_id
    where i.trail_id = ${trailId} and i.day = ${day}::date
    for update of i`;
  return row;
}

/** Party members holding capacity on a trail/day (optionally excluding one booking). */
export async function usedTrailCapacity(tx: Tx, trailId: string, day: string, excludeBookingId: string | null = null): Promise<number> {
  const [row] = await tx<{ used: number }[]>`
    select coalesce(sum(party_size), 0)::int as used
    from public.bookings
    where trail_id = ${trailId} and hike_date = ${day}::date
      and (${excludeBookingId}::uuid is null or id <> ${excludeBookingId}::uuid)
      and (status in ('confirmed', 'cancellation_requested', 'needs_attention')
           or (status = 'pending_payment' and hold_expires_at > now()))`;
  return row.used;
}

/** Serialize add-on capacity checks for one add-on/day across concurrent checkouts. */
export async function lockAddonDay(tx: Tx, addonId: string, day: string) {
  await tx`select pg_advisory_xact_lock(hashtext(${`addon:${addonId}:${day}`}))`;
}

/** Units of an add-on held on a day (across all trails; add-ons are regional). */
export async function usedAddonCapacity(tx: Tx, addonId: string, day: string, excludeBookingId: string | null = null): Promise<number> {
  const [row] = await tx<{ used: number }[]>`
    select coalesce(sum(ba.quantity), 0)::int as used
    from public.booking_addons ba join public.bookings b on b.id = ba.booking_id
    where ba.addon_id = ${addonId} and b.hike_date = ${day}::date
      and (${excludeBookingId}::uuid is null or b.id <> ${excludeBookingId}::uuid)
      and (b.status in ('confirmed', 'cancellation_requested', 'needs_attention')
           or (b.status = 'pending_payment' and b.hold_expires_at > now()))`;
  return row.used;
}

export interface DayAvailability {
  capacity: number;
  used: number;
  remaining: number;
  blocked: boolean;
}

/** Read-only availability for display (no locks; the checkout re-checks under lock). */
export async function getDayAvailability(trailId: string, day: string): Promise<DayAvailability> {
  return withSystem(async (tx) => {
    const [inv] = await tx<{ capacity: number; blocked: boolean }[]>`
      select coalesce(i.capacity, t.daily_capacity) as capacity, coalesce(i.blocked, false) as blocked
      from public.trails t left join public.trail_day_inventory i on i.trail_id = t.id and i.day = ${day}::date
      where t.id = ${trailId}`;
    const used = await usedTrailCapacity(tx, trailId, day);
    const capacity = inv?.capacity ?? 0;
    const blocked = inv?.blocked ?? true;
    return { capacity, used, remaining: blocked ? 0 : Math.max(0, capacity - used), blocked };
  });
}

/** Remaining units per add-on for a day (null = unlimited). */
export async function getAddonRemaining(addons: { id: string; dailyCapacity: number | null }[], day: string): Promise<Record<string, number | null>> {
  if (!addons.length) return {};
  return withSystem(async (tx) => {
    const out: Record<string, number | null> = {};
    for (const a of addons) {
      out[a.id] = a.dailyCapacity == null ? null : Math.max(0, a.dailyCapacity - (await usedAddonCapacity(tx, a.id, day)));
    }
    return out;
  });
}

/** Active pricing rules that could apply to a trail (the pure engine filters further). */
export async function loadPricingRules(regionId: string, trailId: string) {
  return withAnon(
    (tx) => tx<
      {
        id: string;
        name: string;
        kind: "weekend_pct" | "holiday_pct" | "high_demand_pct" | "group_discount_pct" | "flat_fee";
        value: number;
        params: { threshold?: number; minParty?: number; dates?: string[] };
        regionId: string | null;
        trailId: string | null;
        active: boolean;
        priority: number;
        effectiveFrom: string | null;
        effectiveTo: string | null;
      }[]
    >`
      select id, name, kind, value, params, region_id, trail_id, active, priority,
             to_char(effective_from, 'YYYY-MM-DD') as effective_from, to_char(effective_to, 'YYYY-MM-DD') as effective_to
      from public.pricing_rules
      where active and (region_id is null or region_id = ${regionId}) and (trail_id is null or trail_id = ${trailId})`,
  );
}
