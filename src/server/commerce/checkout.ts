import "server-only";
import { z } from "zod";
import { env } from "@/config/env";
import { isUniqueViolation, withAnon, withSystem, type JsonValue } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { getFlags, isEnabled } from "@/server/flags";
import { log } from "@/server/log";
import { getOwnedTrip, type TripRow } from "@/server/trips/queries";
import { getRegionById, getTrailById, isTrailAvailable, type Region, type TrailDetail } from "@/server/catalog/trails";
import { quotePrice, type AddonSelection, type Quote } from "@/domain/pricing";
import { closedOnDateMessage, holdIsValid, isRealIsoDate, toProviderLineItems, type StoredPriceBreakdown } from "@/domain/booking";
import { localDateInZone, zonedTimeToUtc } from "@/lib/time";
import { formatDate } from "@/lib/format";
import { getPaymentProvider, getPaymentProviderByName } from "@/integrations/payments";
import { getCommerceSettings } from "./settings";
import {
  gearAvailability,
  gearNeedFor,
  isGearAddon,
  loadPricingRules,
  lockAddonDay,
  lockGearDay,
  lockTrailDay,
  mergeGearNeeds,
  usedAddonCapacity,
  usedTrailCapacity,
  type GearAddonKind,
} from "./inventory";
import { abandonPendingBooking, expireHoldIfUnpaid } from "./reconcile";
import { closuresOnDay, planForSelection } from "./trip-plan";
import type { GearKindRequest } from "@/integrations/partners";

/**
 * Checkout: trip → pending booking (inventory held) → provider session.
 *
 * Prices are always computed server-side from the catalog, pricing rules and
 * current occupancy; client-submitted prices are never trusted. The booking
 * and its inventory hold are written in ONE transaction that locks the
 * (trail, day) inventory row, so concurrent checkouts can never overbook.
 * The provider session is created after commit; on provider failure the
 * hold is released (compensation).
 */
export const MAX_ADVANCE_DAYS = 365;

export type AddonKind = "gear_locker" | "shuttle" | "meal_pack" | "satellite_device" | "other";

export interface AddonRow {
  id: string;
  code: string;
  name: string;
  description: string;
  kind: AddonKind;
  providerKey: string;
  priceCents: number;
  pricingUnit: "per_booking" | "per_person";
  requiresCustomerConfirmation: boolean;
  dailyCapacity: number | null;
}

/** Active add-ons for a region whose feature flag addon_<kind> is enabled. */
export async function loadOfferedAddons(regionId: string): Promise<AddonRow[]> {
  const [rows, flags] = await Promise.all([
    withAnon(
      (tx) => tx<AddonRow[]>`
        select id, code, name, description, kind, provider_key, price_cents, pricing_unit, requires_customer_confirmation, daily_capacity
        from public.addons where active and (region_id is null or region_id = ${regionId})
        order by price_cents, name`,
    ),
    getFlags(),
  ]);
  return rows.filter((a) => flags[`addon_${a.kind}`] === true);
}

export const simulateModeSchema = z.enum(["fail", "fail_once", "reject"]);

export const checkoutInputSchema = z.object({
  tripId: z.uuid(),
  hikeDate: z.string().refine(isRealIsoDate, "Choose a valid date."),
  partySize: z.coerce.number().int().min(1).max(12),
  addonCodes: z.array(z.string().regex(/^[a-z0-9-]{1,60}$/)).max(10).default([]),
  idempotencyKey: z.uuid(),
  shuttlePickup: z.string().regex(/^[a-z0-9-]{1,60}$/).optional(),
  /** demo mode only: failure injection per add-on code */
  simulate: z.record(z.string().regex(/^[a-z0-9-]{1,60}$/), simulateModeSchema).optional(),
});
export type CheckoutInput = z.input<typeof checkoutInputSchema>;

export type CheckoutErrorCode =
  | "invalid"
  | "not_found"
  | "disabled"
  | "unavailable"
  | "sold_out"
  | "already_booked"
  | "expired"
  | "in_progress"
  | "provider_error";

