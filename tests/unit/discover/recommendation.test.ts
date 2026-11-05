import { describe, expect, it } from "vitest";
import {
  ACCESS_NEED_FEATURE,
  ACCESS_NEEDS,
  closureOverlapsDay,
  recommendTrails,
  type CandidateTrail,
  type ExclusionCode,
} from "@/domain/recommendation";
import { candidate, ctx, prefs } from "./fixtures";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function evaluate(c: CandidateTrail, p = prefs(), context = ctx) {
  return recommendTrails(p, [c], context);
}

function excludedCodes(c: CandidateTrail, p = prefs(), context = ctx): ExclusionCode[] {
  return evaluate(c, p, context).excluded[0]?.codes ?? [];
}

describe("recommendTrails — hard filters", () => {
  it("ranks a trail that meets every constraint", () => {
    const r = evaluate(candidate());
    expect(r.ranked).toHaveLength(1);
    expect(r.excluded).toHaveLength(0);
    expect(r.noMatch).toBe(false);
    // 100 min catalog × 1.0 pace + 2 stops × 5 min
    expect(r.ranked[0].estimatedDurationMin).toBe(110);
    expect(r.ranked[0].estimatedFinishTime).toBe("09:50");
  });

  it("excludes drafts and trails without validated geometry", () => {
    expect(excludedCodes(candidate({ status: "draft" }))).toContain("status");
    expect(excludedCodes(candidate({ status: "closed" }))).toContain("status");
    expect(excludedCodes(candidate({ hasGeometry: false }))).toContain("geometry");
    expect(excludedCodes(candidate({ geometryValidatedAt: null }))).toContain("geometry");
  });

  it("time: estimated duration with pace factor must fit the available hours", () => {
    expect(excludedCodes(candidate(), prefs({ availableHours: 1.5 }))).toEqual(["time"]);
    expect(evaluate(candidate(), prefs({ availableHours: 2 })).ranked).toHaveLength(1);
    // a leisurely, low-fitness group of 9 is ~1.65× slower: 165 + 10 = 175 min > 2.5 h
    expect(excludedCodes(candidate(), prefs({ availableHours: 2.5, pace: "leisurely", fitness: "low", partySize: 9 }))).toContain("time");
  });

  it("distance range applies a stated 10% tolerance", () => {
    expect(excludedCodes(candidate({ distanceKm: 5 }), prefs({ distanceKmMin: 6 }))).toEqual(["distance"]);
    expect(excludedCodes(candidate({ distanceKm: 5 }), prefs({ distanceKmMax: 4 }))).toEqual(["distance"]);
    // 5 km is within 10% of a 4.6 km maximum and a 5.5 km minimum
    expect(evaluate(candidate({ distanceKm: 5 }), prefs({ distanceKmMax: 4.6 })).ranked).toHaveLength(1);
    expect(evaluate(candidate({ distanceKm: 5 }), prefs({ distanceKmMin: 5.5 })).ranked).toHaveLength(1);
  });

  it("elevation gain must not exceed the maximum", () => {
    expect(excludedCodes(candidate({ elevationGainM: 200 }), prefs({ maxElevationGainM: 150 }))).toEqual(["elevation"]);
    expect(evaluate(candidate({ elevationGainM: 200 }), prefs({ maxElevationGainM: 200 })).ranked).toHaveLength(1);
  });

  it("every accessibility need must be satisfied by an explicitly mapped catalog feature", () => {
    for (const need of ACCESS_NEEDS) {
      const feature = ACCESS_NEED_FEATURE[need];
      expect(excludedCodes(candidate({ accessibilityFeatures: [] }), prefs({ accessibilityNeeds: [need] }))).toEqual(["accessibility"]);
      expect(evaluate(candidate({ accessibilityFeatures: [feature] }), prefs({ accessibilityNeeds: [need] })).ranked).toHaveLength(1);
    }
    // two needs, one missing → excluded with exactly one reason
    const r = evaluate(candidate({ accessibilityFeatures: ["benches"] }), prefs({ accessibilityNeeds: ["rest_stops", "shade"] }));
    expect(r.excluded[0].reasons).toHaveLength(1);
    expect(r.excluded[0].reasons[0]).toMatch(/Shade/);
  });

  it("dog policy: not allowed and unknown both exclude when bringing a dog", () => {
    const no = evaluate(candidate({ dogsAllowed: false }), prefs({ bringingDog: true }));
    expect(no.excluded[0].reasons[0]).toMatch(/not allowed/);
    const unknown = evaluate(candidate({ dogsAllowed: null }), prefs({ bringingDog: true }));
    expect(unknown.excluded[0].reasons[0]).toMatch(/dog policy unverified/i);
    // no dog → policy irrelevant
    expect(evaluate(candidate({ dogsAllowed: null }), prefs({ bringingDog: false })).ranked).toHaveLength(1);
  });

  it("experience and fitness caps", () => {
    expect(excludedCodes(candidate({ difficulty: "hard" }), prefs({ experience: "new", fitness: "high" }))).toEqual(["experience"]);
    expect(evaluate(candidate({ difficulty: "moderate" }), prefs({ experience: "new" })).ranked).toHaveLength(1);
    expect(excludedCodes(candidate({ difficulty: "hard" }), prefs({ experience: "expert", fitness: "low" }))).toEqual(["experience"]);
    expect(excludedCodes(candidate({ difficulty: "strenuous" }), prefs({ experience: "some", fitness: "high" }))).toEqual(["experience"]);
    expect(excludedCodes(candidate({ difficulty: "strenuous" }), prefs({ experience: "expert", fitness: "moderate" }))).toEqual(["experience"]);
    expect(evaluate(candidate({ difficulty: "strenuous" }), prefs({ experience: "regular", fitness: "high" })).ranked).toHaveLength(1);
    expect(evaluate(candidate({ difficulty: "hard" }), prefs({ experience: "some", fitness: "moderate" })).ranked).toHaveLength(1);
  });

  it("full closure on the planned date excludes; partial closure and advisories only warn", () => {
    const fullOnDate = candidate({}, {
      closures: [{ severity: "closed", reason: "Bridge out (demo)", startsAt: new Date("2026-11-10T00:00:00Z"), endsAt: new Date("2026-11-20T00:00:00Z") }],
    });
    const r1 = evaluate(fullOnDate);
    expect(r1.excluded[0].codes).toEqual(["closure"]);
    expect(r1.excluded[0].reasons[0]).toMatch(/Fully closed.*Bridge out/);

    // a full closure that ends before the planned (region-local) day does not apply
    const endedBefore = candidate({}, {
      closures: [{ severity: "closed", reason: "Old", startsAt: new Date("2026-11-01T00:00:00Z"), endsAt: new Date("2026-11-14T07:00:00Z") }],
    });
    expect(evaluate(endedBefore).ranked).toHaveLength(1);

    const partial = candidate({}, {
      closures: [
        { severity: "partial", reason: "Upper switchbacks closed", startsAt: new Date("2026-11-01T00:00:00Z"), endsAt: null },
        { severity: "advisory", reason: "Muddy after rain", startsAt: new Date("2026-11-01T00:00:00Z"), endsAt: null },
      ],
    });
    const r2 = evaluate(partial);
    expect(r2.ranked).toHaveLength(1);
    expect(r2.ranked[0].warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^Partial closure: Upper/), expect.stringMatching(/^Advisory: Muddy/)]));
    const plain = evaluate(candidate()).ranked[0].score;
    expect(r2.ranked[0].score).toBe(plain - 14);
    expect(r2.ranked[0].breakdown.find((f) => f.factor === "Closures & advisories")!.points).toBe(-14);
  });

  it("closure day boundaries use the region time zone", () => {
    // Nov 13 in Los Angeles (PST, UTC-8) runs 08:00Z Nov 13 → 08:00Z Nov 14.
    expect(closureOverlapsDay({ startsAt: new Date("2026-11-14T08:00:00Z"), endsAt: null }, "2026-11-13", "America/Los_Angeles")).toBe(false);
    // 23:59 local on Nov 13 still counts for that day (a UTC-date comparison would miss this)
    expect(closureOverlapsDay({ startsAt: new Date("2026-11-14T07:59:00Z"), endsAt: null }, "2026-11-13", "America/Los_Angeles")).toBe(true);
    expect(closureOverlapsDay({ startsAt: new Date("2026-11-01T00:00:00Z"), endsAt: new Date("2026-11-13T08:00:00Z") }, "2026-11-13", "America/Los_Angeles")).toBe(false);
  });

  it("permit lead time: warn when required, exclude when it cannot be met", () => {
    const c = candidate({ permitRequired: true }, { permits: [{ name: "Day permit", leadTimeDays: 7 }] });
    const tooSoon = evaluate(c, prefs({ plannedDate: "2026-11-10" })); // 5 days away
    expect(tooSoon.excluded[0].codes).toEqual(["permit"]);
    expect(tooSoon.excluded[0].reasons[0]).toMatch(/7 days.*5 days away/);
    const ok = evaluate(c, prefs({ plannedDate: "2026-11-14" })); // 9 days away
    expect(ok.ranked[0].warnings.some((w) => /Permit required: Day permit/.test(w))).toBe(true);
  });

  it("start time + estimated duration must finish before the latest-finish estimate for that month", () => {
    // November latest finish 15:45; 110 min from 14:00 ends 15:50
    const late = evaluate(candidate(), prefs({ startTime: "14:00" }));
    expect(late.excluded[0].codes).toEqual(["latest_finish"]);
    expect(late.excluded[0].reasons[0]).toMatch(/15:50.*15:45.*November.*not an exact sunset/);
    expect(evaluate(candidate(), prefs({ startTime: "13:55" })).ranked).toHaveLength(1);
    // July has more daylight
    expect(evaluate(candidate(), prefs({ startTime: "14:00", plannedDate: "2027-07-10" })).ranked).toHaveLength(1);
    // finishing past midnight is always excluded
    expect(excludedCodes(candidate(), prefs({ startTime: "23:30", availableHours: 14 }))).toContain("latest_finish");
  });

  it("party size must fit the remaining daily capacity", () => {
    expect(excludedCodes(candidate({}, { capacityRemaining: 3 }), prefs({ partySize: 5 }))).toEqual(["capacity"]);
    expect(excludedCodes(candidate({}, { capacityRemaining: 0 }), prefs({ partySize: 1 }))).toEqual(["capacity"]);
    expect(evaluate(candidate({ dailyCapacity: 6 }, { capacityRemaining: null }), prefs({ partySize: 6 })).ranked).toHaveLength(1);
    expect(excludedCodes(candidate({ dailyCapacity: 6 }), prefs({ partySize: 7 }))).toEqual(["capacity"]);
  });

  it("collects every failing constraint for a trail", () => {
    const codes = excludedCodes(candidate({ difficulty: "strenuous", dogsAllowed: false, elevationGainM: 1200 }), prefs({ experience: "new", bringingDog: true, maxElevationGainM: 300 }));
    expect(codes).toEqual(expect.arrayContaining(["experience", "dogs", "elevation"]));
  });
});

