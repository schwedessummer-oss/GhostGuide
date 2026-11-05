import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import type { BookingStatus } from "@/domain/types";
import { formatDateTime, formatMoney } from "@/lib/format";
import { assertCan, isUuid, isoDate, likePattern, staffTx, systemTx, type Page, type Paged } from "./common";

export const BOOKING_STATUSES = [
  "pending_payment",
  "confirmed",
  "cancellation_requested",
  "cancelled",
  "refund_pending",
  "refunded",
  "payment_failed",
  "expired",
  "needs_attention",
] as const satisfies readonly BookingStatus[];

export interface BookingListRow {
  id: string;
  status: BookingStatus;
  hikeDate: string;
  partySize: number;
  totalCents: number;
  refundedCents: number;
  currency: string;
  paymentProvider: string;
  trailName: string;
  customerEmail: string | null;
  holdExpiresAt: Date | null;
  createdAt: Date;
}

export interface BookingFilters {
  status?: string;
  from?: string;
  to?: string;
  trailId?: string;
  q?: string;
}

export async function listBookings(user: SessionUser, f: BookingFilters, page: Page): Promise<Paged<BookingListRow>> {
  assertCan(user, "bookings.view");
  const status = z.enum(BOOKING_STATUSES).safeParse(f.status).data ?? null;
  const from = isoDate.safeParse(f.from).data ?? null;
  const to = isoDate.safeParse(f.to).data ?? null;
  const trailId = f.trailId && isUuid(f.trailId) ? f.trailId : null;
  const q = f.q?.trim().slice(0, 120) || null;
  const qId = q && isUuid(q) ? q : null;
  const rows = await staffTx(user, (tx) => tx<(BookingListRow & { total: number })[]>`
    select b.id, b.status, to_char(b.hike_date, 'YYYY-MM-DD') as hike_date, b.party_size, b.total_cents, b.refunded_cents, b.currency,
           b.payment_provider, t.name as trail_name, p.email as customer_email, b.hold_expires_at, b.created_at,
           count(*) over()::int as total
    from public.bookings b join public.trails t on t.id = b.trail_id left join public.profiles p on p.id = b.user_id
    where (${status}::public.booking_status is null or b.status = ${status}::public.booking_status)
      and (${from}::date is null or b.hike_date >= ${from}::date)
      and (${to}::date is null or b.hike_date <= ${to}::date)
      and (${trailId}::uuid is null or b.trail_id = ${trailId}::uuid)
      and (${q}::text is null or b.id = ${qId}::uuid or p.email ilike ${likePattern(q ?? "")} or b.receipt_number = ${q}
           or b.checkout_session_id = ${q})
    order by b.created_at desc
    limit ${page.limit} offset ${page.offset}`);
  return { rows, total: rows[0]?.total ?? 0, ...page };
}

export interface BookingDetail {
  booking: BookingListRow & {
    userId: string;
    tripId: string;
    subtotalCents: number;
    addonsCents: number;
    priceBreakdown: { lines?: { kind?: string; label?: string; amountCents?: number }[]; occupancy?: number; startTime?: string; timezone?: string };
    checkoutSessionId: string | null;
    paymentIntentId: string | null;
    paidAt: Date | null;
    cancelledAt: Date | null;
    cancellationReason: string | null;
    receiptNumber: string | null;
    updatedAt: Date;
  };
  addons: { id: string; name: string; kind: string; quantity: number; unitPriceCents: number; totalCents: number }[];
  payments: { id: string; provider: string; providerPaymentId: string; amountCents: number; currency: string; status: string; createdAt: Date }[] | null;
  refunds: { id: string; amountCents: number; reason: string; status: string; providerRefundId: string | null; lastError: string | null; createdAt: Date }[] | null;
  fulfillments: { id: string; providerKind: string; providerKey: string; status: string; externalRef: string | null; attempts: number; lastError: string | null; updatedAt: Date }[];
  webhookEvents: { id: string; provider: string; eventId: string; type: string; status: string; attempts: number; error: string | null; receivedAt: Date; processedAt: Date | null }[] | null;
  needsAttentionReason: string | null;
  hints: string[];
  holdMinutes: number | null;
}

