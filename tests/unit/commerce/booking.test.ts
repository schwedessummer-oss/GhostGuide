import { describe, expect, it } from "vitest";
import {
  BOOKING_TRANSITIONS,
  DEFAULT_CANCELLATION_POLICY,
  InvalidTransitionError,
  BOOKING_STATUS_COPY,
  assertTransition,
  bookingStatusCopy,
  canTransition,
  computeCancellationRefund,
  describeCancellationPolicy,
  describeFulfillment,
  formatReceiptNumber,
  isReceiptNumber,
  nextActionForTrip,
  parseCancellationPolicy,
  toProviderLineItems,
  RECEIPT_ALPHABET,
} from "@/domain/booking";
import { quotePrice } from "@/domain/pricing";
import type { BookingStatus } from "@/domain/types";

describe("booking state machine", () => {
  const valid: [BookingStatus, BookingStatus][] = [
    ["pending_payment", "confirmed"],
    ["pending_payment", "needs_attention"],
    ["pending_payment", "payment_failed"],
    ["pending_payment", "expired"],
    ["expired", "confirmed"], // late payment, capacity still available
    ["expired", "needs_attention"], // late payment, capacity gone
    ["payment_failed", "needs_attention"],
    ["confirmed", "refund_pending"],
    ["confirmed", "cancelled"],
    ["confirmed", "cancellation_requested"],
    ["refund_pending", "refunded"],
    ["refund_pending", "cancelled"],
    ["needs_attention", "refunded"],
    ["needs_attention", "confirmed"],
  ];
  const invalid: [BookingStatus, BookingStatus][] = [
    ["pending_payment", "refunded"],
    ["pending_payment", "cancelled"],
    ["confirmed", "pending_payment"],
    ["confirmed", "expired"],
    ["confirmed", "refunded"],
    ["cancelled", "confirmed"],
    ["refunded", "confirmed"],
    ["refunded", "refund_pending"],
    ["expired", "pending_payment"],
    ["refund_pending", "confirmed"],
  ];

  it.each(valid)("allows %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each(invalid)("rejects %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it("has terminal states with no exits and no self-transitions", () => {
    expect(BOOKING_TRANSITIONS.cancelled).toEqual([]);
    expect(BOOKING_TRANSITIONS.refunded).toEqual([]);
    for (const [from, tos] of Object.entries(BOOKING_TRANSITIONS)) expect(tos).not.toContain(from);
  });
});

describe("cancellation refund calculator", () => {
  const policy = DEFAULT_CANCELLATION_POLICY; // 48 h full, 50% from 12 h, none after
  const start = new Date("2026-12-10T16:00:00Z");
  const at = (hoursBefore: number) => new Date(start.getTime() - hoursBefore * 3_600_000);
  const calc = (hoursBefore: number, paidCents = 10_000, alreadyRefundedCents = 0) =>
    computeCancellationRefund({ paidCents, alreadyRefundedCents, hikeStart: start, now: at(hoursBefore), policy });

  it("gives a full refund at exactly the full-refund boundary and above", () => {
    expect(calc(48)).toMatchObject({ tier: "full", pct: 100, refundCents: 10_000 });
    expect(calc(200)).toMatchObject({ tier: "full", refundCents: 10_000 });
  });

  it("drops to the partial tier one second inside the full window", () => {
    expect(calc(48 - 1 / 3600)).toMatchObject({ tier: "partial", pct: 50, refundCents: 5_000 });
  });

  it("gives a partial refund at exactly the partial boundary", () => {
    expect(calc(12)).toMatchObject({ tier: "partial", refundCents: 5_000 });
  });

  it("gives nothing inside the no-refund window and after the start", () => {
    expect(calc(12 - 1 / 3600)).toMatchObject({ tier: "none", refundCents: 0 });
    expect(calc(0)).toMatchObject({ tier: "none", refundCents: 0 });
    expect(calc(-5)).toMatchObject({ tier: "none", refundCents: 0 });
  });

  it("rounds partial refunds down to whole cents", () => {
    expect(calc(24, 3_333).refundCents).toBe(1_666);
  });

  it("never refunds more than what is still refundable", () => {
    expect(calc(100, 10_000, 7_000).refundCents).toBe(3_000);
    expect(calc(100, 10_000, 10_000).refundCents).toBe(0);
    expect(calc(24, 10_000, 8_000).refundCents).toBe(2_000);
  });

  it("parses policy settings defensively", () => {
    expect(parseCancellationPolicy(null)).toEqual(DEFAULT_CANCELLATION_POLICY);
    expect(parseCancellationPolicy({ fullRefundHours: 72, partialRefundPct: 25, partialRefundHours: 24 })).toEqual({
      fullRefundHours: 72,
      partialRefundPct: 25,
      partialRefundHours: 24,
    });
    // partial window can never exceed the full window; junk falls back to defaults
    expect(parseCancellationPolicy({ fullRefundHours: 10, partialRefundHours: 20, partialRefundPct: "x" })).toEqual({
      fullRefundHours: 10,
      partialRefundHours: 10,
      partialRefundPct: 50,
    });
    expect(describeCancellationPolicy(policy)[0]).toMatch(/48 hours/);
  });
});

describe("receipt numbers", () => {
  it("formats GG-YYYYMMDD-XXXXXX in UTC", () => {
    const r = formatReceiptNumber(new Date("2026-11-05T23:30:00-08:00"), [0, 1, 2, 3, 4, 255]);
    expect(r).toMatch(/^GG-20261106-[A-Z0-9]{6}$/);
    expect(isReceiptNumber(r)).toBe(true);
  });

  it("only uses the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const bytes = Array.from({ length: 6 }, () => Math.floor(Math.random() * 256));
      const suffix = formatReceiptNumber(new Date(), bytes).slice(-6);
      for (const ch of suffix) expect(RECEIPT_ALPHABET).toContain(ch);
      expect(suffix).not.toMatch(/[01OIL]/);
    }
  });

  it("rejects malformed numbers and short randomness", () => {
    expect(isReceiptNumber("GG-2026115-ABCDEF")).toBe(false);
    expect(isReceiptNumber("XX-20261105-ABCDEF")).toBe(false);
    expect(isReceiptNumber("GG-20261105-abcdef")).toBe(false);
    expect(() => formatReceiptNumber(new Date(), [1, 2, 3])).toThrow();
  });
});

