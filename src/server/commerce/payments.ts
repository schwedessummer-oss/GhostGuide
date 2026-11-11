import "server-only";
import { randomBytes } from "node:crypto";
import { withSystem, type JsonValue, type Tx } from "@/server/db";
import { enqueueJob } from "@/server/jobs/queue";
import { recordAudit } from "@/server/audit";
import { recordIntegrationEvent } from "@/server/integration-log";
import { log } from "@/server/log";
import { assertTransition, formatReceiptNumber } from "@/domain/booking";
import type { BookingStatus } from "@/domain/types";
import { getPaymentProviderByName, WebhookSignatureError, type NormalizedPaymentEvent } from "@/integrations/payments";
import { lockTrailDay, usedTrailCapacity } from "./inventory";
import { applyRefundSucceeded, requestRefund } from "./refunds";
import { syncTripToBooking } from "./trip-plan";

/**
 * Provider-agnostic payment event processor. Used by BOTH webhook routes
 * (Stripe and the simulated provider) and by the reconciliation jobs, so a
 * payment is confirmed by exactly one code path.
 *
 * Idempotency layers:
 *  1. webhook_events (provider, event_id) unique: a redelivered event whose
 *     row is `processed` is a 200 no-op. Concurrent deliveries serialize on
 *     that row (SELECT … FOR UPDATE).
 *  2. The booking row is locked FOR UPDATE; an already-confirmed booking is a no-op.
 *  3. payments (provider, provider_payment_id) unique; fulfillments one per
 *     booking add-on; fulfillment jobs dedup on `fulfill:<fulfillmentId>`.
 *
 * Decisions (documented for operators):
 *  - Paid with the hold still valid and the right amount → confirmed.
 *  - Paid after the hold expired: confirmed if capacity is still available,
 *    otherwise needs_attention + an AUTOMATIC FULL REFUND (we cannot honor the
 *    booking, and holding a customer's money for a hike that cannot happen is
 *    worse than refunding). A high-priority support ticket surfaces it.
 *  - Paid amount/currency differs from the booking total → needs_attention +
 *    automatic full refund of what was actually paid + support ticket.
 *  - Payment failed → payment_failed (hold released). Session expired → expired.
 * Payloads are stored reduced to non-PII fields only.
 */
export type ProcessOutcome =
  | "confirmed"
  | "needs_attention"
  | "payment_failed"
  | "expired"
  | "refund_synced"
  | "noop"
  | "duplicate"
  | "ignored"
  | "failed";

const SYSTEM_ACTOR = { id: null, roles: ["system"] as string[] };

function safePayload(e: NormalizedPaymentEvent): JsonValue {
  return {
    rawType: e.rawType,
    sessionId: e.sessionId,
    bookingId: e.bookingId,
    paymentStatus: e.paymentStatus,
    amountTotal: e.amountTotal,
    currency: e.currency,
    paymentIntentId: e.paymentIntentId,
    amountRefunded: e.amountRefunded ?? null,
    occurredAt: e.occurredAt.toISOString(),
  };
}

/** Entry point for webhook route handlers: verify, then process. */
export async function receivePaymentWebhook(
  providerName: string,
  rawBody: string,
  headers: Headers,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let provider;
  try {
    provider = getPaymentProviderByName(providerName);
  } catch {
    return { status: 404, body: { error: "unknown provider" } };
  }
  let event: NormalizedPaymentEvent;
  try {
    event = provider.parseWebhook(rawBody, headers);
  } catch (err) {
    const reason = err instanceof WebhookSignatureError ? err.message : "verification error";
    log.warn("payments.webhook_rejected", { provider: provider.name, reason });
    await recordIntegrationEvent({ providerKind: "payments", providerKey: provider.name, operation: "webhook.verify", outcome: "failure", error: reason });
    return { status: 400, body: { error: "invalid signature" } };
  }
  const outcome = await processPaymentEvent(event);
  if (outcome === "failed") return { status: 500, body: { error: "processing failed; please retry" } };
  return { status: 200, body: { received: true, outcome } };
}

