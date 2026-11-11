import "server-only";
import { withSystem, type JsonValue, type Tx } from "@/server/db";
import { enqueueJob, type JobOutcome } from "@/server/jobs/queue";
import { log } from "@/server/log";
import { addMinutesToClock, zonedTimeToUtc } from "@/lib/time";
import {
  getGearLockerProvider,
  getMealPackProvider,
  getSatelliteDeviceRentalProvider,
  getShuttleProvider,
  PartnerRejectedError,
  ShuttleConfirmationRequiredError,
  type GearReservationResult,
  type PartnerCallContext,
  type SimulateMode,
} from "@/integrations/partners";
import { SATELLITE_DISCLAIMER } from "@/integrations/partners/satellite-device/demo";
import { DEMO_PICKUP_POINTS, pickupPointByKey } from "@/integrations/partners/shuttle/pickup-points";

/**
 * Partner fulfillment for booked add-ons. One job per fulfillment
 * (`fulfillment.process`, dedup `fulfill:<id>`). Fulfillment status is kept
 * separate from booking status: a partner failure never changes the booking.
 *
 *  - Each run increments fulfillments.attempts before calling the partner.
 *  - Transient failure → status `failed` and the job throws (queue retries with backoff).
 *  - After MAX_FULFILLMENT_ATTEMPTS, or on a permanent rejection → `needs_attention`
 *    (visible on the trip page and in admin), job completes.
 *  - Obsolete runs (booking not confirmed, fulfillment already handled) are no-ops.
 */
export const MAX_FULFILLMENT_ATTEMPTS = 3;

/** Contents of the "gear locker kit" add-on, per person. */
export const GEAR_KIT_KINDS = ["trekking_poles", "daypack"] as const;

export interface FulfillmentContext {
  id: string;
  bookingId: string;
  status: string;
  attempts: number;
  providerKind: "gear_locker" | "shuttle" | "meal_pack" | "satellite_device" | "other";
  providerKey: string;
  details: Record<string, unknown>;
  externalRef: string | null;
  bookingStatus: string;
  hikeDate: string;
  partySize: number;
  quantity: number;
  addonDetails: { simulate?: SimulateMode; shuttlePickup?: string };
  addonName: string;
  addonTotalCents: number;
  regionId: string;
  timezone: string;
  trailheadName: string | null;
  trailheadLat: number;
  trailheadLng: number;
  startTime: string | null;
}

export async function loadFulfillmentContext(tx: Tx, fulfillmentId: string, lock: boolean): Promise<FulfillmentContext | null> {
  const [f] = await tx<FulfillmentContext[]>`
    select f.id, f.booking_id, f.status, f.attempts, f.provider_kind, f.provider_key, f.details, f.external_ref,
           b.status as booking_status, to_char(b.hike_date, 'YYYY-MM-DD') as hike_date, b.party_size,
           ba.quantity, ba.details as addon_details, ba.total_cents as addon_total_cents, a.name as addon_name,
           t.region_id, r.timezone, t.trailhead_name, t.trailhead_lat, t.trailhead_lng,
           -- the start time SOLD (frozen on the booking), never the trip's editable start_time
           coalesce(to_char(b.hike_start_at at time zone r.timezone, 'HH24:MI'), b.price_breakdown ->> 'startTime') as start_time
    from public.fulfillments f
    join public.bookings b on b.id = f.booking_id
    join public.booking_addons ba on ba.id = f.booking_addon_id
    join public.addons a on a.id = ba.addon_id
    join public.trails t on t.id = b.trail_id
    join public.regions r on r.id = t.region_id
    where f.id = ${fulfillmentId}
    ${lock ? tx`for update of f` : tx``}`;
  return f ?? null;
}

/** End of the hike day (region time) — when locker codes stop working. */
function codeExpiry(f: FulfillmentContext): Date {
  return zonedTimeToUtc(f.hikeDate, "23:59", f.timezone);
}

