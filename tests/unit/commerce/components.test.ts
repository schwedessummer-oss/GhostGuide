import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FulfillmentList } from "@/components/commerce/fulfillment-list";
import { ItinerarySummary } from "@/components/commerce/itinerary-summary";
import { PriceBreakdown } from "@/components/commerce/price-breakdown";
import { BookingStatusBadge, TripStatusBadge } from "@/components/commerce/status-badges";
import type { FulfillmentView } from "@/server/commerce/queries";

const base = { quantity: 2, attempts: 1, simulated: true, accessCode: null, shuttle: null, details: {} };

describe("commerce components render", () => {
  it("shows separate per-partner statuses with text, codes only when provided, and SOS disclaimer", () => {
    const fulfillments: FulfillmentView[] = [
      {
        ...base,
        id: "f1",
        kind: "gear_locker",
        status: "confirmed",
        addonName: "Trailhead gear locker kit",
        accessCode: "123456",
        details: { lockerName: "Locker (demo)", locationDescription: "By the restroom", items: ["Poles #1"], codeHint: "56", codeExpiresAt: "2026-12-01T07:59:00Z" },
      },
      {
        ...base,
        id: "f2",
        kind: "shuttle",
        status: "awaiting_customer",
        addonName: "Trailhead shuttle",
        details: { pickup: "Visitor Center (demo)", pickupAt: "2026-12-01T16:20:00Z", priceCents: 3500 },
        shuttle: { status: "quoted", quoteExpiresAt: new Date(Date.now() + 3_600_000), quoteExpired: false, customerConfirmedAt: null, pickupAt: new Date() },
      },
      { ...base, id: "f3", kind: "meal_pack", status: "needs_attention", addonName: "Trail meal pack" },
      { ...base, id: "f4", kind: "satellite_device", status: "pending", addonName: "Satellite communicator rental" },
    ];
    const html = renderToStaticMarkup(h(FulfillmentList, { tripId: "t1", fulfillments, timezone: "America/Los_Angeles", currency: "usd" }));
    expect(html).toContain("Gear locker: confirmed — code ready");
    expect(html).toContain("123456");
    expect(html).toContain("Shuttle: awaiting your confirmation");
    expect(html).toContain('href="/trips/t1/shuttle/f2"');
    expect(html).toContain("Meal pack: failed — our team is on it");
    expect(html).toContain("Ghost Guide does not provide SOS");
    expect(html).toContain("Simulated partner");
  });

  it("labels itinerary times as estimates and reminders as general", () => {
    const html = renderToStaticMarkup(
      h(ItinerarySummary, {
        startTime: "09:00",
        itinerary: {
          startTime: "09:00",
          estimatedFinishTime: "12:30",
          estimatedDurationMin: 210,
          stops: [{ poiId: "p1", name: "Falls", alongM: 2800, etaOffsetMin: 75 }],
          reminders: { hydrationEveryMin: 30, paceCheckEveryMin: 45 },
          turnaroundBy: "11:00",
        },
      }),
    );
    expect(html).toContain("Estimates");
    expect(html).toContain("about 10:15 AM");
    expect(html).toContain("Estimated finish · 12:30 PM");
    expect(html).toContain("not medical advice");
  });

  it("renders price lines, totals and status badges as text", () => {
    const html = renderToStaticMarkup(
      h(PriceBreakdown, {
        lines: [
          { kind: "base", label: "Self-guided experience × 2", amountCents: 5000 },
          { kind: "adjustment", label: "Weekend surcharge (+15%)", amountCents: 750, ruleId: "r" },
        ],
        totalCents: 5750,
        currency: "usd",
        refundedCents: 1000,
      }),
    );
    expect(html).toContain("$57.50");
    expect(html).toContain("Refunded");
    expect(renderToStaticMarkup(h(BookingStatusBadge, { status: "needs_attention" }))).toContain("Needs attention");
    expect(renderToStaticMarkup(h(TripStatusBadge, { status: "booked" }))).toContain("Booked");
  });
});