export async function processPaymentEvent(event: NormalizedPaymentEvent): Promise<ProcessOutcome> {
  await withSystem(
    (tx) => tx`
      insert into public.webhook_events (provider, event_id, type, status, payload)
      values (${event.provider}, ${event.eventId}, ${event.rawType}, 'received', ${tx.json(safePayload(event))})
      on conflict (provider, event_id) do nothing`,
  );
  try {
    const outcome = await withSystem(async (tx): Promise<ProcessOutcome> => {
      const [we] = await tx<{ id: string; status: string }[]>`
        select id, status from public.webhook_events where provider = ${event.provider} and event_id = ${event.eventId} for update`;
      if (we.status === "processed" || we.status === "ignored") return "duplicate";
      const result = await applyPaymentEvent(tx, event);
      await tx`
        update public.webhook_events
        set status = ${result === "ignored" ? "ignored" : "processed"}, processed_at = now(), attempts = attempts + 1, error = null
        where id = ${we.id}`;
      return result;
    });
    await recordIntegrationEvent({
      providerKind: "payments",
      providerKey: event.provider,
      operation: `event.${event.type}`,
      outcome: event.provider === "demo" ? "simulated" : "success",
      entityType: "booking",
      entityId: event.bookingId ?? undefined,
    });
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withSystem(
      (tx) => tx`
        update public.webhook_events set status = 'failed', attempts = attempts + 1, error = ${message.slice(0, 1000)}
        where provider = ${event.provider} and event_id = ${event.eventId} and status <> 'processed'`,
    );
    log.error("payments.event_failed", { provider: event.provider, eventId: event.eventId, type: event.type, error: message });
    return "failed";
  }
}

interface LockedBooking {
  id: string;
  userId: string;
  tripId: string;
  trailId: string;
  hikeDate: string;
  partySize: number;
  status: BookingStatus;
  currency: string;
  totalCents: number;
  paymentProvider: string;
  checkoutSessionId: string | null;
  paymentIntentId: string | null;
  holdExpiresAt: Date | null;
}

async function lockBooking(tx: Tx, provider: string, sessionId: string | null, bookingId: string | null): Promise<LockedBooking | null> {
  const cols = tx`id, user_id, trip_id, trail_id, to_char(hike_date, 'YYYY-MM-DD') as hike_date, party_size, status, currency, total_cents,
                  payment_provider, checkout_session_id, payment_intent_id, hold_expires_at`;
  if (sessionId) {
    const [b] = await tx<LockedBooking[]>`select ${cols} from public.bookings where checkout_session_id = ${sessionId} for update`;
    if (b) return b;
  }
  if (bookingId && /^[0-9a-f-]{36}$/i.test(bookingId)) {
    const [b] = await tx<LockedBooking[]>`
      select ${cols} from public.bookings where id = ${bookingId} and payment_provider = ${provider}
        and (checkout_session_id is null or ${sessionId}::text is null or checkout_session_id = ${sessionId}::text)
      for update`;
    if (b) return b;
  }
  return null;
}

export async function applyPaymentEvent(tx: Tx, e: NormalizedPaymentEvent): Promise<ProcessOutcome> {
  switch (e.type) {
    case "checkout.completed":
    case "checkout.async_payment_succeeded":
      if (e.paymentStatus !== "paid" && e.type === "checkout.completed") return "noop"; // async method: wait for async_payment_succeeded
      return handlePaid(tx, e);
    case "checkout.async_payment_failed": {
      const b = await lockBooking(tx, e.provider, e.sessionId, e.bookingId);
      if (!b || b.status !== "pending_payment") return b ? "noop" : "ignored";
      assertTransition(b.status, "payment_failed");
      await tx`update public.bookings set status = 'payment_failed' where id = ${b.id}`;
      return "payment_failed";
    }
    case "checkout.expired": {
      const b = await lockBooking(tx, e.provider, e.sessionId, e.bookingId);
      if (!b || b.status !== "pending_payment") return b ? "noop" : "ignored";
      assertTransition(b.status, "expired");
      await tx`update public.bookings set status = 'expired' where id = ${b.id}`;
      return "expired";
    }
    case "charge.refunded":
      return handleChargeRefunded(tx, e);
    default:
      return "ignored";
  }
}

