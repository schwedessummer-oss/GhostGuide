import "server-only";
import type { SessionUser } from "@/server/auth";

/**
 * CROSS-SLICE CONTRACT — implemented by the commerce slice, called by the
 * admin slice. Each function must: check the actor's permission (rbac.can),
 * perform the change in a system transaction with row locks, write an audit
 * log entry, and be idempotent (repeat calls do not double-refund).
 */
export type StaffActionResult = { ok: true; message?: string } | { ok: false; error: string };

export async function staffCancelBooking(actor: SessionUser, bookingId: string, reason: string): Promise<StaffActionResult> {
  void actor;
  void bookingId;
  void reason;
  return { ok: false, error: "Not implemented" };
}

/** Refund part or all of a confirmed booking's captured payment. */
export async function staffRefundBooking(
  actor: SessionUser,
  bookingId: string,
  amountCents: number,
  reason: string,
): Promise<StaffActionResult> {
  void actor;
  void bookingId;
  void amountCents;
  void reason;
  return { ok: false, error: "Not implemented" };
}

/** Re-run a failed / needs_attention partner fulfillment. */
export async function staffRetryFulfillment(actor: SessionUser, fulfillmentId: string): Promise<StaffActionResult> {
  void actor;
  void fulfillmentId;
  return { ok: false, error: "Not implemented" };
}

/** Manually set a fulfillment's status (e.g. confirmed by phone with the partner). */
export async function staffSetFulfillmentStatus(
  actor: SessionUser,
  fulfillmentId: string,
  status: "confirmed" | "completed" | "cancelled" | "failed",
  note: string,
): Promise<StaffActionResult> {
  void actor;
  void fulfillmentId;
  void status;
  void note;
  return { ok: false, error: "Not implemented" };
}
