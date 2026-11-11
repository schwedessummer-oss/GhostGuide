/**
 * Booking domain logic: state machine, cancellation/refund policy, receipt
 * numbers, customer-facing status copy. Pure and deterministic (no I/O), so
 * it is safe on client and server and fully unit tested.
 */
import type { BookingStatus, Closure, FulfillmentStatus, Itinerary, TripPreferences, TripStatus } from "./types";
import type { Quote } from "./pricing";
import { buildItinerary, clockToMinutes, type ItineraryPoi, type ItineraryTrail } from "./itinerary";
import { closureOverlapsDay, DEFAULT_LATEST_FINISH_BY_MONTH, latestFinishFor, monthName } from "./recommendation";
import { addMinutesToClock, localDateInZone } from "@/lib/time";

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Allowed booking status transitions.
 *
 *  pending_payment → confirmed            signed webhook / reconciliation: paid, amount matches
 *  pending_payment → needs_attention      paid but amount mismatch, or paid after hold expired and capacity is gone
 *  pending_payment → payment_failed       provider reported failure (hold released)
 *  pending_payment → expired              hold expired / session expired without payment
 *  expired|payment_failed → confirmed     LATE payment captured; capacity still available
 *  expired|payment_failed → needs_attention LATE payment captured; capacity gone (auto refund)
 *  confirmed → cancellation_requested     reserved for partner-approval flows
 *  confirmed|cancellation_requested|needs_attention → refund_pending   cancelled with a refund due
 *  confirmed|cancellation_requested|needs_attention → cancelled        cancelled, nothing to refund
 *  refund_pending → refunded              refund(s) succeeded for the whole paid amount
 *  refund_pending → cancelled             partial refund succeeded (cancelled, partially refunded)
 *  needs_attention → confirmed            operator resolved the issue and honors the booking
 *  needs_attention → refunded             automatic / operator refund of the full amount succeeded
 */