function partnerCtx(f: FulfillmentContext, attempt: number): PartnerCallContext & { regionId: string } {
  return { fulfillmentId: f.id, attempt, simulate: f.addonDetails?.simulate ?? null, regionId: f.regionId };
}

async function setDetails(tx: Tx, id: string, status: string, externalRef: string | null, details: Record<string, unknown>) {
  await tx`
    update public.fulfillments
    set status = ${status}, external_ref = ${externalRef}, details = ${tx.json(details as JsonValue)}, last_error = null
    where id = ${id}`;
}

function gearDetails(res: GearReservationResult, code: { hint: string; expiresAt: Date }, extra: Record<string, unknown> = {}) {
  return {
    simulated: true,
    lockerName: res.lockerName,
    locationDescription: res.locationDescription,
    items: res.itemLabels,
    primaryReservationId: res.primaryReservationId,
    codeHint: code.hint,
    codeExpiresAt: code.expiresAt.toISOString(),
    ...extra,
  };
}

/** Shuttle pickup: chosen pickup point, timed to reach the trailhead 15 min before the start (estimate). */
export function shuttlePlan(f: Pick<FulfillmentContext, "addonDetails" | "hikeDate" | "startTime" | "timezone" | "trailheadName" | "trailheadLat" | "trailheadLng">, pickupKey?: string) {
  const point = pickupPointByKey(pickupKey ?? f.addonDetails?.shuttlePickup) ?? DEMO_PICKUP_POINTS[0];
  const start = f.startTime ?? "08:00";
  const pickupClock = addMinutesToClock(start, -(point.driveMinutes + 15));
  const pickupAt = zonedTimeToUtc(f.hikeDate, pickupClock, f.timezone);
  return {
    point,
    pickupAt,
    pickup: { description: point.label, lat: point.lat, lng: point.lng },
    dropoff: { description: f.trailheadName ?? "Trailhead", lat: f.trailheadLat, lng: f.trailheadLng },
  };
}

/** Fulfillment statuses in which a (new) shuttle quote may replace the current one. */
export const SHUTTLE_QUOTABLE_STATUSES = ["pending", "failed", "awaiting_customer", "needs_attention"] as const;

/**
 * Request a fresh shuttle quote and store it (status quoted / awaiting_customer).
 * The partner call happens outside any lock, so the write re-checks state:
 * a quote never overwrites a shuttle the customer confirmed (or that was
 * requested / cancelled) while the call was in flight. Returns whether the
 * new quote was stored.
 */
export async function quoteShuttle(f: FulfillmentContext, attempt: number, pickupKey?: string): Promise<boolean> {
  const provider = getShuttleProvider(f.providerKey);
  const plan = shuttlePlan(f, pickupKey);
  const quote = await provider.requestQuote(
    { pickup: plan.pickup, dropoff: plan.dropoff, pickupAt: plan.pickupAt, partySize: f.partySize, prepaidCents: f.addonTotalCents },
    partnerCtx(f, attempt),
  );
  return withSystem(async (tx) => {
    const current = await loadFulfillmentContext(tx, f.id, true);
    if (!current || current.bookingStatus !== "confirmed" || !(SHUTTLE_QUOTABLE_STATUSES as readonly string[]).includes(current.status)) return false;
    const [sr] = await tx<{ status: string; customerConfirmedAt: Date | null }[]>`
      select status, customer_confirmed_at from public.shuttle_requests where fulfillment_id = ${f.id} for update`;
    if (sr && (sr.customerConfirmedAt || ["confirmed", "requested", "completed", "cancelled"].includes(sr.status))) return false;
    await tx`
      insert into public.shuttle_requests (fulfillment_id, pickup_description, pickup_lat, pickup_lng, dropoff_description,
                                           pickup_at, quoted_price_cents, quote_expires_at, customer_confirmed_at, status)
      values (${f.id}, ${plan.pickup.description}, ${plan.pickup.lat}, ${plan.pickup.lng}, ${plan.dropoff.description},
              ${plan.pickupAt}::timestamptz, ${quote.priceCents}, ${quote.expiresAt}::timestamptz, null, 'quoted')
      on conflict (fulfillment_id) do update set
        pickup_description = excluded.pickup_description, pickup_lat = excluded.pickup_lat, pickup_lng = excluded.pickup_lng,
        dropoff_description = excluded.dropoff_description, pickup_at = excluded.pickup_at,
        quoted_price_cents = excluded.quoted_price_cents, quote_expires_at = excluded.quote_expires_at,
        customer_confirmed_at = null, status = 'quoted'`;
    await setDetails(tx, f.id, "awaiting_customer", null, {
      simulated: true,
      pickupKey: plan.point.key,
      pickup: plan.pickup.description,
      dropoff: plan.dropoff.description,
      pickupAt: plan.pickupAt.toISOString(),
      priceCents: quote.priceCents,
      prepaidCents: f.addonTotalCents,
      quoteRef: quote.quoteRef,
      quoteExpiresAt: quote.expiresAt.toISOString(),
    });
    return true;
  });
}

