import "server-only";
import { withSystem, type Tx } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { cancelQueuedJobs } from "@/server/jobs/queue";
import { recordAudit, type AuditActor } from "@/server/audit";
import { getOwnedTrip } from "@/server/trips/queries";
import { getRegionById } from "@/server/catalog/trails";
import {
  assertTransition,
  computeCancellationRefund,
  describeCancellationPolicy,
  type CancellationPolicy,
  type RefundComputation,
} from "@/domain/booking";
import type { BookingStatus, TripStatus } from "@/domain/types";
import { zonedTimeToUtc } from "@/lib/time";
import { cancelFulfillmentsForBooking } from "@/server/fulfillment/cancel";
import { getCommerceSettings } from "./settings";
import { refundBalance, requestRefund } from "./refunds";
import { tripStartTime } from "./checkout";

/**
 * Cancellation. Customers cancel a TRIP (with or without a booking); the
 * refund follows app_settings.cancellation_policy measured against the hike
 * start instant (planned date + start time in the region's time zone).
 * Cancelling is idempotent: a second request is a no-op.
 */
export interface CancelBookingRow {
  id: string;
  userId: string;
  tripId: string;
  status: BookingStatus;
  hikeDate: string;
  totalCents: number;
  currency: string;
  refundedCents: number;
  paymentProvider: string;
  checkoutSessionId: string | null;
  startTime: string | null;
}

export async function lockBookingForCancel(tx: Tx, where: { bookingId?: string; tripId?: string }): Promise<CancelBookingRow | null> {
  const cols = tx`b.id, b.user_id, b.trip_id, b.status, to_char(b.hike_date, 'YYYY-MM-DD') as hike_date, b.total_cents, b.currency,
                  b.refunded_cents, b.payment_provider, b.checkout_session_id,
                  coalesce(to_char(tr.start_time, 'HH24:MI'), b.price_breakdown ->> 'startTime') as start_time`;
  const rows = where.bookingId
    ? await tx<CancelBookingRow[]>`
        select ${cols} from public.bookings b join public.trips tr on tr.id = b.trip_id where b.id = ${where.bookingId} for update of b`
    : await tx<CancelBookingRow[]>`
        select ${cols} from public.bookings b join public.trips tr on tr.id = b.trip_id
        where b.trip_id = ${where.tripId!}
          and b.status in ('pending_payment', 'confirmed', 'cancellation_requested', 'refund_pending', 'needs_attention')
        for update of b`;
  return rows[0] ?? null;
}

/**
 * Shared cancellation core (customer and staff). Caller holds the booking
 * lock and has authorized the actor. Cancels fulfillments + their queued
 * jobs, requests the refund (job `refund:<id>`), and cancels the trip.
 */
export async function cancelBookingCore(
  tx: Tx,
  b: CancelBookingRow,
  opts: { refundCents: number; reason: string; requestedBy: string | null; actor: AuditActor; auditAction: string; meta?: Record<string, unknown> },
): Promise<{ status: BookingStatus; refundId: string | null }> {
  const to: BookingStatus = opts.refundCents > 0 ? "refund_pending" : "cancelled";
  assertTransition(b.status, to);
  await tx`
    update public.bookings set status = ${to}, cancelled_at = now(), cancellation_reason = ${opts.reason.slice(0, 500)}
    where id = ${b.id}`;
  let refundId: string | null = null;
  if (opts.refundCents > 0) {
    ({ refundId } = await requestRefund(tx, { bookingId: b.id, amountCents: opts.refundCents, reason: opts.reason, requestedBy: opts.requestedBy }));
  }
  const fulfillments = await cancelFulfillmentsForBooking(tx, b.id);
  await cancelQueuedJobs(tx, `booking:${b.id}:`);
  // Queued check-in reminders for this trip are obsolete (dedup convention
  // checkin:<checkinId>:v<version>:<step>); the safety slice owns the check-in row itself.
  const checkins = await tx<{ id: string }[]>`select id from public.trip_checkins where trip_id = ${b.tripId}`;
  for (const c of checkins) await cancelQueuedJobs(tx, `checkin:${c.id}:`);
  await tx`update public.trips set status = 'cancelled' where id = ${b.tripId} and status in ('saved', 'booked')`;
  await recordAudit(tx, opts.actor, opts.auditAction, "booking", b.id, {
    from: b.status,
    to,
    refundCents: opts.refundCents,
    fulfillmentsCancelled: fulfillments,
    ...(opts.meta ?? {}),
  });
  return { status: to, refundId };
}

export interface CancellationPreview {
  tripId: string;
  tripStatus: TripStatus;
  trailName: string;
  trailIsDemo: boolean;
  canCancel: boolean;
  blockedReason: string | null;
  booking: { id: string; status: BookingStatus; totalCents: number; currency: string; paidCents: number; refundedCents: number } | null;
  policy: CancellationPolicy;
  policyLines: string[];
  hikeStart: Date | null;
  timezone: string;
  refund: RefundComputation | null;
  openAddons: { kind: string; status: string }[];
}

async function hikeStartFor(regionId: string, hikeDate: string | null, startTime: string | null) {
  const region = await getRegionById(regionId);
  const tz = region?.timezone ?? "UTC";
  return { tz, start: hikeDate ? zonedTimeToUtc(hikeDate, (startTime ?? "08:00").slice(0, 5), tz) : null };
}

