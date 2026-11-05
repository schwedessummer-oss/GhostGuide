import "server-only";
import { z } from "zod";
import { withSystem } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { enqueueJob, type JobOutcome } from "@/server/jobs/queue";
import { recordAudit } from "@/server/audit";
import { log } from "@/server/log";
import { getShuttleProvider, ShuttleConfirmationRequiredError } from "@/integrations/partners";
import { loadFulfillmentContext, quoteShuttle } from "./process";

/**
 * Customer-confirmed shuttle rides.
 *
 * Rule: a paid ride is NEVER requested until the customer has explicitly
 * confirmed the pickup location, the price and the pickup time of a current
 * (unexpired) quote. The confirmation stores customer_confirmed_at and only
 * then enqueues `shuttle.request_ride`; requestShuttleRide re-checks it, and
 * the partner adapter refuses without it too.
 */
export interface ShuttleView {
  fulfillmentId: string;
  bookingId: string;
  tripId: string;
  fulfillmentStatus: string;
  requestStatus: string | null;
  pickupDescription: string | null;
  dropoffDescription: string | null;
  pickupAt: Date | null;
  quotedPriceCents: number | null;
  prepaidCents: number;
  currency: string;
  quoteExpiresAt: Date | null;
  customerConfirmedAt: Date | null;
  quoteExpired: boolean;
  pickupKey: string | null;
  timezone: string;
  simulated: boolean;
}

/** Owner-only view; null for anyone else (callers respond 404). */
export async function getShuttleForOwner(user: SessionUser, tripId: string, fulfillmentId: string): Promise<ShuttleView | null> {
  if (!z.uuid().safeParse(fulfillmentId).success || !z.uuid().safeParse(tripId).success) return null;
  const [row] = await withSystem(
    (tx) => tx<(Omit<ShuttleView, "quoteExpired" | "pickupKey" | "simulated"> & { details: Record<string, unknown>; providerKey: string })[]>`
      select f.id as fulfillment_id, f.booking_id, b.trip_id, f.status as fulfillment_status, sr.status as request_status,
             sr.pickup_description, sr.dropoff_description, sr.pickup_at, sr.quoted_price_cents, ba.total_cents as prepaid_cents,
             b.currency, sr.quote_expires_at, sr.customer_confirmed_at, r.timezone, f.details, f.provider_key
      from public.fulfillments f
      join public.bookings b on b.id = f.booking_id
      join public.booking_addons ba on ba.id = f.booking_addon_id
      join public.trails t on t.id = b.trail_id
      join public.regions r on r.id = t.region_id
      left join public.shuttle_requests sr on sr.fulfillment_id = f.id
      where f.id = ${fulfillmentId} and f.provider_kind = 'shuttle' and b.user_id = ${user.id} and b.trip_id = ${tripId}`,
  );
  if (!row) return null;
  const { details, providerKey, ...rest } = row;
  return {
    ...rest,
    quoteExpired: !!row.quoteExpiresAt && new Date(row.quoteExpiresAt).getTime() <= Date.now(),
    pickupKey: typeof details?.pickupKey === "string" ? details.pickupKey : null,
    simulated: providerKey === "demo",
  };
}

export const confirmShuttleSchema = z.object({
  tripId: z.uuid(),
  fulfillmentId: z.uuid(),
  confirmPickup: z.literal(true, { error: "Confirm the pickup location, time and price." }),
  /** the price and time the customer saw; must match the current quote */
  quotedPriceCents: z.coerce.number().int().min(0),
  pickupAt: z.iso.datetime(),
});

export type ShuttleActionResult = { ok: true; message: string } | { ok: false; error: string; code?: "expired" | "changed" | "not_found" | "invalid" | "state" };

export async function confirmShuttleQuote(user: SessionUser, raw: z.input<typeof confirmShuttleSchema>): Promise<ShuttleActionResult> {
  const parsed = confirmShuttleSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "invalid", error: parsed.error.issues[0]?.message ?? "Confirm the pickup details." };
  const input = parsed.data;
  return withSystem(async (tx): Promise<ShuttleActionResult> => {
    const [row] = await tx<{ fstatus: string; bookingStatus: string; srId: string | null; srStatus: string | null; quotedPriceCents: number | null; pickupAt: Date | null; quoteExpiresAt: Date | null; customerConfirmedAt: Date | null }[]>`
      select f.status as fstatus, b.status as booking_status, sr.id as sr_id, sr.status as sr_status, sr.quoted_price_cents,
             sr.pickup_at, sr.quote_expires_at, sr.customer_confirmed_at
      from public.fulfillments f
      join public.bookings b on b.id = f.booking_id
      left join public.shuttle_requests sr on sr.fulfillment_id = f.id
      where f.id = ${input.fulfillmentId} and f.provider_kind = 'shuttle' and b.user_id = ${user.id} and b.trip_id = ${input.tripId}
      for update of f`;
    if (!row || !row.srId) return { ok: false, code: "not_found", error: "Shuttle request not found." };
    if (row.customerConfirmedAt && ["confirmed", "requested"].includes(row.srStatus ?? "")) {
      return { ok: true, message: "You already confirmed this shuttle." }; // idempotent
    }
    if (row.bookingStatus !== "confirmed") return { ok: false, code: "state", error: "This booking is not active." };
    if (row.fstatus !== "awaiting_customer" || row.srStatus !== "quoted") return { ok: false, code: "state", error: "This shuttle quote cannot be confirmed right now." };
    if (!row.quoteExpiresAt || new Date(row.quoteExpiresAt).getTime() <= Date.now()) {
      return { ok: false, code: "expired", error: "This quote has expired. Request a new quote to continue." };
    }
    if (row.quotedPriceCents !== input.quotedPriceCents || !row.pickupAt || new Date(row.pickupAt).toISOString() !== new Date(input.pickupAt).toISOString()) {
      return { ok: false, code: "changed", error: "The quote changed since you opened this page. Please review the new details." };
    }
    await tx`
      update public.shuttle_requests set customer_confirmed_at = now(), status = 'confirmed'
      where id = ${row.srId} and status = 'quoted'`;
    await tx`update public.fulfillments set status = 'requested' where id = ${input.fulfillmentId}`;
    await enqueueJob(tx, "shuttle.request_ride", { fulfillmentId: input.fulfillmentId }, { dedupKey: `shuttle:${input.fulfillmentId}:ride:${row.srId}`, maxAttempts: 3 });
    await recordAudit(tx, { id: user.id, roles: user.roles }, "shuttle.customer_confirmed", "fulfillment", input.fulfillmentId, {
      quotedPriceCents: row.quotedPriceCents,
    });
    return { ok: true, message: "Thanks — your shuttle request has been sent to the partner." };
  });
}

