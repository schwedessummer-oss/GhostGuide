import "server-only";
import { z } from "zod";
import { withUser, type Tx } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import type { BookingStatus, FulfillmentStatus } from "@/domain/types";
import type { AddonKind, StoredPriceBreakdown } from "@/domain/booking";
import { holdIsValid } from "@/domain/booking";
import { revealAccessCodes } from "@/server/fulfillment/access-codes";

/**
 * Customer read model for bookings, receipts and fulfillment. All queries
 * run as the customer (RLS) AND filter on user_id, so another customer's
 * booking simply does not exist (callers respond 404).
 */
export interface BookingSummary {
  id: string;
  tripId: string;
  status: BookingStatus;
  hikeDate: string;
  partySize: number;
  currency: string;
  subtotalCents: number;
  addonsCents: number;
  totalCents: number;
  refundedCents: number;
  priceBreakdown: Partial<StoredPriceBreakdown>;
  paymentProvider: string;
  checkoutSessionId: string | null;
  holdExpiresAt: Date | null;
  paidAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  receiptNumber: string | null;
  createdAt: Date;
}

const isUuid = (s: string) => z.uuid().safeParse(s).success;

const BOOKING_COLS = (tx: Tx) => tx`b.id, b.trip_id, b.status, to_char(b.hike_date, 'YYYY-MM-DD') as hike_date, b.party_size, b.currency,
  b.subtotal_cents, b.addons_cents, b.total_cents, b.refunded_cents, b.price_breakdown, b.payment_provider, b.checkout_session_id,
  b.hold_expires_at, b.paid_at, b.cancelled_at, b.cancellation_reason, b.receipt_number, b.created_at`;

export interface FulfillmentView {
  id: string;
  kind: AddonKind;
  status: FulfillmentStatus;
  addonName: string;
  quantity: number;
  details: Record<string, unknown>;
  attempts: number;
  shuttle: { status: string; quoteExpiresAt: Date | null; quoteExpired: boolean; customerConfirmedAt: Date | null; pickupAt: Date | null } | null;
  /** owner-only: derived locker access code */
  accessCode: string | null;
  simulated: boolean;
}

export interface RefundView {
  id: string;
  amountCents: number;
  status: "requested" | "pending" | "succeeded" | "failed";
  reason: string;
  createdAt: Date;
}

export interface PaymentView {
  id: string;
  provider: string;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: Date;
}

export interface TripBookingView {
  booking: BookingSummary;
  fulfillments: FulfillmentView[];
  refunds: RefundView[];
  payments: PaymentView[];
  holdValid: boolean;
}

/** Latest booking for a trip (live one preferred) with fulfillments; null if none. */
export async function getTripBookingView(user: SessionUser, tripId: string): Promise<TripBookingView | null> {
  if (!isUuid(tripId)) return null;
  const view = await withUser(user, async (tx) => {
    const [booking] = await tx<BookingSummary[]>`
      select ${BOOKING_COLS(tx)} from public.bookings b
      where b.trip_id = ${tripId} and b.user_id = ${user.id}
      order by (b.status in ('pending_payment', 'confirmed', 'cancellation_requested', 'refund_pending', 'needs_attention')) desc, b.created_at desc
      limit 1`;
    if (!booking) return null;
    const [fulfillments, refunds, payments] = await Promise.all([
      tx<(Omit<FulfillmentView, "accessCode" | "simulated" | "shuttle"> & { providerKey: string; srStatus: string | null; quoteExpiresAt: Date | null; customerConfirmedAt: Date | null; pickupAt: Date | null })[]>`
        select f.id, f.provider_kind as kind, f.status, coalesce(a.name, initcap(replace(f.provider_kind, '_', ' '))) as addon_name,
               ba.quantity, f.details, f.attempts, f.provider_key,
               sr.status as sr_status, sr.quote_expires_at, sr.customer_confirmed_at, sr.pickup_at
        from public.fulfillments f
        join public.booking_addons ba on ba.id = f.booking_addon_id
        left join public.addons a on a.id = ba.addon_id -- add-ons retired later are hidden by RLS; keep the row
        left join public.shuttle_requests sr on sr.fulfillment_id = f.id
        where f.booking_id = ${booking.id}
        order by f.provider_kind`,
      tx<RefundView[]>`select id, amount_cents, status, reason, created_at from public.refunds where booking_id = ${booking.id} order by created_at`,
      tx<PaymentView[]>`select id, provider, amount_cents, currency, status, created_at from public.payments where booking_id = ${booking.id} order by created_at`,
    ]);
    return { booking, fulfillments, refunds, payments };
  });
  if (!view) return null;
  const codes = view.booking.status === "confirmed" ? await revealAccessCodes(user, view.booking.id) : {};
  return {
    booking: view.booking,
    refunds: view.refunds,
    payments: view.payments,
    holdValid: view.booking.status === "pending_payment" && holdIsValid(view.booking.holdExpiresAt, new Date()),
    fulfillments: view.fulfillments.map(({ providerKey, srStatus, quoteExpiresAt, customerConfirmedAt, pickupAt, ...f }) => ({
      ...f,
      shuttle: srStatus
        ? { status: srStatus, quoteExpiresAt, quoteExpired: !!quoteExpiresAt && new Date(quoteExpiresAt).getTime() <= Date.now(), customerConfirmedAt, pickupAt }
        : null,
      accessCode: codes[f.id] ?? null,
      simulated: providerKey === "demo",
    })),
  };
}

