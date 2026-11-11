import "server-only";
import { withAnon, withSystem, type Tx } from "@/server/db";
import { log } from "@/server/log";
import { getGearLockerProvider, type GearKind, type GearKindRequest } from "@/integrations/partners";
import { GEAR_KIT_KINDS } from "@/server/fulfillment/process";

/**
 * Trail-day and add-on capacity.
 *
 * A booking consumes capacity when it is confirmed / cancellation_requested /
 * needs_attention, or pending_payment with an unexpired hold. Reservations
 * serialize on the trail_day_inventory row (SELECT … FOR UPDATE) and, for
 * add-ons with a daily limit, on a transaction-scoped advisory lock.
 *
 * Locker gear (gear kits, satellite communicators) is finite physical stock:
 * gear_reservations rows only exist once a booking's fulfillment has run, so
 * the gear a held or paid-but-not-yet-fulfilled booking will need is counted
 * as demand against the free items (see gearAvailability).
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

/** Add-on kinds that take physical items from a region's gear lockers. */
export type GearAddonKind = "gear_locker" | "satellite_device";

export function isGearAddon(kind: string): kind is GearAddonKind {
  return kind === "gear_locker" || kind === "satellite_device";
}

/** Locker items one booked add-on line needs (same rule fulfillment uses when it reserves). */
export function gearNeedFor(kind: GearAddonKind, quantity: number): GearKindRequest[] {
  return kind === "gear_locker" ? GEAR_KIT_KINDS.map((k) => ({ kind: k, count: quantity })) : [{ kind: "satellite_communicator", count: 1 }];
}

/** Sum requests per item kind. */
export function mergeGearNeeds(...needs: GearKindRequest[][]): GearKindRequest[] {
  const out = new Map<GearKind, number>();
  for (const list of needs) for (const n of list) out.set(n.kind, (out.get(n.kind) ?? 0) + n.count);
  return [...out].map(([kind, count]) => ({ kind, count }));
}

/** Serialize gear checks for one region/day (taken after the add-on day locks). */
export async function lockGearDay(tx: Tx, regionId: string, day: string) {
  await tx`select pg_advisory_xact_lock(hashtext(${`gear:${regionId}:${day}`}))`;
}

/**
 * Locker items still owed to live bookings on a day in a region: gear add-ons
 * of bookings that hold capacity (pending with a valid hold, confirmed,
 * cancellation_requested, needs_attention) whose fulfillment has not reserved
 * items yet: no fulfillment row yet, or pending / failed / requested, or
 * needs_attention (paid for and owed to the customer until staff resolve it).
 */
export async function unfulfilledGearDemand(tx: Tx, regionId: string, day: string, excludeBookingId: string | null = null): Promise<Map<GearKind, number>> {
  const rows = await tx<{ kind: GearAddonKind; quantity: number }[]>`
    select a.kind, ba.quantity
    from public.booking_addons ba
    join public.addons a on a.id = ba.addon_id
    join public.bookings b on b.id = ba.booking_id
    join public.trails t on t.id = b.trail_id
    left join public.fulfillments f on f.booking_addon_id = ba.id
    where a.kind in ('gear_locker', 'satellite_device')
      and t.region_id = ${regionId} and b.hike_date = ${day}::date
      and (${excludeBookingId}::uuid is null or b.id <> ${excludeBookingId}::uuid)
      and (b.status in ('confirmed', 'cancellation_requested', 'needs_attention')
           or (b.status = 'pending_payment' and b.hold_expires_at > now()))
      and (f.id is null or f.status in ('pending', 'failed', 'requested', 'needs_attention'))
      and not exists (
        select 1 from public.gear_reservations gr where gr.fulfillment_id = f.id and gr.status in ('reserved', 'picked_up'))`;
  const demand = new Map<GearKind, number>();
  for (const n of mergeGearNeeds(...rows.map((r) => gearNeedFor(r.kind, r.quantity)))) demand.set(n.kind, n.count);
  return demand;
}

export interface GearCheck {
  ok: boolean;
  byKind: { kind: GearKind; requested: number; available: number }[];
}

/**
 * Locker items available for a NEW sale: the partner's free items minus the
 * demand of live bookings not yet fulfilled. The demand is read BEFORE the
 * free items, so a fulfillment committing in between is counted twice
 * (conservative), never zero times. Callers that sell must hold lockGearDay.
 * A provider error counts as "not available".
 */
export async function gearAvailability(
  tx: Tx,
  providerKey: string,
  regionId: string,
  day: string,
  need: GearKindRequest[],
  excludeBookingId: string | null = null,
): Promise<GearCheck> {
  const demand = await unfulfilledGearDemand(tx, regionId, day, excludeBookingId);
  try {
    const free = await getGearLockerProvider(providerKey).checkAvailability(tx, regionId, day, need);
    const byKind = free.byKind.map((k) => ({ kind: k.kind, requested: k.requested, available: Math.max(0, k.available - (demand.get(k.kind) ?? 0)) }));
    return { ok: byKind.every((k) => k.available >= k.requested), byKind };
  } catch (err) {
    log.warn("inventory.gear_availability_failed", { providerKey, day, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, byKind: need.map((n) => ({ kind: n.kind, requested: n.count, available: 0 })) };
  }
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