export type CheckoutResult =
  | { ok: true; bookingId: string; url: string; resumed: boolean }
  | { ok: false; code: CheckoutErrorCode; error: string; renewKey?: boolean };

const fail = (code: CheckoutErrorCode, error: string, renewKey = false): CheckoutResult => ({ ok: false, code, error, renewKey });

export function tripStartTime(trip: Pick<TripRow, "startTime" | "itinerary" | "preferences">): string {
  const t = trip.startTime ?? trip.itinerary?.startTime ?? trip.preferences?.startTime ?? "08:00";
  return /^\d{2}:\d{2}/.test(t) ? t.slice(0, 5) : "08:00";
}

/** Date rules shared by the checkout page and the use-case. */
export function validateHikeDate(hikeDate: string, startTime: string, timezone: string, now = new Date()): string | null {
  // Reject impossible calendar dates before anything (Date.UTC would roll 2026-12-32 over to January).
  if (!isRealIsoDate(hikeDate)) return "Choose a valid date.";
  const today = localDateInZone(now, timezone);
  if (hikeDate < today) return "That date is in the past.";
  const max = localDateInZone(new Date(now.getTime() + MAX_ADVANCE_DAYS * 86_400_000), timezone);
  if (hikeDate > max) return `Bookings open up to ${MAX_ADVANCE_DAYS} days ahead.`;
  let start: Date;
  try {
    start = zonedTimeToUtc(hikeDate, startTime, timezone);
  } catch {
    return "Choose a valid date.";
  }
  if (start.getTime() <= now.getTime()) return "Your planned start time has already passed for that date.";
  return null;
}

/**
 * Date-independent bookability (catalog status, validated route, demo rules).
 * Closures are checked for the selected hike date — active or scheduled —
 * by closuresOnDay, so a closure that ends before the hike does not block it
 * and one scheduled for the hike day does.
 */
export function trailBookability(trail: TrailDetail | null): string | null {
  if (!trail) return "This trail is no longer available.";
  if (!isTrailAvailable(trail, [])) return "This trail is currently closed or not available for booking.";
  if (trail.isDemo && env().APP_MODE === "live") return "Demonstration trails cannot be booked.";
  return null;
}

interface BookingKeyRow {
  id: string;
  userId: string;
  tripId: string;
  status: string;
  holdExpiresAt: Date | null;
  checkoutSessionId: string | null;
  paymentProvider: string;
}

interface LiveBookingRow extends BookingKeyRow {
  hikeDate: string;
  partySize: number;
}

function urlsFor(providerName: string, bookingId: string) {
  // Stripe needs absolute URLs; the simulated provider redirects within this app.
  const base = providerName === "stripe" ? env().NEXT_PUBLIC_APP_URL.replace(/\/$/, "") : "";
  return {
    successUrl: `${base}/checkout/success?booking=${bookingId}`,
    cancelUrl: `${base}/checkout/cancelled?booking=${bookingId}`,
  };
}

/**
 * Where the customer can continue paying for a pending booking, creating the
 * provider session if an earlier attempt did not get that far. Provider
 * idempotency key `checkout:<bookingId>` makes this safe to repeat.
 */
export async function ensureCheckoutSession(user: SessionUser, bookingId: string): Promise<string | null> {
  const [b] = await withSystem(
    (tx) => tx<(BookingKeyRow & { totalCents: number; currency: string; priceBreakdown: StoredPriceBreakdown })[]>`
      select id, user_id, trip_id, status, hold_expires_at, checkout_session_id, payment_provider, total_cents, currency, price_breakdown
      from public.bookings where id = ${bookingId} and user_id = ${user.id}`,
  );
  if (!b || b.status !== "pending_payment" || !holdIsValid(b.holdExpiresAt, new Date())) return null;
  const provider = getPaymentProviderByName(b.paymentProvider);
  if (b.checkoutSessionId) {
    const s = await provider.getSession(b.checkoutSessionId);
    return s?.url ?? null;
  }
  const { successUrl, cancelUrl } = urlsFor(provider.name, b.id);
  const ref = await provider.createCheckoutSession({
    bookingId: b.id,
    userId: user.id,
    lineItems: toProviderLineItems(b.priceBreakdown, `Self-guided hike: ${b.priceBreakdown.trailName} × ${b.priceBreakdown.partySize}`),
    totalCents: b.totalCents,
    currency: b.currency,
    customerEmail: user.email || null,
    successUrl,
    cancelUrl,
    idempotencyKey: `checkout:${b.id}`,
    expiresAt: b.holdExpiresAt ?? undefined,
  });
  await withSystem((tx) => tx`update public.bookings set checkout_session_id = ${ref.sessionId} where id = ${b.id} and checkout_session_id is null`);
  return ref.url;
}