/** Booked-status summary per trip for the My Trips list. */
export async function listTripBookingSummaries(
  user: SessionUser,
): Promise<Record<string, { bookingId: string; status: BookingStatus; holdValid: boolean; awaitingShuttleFulfillmentId: string | null; receiptNumber: string | null }>> {
  const rows = await withUser(
    user,
    (tx) => tx<{ id: string; tripId: string; status: BookingStatus; holdExpiresAt: Date | null; receiptNumber: string | null; awaitingShuttle: string | null }[]>`
      select distinct on (b.trip_id) b.id, b.trip_id, b.status, b.hold_expires_at, b.receipt_number,
        (select f.id::text from public.fulfillments f where f.booking_id = b.id and f.provider_kind = 'shuttle' and f.status = 'awaiting_customer' limit 1) as awaiting_shuttle
      from public.bookings b
      where b.user_id = ${user.id}
      order by b.trip_id, (b.status in ('pending_payment', 'confirmed', 'cancellation_requested', 'refund_pending', 'needs_attention')) desc, b.created_at desc`,
  );
  const now = new Date();
  return Object.fromEntries(
    rows.map((r) => [
      r.tripId,
      {
        bookingId: r.id,
        status: r.status,
        holdValid: r.status === "pending_payment" && holdIsValid(r.holdExpiresAt, now),
        awaitingShuttleFulfillmentId: r.awaitingShuttle,
        receiptNumber: r.receiptNumber,
      },
    ]),
  );
}

export interface OwnedBooking extends BookingSummary {
  trailName: string;
  trailIsDemo: boolean;
  timezone: string;
}

/** A booking the user owns, or null (404) — by id. */
export async function getOwnedBooking(user: SessionUser, bookingId: string): Promise<OwnedBooking | null> {
  if (!isUuid(bookingId)) return null;
  const [b] = await withUser(
    user,
    (tx) => tx<OwnedBooking[]>`
      select ${BOOKING_COLS(tx)}, t.name as trail_name, t.is_demo as trail_is_demo, r.timezone
      from public.bookings b join public.trails t on t.id = b.trail_id join public.regions r on r.id = t.region_id
      where b.id = ${bookingId} and b.user_id = ${user.id}`,
  );
  return b ?? null;
}

export interface Receipt {
  booking: OwnedBooking;
  addons: { name: string; quantity: number; unitPriceCents: number; totalCents: number }[];
  payments: PaymentView[];
  refunds: RefundView[];
  customerName: string | null;
  customerEmail: string;
}

/** Receipt for a PAID booking the user owns; null otherwise. */
export async function getReceipt(user: SessionUser, bookingId: string): Promise<Receipt | null> {
  const booking = await getOwnedBooking(user, bookingId);
  if (!booking || !booking.paidAt) return null;
  return withUser(user, async (tx) => {
    const [addons, payments, refunds, profile] = await Promise.all([
      tx<Receipt["addons"]>`
        select coalesce(a.name, 'Add-on') as name, ba.quantity, ba.unit_price_cents, ba.total_cents
        from public.booking_addons ba left join public.addons a on a.id = ba.addon_id where ba.booking_id = ${booking.id} order by 1`,
      tx<PaymentView[]>`select id, provider, amount_cents, currency, status, created_at from public.payments where booking_id = ${booking.id} order by created_at`,
      tx<RefundView[]>`select id, amount_cents, status, reason, created_at from public.refunds where booking_id = ${booking.id} order by created_at`,
      tx<{ fullName: string | null }[]>`select full_name from public.profiles where id = ${user.id}`,
    ]);
    return { booking, addons, payments, refunds, customerName: profile[0]?.fullName ?? null, customerEmail: user.email };
  });
}
