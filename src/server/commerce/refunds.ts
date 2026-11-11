import "server-only";
import { withSystem, type Tx } from "@/server/db";
import { enqueueJob, type JobOutcome } from "@/server/jobs/queue";
import { recordIntegrationEvent } from "@/server/integration-log";
import { log } from "@/server/log";
import { getPaymentProviderByName } from "@/integrations/payments";

/**
 * Refund bookkeeping. A refund is a row in public.refunds plus a
 * `refunds.process` job (dedup `refund:<refundId>`); the job calls the
 * provider with idempotency key `refund:<refundId>`, so retries and
 * redeliveries can never refund twice. Failures retry with backoff and end
 * up `dead` in the admin retry queue with the refund marked `failed`.
 *
 * Invariant (enforced under a booking row lock by every caller):
 *   refunded_cents + outstanding refunds <= amount actually paid.
 */
export interface RefundBalance {
  paidCents: number;
  refundedCents: number;
  /** requested / pending / failed (may still be retried) refunds */
  outstandingCents: number;
  availableCents: number;
}

export async function refundBalance(tx: Tx, bookingId: string): Promise<RefundBalance> {
  const [row] = await tx<{ paid: number; refunded: number; outstanding: number }[]>`
    select
      (select coalesce(sum(amount_cents), 0)::int from public.payments
        where booking_id = ${bookingId} and status in ('succeeded', 'partially_refunded', 'refunded')) as paid,
      (select refunded_cents from public.bookings where id = ${bookingId}) as refunded,
      (select coalesce(sum(amount_cents), 0)::int from public.refunds
        where booking_id = ${bookingId} and status in ('requested', 'pending', 'failed')) as outstanding`;
  const paidCents = row?.paid ?? 0;
  const refundedCents = row?.refunded ?? 0;
  const outstandingCents = row?.outstanding ?? 0;
  return { paidCents, refundedCents, outstandingCents, availableCents: Math.max(0, paidCents - refundedCents - outstandingCents) };
}

/** Insert a refund + enqueue its job in the caller's transaction. Caller holds the booking lock. */
export async function requestRefund(
  tx: Tx,
  p: { bookingId: string; amountCents: number; reason: string; requestedBy: string | null; paymentId?: string | null },
): Promise<{ refundId: string }> {
  if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) throw new Error("Refund amount must be a positive whole number of cents");
  const balance = await refundBalance(tx, p.bookingId);
  if (p.amountCents > balance.availableCents) throw new Error("Refund exceeds the refundable balance");
  const [payment] = p.paymentId
    ? [{ id: p.paymentId }]
    : await tx<{ id: string }[]>`
        select id from public.payments where booking_id = ${p.bookingId} and status in ('succeeded', 'partially_refunded')
        order by created_at limit 1`;
  const [refund] = await tx<{ id: string }[]>`
    insert into public.refunds (booking_id, payment_id, amount_cents, reason, status, requested_by)
    values (${p.bookingId}, ${payment?.id ?? null}, ${p.amountCents}, ${p.reason.slice(0, 500)}, 'requested', ${p.requestedBy})
    returning id`;
  await enqueueJob(tx, "refunds.process", { refundId: refund.id }, { dedupKey: `refund:${refund.id}`, maxAttempts: 5 });
  return { refundId: refund.id };
}

interface RefundRow {
  id: string;
  bookingId: string;
  paymentId: string | null;
  amountCents: number;
  status: "requested" | "pending" | "succeeded" | "failed";
  providerRefundId: string | null;
}

/**
 * Record a successful provider refund; settles booking/payment status.
 * Idempotent per refund row. bookings.refunded_cents is capped at the amount
 * actually paid: money can never be refunded twice at the provider, so a sum
 * above it can only be a bookkeeping double count (logged for review).
 */