async function resumeExisting(user: SessionUser, b: BookingKeyRow): Promise<CheckoutResult> {
  if (b.userId !== user.id) return fail("invalid", "This checkout link is no longer valid. Please try again.", true);
  if (b.status === "pending_payment" && holdIsValid(b.holdExpiresAt, new Date())) {
    try {
      const url = await ensureCheckoutSession(user, b.id);
      if (url) return { ok: true, bookingId: b.id, url, resumed: true };
    } catch (err) {
      log.warn("checkout.resume_failed", { bookingId: b.id, error: err instanceof Error ? err.message : String(err) });
      return fail("provider_error", "We could not reach the payment provider. Please try again in a moment.");
    }
    return { ok: true, bookingId: b.id, url: `/checkout/success?booking=${b.id}`, resumed: true };
  }
  if (["confirmed", "needs_attention", "cancellation_requested", "refund_pending", "refunded", "cancelled"].includes(b.status)) {
    return { ok: true, bookingId: b.id, url: `/checkout/success?booking=${b.id}`, resumed: true };
  }
  return fail("expired", "That checkout attempt has ended without payment. Please review the details and try again.", true);
}

export async function createCheckout(user: SessionUser, raw: CheckoutInput): Promise<CheckoutResult> {
  const parsed = checkoutInputSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid", parsed.error.issues[0]?.message ?? "Check the booking details.");
  const input = parsed.data;

  // 1. Idempotent replay: the same form submission returns the same booking/session.
  const [byKey] = await withSystem(
    (tx) => tx<BookingKeyRow[]>`
      select id, user_id, trip_id, status, hold_expires_at, checkout_session_id, payment_provider
      from public.bookings where idempotency_key = ${input.idempotencyKey}`,
  );
  if (byKey) return resumeExisting(user, byKey);

  // 2. Authorization and validation.
  const trip = await getOwnedTrip(user, input.tripId);
  if (!trip) return fail("not_found", "Trip not found.");
  if (trip.status !== "saved") return fail("already_booked", "This trip is already booked or no longer open for booking.");
  if (!(await isEnabled("checkout_enabled"))) return fail("disabled", "Booking is temporarily paused. Please try again later.");

  const [trail, region] = await Promise.all([getTrailById(trip.trailId), getRegionById(trip.regionId)]);
  const notBookable = trailBookability(trail);
  if (notBookable || !trail) return fail("unavailable", notBookable ?? "This trail is not available.");
  if (!region) return fail("unavailable", "This region is not available.");
  const startTime = tripStartTime(trip);
  const dateError = validateHikeDate(input.hikeDate, startTime, region.timezone);
  if (dateError) return fail("invalid", dateError);
  // A date or group the saved plan was not computed for gets the planner's daylight rule.
  const selection = await planForSelection(trip, trail, region, { hikeDate: input.hikeDate, partySize: input.partySize, startTime });
  if (selection.daylightError) return fail("unavailable", selection.daylightError);

  const offered = await loadOfferedAddons(trip.regionId);
  const codes = [...new Set(input.addonCodes)];
  const chosen = codes.map((c) => offered.find((a) => a.code === c));
  if (chosen.some((a) => !a)) return fail("invalid", "One of the selected add-ons is not available.");
  const addons = chosen as AddonRow[];

  // 3. A lapsed pending booking for this trip must be settled (provider checked) before a new one.
  const [lapsed] = await withSystem(
    (tx) => tx<{ id: string }[]>`
      select id from public.bookings where trip_id = ${trip.id} and status = 'pending_payment' and hold_expires_at <= now()`,
  );
  if (lapsed) await expireHoldIfUnpaid(lapsed.id);

  const [settings, rules] = await Promise.all([getCommerceSettings(), loadPricingRules(trip.regionId, trip.trailId)]);
  const providerName = getPaymentProvider().name;
  const demo = env().APP_MODE === "demo";

  type TxOutcome =
    | { kind: "created"; bookingId: string; quote: Quote; holdExpiresAt: Date; breakdown: StoredPriceBreakdown }
    | { kind: "existing"; booking: BookingKeyRow }
    | { kind: "error"; result: CheckoutResult };
  const requestedCodes = [...codes].sort().join(",");

  let outcome: TxOutcome;
  try {
    outcome = await withSystem(async (tx): Promise<TxOutcome> => {
      // Lock the trip first (the same order as payments and cancellations: trip,
      // booking, trail day, add-on days, gear day) and re-check it under the
      // lock, so a trip cancelled meanwhile never gets a new held booking.
      const [lockedTrip] = await tx<{ status: string }[]>`select status from public.trips where id = ${trip.id} for update`;
      if (!lockedTrip || lockedTrip.status !== "saved") {
        return { kind: "error", result: fail("already_booked", "This trip is already booked or no longer open for booking.") };
      }
      const [live] = await tx<LiveBookingRow[]>`
        select id, user_id, trip_id, status, hold_expires_at, checkout_session_id, payment_provider,
               to_char(hike_date, 'YYYY-MM-DD') as hike_date, party_size
        from public.bookings
        where trip_id = ${trip.id} and status in ('pending_payment', 'confirmed', 'cancellation_requested', 'refund_pending', 'needs_attention')
        for update`;
      if (live) {
        if (live.status !== "pending_payment") return { kind: "error", result: fail("already_booked", "This trip already has a booking.") };
        // Same details: resume it. Different details: never silently send the
        // customer to pay the OLD booking — they must continue or release it.
        const held = await tx<{ code: string }[]>`
          select a.code from public.booking_addons ba join public.addons a on a.id = ba.addon_id where ba.booking_id = ${live.id}`;
        const heldCodes = held.map((h) => h.code).sort().join(",");
        if (live.hikeDate === input.hikeDate && live.partySize === input.partySize && heldCodes === requestedCodes) {
          return { kind: "existing", booking: live };
        }
        return {
          kind: "error",
          result: fail(
            "in_progress",
            `A checkout is already in progress for ${formatDate(live.hikeDate, { weekday: "short", month: "short", day: "numeric", year: "numeric" })} · ${live.partySize} ${live.partySize === 1 ? "hiker" : "hikers"}. Continue it, or release it to change the details.`,
          ),
        };
      }

      // Closures active OR scheduled on the hike day (region-local) are checked here, not just today's.
      const closures = await closuresOnDay(tx, trip.trailId, input.hikeDate, region.timezone);
      if (closures.closed) return { kind: "error", result: fail("unavailable", closedOnDateMessage(closures.closed)) };

      const day = await lockTrailDay(tx, trip.trailId, input.hikeDate);
      if (day.blocked) return { kind: "error", result: fail("sold_out", "That date is not available. Please choose another date.") };
      const used = await usedTrailCapacity(tx, trip.trailId, input.hikeDate);
      if (used + input.partySize > day.capacity) {
        const left = Math.max(0, day.capacity - used);
        return {
          kind: "error",
          result: fail("sold_out", left > 0 ? `Only ${left} spot${left === 1 ? "" : "s"} left on that date.` : "That date is fully booked. Please choose another date."),
        };
      }

      // Lock add-on days in a fixed (id) order so concurrent checkouts cannot deadlock.
      for (const a of [...addons].sort((x, y) => x.id.localeCompare(y.id))) {
        if (a.dailyCapacity == null) continue;
        await lockAddonDay(tx, a.id, input.hikeDate);
        const units = a.pricingUnit === "per_person" ? input.partySize : 1;
        const usedUnits = await usedAddonCapacity(tx, a.id, input.hikeDate);
        if (usedUnits + units > a.dailyCapacity) {
          return { kind: "error", result: fail("sold_out", `${a.name} is sold out on that date. Remove it or choose another date.`) };
        }
      }

      // Locker gear is finite physical stock. Count what held and paid-but-not-yet-fulfilled
      // bookings will take, under a region/day lock, so sequential or concurrent checkouts
      // cannot sell the same items twice (the hold itself reserves the demand).
      const gearAddons = addons.filter((a) => isGearAddon(a.kind)).sort((x, y) => x.id.localeCompare(y.id));
      if (gearAddons.length) {
        await lockGearDay(tx, trip.regionId, input.hikeDate);
        let needSoFar: GearKindRequest[] = [];
        for (const a of gearAddons) {
          const qty = a.pricingUnit === "per_person" ? input.partySize : 1;
          needSoFar = mergeGearNeeds(needSoFar, gearNeedFor(a.kind as GearAddonKind, qty));
          const check = await gearAvailability(tx, a.providerKey, trip.regionId, input.hikeDate, needSoFar);
          if (!check.ok) {
            return {
              kind: "error",
              result: fail(
                "sold_out",
                a.kind === "gear_locker"
                  ? `Not enough locker gear is available on that date for ${input.partySize} ${input.partySize === 1 ? "hiker" : "hikers"}. Remove "${a.name}" or choose another date.`
                  : `${a.name} is sold out on that date. Remove it or choose another date.`,
              ),
            };
          }
        }
      }

      const occupancy = day.capacity > 0 ? Math.min(1, used / day.capacity) : 1;
      const selections: AddonSelection[] = addons.map((a) => ({ code: a.code, name: a.name, priceCents: a.priceCents, pricingUnit: a.pricingUnit }));
      const quote = quotePrice({
        basePriceCents: trail.basePriceCents,
        partySize: input.partySize,
        hikeDate: input.hikeDate,
        occupancy,
        regionId: trip.regionId,
        trailId: trip.trailId,
        rules,
        addons: selections,
        currency: trail.currency,
      });
      const breakdown: StoredPriceBreakdown = {
        ...quote,
        trailName: trail.name,
        hikeDate: input.hikeDate,
        startTime,
        partySize: input.partySize,
        occupancy: Math.round(occupancy * 1000) / 1000,
        timezone: region.timezone,
      };

      const inserted = await tx<{ id: string; holdExpiresAt: Date }[]>`
        insert into public.bookings (user_id, trip_id, trail_id, hike_date, party_size, status, currency, subtotal_cents,
                                     addons_cents, total_cents, price_breakdown, payment_provider, hold_expires_at, idempotency_key)
        values (${user.id}, ${trip.id}, ${trip.trailId}, ${input.hikeDate}::date, ${input.partySize}, 'pending_payment', ${quote.currency},
                ${quote.subtotalCents}, ${quote.addonsCents}, ${quote.totalCents}, ${tx.json(breakdown as unknown as JsonValue)},
                ${providerName}, now() + make_interval(mins => ${settings.holdMinutes}), ${input.idempotencyKey})
        on conflict (idempotency_key) do nothing
        returning id, hold_expires_at`;
      if (!inserted.length) {
        const [same] = await tx<BookingKeyRow[]>`
          select id, user_id, trip_id, status, hold_expires_at, checkout_session_id, payment_provider
          from public.bookings where idempotency_key = ${input.idempotencyKey}`;
        return { kind: "existing", booking: same };
      }
      const bookingId = inserted[0].id;
      for (const a of addons) {
        const qty = a.pricingUnit === "per_person" ? input.partySize : 1;
        const details: Record<string, string> = {};
        if (a.kind === "shuttle" && input.shuttlePickup) details.shuttlePickup = input.shuttlePickup;
        const sim = demo ? input.simulate?.[a.code] : undefined;
        if (sim) details.simulate = sim;
        await tx`
          insert into public.booking_addons (booking_id, addon_id, quantity, unit_price_cents, total_cents, details)
          values (${bookingId}, ${a.id}, ${qty}, ${a.priceCents}, ${a.priceCents * qty}, ${tx.json(details)})`;
      }
      return { kind: "created", bookingId, quote, holdExpiresAt: inserted[0].holdExpiresAt, breakdown };
    });
  } catch (err) {
    // Two different submissions racing for the same trip: the partial unique
    // index (one live booking per trip) rejects the second; resume the first.
    if (isUniqueViolation(err)) {
      const [live] = await withSystem(
        (tx) => tx<BookingKeyRow[]>`
          select id, user_id, trip_id, status, hold_expires_at, checkout_session_id, payment_provider
          from public.bookings where trip_id = ${trip.id}
            and status in ('pending_payment', 'confirmed', 'cancellation_requested', 'refund_pending', 'needs_attention')`,
      );
      if (live) return resumeExisting(user, live);
    }
    throw err;
  }

  if (outcome.kind === "error") return outcome.result;
  if (outcome.kind === "existing") return resumeExisting(user, outcome.booking);

  // 4. Provider session (outside the transaction), with compensation on failure.
  const provider = getPaymentProviderByName(providerName);
  const { successUrl, cancelUrl } = urlsFor(provider.name, outcome.bookingId);
  try {
    const ref = await provider.createCheckoutSession({
      bookingId: outcome.bookingId,
      userId: user.id,
      lineItems: toProviderLineItems(outcome.quote, `Self-guided hike: ${trail.name} × ${input.partySize}`),
      totalCents: outcome.quote.totalCents,
      currency: outcome.quote.currency,
      customerEmail: user.email || null,
      successUrl,
      cancelUrl,
      idempotencyKey: `checkout:${outcome.bookingId}`,
      expiresAt: outcome.holdExpiresAt,
    });
    await withSystem(
      (tx) => tx`update public.bookings set checkout_session_id = ${ref.sessionId} where id = ${outcome.bookingId} and checkout_session_id is null`,
    );
    return { ok: true, bookingId: outcome.bookingId, url: ref.url, resumed: false };
  } catch (err) {
    log.error("checkout.provider_session_failed", { bookingId: outcome.bookingId, provider: provider.name, error: err instanceof Error ? err.message : String(err) });
    await withSystem(
      (tx) => tx`
        update public.bookings set status = 'expired', hold_expires_at = now(), cancellation_reason = 'Payment provider unavailable at checkout'
        where id = ${outcome.bookingId} and status = 'pending_payment' and checkout_session_id is null`,
    );
    return fail("provider_error", "We could not reach the payment provider, so nothing was charged. Please try again in a moment.", true);
  }
}

