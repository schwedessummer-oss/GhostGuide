import { describe, expect, it } from "vitest";
import { isWeekend, quotePrice, type PricingRule, type QuoteInput } from "@/domain/pricing";

const rule = (r: Partial<PricingRule> & Pick<PricingRule, "kind" | "value">): PricingRule => ({
  id: r.kind,
  name: r.kind,
  params: {},
  regionId: null,
  trailId: null,
  active: true,
  priority: 10,
  effectiveFrom: null,
  effectiveTo: null,
  ...r,
});

const base: QuoteInput = {
  basePriceCents: 2000,
  partySize: 2,
  hikeDate: "2026-11-11", // Wednesday
  occupancy: 0.1,
  regionId: "r1",
  trailId: "t1",
  rules: [
    rule({ kind: "weekend_pct", value: 15, priority: 10 }),
    rule({ kind: "holiday_pct", value: 20, params: { dates: ["2026-12-25"] }, priority: 20 }),
    rule({ kind: "high_demand_pct", value: 10, params: { threshold: 0.75 }, priority: 30 }),
    rule({ kind: "group_discount_pct", value: -10, params: { minParty: 4 }, priority: 40 }),
  ],
  addons: [],
  currency: "usd",
};

describe("pricing", () => {
  it("weekday base price with no adjustments", () => {
    const q = quotePrice(base);
    expect(q.totalCents).toBe(4000);
    expect(q.lines).toHaveLength(1);
  });

  it("detects weekends from the calendar date", () => {
    expect(isWeekend("2026-11-14")).toBe(true); // Saturday
    expect(isWeekend("2026-11-15")).toBe(true); // Sunday
    expect(isWeekend("2026-11-16")).toBe(false);
  });

  it("applies weekend, holiday, demand and group rules non-compounding", () => {
    const q = quotePrice({ ...base, hikeDate: "2026-12-26", partySize: 4, occupancy: 0.8 }); // Saturday, not holiday
    // base 8000; weekend +1200; demand +800; group -800
    expect(q.baseCents).toBe(8000);
    expect(q.adjustmentsCents).toBe(1200);
    expect(q.totalCents).toBe(9200);
    expect(q.lines.map((l) => l.label)).toEqual([
      "Self-guided experience × 4",
      "weekend_pct (+15%)",
      "high_demand_pct (+10%)",
      "group_discount_pct (-10%)",
    ]);
  });

  it("applies holiday surcharge on listed dates", () => {
    const q = quotePrice({ ...base, hikeDate: "2026-12-25" }); // Friday holiday
    expect(q.totalCents).toBe(4800);
  });

  it("prices per-person and per-booking add-ons", () => {
    const q = quotePrice({
      ...base,
      addons: [
        { code: "gear", name: "Gear", priceCents: 1200, pricingUnit: "per_person" },
        { code: "shuttle", name: "Shuttle", priceCents: 3500, pricingUnit: "per_booking" },
      ],
    });
    expect(q.addonsCents).toBe(1200 * 2 + 3500);
    expect(q.totalCents).toBe(4000 + 5900);
  });

  it("respects scope, activity and effective dates", () => {
    const scoped = quotePrice({
      ...base,
      hikeDate: "2026-11-14",
      rules: [
        rule({ kind: "weekend_pct", value: 15, trailId: "other" }),
        rule({ kind: "flat_fee", value: 500, active: false }),
        rule({ kind: "flat_fee", value: 300, effectiveFrom: "2027-01-01" }),
      ],
    });
    expect(scoped.totalCents).toBe(4000);
  });

  it("never produces a negative subtotal and rejects invalid party sizes", () => {
    const q = quotePrice({ ...base, partySize: 4, rules: [rule({ kind: "group_discount_pct", value: -150, params: { minParty: 2 } })] });
    expect(q.subtotalCents).toBe(0);
    expect(() => quotePrice({ ...base, partySize: 0 })).toThrow();
    expect(() => quotePrice({ ...base, partySize: 13 })).toThrow();
  });
});
