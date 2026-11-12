import { describe, expect, it } from "vitest";
import { VIEW_H, VIEW_W, buildElevationChart, cleanProfile, niceStep } from "@/components/trail/elevation";

describe("niceStep", () => {
  it("picks 1 / 2 / 2.5 / 5 × 10^n steps", () => {
    expect(niceStep(3.4, 5)).toBe(1);
    expect(niceStep(6.8, 5)).toBe(2);
    expect(niceStep(2000, 3)).toBe(1000);
    expect(niceStep(450, 3)).toBe(200);
    expect(niceStep(700, 3)).toBe(250);
    expect(niceStep(0.9, 5)).toBe(0.2);
    expect(niceStep(0, 5)).toBe(1);
  });
});

describe("cleanProfile", () => {
  it("drops non-finite points and backwards distances", () => {
    expect(
      cleanProfile([
        [0, 100],
        [10, Number.NaN],
        [20, 110],
        [15, 120],
        [30, 130],
      ]),
    ).toEqual([
      [0, 100],
      [20, 110],
      [30, 130],
    ]);
    expect(cleanProfile(null)).toEqual([]);
  });
});

describe("buildElevationChart", () => {
  const profile: [number, number][] = [
    [0, 351],
    [1000, 500],
    [2000, 700],
    [4000, 949],
    [5483, 876],
  ];

  it("returns null without at least two usable points", () => {
    expect(buildElevationChart(null)).toBeNull();
    expect(buildElevationChart([[0, 100]])).toBeNull();
    expect(
      buildElevationChart([
        [0, 100],
        [0, 120],
      ]),
    ).toBeNull();
  });

  it("draws a line and a closed area across the full viewBox", () => {
    const c = buildElevationChart(profile)!;
    expect(c.linePath.startsWith("M0,")).toBe(true);
    expect(c.linePath.split("L")).toHaveLength(profile.length);
    expect(c.linePath).toMatch(new RegExp(`L${VIEW_W},[\\d.]+$`));
    expect(c.areaPath.endsWith(`L${VIEW_W},${VIEW_H}L0,${VIEW_H}Z`)).toBe(true);
    // Every y stays inside the plot (domain is padded around the data).
    for (const pair of c.linePath.slice(1).split("L")) {
      const y = Number(pair.split(",")[1]);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(VIEW_H);
    }
  });

  it("finds the highest and lowest points with their positions", () => {
    const c = buildElevationChart(profile)!;
    expect(c.high).toMatchObject({ distanceM: 4000, elevationM: 949 });
    expect(c.low).toMatchObject({ distanceM: 0, elevationM: 351, xPct: 0 });
    expect(c.end.xPct).toBe(100);
    expect(c.high.yPct).toBeLessThan(c.low.yPct);
    expect(c.domainMinM).toBeLessThan(351);
    expect(c.domainMaxM).toBeGreaterThan(949);
    expect(c.totalM).toBe(5483);
  });

  it("labels distance ticks in miles and kilometres", () => {
    const c = buildElevationChart(profile)!;
    expect(c.xTicks.imperial.map((t) => t.label)).toEqual(["0 mi", "1 mi", "2 mi", "3 mi"]);
    expect(c.xTicks.metric.map((t) => t.label)).toEqual(["0 km", "2 km", "4 km"]);
    expect(c.xTicks.metric[1].pct).toBeCloseTo((2000 / 5483) * 100, 1);
    for (const t of [...c.xTicks.imperial, ...c.xTicks.metric]) {
      expect(t.pct).toBeGreaterThanOrEqual(0);
      expect(t.pct).toBeLessThanOrEqual(100);
    }
  });

  it("labels elevation ticks with round values inside the domain", () => {
    const c = buildElevationChart(profile)!;
    expect(c.yTicks.imperial.map((t) => t.label)).toEqual(["1,000 ft", "2,000 ft", "3,000 ft"]);
    expect(c.yTicks.metric.map((t) => t.label)).toEqual(["500 m", "750 m", "1,000 m"]);
    for (const t of [...c.yTicks.imperial, ...c.yTicks.metric]) {
      expect(t.pct).toBeGreaterThanOrEqual(0);
      expect(t.pct).toBeLessThanOrEqual(100);
    }
    // Higher values sit nearer the top.
    expect(c.yTicks.imperial[2].pct).toBeLessThan(c.yTicks.imperial[0].pct);
  });

  it("uses feet / metres on the distance axis for very short trails", () => {
    const c = buildElevationChart([
      [0, 300],
      [150, 310],
      [320, 305],
    ])!;
    expect(c.xTicks.imperial[0].label).toBe("0 ft");
    expect(c.xTicks.imperial.every((t) => t.label.endsWith(" ft"))).toBe(true);
    expect(c.xTicks.metric.every((t) => t.label.endsWith(" m"))).toBe(true);
  });

  it("pads flat profiles so small bumps don't look dramatic", () => {
    const c = buildElevationChart([
      [0, 100],
      [500, 102],
      [1000, 101],
    ])!;
    expect(c.domainMaxM - c.domainMinM).toBeGreaterThanOrEqual(40);
  });
});