// ---------------------------------------------------------------------------
// Read model for the checkout page
// ---------------------------------------------------------------------------

export interface CheckoutView {
  trip: TripRow;
  trail: TrailDetail | null;
  region: Region | null;
  bookable: boolean;
  unavailableReason: string | null;
}

export async function loadCheckoutTrip(user: SessionUser, tripId: string): Promise<CheckoutView | null> {
  const trip = await getOwnedTrip(user, tripId);
  if (!trip) return null;
  const [trail, region] = await Promise.all([getTrailById(trip.trailId), getRegionById(trip.regionId)]);
  const reason = trailBookability(trail) ?? (region ? null : "This region is not available.");
  return { trip, trail, region, bookable: !reason, unavailableReason: reason };
}

/** Server-side quote for display (same engine and inputs the checkout uses). */
export async function previewQuote(params: {
  trail: TrailDetail;
  regionId: string;
  hikeDate: string;
  partySize: number;
  addons: AddonRow[];
  occupancy: number;
}): Promise<Quote> {
  const rules = await loadPricingRules(params.regionId, params.trail.id);
  return quotePrice({
    basePriceCents: params.trail.basePriceCents,
    partySize: params.partySize,
    hikeDate: params.hikeDate,
    occupancy: params.occupancy,
    regionId: params.regionId,
    trailId: params.trail.id,
    rules,
    addons: params.addons.map((a) => ({ code: a.code, name: a.name, priceCents: a.priceCents, pricingUnit: a.pricingUnit })),
    currency: params.trail.currency,
  });
}