/**
 * A partner accepted an order/ride while the fulfillment was being cancelled
 * (the call ran outside the lock). Keep the partner's reference and queue the
 * partner cancellation, so a paid order is never left orphaned. Call with the
 * fulfillment row locked and its status 'cancelled'.
 */
export async function compensateLatePartnerOrder(tx: Tx, fulfillmentId: string, ref: string, extra: Record<string, unknown>) {
  await tx`
    update public.fulfillments
    set external_ref = ${ref}, details = (details - 'partnerCancelledAt') || ${tx.json({ ...extra, acceptedAfterCancellation: true } as JsonValue)}
    where id = ${fulfillmentId}`;
  await enqueueJob(tx, "fulfillment.cancel", { fulfillmentId }, { dedupKey: `fulfill-cancel:${fulfillmentId}:${ref}`, maxAttempts: 5 });
  log.warn("fulfillment.partner_order_after_cancel", { fulfillmentId });
}

/**
 * Where a meal pack is collected: the booking region's online locker closest
 * to the booked trail's trailhead, or the trailhead itself when the region has
 * no online locker. Never a fixed, hard-coded locker.
 */
export async function mealPackPickup(
  tx: Tx,
  f: Pick<FulfillmentContext, "regionId" | "trailheadName" | "trailheadLat" | "trailheadLng">,
): Promise<{ location: string; instruction: string; lockerName: string | null; locationDescription: string | null }> {
  const [locker] = await tx<{ name: string; locationDescription: string }[]>`
    select name, location_description from public.gear_lockers
    where region_id = ${f.regionId} and status = 'online'
    order by case when lat is null or lng is null then 1 else 0 end,
             power(coalesce(lat, 0) - ${f.trailheadLat}, 2) + power(coalesce(lng, 0) - ${f.trailheadLng}, 2), name
    limit 1`;
  if (locker) {
    return {
      location: `${locker.name} — ${locker.locationDescription}`,
      instruction: `Collect on your hike date at ${locker.name} — ${locker.locationDescription.replace(/[.\s]+$/, "")}.`,
      lockerName: locker.name,
      locationDescription: locker.locationDescription,
    };
  }
  const trailhead = f.trailheadName ?? "the trailhead";
  return { location: trailhead, instruction: `Collect on your hike date at ${trailhead}.`, lockerName: null, locationDescription: null };
}