export async function getBookingDetail(user: SessionUser, bookingId: string): Promise<BookingDetail | null> {
  assertCan(user, "bookings.view");
  if (!isUuid(bookingId)) return null;
  const canPayments = can(user.roles, "bookings.refund");
  const canWebhooks = can(user.roles, "integrations.view");
  const base = await staffTx(user, async (tx) => {
    const [booking] = await tx<BookingDetail["booking"][]>`
      select b.id, b.user_id, b.trip_id, b.status, to_char(b.hike_date, 'YYYY-MM-DD') as hike_date, b.party_size, b.subtotal_cents,
             b.addons_cents, b.total_cents, b.refunded_cents, b.currency, b.price_breakdown, b.payment_provider, b.checkout_session_id,
             b.payment_intent_id, b.hold_expires_at, b.paid_at, b.cancelled_at, b.cancellation_reason, b.receipt_number, b.created_at,
             b.updated_at, t.name as trail_name, p.email as customer_email
      from public.bookings b join public.trails t on t.id = b.trail_id left join public.profiles p on p.id = b.user_id
      where b.id = ${bookingId}`;
    if (!booking) return null;
    const [addons, payments, refunds, fulfillments] = await Promise.all([
      tx<BookingDetail["addons"]>`
        select ba.id, a.name, a.kind, ba.quantity, ba.unit_price_cents, ba.total_cents
        from public.booking_addons ba join public.addons a on a.id = ba.addon_id where ba.booking_id = ${bookingId}`,
      canPayments
        ? tx<NonNullable<BookingDetail["payments"]>>`
            select id, provider, provider_payment_id, amount_cents, currency, status, created_at from public.payments
            where booking_id = ${bookingId} order by created_at`
        : Promise.resolve(null),
      canPayments
        ? tx<NonNullable<BookingDetail["refunds"]>>`
            select id, amount_cents, reason, status, provider_refund_id, last_error, created_at from public.refunds
            where booking_id = ${bookingId} order by created_at`
        : Promise.resolve(null),
      tx<BookingDetail["fulfillments"]>`
        select id, provider_kind, provider_key, status, external_ref, attempts, last_error, updated_at from public.fulfillments
        where booking_id = ${bookingId} order by created_at`,
    ]);
    return { booking, addons, payments, refunds, fulfillments };
  });
  if (!base) return null;
  const b = base.booking;

  // Server-only tables, read narrowly after the permission checks above.
  const sys = await systemTx(async (tx) => {
    const webhookEvents = canWebhooks
      ? await tx<NonNullable<BookingDetail["webhookEvents"]>>`
          select id, provider, event_id, type, status, attempts, error, received_at, processed_at from public.webhook_events
          where position(${b.id} in payload::text) > 0
             or (${b.checkoutSessionId}::text is not null and position(${b.checkoutSessionId ?? ""} in payload::text) > 0)
          order by received_at desc limit 50`
      : null;
    const [na] = await tx<{ reason: string | null }[]>`
      select metadata ->> 'reason' as reason from public.audit_logs
      where entity_type = 'booking' and entity_id = ${b.id} and action = 'booking.needs_attention'
      order by created_at desc limit 1`;
    const [hold] = await tx<{ value: unknown }[]>`select value from public.app_settings where key = 'checkout_hold_minutes'`;
    return { webhookEvents, needsAttentionReason: na?.reason ?? null, holdMinutes: typeof hold?.value === "number" ? hold.value : null };
  });

  return { ...base, ...sys, hints: reconciliationHints(b, base.payments, base.refunds, sys.needsAttentionReason, sys.holdMinutes) };
}

export function reconciliationHints(
  b: Pick<BookingDetail["booking"], "status" | "holdExpiresAt" | "paidAt" | "createdAt" | "totalCents" | "currency" | "refundedCents">,
  payments: BookingDetail["payments"],
  refunds: BookingDetail["refunds"],
  needsAttentionReason: string | null,
  holdMinutes: number | null,
  now = new Date(),
): string[] {
  const hints: string[] = [];
  const holdExpired = b.holdExpiresAt && new Date(b.holdExpiresAt) < now;
  if (b.status === "pending_payment") {
    if (holdExpired) {
      hints.push(
        `Pending payment, but the inventory hold expired at ${formatDateTime(b.holdExpiresAt!)}${holdMinutes ? ` (hold length ${holdMinutes} min)` : ""}. ` +
          "The bookings.expire_holds job (every 5 min) should mark it expired; if it stays pending, check the job queue. " +
          "If the customer pays late and capacity is gone, the booking becomes needs-attention and is refunded automatically.",
      );
    } else if (b.holdExpiresAt) {
      hints.push(`Awaiting payment; capacity is held until ${formatDateTime(b.holdExpiresAt)}.`);
    }
    const ageH = (now.getTime() - new Date(b.createdAt).getTime()) / 3_600_000;
    if (ageH > 2) hints.push(`Checkout started ${Math.round(ageH)} h ago. payments.reconcile (hourly) compares it with the payment provider.`);
  }
  if (b.status === "needs_attention") {
    hints.push(`Needs attention${needsAttentionReason ? `: ${needsAttentionReason}` : ""}. Review the payment and capacity, then refund or contact the customer.`);
  }
  if (b.status === "payment_failed") hints.push("The payment failed. No money was captured; the customer can retry checkout.");
  if (payments) {
    const captured = payments.filter((p) => ["succeeded", "partially_refunded", "refunded"].includes(p.status)).reduce((s, p) => s + p.amountCents, 0);
    if (b.status === "confirmed" && captured === 0) hints.push("Confirmed but no captured payment is recorded. Check the webhook events below.");
    if (captured > 0 && captured !== b.totalCents) {
      hints.push(`Captured ${formatMoney(captured, b.currency)} differs from the booking total ${formatMoney(b.totalCents, b.currency)}.`);
    }
  }
  if (refunds) {
    const pending = refunds.filter((r) => r.status === "requested" || r.status === "pending");
    const failed = refunds.filter((r) => r.status === "failed");
    if (pending.length) hints.push(`${pending.length} refund(s) in progress. Refund status is confirmed by the provider webhook / reconcile job.`);
    if (failed.length) hints.push(`${failed.length} refund(s) failed: ${failed.map((r) => r.lastError ?? "no error recorded").join("; ")}.`);
  }
  if (b.status === "refund_pending") hints.push("Refund pending: the booking moves to refunded when the provider confirms the refund.");
  return hints;
}

/** Trail options for booking filters (any staff role can read the catalog). */
export async function bookingTrailOptions(user: SessionUser): Promise<{ id: string; name: string }[]> {
  assertCan(user, "bookings.view");
  return staffTx(user, (tx) => tx<{ id: string; name: string }[]>`select id, name from public.trails order by name`);
}