/**
 * Locker kits still available per gear_locker add-on for a day and region:
 * free items minus what held and paid-but-unfulfilled bookings will take
 * (read-only display; the checkout re-checks under lock).
 */
export async function getGearKitsAvailable(addons: AddonRow[], regionId: string, day: string): Promise<Record<string, number>> {
  const gear = addons.filter((a) => a.kind === "gear_locker");
  if (!gear.length) return {};
  return withSystem(async (tx) => {
    const out: Record<string, number> = {};
    for (const a of gear) {
      const res = await gearAvailability(tx, a.providerKey, regionId, day, gearNeedFor("gear_locker", 1));
      out[a.id] = Math.min(...res.byKind.map((k) => k.available));
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Releasing a pending checkout ("Change details / start over")
// ---------------------------------------------------------------------------

export interface HeldSelection {
  hikeDate: string;
  partySize: number;
  addonCodes: string[];
  shuttlePickup: string | null;
}

export type ReleaseCheckoutResult =
  | { ok: true; outcome: "released" | "already_released"; held: HeldSelection }
  | { ok: true; outcome: "paid"; bookingId: string }
  | { ok: false; code: "not_found" | "provider_error"; error: string };

/**
 * Release the customer's own unpaid checkout so they can change the date,
 * group or add-ons: the provider session is closed FIRST (so it can no longer
 * be paid), then the booking expires and its held spots are freed. If the
 * provider reports the session was already paid, the payment is processed
 * normally instead (booking confirmed). Idempotent: releasing twice, or a
 * booking that already expired or failed, is a no-op that returns the held
 * selection.
 */
export async function releasePendingCheckout(user: SessionUser, tripId: string, bookingId: string): Promise<ReleaseCheckoutResult> {
  if (!z.uuid().safeParse(tripId).success || !z.uuid().safeParse(bookingId).success) return { ok: false, code: "not_found", error: "Checkout not found." };
  const [b] = await withSystem(
    (tx) => tx<{ id: string; status: string; hikeDate: string; partySize: number }[]>`
      select id, status, to_char(hike_date, 'YYYY-MM-DD') as hike_date, party_size
      from public.bookings where id = ${bookingId} and user_id = ${user.id} and trip_id = ${tripId}`,
  );
  if (!b) return { ok: false, code: "not_found", error: "Checkout not found." };
  const addons = await withSystem(
    (tx) => tx<{ code: string; details: { shuttlePickup?: string } | null }[]>`
      select a.code, ba.details from public.booking_addons ba join public.addons a on a.id = ba.addon_id
      where ba.booking_id = ${b.id} order by a.code`,
  );
  const held: HeldSelection = {
    hikeDate: b.hikeDate,
    partySize: b.partySize,
    addonCodes: addons.map((a) => a.code),
    shuttlePickup: addons.find((a) => a.details?.shuttlePickup)?.details?.shuttlePickup ?? null,
  };
  if (b.status === "expired" || b.status === "payment_failed") return { ok: true, outcome: "already_released", held };
  if (b.status !== "pending_payment") return { ok: true, outcome: "paid", bookingId: b.id };

  const outcome = await abandonPendingBooking(b.id, "Checkout released by the customer to change details");
  if (outcome === "error") {
    return { ok: false, code: "provider_error", error: "We could not reach the payment provider to close this checkout, so your spots are still held. Please try again in a moment." };
  }
  if (outcome === "confirmed" || outcome === "needs_attention") return { ok: true, outcome: "paid", bookingId: b.id };
  if (outcome === "skipped") {
    // Settled concurrently (e.g. the payment webhook won the race): report what it became.
    const [now] = await withSystem((tx) => tx<{ status: string }[]>`select status from public.bookings where id = ${b.id}`);
    if (now && now.status !== "expired" && now.status !== "payment_failed" && now.status !== "pending_payment") return { ok: true, outcome: "paid", bookingId: b.id };
  }
  log.info("checkout.released", { bookingId: b.id, outcome });
  return { ok: true, outcome: outcome === "expired" ? "released" : "already_released", held };
}