async function handlePaid(tx: Tx, e: NormalizedPaymentEvent): Promise<ProcessOutcome> {
  const b = await lockBooking(tx, e.provider, e.sessionId, e.bookingId);
  if (!b) {
    log.warn("payments.paid_unknown_booking", { provider: e.provider, eventId: e.eventId });
    return "ignored";
  }
  const providerPaymentId = e.paymentIntentId ?? e.sessionId ?? e.eventId;
  const [known] = await tx`select id from public.payments where provider = ${e.provider} and provider_payment_id = ${providerPaymentId}`;
  if (known) return "noop"; // same payment already recorded (different event id, e.g. reconcile + webhook)

  const paidAmount = e.amountTotal ?? 0;
  const currency = (e.currency ?? b.currency).toLowerCase();
  const insertPayment = async () => {
    const [p] = await tx<{ id: string }[]>`
      insert into public.payments (booking_id, provider, provider_payment_id, amount_cents, currency, status)
      values (${b.id}, ${e.provider}, ${providerPaymentId}, ${paidAmount}, ${currency}, 'succeeded')
      on conflict (provider, provider_payment_id) do nothing returning id`;
    return p?.id ?? null;
  };

  if (b.status === "confirmed" || b.status === "cancellation_requested" || b.status === "refund_pending" || b.status === "refunded" || b.status === "cancelled" || b.status === "needs_attention") {
    // A second, different payment for a booking that is already settled
    // (should not happen with one session per booking): never keep it.
    const paymentId = await insertPayment();
    if (paymentId && paidAmount > 0) {
      await refundUnattributable(tx, b, paymentId, paidAmount, "Duplicate payment for an already settled booking");
      return "needs_attention";
    }
    return "noop";
  }

  // pending_payment, or a LATE payment for an expired / payment_failed booking
  const amountOk = paidAmount === b.totalCents && currency === b.currency.toLowerCase();
  const holdOk = b.status === "pending_payment" && !!b.holdExpiresAt && e.occurredAt.getTime() <= new Date(b.holdExpiresAt).getTime();

  if (b.status !== "pending_payment") {
    const [other] = await tx`
      select id from public.bookings where trip_id = ${b.tripId} and id <> ${b.id}
        and status in ('pending_payment', 'confirmed', 'cancellation_requested', 'refund_pending', 'needs_attention')`;
    if (other) {
      // The customer already started/finished another booking for this trip.
      const paymentId = await insertPayment();
      await tx`update public.bookings set paid_at = now(), payment_intent_id = ${e.paymentIntentId} where id = ${b.id}`;
      if (paymentId && paidAmount > 0) await refundUnattributable(tx, b, paymentId, paidAmount, "Late payment for an expired checkout; the trip has another booking");
      return "needs_attention";
    }
  }

  let capacityOk = holdOk;
  if (!capacityOk) {
    const day = await lockTrailDay(tx, b.trailId, b.hikeDate);
    const used = await usedTrailCapacity(tx, b.trailId, b.hikeDate, b.id);
    capacityOk = !day.blocked && used + b.partySize <= day.capacity;
  }

  const paymentId = await insertPayment();
  if (!paymentId) return "noop";

  if (amountOk && capacityOk) {
    await confirmBooking(tx, b, e.paymentIntentId);
    return "confirmed";
  }

  const reason = !amountOk
    ? `Paid amount (${paidAmount} ${currency}) does not match the booking total (${b.totalCents} ${b.currency})`
    : "Payment arrived after the hold expired and the date is now fully booked";
  assertTransition(b.status, "needs_attention");
  await tx`
    update public.bookings set status = 'needs_attention', paid_at = now(), payment_intent_id = ${e.paymentIntentId}
    where id = ${b.id}`;
  if (paidAmount > 0) {
    await requestRefund(tx, { bookingId: b.id, paymentId, amountCents: paidAmount, reason: `Automatic full refund: ${reason}`, requestedBy: null });
  }
  await openTicket(tx, b, "Booking needs attention: automatic refund issued", reason);
  await recordAudit(tx, SYSTEM_ACTOR, "booking.needs_attention", "booking", b.id, { reason, paidAmount, currency });
  log.warn("payments.needs_attention", { bookingId: b.id, reason });
  return "needs_attention";
}