async function runPartner(f: FulfillmentContext, attempt: number) {
  const ctx = partnerCtx(f, attempt);
  switch (f.providerKind) {
    case "gear_locker": {
      const provider = getGearLockerProvider(f.providerKey);
      await withSystem(async (tx) => {
        const current = await loadFulfillmentContext(tx, f.id, true);
        if (!current || !["pending", "failed"].includes(current.status)) return;
        const kinds = GEAR_KIT_KINDS.map((kind) => ({ kind, count: f.quantity }));
        const res = await provider.reserve(tx, ctx, f.hikeDate, kinds);
        const code = await provider.issueAccessCode(tx, res, codeExpiry(f));
        await setDetails(tx, f.id, "confirmed", res.primaryReservationId, gearDetails(res, code));
      });
      return;
    }
    case "satellite_device": {
      const provider = getSatelliteDeviceRentalProvider(f.providerKey);
      const gear = getGearLockerProvider(f.providerKey);
      await withSystem(async (tx) => {
        const current = await loadFulfillmentContext(tx, f.id, true);
        if (!current || !["pending", "failed"].includes(current.status)) return;
        const res = await provider.reserve(tx, ctx, f.hikeDate);
        const code = await gear.issueAccessCode(tx, res, codeExpiry(f));
        await setDetails(tx, f.id, "confirmed", res.primaryReservationId, gearDetails(res, code, { disclaimer: SATELLITE_DISCLAIMER }));
      });
      return;
    }
    case "meal_pack": {
      const provider = getMealPackProvider(f.providerKey);
      const pickup = await withSystem((tx) => mealPackPickup(tx, f));
      const order = await provider.placeOrder({ hikeDate: f.hikeDate, quantity: f.quantity, partySize: f.partySize, pickupLocation: pickup.location }, ctx);
      await withSystem(async (tx) => {
        const current = await loadFulfillmentContext(tx, f.id, true);
        if (current?.status === "cancelled") {
          // Cancelled while the order was being placed: cancel it with the partner.
          await compensateLatePartnerOrder(tx, f.id, order.orderRef, { orderRef: order.orderRef });
          return;
        }
        if (!current || !["pending", "failed"].includes(current.status)) return;
        await setDetails(tx, f.id, "confirmed", order.orderRef, {
          simulated: true,
          orderRef: order.orderRef,
          quantity: f.quantity,
          ...(pickup.lockerName ? { lockerName: pickup.lockerName, locationDescription: pickup.locationDescription } : {}),
          pickup: pickup.instruction,
        });
      });
      return;
    }
    case "shuttle":
      await quoteShuttle(f, attempt);
      return;
    default:
      await withSystem((tx) => setDetails(tx, f.id, "confirmed", null, { simulated: true }));
  }
}

/** Job handler body for `fulfillment.process`. */
export async function processFulfillment(fulfillmentId: string): Promise<JobOutcome> {
  const claim = await withSystem(async (tx) => {
    const f = await loadFulfillmentContext(tx, fulfillmentId, true);
    if (!f) return { skip: "fulfillment not found" };
    if (f.bookingStatus !== "confirmed") return { skip: `booking is ${f.bookingStatus}` };
    if (!["pending", "failed"].includes(f.status)) return { skip: `fulfillment is ${f.status}` };
    const [{ attempts }] = await tx<{ attempts: number }[]>`
      update public.fulfillments set attempts = attempts + 1 where id = ${f.id} returning attempts`;
    return { f: { ...f, attempts }, attempt: attempts };
  });
  if ("skip" in claim) return { outcome: "noop", note: claim.skip };
  const { f, attempt } = claim as { f: FulfillmentContext; attempt: number };
  try {
    await runPartner(f, attempt);
    return { outcome: "done" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const permanent = err instanceof PartnerRejectedError || err instanceof ShuttleConfirmationRequiredError;
    const exhausted = attempt >= MAX_FULFILLMENT_ATTEMPTS;
    const next = permanent || exhausted ? "needs_attention" : "failed";
    await withSystem(
      (tx) => tx`
        update public.fulfillments set status = ${next}, last_error = ${message.slice(0, 1000)}
        where id = ${f.id} and status in ('pending', 'failed')`,
    );
    log.warn("fulfillment.failed", { fulfillmentId: f.id, kind: f.providerKind, attempt, next, error: message });
    if (next === "needs_attention") return { outcome: "done", note: `needs_attention: ${message}` };
    throw err;
  }
}