describe("recommendTrails — no match and relax suggestions", () => {
  it("never invents a route: returns noMatch with concrete suggestions", () => {
    const cands = [
      candidate({ id: ID(1), name: "Alpha", estimatedDurationMin: 200 }),
      candidate({ id: ID(2), name: "Bravo", elevationGainM: 900, estimatedDurationMin: 120 }),
      candidate({ id: ID(3), name: "Charlie", dogsAllowed: false, estimatedDurationMin: 60 }),
    ];
    const r = recommendTrails(prefs({ availableHours: 2.5, maxElevationGainM: 500, bringingDog: true }), cands, ctx);
    expect(r.noMatch).toBe(true);
    expect(r.ranked).toEqual([]);
    expect(r.excluded.map((e) => e.trailId)).toEqual([ID(1), ID(2), ID(3)]);
    const text = r.relaxSuggestions.join("\n");
    expect(text).toMatch(/Allow at least 3\.5 h to include Alpha/);
    expect(text).toMatch(/Raise your maximum elevation gain to 2,953 ft to include Bravo/);
    expect(text).toMatch(/without a dog to include Charlie/);
  });

  it("suggests an earlier start when the latest-finish estimate is the blocker", () => {
    const r = recommendTrails(prefs({ startTime: "15:00" }), [candidate({ name: "Late" })], ctx);
    expect(r.noMatch).toBe(true);
    expect(r.relaxSuggestions.join(" ")).toMatch(/Start earlier, by 13:55/);
  });
});