export const BOOKING_TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  pending_payment: ["confirmed", "needs_attention", "payment_failed", "expired"],
  confirmed: ["cancellation_requested", "refund_pending", "cancelled"],
  cancellation_requested: ["confirmed", "refund_pending", "cancelled"],
  refund_pending: ["refunded", "cancelled"],
  needs_attention: ["confirmed", "refund_pending", "cancelled", "refunded"],
  payment_failed: ["confirmed", "needs_attention"],
  expired: ["confirmed", "needs_attention"],
  cancelled: [],
  refunded: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return BOOKING_TRANSITIONS[from]?.includes(to) ?? false;
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: BookingStatus,
    readonly to: BookingStatus,
  ) {
    super(`Invalid booking transition ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Statuses covered by the "one live booking per trip" unique index. */
export const LIVE_BOOKING_STATUSES: readonly BookingStatus[] = [
  "pending_payment",
  "confirmed",
  "cancellation_requested",
  "refund_pending",
  "needs_attention",
];

/** Statuses that consume trail capacity (pending_payment only while its hold is valid). */
export const CAPACITY_STATUSES: readonly BookingStatus[] = ["confirmed", "cancellation_requested", "needs_attention"];

export const TERMINAL_CANCELLED_STATUSES: readonly BookingStatus[] = ["cancelled", "refund_pending", "refunded"];

export function holdIsValid(holdExpiresAt: Date | string | null | undefined, now: Date): boolean {
  return !!holdExpiresAt && new Date(holdExpiresAt).getTime() > now.getTime();
}

// ---------------------------------------------------------------------------
// Cancellation policy & refunds
// ---------------------------------------------------------------------------

export interface CancellationPolicy {
  /** cancel at least this many hours before the hike start for a full refund */
  fullRefundHours: number;
  /** percentage refunded in the partial window */
  partialRefundPct: number;
  /** cancel at least this many hours before start for the partial refund */
  partialRefundHours: number;
}

export const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = { fullRefundHours: 48, partialRefundPct: 50, partialRefundHours: 12 };

/** Parse app_settings.cancellation_policy defensively (falls back to defaults field by field). */
export function parseCancellationPolicy(value: unknown): CancellationPolicy {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const num = (x: unknown, d: number, min: number, max: number) =>
    typeof x === "number" && Number.isFinite(x) && x >= min && x <= max ? x : d;
  const fullRefundHours = num(v.fullRefundHours, DEFAULT_CANCELLATION_POLICY.fullRefundHours, 0, 24 * 365);
  const partialRefundHours = Math.min(fullRefundHours, num(v.partialRefundHours, DEFAULT_CANCELLATION_POLICY.partialRefundHours, 0, 24 * 365));
  const partialRefundPct = num(v.partialRefundPct, DEFAULT_CANCELLATION_POLICY.partialRefundPct, 0, 100);
  return { fullRefundHours, partialRefundPct, partialRefundHours };
}

export type RefundTier = "full" | "partial" | "none";

export interface RefundComputation {
  tier: RefundTier;
  /** percent of the paid amount the policy grants */
  pct: number;
  /** refund amount in cents, capped at what is still refundable */
  refundCents: number;
  /** hours between `now` and the hike start (negative once started) */
  hoursBeforeStart: number;
}

/**
 * Refund owed when a customer cancels. Boundaries are inclusive: cancelling
 * exactly `fullRefundHours` before the start still earns a full refund.
 * The refund is a percentage of the amount actually paid, rounded down to a
 * whole cent, and never more than what has not already been refunded.
 */
export function computeCancellationRefund(input: {
  paidCents: number;
  alreadyRefundedCents?: number;
  hikeStart: Date;
  now: Date;
  policy: CancellationPolicy;
}): RefundComputation {
  const { policy } = input;
  const hoursBeforeStart = (input.hikeStart.getTime() - input.now.getTime()) / 3_600_000;
  let tier: RefundTier = "none";
  let pct = 0;
  if (hoursBeforeStart >= policy.fullRefundHours) {
    tier = "full";
    pct = 100;
  } else if (hoursBeforeStart >= policy.partialRefundHours && policy.partialRefundPct > 0) {
    tier = "partial";
    pct = policy.partialRefundPct;
  }
  const paid = Math.max(0, Math.floor(input.paidCents));
  const remaining = Math.max(0, paid - Math.max(0, Math.floor(input.alreadyRefundedCents ?? 0)));
  const owed = Math.floor((paid * pct) / 100);
  return { tier, pct, refundCents: Math.min(owed, remaining), hoursBeforeStart };
}

/** Human summary of the policy, e.g. for the checkout and cancel pages. */
export function describeCancellationPolicy(p: CancellationPolicy): string[] {
  const lines = [`Full refund if you cancel at least ${p.fullRefundHours} hours before your start time.`];
  if (p.partialRefundPct > 0 && p.partialRefundHours < p.fullRefundHours) {
    lines.push(`${p.partialRefundPct}% refund if you cancel at least ${p.partialRefundHours} hours before your start time.`);
    lines.push(`No refund within ${p.partialRefundHours} hours of your start time.`);
  } else {
    lines.push(`No refund within ${p.fullRefundHours} hours of your start time.`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Receipt numbers
// ---------------------------------------------------------------------------

/** Unambiguous alphabet (no 0/O, 1/I/L). */
export const RECEIPT_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const RECEIPT_NUMBER_PATTERN = /^GG-\d{8}-[A-Z0-9]{6}$/;

/**
 * Format "GG-YYYYMMDD-XXXXXX". The date is the payment date in `timeZone`
 * (the trail region's zone, so it matches the dates printed on the receipt);
 * without a zone it is the UTC date. `randomBytes` must hold at least 6 bytes
 * (callers pass crypto.randomBytes(6)); kept as a parameter so this stays pure.
 */
export function formatReceiptNumber(paidAt: Date, randomBytes: ArrayLike<number>, timeZone?: string): string {
  if (randomBytes.length < 6) throw new Error("receipt number needs 6 random bytes");
  const day = timeZone ? localDateInZone(paidAt, timeZone) : paidAt.toISOString().slice(0, 10);
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += RECEIPT_ALPHABET[randomBytes[i] % RECEIPT_ALPHABET.length];
  return `GG-${day.replace(/-/g, "")}-${suffix}`;
}

export function isReceiptNumber(s: string): boolean {
  return RECEIPT_NUMBER_PATTERN.test(s);
}

// ---------------------------------------------------------------------------
// Price breakdown stored on bookings.price_breakdown
// ---------------------------------------------------------------------------

export interface StoredPriceBreakdown extends Quote {
  trailName: string;
  hikeDate: string;
  startTime: string;
  partySize: number;
  /** occupancy (0..1) used for the high-demand rule at quote time */
  occupancy: number;
  timezone: string;
}

export interface ProviderLineItem {
  label: string;
  amountCents: number;
}

/**
 * Line items sent to the payment provider. Providers reject negative lines,
 * so percentage adjustments (incl. discounts) are folded into the experience
 * line; add-ons stay separate. The items always sum to quote.totalCents.
 */
export function toProviderLineItems(quote: Quote, experienceLabel: string): ProviderLineItem[] {
  const items: ProviderLineItem[] = [];
  const adjusted = quote.adjustmentsCents !== 0;
  items.push({ label: adjusted ? `${experienceLabel} (incl. adjustments)` : experienceLabel, amountCents: quote.subtotalCents });
  for (const line of quote.lines) {
    if (line.kind === "addon") items.push({ label: line.label, amountCents: line.amountCents });
  }
  return items.filter((i, idx) => idx === 0 || i.amountCents > 0);
}

// ---------------------------------------------------------------------------
// Customer-facing copy
// ---------------------------------------------------------------------------

export type Tone = "neutral" | "forest" | "amber" | "red" | "blue";

export const BOOKING_STATUS_COPY: Record<BookingStatus, { label: string; tone: Tone; description: string }> = {
  pending_payment: { label: "Awaiting payment", tone: "amber", description: "Your spot is held while you finish payment." },
  confirmed: { label: "Confirmed", tone: "forest", description: "Payment received and your hike is booked." },
  cancellation_requested: { label: "Cancellation requested", tone: "amber", description: "We are processing your cancellation." },
  cancelled: { label: "Cancelled", tone: "neutral", description: "This booking was cancelled." },
  refund_pending: { label: "Refund pending", tone: "blue", description: "Cancelled. Your refund is being processed." },
  refunded: { label: "Refunded", tone: "neutral", description: "This booking was refunded." },
  payment_failed: { label: "Payment failed", tone: "red", description: "The payment did not go through. You were not charged and the hold was released." },
  expired: { label: "Checkout expired", tone: "neutral", description: "The payment hold expired before payment. You were not charged." },
  needs_attention: {
    label: "Needs attention",
    tone: "red",
    description: "We received your payment but could not confirm the booking automatically. Our team has been alerted; any refund due is issued automatically.",
  },
};

export const TRIP_STATUS_COPY: Record<TripStatus, { label: string; tone: Tone }> = {
  saved: { label: "Saved", tone: "neutral" },
  booked: { label: "Booked", tone: "forest" },
  active: { label: "On the trail", tone: "blue" },
  completed: { label: "Completed", tone: "forest" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export type AddonKind = "gear_locker" | "shuttle" | "meal_pack" | "satellite_device" | "other";

export const ADDON_KIND_LABEL: Record<AddonKind, string> = {
  gear_locker: "Gear locker",
  shuttle: "Shuttle",
  meal_pack: "Meal pack",
  satellite_device: "Satellite communicator rental",
  other: "Add-on",
};

/**
 * Per-provider fulfillment status line, e.g. "Gear locker: confirmed — code ready".
 * Kept separate from booking status: a partner problem never changes whether
 * the hike itself is booked.
 */
export function describeFulfillment(
  kind: AddonKind,
  status: FulfillmentStatus,
  opts: { codeReady?: boolean; shuttleQuoteExpired?: boolean } = {},
): { text: string; tone: Tone; detail: string } {
  const name = ADDON_KIND_LABEL[kind] ?? "Add-on";
  switch (status) {
    case "pending":
      return { text: `${name}: processing`, tone: "neutral", detail: "We are arranging this with our partner." };
    case "requested":
      return { text: `${name}: requested`, tone: "blue", detail: "Requested from our partner; waiting for their confirmation." };
    case "awaiting_customer":
      return opts.shuttleQuoteExpired
        ? { text: `${name}: quote expired — request a new quote`, tone: "amber", detail: "The quote expired before it was confirmed. No ride has been requested." }
        : { text: `${name}: awaiting your confirmation`, tone: "amber", detail: "Review and confirm the pickup location, time and price. No ride is requested until you confirm." };
    case "confirmed":
      if (kind === "gear_locker" || kind === "satellite_device")
        return { text: `${name}: confirmed${opts.codeReady ? " — code ready" : ""}`, tone: "forest", detail: "Reserved for your hike date." };
      if (kind === "shuttle") return { text: `${name}: ride confirmed`, tone: "forest", detail: "Your ride is booked with the shuttle partner." };
      return { text: `${name}: confirmed`, tone: "forest", detail: "Confirmed by our partner." };
    case "completed":
      return { text: `${name}: completed`, tone: "forest", detail: "Done." };
    case "failed":
      return { text: `${name}: delayed — retrying`, tone: "amber", detail: "Our partner did not respond. We are retrying automatically." };
    case "needs_attention":
      return { text: `${name}: failed — our team is on it`, tone: "red", detail: "We could not arrange this automatically. Our team will follow up; your hike booking is not affected." };
    case "cancelled":
      return { text: `${name}: cancelled`, tone: "neutral", detail: "Cancelled." };
  }
}

export interface NextActionInput {
  tripId: string;
  tripStatus: TripStatus;
  bookingId?: string | null;
  bookingStatus?: BookingStatus | null;
  holdValid?: boolean;
  resumeUrl?: string | null;
  awaitingShuttleFulfillmentId?: string | null;
}

/** The single most useful next step for a trip, for the My Trips list. */
export function nextActionForTrip(i: NextActionInput): { label: string; href: string } | null {
  const trip = `/trips/${i.tripId}`;
  if (i.tripStatus === "cancelled") return null;
  if (i.tripStatus === "completed") return { label: "View trip summary", href: trip };
  if (i.tripStatus === "active") return { label: "Resume your hike", href: trip };
  if (i.bookingStatus === "pending_payment" && i.holdValid && i.resumeUrl) return { label: "Complete payment", href: i.resumeUrl };
  if (i.tripStatus === "saved") return { label: "Book this hike", href: `${trip}/checkout` };
  if (i.awaitingShuttleFulfillmentId) return { label: "Confirm your shuttle", href: `${trip}/shuttle/${i.awaitingShuttleFulfillmentId}` };
  if (i.bookingStatus === "needs_attention") return { label: "See booking status", href: trip };
  return { label: "Prepare for your hike", href: trip };
}

// ---------------------------------------------------------------------------
// Booked date: validity, closures and re-planning
// ---------------------------------------------------------------------------

/** A real calendar date written as YYYY-MM-DD (rejects 2026-02-30, 2026-13-45, 2026-12-32). */
export function isRealIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export type DayClosure = Pick<Closure, "severity" | "reason" | "startsAt" | "endsAt">;

export interface ClosureVerdict {
  /** A full ("closed") closure overlapping the region-local day: the date cannot be booked. */
  closed: DayClosure | null;
  /** Partial closures and advisories overlapping the day: shown as warnings. */
  notices: DayClosure[];
}

/**
 * Closures that matter for a hike on `date` (region-local calendar day),
 * whether they are active now or scheduled. Same overlap rule as the planner.
 */
export function closureVerdict(closures: DayClosure[], date: string, timeZone: string): ClosureVerdict {
  const onDay = closures
    .filter((c) => closureOverlapsDay(c, date, timeZone))
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  return {
    closed: onDay.find((c) => c.severity === "closed") ?? null,
    notices: onDay.filter((c) => c.severity !== "closed"),
  };
}

export function closedOnDateMessage(c: Pick<Closure, "reason">): string {
  return `The trail is closed on that date: ${c.reason.replace(/[.\s]+$/, "")}. Please choose another date.`;
}

/** Defaults used only to compute estimates when a saved trip has no questionnaire answers. */
const REPLAN_DEFAULTS: Pick<TripPreferences, "experience" | "fitness" | "pace" | "preferredTerrain" | "availableHours" | "accessibilityNeeds" | "equipment"> = {
  experience: "some",
  fitness: "moderate",
  pace: "steady",
  preferredTerrain: [],
  availableHours: 8,
  accessibilityNeeds: [],
  equipment: [],
};

export interface ReplanInput {
  trail: ItineraryTrail;
  pois: ItineraryPoi[];
  permits: { name: string; leadTimeDays: number | null }[];
  /** The trip's saved questionnaire answers (may be partial or empty). */
  preferences: Partial<TripPreferences>;
  hikeDate: string;
  startTime: string;
  partySize: number;
  /** Region latest-finish table (month → HH:MM); defaults to the built-in table. */
  latestFinishByMonth?: Record<number, string>;
  /** Reasons of partial closures on the booked (region-local) day, noted like the planner does. */
  partialClosures?: string[];
  now: Date;
}

export interface ReplanResult {
  /** Saved answers with the booked date, start time and group size (no invented answers). */
  preferences: Partial<TripPreferences>;
  itinerary: Itinerary;
  latestFinishTime: string;
  /** The estimated finish is after the conservative latest-finish estimate for that month. */
  finishesAfterLatest: boolean;
}

/**
 * Rebuild the deterministic itinerary for the date / group actually booked,
 * with exactly the same builder, pace factor and latest-finish table the
 * planner uses when a trip is saved, so the daylight cutoff, turnaround and
 * stop times match the booked day.
 */
export function replanForBooking(i: ReplanInput): ReplanResult {
  const startTime = i.startTime.slice(0, 5);
  const full: TripPreferences = {
    ...REPLAN_DEFAULTS,
    ...i.preferences,
    plannedDate: i.hikeDate,
    startTime,
    partySize: i.partySize,
  };
  const latestFinishTime = latestFinishFor(i.hikeDate, i.latestFinishByMonth ?? DEFAULT_LATEST_FINISH_BY_MONTH);
  const itinerary = buildItinerary(i.trail, i.pois, full, i.now, {
    latestFinishTime,
    partialClosures: i.partialClosures ?? [],
    extraNotes: i.permits.map((p) => `Permit: ${p.name}${p.leadTimeDays !== null ? ` (allow about ${p.leadTimeDays} days)` : ""}.`),
  });
  const finishesAfterLatest = clockToMinutes(startTime) + itinerary.estimatedDurationMin > clockToMinutes(latestFinishTime);
  return {
    preferences: { ...i.preferences, plannedDate: i.hikeDate, startTime, partySize: i.partySize },
    itinerary,
    latestFinishTime,
    finishesAfterLatest,
  };
}

/** Customer message when a changed date / group would finish after the latest-finish estimate. */
export function daylightProblem(r: Pick<ReplanResult, "finishesAfterLatest" | "latestFinishTime" | "itinerary">): string | null {
  if (!r.finishesAfterLatest) return null;
  const { startTime, estimatedDurationMin, plannedDate } = r.itinerary;
  const finishMin = clockToMinutes(startTime) + estimatedDurationMin;
  const finish = finishMin >= 1440 ? "after midnight" : addMinutesToClock(startTime, estimatedDurationMin);
  return (
    `On ${plannedDate} your estimated finish (${finish}) is after the conservative latest-finish estimate for ${monthName(plannedDate)} (${r.latestFinishTime}). ` +
    "Choose a date with more daylight or a smaller group, or plan a new trip with an earlier start."
  );
}

/** True when the trip's saved plan was not computed for this date / group / start time. */
export function planDiffersFromBooking(
  trip: { plannedDate: string | null; partySize: number; startTime: string | null; itinerary?: Partial<Itinerary> | null },
  booked: { hikeDate: string; partySize: number; startTime: string },
): boolean {
  const itineraryDate = trip.itinerary?.plannedDate;
  return (
    trip.plannedDate !== booked.hikeDate ||
    trip.partySize !== booked.partySize ||
    (trip.startTime ?? "").slice(0, 5) !== booked.startTime.slice(0, 5) ||
    (!!itineraryDate && itineraryDate !== booked.hikeDate)
  );
}