export async function applyRefundSucceeded(tx: Tx, refund: RefundRow, providerRefundId: string | null) {
  const [updated] = await tx<{ id: string }[]>`
    update public.refunds set status = 'succeeded', provider_refund_id = coalesce(provider_refund_id, ${providerRefundId}), last_error = null
    where id = ${refund.id} and status <> 'succeeded' returning id`;
  if (!updated) return;
  const before = await refundBalance(tx, refund.bookingId);
  const target = Math.min(before.refundedCents + refund.amountCents, Math.max(before.paidCents, before.refundedCents));
  if (target < before.refundedCents + refund.amountCents) {
    log.warn("refund.capped_at_paid", { refundId: refund.id, bookingId: refund.bookingId, amountCents: refund.amountCents, paidCents: before.paidCents });
  }
  const [b] = await tx<{ status: string; refundedCents: number }[]>`
    update public.bookings set refunded_cents = ${target} where id = ${refund.bookingId} returning status, refunded_cents`;
  const balance = await refundBalance(tx, refund.bookingId);
  if (refund.paymentId) {
    await tx`
      update public.payments p set status = case
        when (select coalesce(sum(r.amount_cents), 0) from public.refunds r where r.payment_id = p.id and r.status = 'succeeded') >= p.amount_cents
          then 'refunded' else 'partially_refunded' end
      where p.id = ${refund.paymentId}`;
  }
  const fullyRefunded = b.refundedCents >= balance.paidCents;
  if (balance.outstandingCents === 0) {
    if (b.status === "refund_pending") {
      // refund_pending → refunded (whole amount) or cancelled (partial refund per policy)
      await tx`update public.bookings set status = ${fullyRefunded ? "refunded" : "cancelled"} where id = ${refund.bookingId}`;
    } else if (b.status === "needs_attention" && fullyRefunded) {
      await tx`update public.bookings set status = 'refunded' where id = ${refund.bookingId}`;
    }
  }
}

/** Job: send one refund to the provider. */
export async function processRefundJob(refundId: string): Promise<JobOutcome> {
  const prep = await withSystem(async (tx) => {
    const [r] = await tx<(RefundRow & { provider: string | null; providerPaymentId: string | null; bookingPi: string | null; bookingProvider: string })[]>`
      select r.id, r.booking_id, r.payment_id, r.amount_cents, r.status, r.provider_refund_id,
             p.provider, p.provider_payment_id, b.payment_intent_id as booking_pi, b.payment_provider as booking_provider
      from public.refunds r
      join public.bookings b on b.id = r.booking_id
      left join public.payments p on p.id = r.payment_id
      where r.id = ${refundId}
      for update of r`;
    if (!r) return { skip: "refund not found" as const };
    if (r.status === "succeeded") return { skip: "already succeeded" as const };
    if (r.status === "pending" && r.providerRefundId) return { skip: "awaiting provider confirmation" as const };
    await tx`update public.refunds set status = 'pending', last_error = null where id = ${r.id}`;
    return { refund: r };
  });
  if ("skip" in prep) return { outcome: "noop", note: prep.skip };
  const r = prep.refund;
  const provider = getPaymentProviderByName(r.provider ?? r.bookingProvider);
  const paymentIntentId = r.providerPaymentId ?? r.bookingPi;
  const started = Date.now();
  try {
    if (!paymentIntentId) throw new Error("No captured payment to refund");
    const result = await provider.refund({ paymentIntentId, amountCents: r.amountCents, idempotencyKey: `refund:${r.id}` });
    if (result.status === "failed") throw new Error("Provider reported the refund as failed");
    await withSystem(async (tx) => {
      // Booking first, then the refund row: the same order as charge.refunded
      // processing and staff refunds, so they serialize instead of deadlocking.
      await tx`select id from public.bookings where id = ${r.bookingId} for update`;
      const [locked] = await tx<RefundRow[]>`
        select id, booking_id, payment_id, amount_cents, status, provider_refund_id from public.refunds where id = ${r.id} for update`;
      if (!locked || locked.status === "succeeded") return;
      if (result.status === "succeeded") await applyRefundSucceeded(tx, locked, result.refundId);
      else await tx`update public.refunds set status = 'pending', provider_refund_id = ${result.refundId} where id = ${r.id}`;
    });
    await recordIntegrationEvent({
      providerKind: "payments",
      providerKey: provider.name,
      operation: "refund",
      outcome: provider.simulated ? "simulated" : "success",
      entityType: "refund",
      entityId: r.id,
      durationMs: Date.now() - started,
    });
    return { outcome: "done", note: result.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withSystem(
      (tx) => tx`update public.refunds set status = 'failed', last_error = ${message.slice(0, 1000)} where id = ${r.id} and status <> 'succeeded'`,
    );
    await recordIntegrationEvent({
      providerKind: "payments",
      providerKey: provider.name,
      operation: "refund",
      outcome: "failure",
      entityType: "refund",
      entityId: r.id,
      error: message,
      durationMs: Date.now() - started,
    });
    log.warn("refund.failed", { refundId: r.id, error: message });
    throw err;
  }
}
