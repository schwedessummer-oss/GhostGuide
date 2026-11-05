import "server-only";
import { withSystem } from "@/server/db";
import { recordIntegrationEvent } from "@/server/integration-log";
import { log } from "@/server/log";
import { getPaymentProviderByName, type ProviderSession } from "@/integrations/payments";
import { processPaymentEvent, type ProcessOutcome } from "./payments";

/**
 * Safety nets for lost or delayed webhooks:
 *  - bookings.expire_holds (every 5 min): pending_payment bookings past their
 *    hold. The provider session is checked FIRST; a paid session is processed
 *    through the normal processor, otherwise the session is closed and the
 *    booking expires (releasing inventory).
 *  - payments.reconcile (hourly): pending_payment bookings older than 10
 *    minutes are compared with the provider; paid-but-unnotified sessions are
 *    confirmed through the same processor.
 * Every provider lookup is recorded as an integration event.
 */
interface PendingRow {
  id: string;
  checkoutSessionId: string | null;
  paymentProvider: string;
}

async function lookupSession(b: PendingRow, operation: string): Promise<ProviderSession | null | "error"> {
  if (!b.checkoutSessionId) return null;
  const provider = getPaymentProviderByName(b.paymentProvider);
  const started = Date.now();
  try {
    const s = await provider.getSession(b.checkoutSessionId);
    await recordIntegrationEvent({
      providerKind: "payments",
      providerKey: provider.name,
      operation,
      outcome: provider.simulated ? "simulated" : "success",
      entityType: "booking",
      entityId: b.id,
      durationMs: Date.now() - started,
    });
    return s;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordIntegrationEvent({
      providerKind: "payments",
      providerKey: provider.name,
      operation,
      outcome: "failure",
      entityType: "booking",
      entityId: b.id,
      error: message,
      durationMs: Date.now() - started,
    });
    log.warn("payments.session_lookup_failed", { bookingId: b.id, error: message });
    return "error";
  }
}

/** Feed a paid provider session through the normal processor (synthetic event id). */
async function processPaidSession(b: PendingRow, s: ProviderSession, source: "reconcile" | "expire"): Promise<ProcessOutcome> {
  return processPaymentEvent({
    provider: b.paymentProvider === "stripe" ? "stripe" : "demo",
    eventId: `${source}:${s.sessionId}`,
    type: "checkout.completed",
    rawType: `${source}.session_paid`,
    occurredAt: new Date(),
    sessionId: s.sessionId,
    bookingId: s.bookingId ?? b.id,
    paymentStatus: "paid",
    amountTotal: s.amountTotal,
    currency: s.currency,
    paymentIntentId: s.paymentIntentId,
  });
}

export type HoldOutcome = "confirmed" | "needs_attention" | "expired" | "skipped" | "error";

/** Expire one lapsed hold, unless the provider says it was actually paid. Idempotent. */
export async function expireHoldIfUnpaid(bookingId: string): Promise<HoldOutcome> {
  const [b] = await withSystem(
    (tx) => tx<PendingRow[]>`
      select id, checkout_session_id, payment_provider from public.bookings
      where id = ${bookingId} and status = 'pending_payment' and hold_expires_at <= now()`,
  );
  if (!b) return "skipped";
  const s = await lookupSession(b, "expire_holds.get_session");
  if (s === "error") return "error"; // try again next tick rather than expiring a possibly-paid booking
  if (s && s.paymentStatus === "paid") {
    const outcome = await processPaidSession(b, s, "expire");
    return outcome === "confirmed" ? "confirmed" : outcome === "needs_attention" ? "needs_attention" : "skipped";
  }
  if (s && s.status === "open" && b.checkoutSessionId) {
    // Close the provider session so it can no longer be paid after the hold is released.
    try {
      await getPaymentProviderByName(b.paymentProvider).expireSession?.(b.checkoutSessionId);
    } catch (err) {
      log.warn("payments.expire_session_failed", { bookingId: b.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const rows = await withSystem(
    (tx) => tx`
      update public.bookings set status = 'expired'
      where id = ${b.id} and status = 'pending_payment' and hold_expires_at <= now()
      returning id`,
  );
  return rows.length ? "expired" : "skipped";
}

export async function expireStaleHolds(limit = 100): Promise<Record<HoldOutcome, number>> {
  const rows = await withSystem(
    (tx) => tx<{ id: string }[]>`
      select id from public.bookings where status = 'pending_payment' and hold_expires_at <= now()
      order by hold_expires_at limit ${limit}`,
  );
  const totals: Record<HoldOutcome, number> = { confirmed: 0, needs_attention: 0, expired: 0, skipped: 0, error: 0 };
  for (const r of rows) totals[await expireHoldIfUnpaid(r.id)]++;
  return totals;
}

/** Confirm bookings whose payment succeeded but whose webhook never arrived. */
export async function reconcilePendingPayments(olderThanMinutes = 10, limit = 100): Promise<{ checked: number; confirmed: number; needsAttention: number; errors: number }> {
  const rows = await withSystem(
    (tx) => tx<PendingRow[]>`
      select id, checkout_session_id, payment_provider from public.bookings
      where status = 'pending_payment' and checkout_session_id is not null
        and created_at < now() - make_interval(mins => ${olderThanMinutes})
      order by created_at limit ${limit}`,
  );
  const out = { checked: rows.length, confirmed: 0, needsAttention: 0, errors: 0 };
  for (const b of rows) {
    const s = await lookupSession(b, "reconcile.get_session");
    if (s === "error") {
      out.errors++;
      continue;
    }
    if (s && s.paymentStatus === "paid") {
      const outcome = await processPaidSession(b, s, "reconcile");
      if (outcome === "confirmed") out.confirmed++;
      if (outcome === "needs_attention") out.needsAttention++;
      if (outcome === "failed") out.errors++;
      log.info("payments.reconciled", { bookingId: b.id, outcome });
    }
  }
  return out;
}