async function confirmBooking(tx: Tx, b: LockedBooking, paymentIntentId: string | null) {
  assertTransition(b.status, "confirmed");
  // Receipt numbers carry the payment date in the trail region's zone (as printed on the receipt).
  const [zone] = await tx<{ timezone: string }[]>`
    select r.timezone from public.trails t join public.regions r on r.id = t.region_id where t.id = ${b.trailId}`;
  const paidAt = new Date();
  let receipt = "";
  for (let i = 0; i < 5; i++) {
    const candidate = formatReceiptNumber(paidAt, randomBytes(6), zone?.timezone);
    const [taken] = await tx`select 1 from public.bookings where receipt_number = ${candidate}`;
    if (!taken) {
      receipt = candidate;
      break;
    }
  }
  if (!receipt) throw new Error("Could not allocate a receipt number");
  await tx`
    update public.bookings
    set status = 'confirmed', paid_at = now(), payment_intent_id = ${paymentIntentId}, receipt_number = ${receipt}
    where id = ${b.id}`;
  await tx`update public.trips set status = 'booked' where id = ${b.tripId} and status = 'saved'`;
  // The customer may have booked a different date or group than the saved plan:
  // rewrite the trip (date, start, group, rebuilt itinerary) for what was paid for.
  // A savepoint keeps a re-planning problem from blocking the payment confirmation itself.
  let replanned = false;
  try {
    replanned = await tx.savepoint((sp) => syncTripToBooking(sp, b));
  } catch (err) {
    log.error("payments.trip_replan_failed", { bookingId: b.id, tripId: b.tripId, error: err instanceof Error ? err.message : String(err) });
    await openTicket(tx, b, "Trip plan not updated for the booked date", "The booking is confirmed, but the trip's itinerary could not be rebuilt for the booked date and group. Please review the trip.");
  }
  const created = await tx<{ id: string }[]>`
    insert into public.fulfillments (booking_id, booking_addon_id, provider_kind, provider_key, status)
    select ba.booking_id, ba.id, a.kind, a.provider_key, 'pending'
    from public.booking_addons ba join public.addons a on a.id = ba.addon_id
    where ba.booking_id = ${b.id}
    on conflict (booking_addon_id) do nothing
    returning id`;
  for (const f of created) {
    await enqueueJob(tx, "fulfillment.process", { fulfillmentId: f.id }, { dedupKey: `fulfill:${f.id}`, maxAttempts: 5 });
  }
  await recordAudit(tx, SYSTEM_ACTOR, "booking.confirmed", "booking", b.id, { receipt, fulfillments: created.length, tripReplanned: replanned });
}

async function refundUnattributable(tx: Tx, b: LockedBooking, paymentId: string, amountCents: number, reason: string) {
  await requestRefund(tx, { bookingId: b.id, paymentId, amountCents, reason: `Automatic full refund: ${reason}`, requestedBy: null });
  await openTicket(tx, b, "Unexpected payment refunded automatically", reason);
  await recordAudit(tx, SYSTEM_ACTOR, "payment.auto_refunded", "booking", b.id, { reason, amountCents });
  log.warn("payments.unattributable_refunded", { bookingId: b.id, reason });
}

async function openTicket(tx: Tx, b: LockedBooking, subject: string, body: string) {
  await tx`
    insert into public.support_tickets (user_id, trip_id, booking_id, subject, body, status, priority)
    values (${b.userId}, ${b.tripId}, ${b.id}, ${subject}, ${body}, 'open', 'high')`;
}

/** Sync refunds made directly in the provider (e.g. Stripe dashboard) or confirm pending ones. */
async function handleChargeRefunded(tx: Tx, e: NormalizedPaymentEvent): Promise<ProcessOutcome> {
  if (!e.paymentIntentId || e.amountRefunded == null) return "ignored";
  const [payment] = await tx<{ id: string; bookingId: string; amountCents: number }[]>`
    select id, booking_id, amount_cents from public.payments where provider = ${e.provider} and provider_payment_id = ${e.paymentIntentId}`;
  if (!payment) return "ignored";
  await tx`select id from public.bookings where id = ${payment.bookingId} for update`;
  const refunds = await tx<{ id: string; bookingId: string; paymentId: string | null; amountCents: number; status: "requested" | "pending" | "succeeded" | "failed"; providerRefundId: string | null }[]>`
    select id, booking_id, payment_id, amount_cents, status, provider_refund_id from public.refunds
    where booking_id = ${payment.bookingId} order by created_at for update`;
  let accounted = refunds.filter((r) => r.status === "succeeded").reduce((s, r) => s + r.amountCents, 0);
  for (const r of refunds) {
    if (r.status === "pending" && r.providerRefundId && accounted + r.amountCents <= e.amountRefunded) {
      await applyRefundSucceeded(tx, r, r.providerRefundId);
      accounted += r.amountCents;
    }
  }
  const external = e.amountRefunded - accounted - refunds.filter((r) => r.status === "pending" || r.status === "requested").reduce((s, r) => s + r.amountCents, 0);
  if (external > 0) {
    const [r] = await tx<{ id: string; bookingId: string; paymentId: string | null; amountCents: number; status: "requested"; providerRefundId: null }[]>`
      insert into public.refunds (booking_id, payment_id, amount_cents, reason, status)
      values (${payment.bookingId}, ${payment.id}, ${external}, 'Refunded directly in the payment provider dashboard', 'requested')
      returning id, booking_id, payment_id, amount_cents, status, provider_refund_id`;
    await applyRefundSucceeded(tx, r, null);
    await recordAudit(tx, SYSTEM_ACTOR, "refund.external_synced", "booking", payment.bookingId, { amountCents: external });
  }
  return "refund_synced";
}
