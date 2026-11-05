import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import { withSystem } from "@/server/db";
import { cancelQueuedJobs, enqueueJob } from "@/server/jobs/queue";
import { recordAudit } from "@/server/audit";
import { log } from "@/server/log";
import { getPaymentProviderByName } from "@/integrations/payments";
import { cancelOneFulfillment } from "@/server/fulfillment/cancel";
import { cancelBookingCore, lockBookingForCancel } from "./cancellation";
import { refundBalance, requestRefund } from "./refunds";

/**
 * CROSS-SLICE CONTRACT — implemented by the commerce slice, called by the
 * admin slice. Each function must: check the actor's permission (rbac.can),
 * perform the change in a system transaction with row locks, write an audit
 * log entry, and be idempotent (repeat calls do not double-refund).
 */
export type StaffActionResult = { ok: true; message?: string } | { ok: false; error: string };

const uuid = z.uuid();
const reasonSchema = z.string().trim().min(3, "Give a short reason (at least 3 characters).").max(500);

const actorOf = (u: SessionUser) => ({ id: u.id, roles: u.roles });

/**
 * Cancel a booking on behalf of the business (e.g. closure, partner issue).
 * Operator-initiated cancellations refund everything still refundable,
 * regardless of the customer policy window. Pending checkouts are expired
 * (no money was taken). Idempotent: an already-cancelled booking is a no-op.
 */