export async function getCancellationPreview(user: SessionUser, tripId: string, now = new Date()): Promise<CancellationPreview | null> {
  const trip = await getOwnedTrip(user, tripId);
  if (!trip) return null;
  const { policy } = await getCommerceSettings();
  const base = {
    tripId: trip.id,
    tripStatus: trip.status,
    trailName: trip.trailName,
    trailIsDemo: trip.trailIsDemo,
    policy,
    policyLines: describeCancellationPolicy(policy),
  };
  const data = await withSystem(async (tx) => {
    const [b] = await tx<(CancelBookingRow & { paidAt: Date | null })[]>`
      select b.id, b.status, to_char(b.hike_date, 'YYYY-MM-DD') as hike_date, b.total_cents, b.currency, b.refunded_cents, b.paid_at
      from public.bookings b
      where b.trip_id = ${trip.id} and b.user_id = ${user.id}
        and b.status in ('pending_payment', 'confirmed', 'cancellation_requested', 'refund_pending', 'needs_attention')`;
    if (!b) return null;
    const balance = await refundBalance(tx, b.id);
    const addons = await tx<{ kind: string; status: string }[]>`
      select provider_kind as kind, status from public.fulfillments where booking_id = ${b.id} and status not in ('cancelled', 'completed')`;
    return { b, balance, addons };
  });
  const startTime = tripStartTime(trip);
  const { tz, start } = await hikeStartFor(trip.regionId, data?.b.hikeDate ?? trip.plannedDate, startTime);
  let blockedReason: string | null = null;
  if (trip.status === "cancelled") blockedReason = "This trip is already cancelled.";
  else if (trip.status === "active") blockedReason = "Your hike is in progress, so it can't be cancelled here. Finish or end the hike from the trip page.";
  else if (trip.status === "completed") blockedReason = "This trip is already completed.";
  else if (data?.b.status === "pending_payment") blockedReason = "A checkout is in progress for this trip. Finish paying or let the hold expire before cancelling.";
  else if (data?.b.status === "needs_attention") blockedReason = "Our team is reviewing this booking. Please contact support to cancel it.";
  else if (data && data.b.status !== "confirmed") blockedReason = "This booking is already being cancelled.";

  const refund =
    data && start
      ? computeCancellationRefund({
          paidCents: data.balance.paidCents,
          alreadyRefundedCents: data.balance.refundedCents + data.balance.outstandingCents,
          hikeStart: start,
          now,
          policy,
        })
      : null;
  return {
    ...base,
    canCancel: !blockedReason,
    blockedReason,
    booking: data
      ? { id: data.b.id, status: data.b.status, totalCents: data.b.totalCents, currency: data.b.currency, paidCents: data.balance.paidCents, refundedCents: data.balance.refundedCents }
      : null,
    hikeStart: start,
    timezone: tz,
    refund,
    openAddons: data?.addons ?? [],
  };
}

export type CustomerCancelResult =
  | { ok: true; alreadyCancelled: boolean; refundCents: number; bookingStatus: BookingStatus | null }
  | { ok: false; code: "not_found" | "not_allowed"; error: string };

export async function cancelTripByCustomer(user: SessionUser, tripId: string, now = new Date()): Promise<CustomerCancelResult> {
  const trip = await getOwnedTrip(user, tripId);
  if (!trip) return { ok: false, code: "not_found", error: "Trip not found." };
  const { policy } = await getCommerceSettings();
  const region = await getRegionById(trip.regionId);
  const tz = region?.timezone ?? "UTC";
  const startTime = tripStartTime(trip);

  return withSystem(async (tx): Promise<CustomerCancelResult> => {
    const [t] = await tx<{ status: TripStatus }[]>`select status from public.trips where id = ${trip.id} and user_id = ${user.id} for update`;
    if (!t) return { ok: false, code: "not_found", error: "Trip not found." };
    if (t.status === "cancelled") return { ok: true, alreadyCancelled: true, refundCents: 0, bookingStatus: null };
    if (t.status === "active" || t.status === "completed") {
      return { ok: false, code: "not_allowed", error: t.status === "active" ? "Your hike is in progress and can't be cancelled." : "This trip is already completed." };
    }
    const b = await lockBookingForCancel(tx, { tripId: trip.id });
    const actor = { id: user.id, roles: user.roles };
    if (!b) {
      await tx`update public.trips set status = 'cancelled' where id = ${trip.id} and status in ('saved', 'booked')`;
      await recordAudit(tx, actor, "trip.cancelled_by_customer", "trip", trip.id, { booking: null });
      return { ok: true, alreadyCancelled: false, refundCents: 0, bookingStatus: null };
    }
    if (b.userId !== user.id) return { ok: false, code: "not_found", error: "Trip not found." };
    if (b.status === "pending_payment") return { ok: false, code: "not_allowed", error: "A checkout is in progress. Finish paying or let the hold expire first." };
    if (b.status === "needs_attention") return { ok: false, code: "not_allowed", error: "Our team is reviewing this booking. Please contact support to cancel it." };
    if (b.status !== "confirmed") return { ok: true, alreadyCancelled: true, refundCents: 0, bookingStatus: b.status };

    const balance = await refundBalance(tx, b.id);
    const hikeStart = zonedTimeToUtc(b.hikeDate, (b.startTime ?? startTime).slice(0, 5), tz);
    const refund = computeCancellationRefund({
      paidCents: balance.paidCents,
      alreadyRefundedCents: balance.refundedCents + balance.outstandingCents,
      hikeStart,
      now,
      policy,
    });
    const res = await cancelBookingCore(tx, b, {
      refundCents: refund.refundCents,
      reason: `Cancelled by customer (${refund.tier === "full" ? "full refund" : refund.tier === "partial" ? `${refund.pct}% refund` : "no refund"} per policy)`,
      requestedBy: user.id,
      actor,
      auditAction: "booking.cancelled_by_customer",
      meta: { tier: refund.tier, hoursBeforeStart: Math.round(refund.hoursBeforeStart * 10) / 10 },
    });
    return { ok: true, alreadyCancelled: false, refundCents: refund.refundCents, bookingStatus: res.status };
  });
}