describe("provider line items", () => {
  it("fold adjustments (incl. discounts) into the experience line and sum to the total", () => {
    const quote = quotePrice({
      basePriceCents: 2500,
      partySize: 5,
      hikeDate: "2026-11-07", // Saturday
      occupancy: 0.9,
      regionId: "r",
      trailId: "t",
      currency: "usd",
      rules: [
        { id: "w", name: "Weekend", kind: "weekend_pct", value: 15, params: {}, regionId: null, trailId: null, active: true, priority: 1, effectiveFrom: null, effectiveTo: null },
        { id: "g", name: "Group", kind: "group_discount_pct", value: -10, params: { minParty: 4 }, regionId: null, trailId: null, active: true, priority: 2, effectiveFrom: null, effectiveTo: null },
      ],
      addons: [
        { code: "meal", name: "Meal", priceCents: 1800, pricingUnit: "per_person" },
        { code: "shuttle", name: "Shuttle", priceCents: 3500, pricingUnit: "per_booking" },
      ],
    });
    const items = toProviderLineItems(quote, "Hike × 5");
    expect(items.every((i) => i.amountCents >= 0)).toBe(true);
    expect(items.reduce((s, i) => s + i.amountCents, 0)).toBe(quote.totalCents);
    expect(items[0].label).toMatch(/incl\. adjustments/);
    expect(items).toHaveLength(3);
  });
});

describe("customer-facing copy", () => {
  it("describes per-provider fulfillment status separately from the booking", () => {
    expect(describeFulfillment("gear_locker", "confirmed", { codeReady: true }).text).toBe("Gear locker: confirmed — code ready");
    expect(describeFulfillment("shuttle", "awaiting_customer").text).toBe("Shuttle: awaiting your confirmation");
    expect(describeFulfillment("meal_pack", "needs_attention").text).toBe("Meal pack: failed — our team is on it");
    expect(describeFulfillment("shuttle", "awaiting_customer", { shuttleQuoteExpired: true }).text).toMatch(/quote expired/);
  });

  it("picks the next action for a trip", () => {
    expect(nextActionForTrip({ tripId: "t", tripStatus: "saved" })?.href).toBe("/trips/t/checkout");
    expect(nextActionForTrip({ tripId: "t", tripStatus: "saved", bookingStatus: "pending_payment", holdValid: true, resumeUrl: "/trips/t/checkout" })?.label).toBe(
      "Complete payment",
    );
    expect(nextActionForTrip({ tripId: "t", tripStatus: "booked", bookingStatus: "confirmed", awaitingShuttleFulfillmentId: "f" })?.href).toBe("/trips/t/shuttle/f");
    expect(nextActionForTrip({ tripId: "t", tripStatus: "cancelled" })).toBeNull();
  });
});

describe("booking status copy for an ended checkout (COMMERCE-1)", () => {
  it("never says 'not charged' when a payment still arrived after the checkout ended", () => {
    for (const status of ["expired", "payment_failed"] as BookingStatus[]) {
      expect(bookingStatusCopy(status)).toEqual(BOOKING_STATUS_COPY[status]);
      expect(bookingStatusCopy(status).description).toMatch(/not charged/);
      const late = bookingStatusCopy(status, { paidAt: new Date() });
      expect(late.label).toMatch(/automatic refund/i);
      expect(late.description).not.toMatch(/not charged/);
      expect(late.description).toMatch(/refunded to you automatically and in full/);
      expect(late.tone).toBe("amber");
      expect(bookingStatusCopy(status, { paidAt: "2026-11-11T10:00:00Z" }).label).toBe(late.label);
    }
  });

  it("leaves every other status unchanged, paid or not", () => {
    for (const status of Object.keys(BOOKING_STATUS_COPY) as BookingStatus[]) {
      if (status === "expired" || status === "payment_failed") continue;
      expect(bookingStatusCopy(status, { paidAt: new Date() })).toEqual(BOOKING_STATUS_COPY[status]);
    }
  });
});