describe("recommendTrails — scoring and ordering", () => {
  it("scores within 0–100 with a per-factor breakdown", () => {
    const r = evaluate(candidate(), prefs({ distanceKmMin: 4, distanceKmMax: 6, maxElevationGainM: 400 }));
    const s = r.ranked[0];
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
    expect(s.score).toBe(Math.max(0, Math.min(100, s.breakdown.reduce((a, f) => a + f.points, 0))));
    expect(s.breakdown.map((f) => f.factor)).toEqual([
      "Terrain match",
      "Distance fit",
      "Elevation fit",
      "Difficulty fit",
      "Time buffer",
      "Closures & advisories",
      "Accessibility",
      "Narration stops",
    ]);
    expect(s.breakdown.find((f) => f.factor === "Distance fit")!.points).toBe(20);
  });

  it("prefers better fits and breaks ties by name, independent of input order", () => {
    const cands = [
      candidate({ id: ID(4), name: "Zed Loop" }),
      candidate({ id: ID(5), name: "Able Loop" }),
      candidate({ id: ID(6), name: "Rocky Spur", terrain: ["rocky"] }), // no terrain match → lower
      candidate({ id: ID(7), name: "Middle Loop" }),
    ];
    const a = recommendTrails(prefs(), cands, ctx);
    const b = recommendTrails(prefs(), [...cands].reverse(), ctx);
    expect(a.ranked.map((r) => r.trailId)).toEqual([ID(5), ID(7), ID(4), ID(6)]);
    expect(b).toEqual(a);
  });

  it("never depends on AI or randomness: repeated runs are identical", () => {
    const cands = [candidate({ id: ID(8), name: "One" }), candidate({ id: ID(9), name: "Two", difficulty: "easy" })];
    expect(JSON.stringify(recommendTrails(prefs(), cands, ctx))).toBe(JSON.stringify(recommendTrails(prefs(), cands, ctx)));
  });

  it("adds equipment notes without excluding", () => {
    const r = evaluate(candidate({ difficulty: "hard", distanceKm: 13, elevationGainM: 700, routeType: "point_to_point", estimatedDurationMin: 200 }), prefs({ experience: "regular", fitness: "high", availableHours: 8 }));
    const w = r.ranked[0].warnings.join("\n");
    expect(w).toMatch(/map and compass/);
    expect(w).toMatch(/satellite communicator/);
    expect(w).toMatch(/trekking poles/);
    expect(w).toMatch(/shuttle/);
    const equipped = evaluate(
      candidate({ difficulty: "hard", distanceKm: 13, elevationGainM: 700, routeType: "point_to_point", estimatedDurationMin: 200 }),
      prefs({ experience: "regular", fitness: "high", availableHours: 8, equipment: ["map_and_compass", "satellite_communicator", "trekking_poles", "first_aid_kit", "headlamp"] }),
    );
    expect(equipped.ranked[0].warnings.join("\n")).not.toMatch(/map and compass|satellite|trekking poles|first-aid/);
  });
});