/** Get a fresh quote (e.g. after expiry, or to change the pickup point). Partner call happens outside the lock. */
export async function requestNewShuttleQuote(user: SessionUser, tripId: string, fulfillmentId: string, pickupKey?: string): Promise<ShuttleActionResult> {
  const view = await getShuttleForOwner(user, tripId, fulfillmentId);
  if (!view) return { ok: false, code: "not_found", error: "Shuttle request not found." };
  if (view.customerConfirmedAt) return { ok: false, code: "state", error: "This shuttle is already confirmed." };
  if (!["awaiting_customer", "needs_attention", "failed"].includes(view.fulfillmentStatus)) {
    return { ok: false, code: "state", error: "A new quote is not available for this shuttle." };
  }
  const f = await withSystem((tx) => loadFulfillmentContext(tx, fulfillmentId, false));
  if (!f || f.bookingStatus !== "confirmed") return { ok: false, code: "state", error: "This booking is not active." };
  try {
    await quoteShuttle(f, f.attempts + 1, pickupKey);
  } catch (err) {
    log.warn("shuttle.requote_failed", { fulfillmentId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: "The shuttle partner did not return a quote. Please try again shortly." };
  }
  return { ok: true, message: "Here is your new quote. Review it and confirm to request the ride." };
}

/**
 * Job body for `shuttle.request_ride`. Refuses (permanently) when the
 * customer has not confirmed; idempotent once the ride is requested.
 */
export async function requestShuttleRide(fulfillmentId: string, job?: { attempts: number; maxAttempts: number }): Promise<JobOutcome> {
  const prep = await withSystem(async (tx) => {
    const f = await loadFulfillmentContext(tx, fulfillmentId, true);
    if (!f) return { skip: "fulfillment not found" };
    const [sr] = await tx<{ id: string; status: string; customerConfirmedAt: Date | null; pickupDescription: string | null; pickupLat: number | null; pickupLng: number | null; dropoffDescription: string | null; pickupAt: Date | null; quotedPriceCents: number | null }[]>`
      select id, status, customer_confirmed_at, pickup_description, pickup_lat, pickup_lng, dropoff_description, pickup_at, quoted_price_cents
      from public.shuttle_requests where fulfillment_id = ${fulfillmentId} for update`;
    if (!sr) return { skip: "no shuttle request" };
    if (f.bookingStatus !== "confirmed" || f.status === "cancelled") return { skip: "booking not active" };
    if (sr.status === "requested") return { skip: "ride already requested" };
    if (!sr.customerConfirmedAt || sr.status !== "confirmed") throw new ShuttleConfirmationRequiredError();
    return { f, sr };
  });
  if ("skip" in prep) return { outcome: "noop", note: prep.skip };
  const { f, sr } = prep as Exclude<typeof prep, { skip: string }>;
  const provider = getShuttleProvider(f.providerKey);
  try {
    const ride = await provider.requestRide(
      {
        shuttleRequestId: sr.id,
        customerConfirmedAt: sr.customerConfirmedAt,
        pickup: { description: sr.pickupDescription ?? "", lat: sr.pickupLat, lng: sr.pickupLng },
        dropoff: { description: sr.dropoffDescription ?? "" },
        pickupAt: new Date(sr.pickupAt ?? Date.now()),
        priceCents: sr.quotedPriceCents ?? 0,
        partySize: f.partySize,
      },
      { fulfillmentId: f.id, attempt: (job?.attempts ?? 1), simulate: null },
    );
    await withSystem(async (tx) => {
      await tx`update public.shuttle_requests set status = 'requested' where id = ${sr.id} and status = 'confirmed'`;
      await tx`
        update public.fulfillments
        set status = 'confirmed', external_ref = ${ride.rideRef}, details = details || ${tx.json({ rideRef: ride.rideRef, rideStatus: ride.status })}, last_error = null
        where id = ${f.id} and status in ('requested', 'failed')`;
    });
    return { outcome: "done" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const last = !job || job.attempts >= job.maxAttempts;
    await withSystem(
      (tx) => tx`
        update public.fulfillments set status = ${last ? "needs_attention" : "requested"}, last_error = ${message.slice(0, 1000)}
        where id = ${f.id} and status in ('requested', 'failed')`,
    );
    throw err;
  }
}