export async function staffCancelBooking(actor: SessionUser, bookingId: string, reason: string): Promise<StaffActionResult> {
  if (!can(actor.roles, "bookings.cancel")) return { ok: false, error: "You do not have permission to cancel bookings." };
  if (!uuid.safeParse(bookingId).success) return { ok: false, error: "Booking not found." };
  const r = reasonSchema.safeParse(reason);
  if (!r.success) return { ok: false, error: r.error.issues[0].message };

  let expireSession: { provider: string; sessionId: string } | null = null;
  const result = await withSystem(async (tx): Promise<StaffActionResult> => {
    const b = await lockBookingForCancel(tx, { bookingId });
    if (!b) return { ok: false, error: "Booking not found." };
    if (b.status === "cancelled" || b.status === "refund_pending" || b.status === "refunded") {
      return { ok: true, message: "Booking was already cancelled; nothing changed." };
    }
    if (b.status === "pending_payment") {
      await tx`update public.bookings set status = 'expired', cancellation_reason = ${r.data} where id = ${b.id} and status = 'pending_payment'`;
      await recordAudit(tx, actorOf(actor), "booking.staff_cancelled", "booking", b.id, { from: b.status, to: "expired", reason: r.data });
      if (b.checkoutSessionId) expireSession = { provider: b.paymentProvider, sessionId: b.checkoutSessionId };
      return { ok: true, message: "Pending checkout cancelled; the hold was released and nothing was charged." };
    }
    if (b.status === "expired" || b.status === "payment_failed") return { ok: true, message: "Booking was never paid; nothing to cancel." };
    const balance = await refundBalance(tx, b.id);
    const res = await cancelBookingCore(tx, b, {
      refundCents: balance.availableCents,
      reason: `Cancelled by staff: ${r.data}`,
      requestedBy: actor.id,
      actor: actorOf(actor),
      auditAction: "booking.staff_cancelled",
      meta: { reason: r.data },
    });
    return {
      ok: true,
      message: balance.availableCents > 0 ? `Booking cancelled; refund of ${balance.availableCents} cents requested.` : `Booking ${res.status}.`,
    };
  });
  if (expireSession) {
    const s = expireSession as { provider: string; sessionId: string };
    try {
      await getPaymentProviderByName(s.provider).expireSession?.(s.sessionId);
    } catch (err) {
      log.warn("staff.expire_session_failed", { bookingId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** Refund part or all of a confirmed booking's captured payment. */
export async function staffRefundBooking(
  actor: SessionUser,
  bookingId: string,
  amountCents: number,
  reason: string,
): Promise<StaffActionResult> {
  if (!can(actor.roles, "bookings.refund")) return { ok: false, error: "You do not have permission to issue refunds." };
  if (!uuid.safeParse(bookingId).success) return { ok: false, error: "Booking not found." };
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, error: "Refund amount must be a positive whole number of cents." };
  const r = reasonSchema.safeParse(reason);
  if (!r.success) return { ok: false, error: r.error.issues[0].message };

  return withSystem(async (tx): Promise<StaffActionResult> => {
    const [b] = await tx<{ id: string; status: string }[]>`select id, status from public.bookings where id = ${bookingId} for update`;
    if (!b) return { ok: false, error: "Booking not found." };
    const balance = await refundBalance(tx, b.id);
    if (balance.paidCents <= 0) return { ok: false, error: "This booking has no captured payment to refund." };
    if (amountCents > balance.availableCents) {
      return {
        ok: false,
        error: `Refund exceeds the refundable balance (${balance.availableCents} cents available of ${balance.paidCents} paid; ${balance.refundedCents} refunded, ${balance.outstandingCents} in progress).`,
      };
    }
    const { refundId } = await requestRefund(tx, { bookingId: b.id, amountCents, reason: `Staff refund: ${r.data}`, requestedBy: actor.id });
    await recordAudit(tx, actorOf(actor), "booking.staff_refund", "booking", b.id, { refundId, amountCents, reason: r.data, bookingStatus: b.status });
    return { ok: true, message: `Refund of ${amountCents} cents requested.` };
  });
}

/** Re-run a failed / needs_attention partner fulfillment. */
export async function staffRetryFulfillment(actor: SessionUser, fulfillmentId: string): Promise<StaffActionResult> {
  if (!can(actor.roles, "fulfillment.manage")) return { ok: false, error: "You do not have permission to manage fulfillment." };
  if (!uuid.safeParse(fulfillmentId).success) return { ok: false, error: "Fulfillment not found." };
  return withSystem(async (tx): Promise<StaffActionResult> => {
    const [f] = await tx<{ id: string; status: string; providerKind: string; bookingStatus: string; srStatus: string | null; customerConfirmedAt: Date | null; srId: string | null }[]>`
      select f.id, f.status, f.provider_kind, b.status as booking_status, sr.status as sr_status, sr.customer_confirmed_at, sr.id as sr_id
      from public.fulfillments f join public.bookings b on b.id = f.booking_id
      left join public.shuttle_requests sr on sr.fulfillment_id = f.id
      where f.id = ${fulfillmentId}
      for update of f`;
    if (!f) return { ok: false, error: "Fulfillment not found." };
    if (["pending", "requested"].includes(f.status)) return { ok: true, message: "Already queued; nothing changed." };
    if (!["failed", "needs_attention"].includes(f.status)) return { ok: false, error: `Only failed or needs-attention fulfillments can be retried (status: ${f.status}).` };
    if (f.bookingStatus !== "confirmed") return { ok: false, error: "The booking is not confirmed, so the fulfillment cannot be retried." };
    const token = randomUUID();
    if (f.providerKind === "shuttle" && f.customerConfirmedAt && f.srStatus === "confirmed") {
      // The customer already confirmed this quote: retry only the ride request.
      await tx`update public.fulfillments set status = 'requested', last_error = null where id = ${f.id}`;
      await enqueueJob(tx, "shuttle.request_ride", { fulfillmentId: f.id }, { dedupKey: `shuttle:${f.id}:ride:${f.srId}:retry:${token}`, maxAttempts: 3 });
    } else {
      await tx`update public.fulfillments set status = 'pending', attempts = 0, last_error = null where id = ${f.id}`;
      await enqueueJob(tx, "fulfillment.process", { fulfillmentId: f.id }, { dedupKey: `fulfill:${f.id}:retry:${token}`, maxAttempts: 5 });
    }
    await recordAudit(tx, actorOf(actor), "fulfillment.staff_retry", "fulfillment", f.id, { from: f.status });
    return { ok: true, message: "Retry queued." };
  });
}

const settableStatus = z.enum(["confirmed", "completed", "cancelled", "failed"]);

/** Manually set a fulfillment's status (e.g. confirmed by phone with the partner). */
export async function staffSetFulfillmentStatus(
  actor: SessionUser,
  fulfillmentId: string,
  status: "confirmed" | "completed" | "cancelled" | "failed",
  note: string,
): Promise<StaffActionResult> {
  if (!can(actor.roles, "fulfillment.manage")) return { ok: false, error: "You do not have permission to manage fulfillment." };
  if (!uuid.safeParse(fulfillmentId).success) return { ok: false, error: "Fulfillment not found." };
  const s = settableStatus.safeParse(status);
  if (!s.success) return { ok: false, error: "Unsupported status." };
  const n = reasonSchema.safeParse(note);
  if (!n.success) return { ok: false, error: n.error.issues[0].message };

  return withSystem(async (tx): Promise<StaffActionResult> => {
    const [f] = await tx<{ id: string; status: string; providerKind: string; providerKey: string; externalRef: string | null }[]>`
      select id, status, provider_kind, provider_key, external_ref from public.fulfillments where id = ${fulfillmentId} for update`;
    if (!f) return { ok: false, error: "Fulfillment not found." };
    if (f.status === s.data) return { ok: true, message: "Status unchanged." };
    if (f.status === "cancelled") return { ok: false, error: "Cancelled fulfillments cannot be changed." };
    if (s.data === "cancelled") {
      await cancelOneFulfillment(tx, f);
    } else {
      await tx`
        update public.fulfillments set status = ${s.data}, last_error = ${s.data === "failed" ? `Set by staff: ${n.data}` : null}
        where id = ${f.id}`;
      // A manual decision supersedes any queued automatic attempt.
      await cancelQueuedJobs(tx, `fulfill:${f.id}`);
    }
    await recordAudit(tx, actorOf(actor), "fulfillment.staff_set_status", "fulfillment", f.id, { from: f.status, to: s.data, note: n.data });
    return { ok: true, message: `Fulfillment marked ${s.data}.` };
  });
}
