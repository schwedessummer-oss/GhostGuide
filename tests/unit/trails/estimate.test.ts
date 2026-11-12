import { describe, expect, it } from "vitest";
import {
  classifyDifficulty,
  difficultyFromSacScale,
  effortDifficulty,
  effortScore,
  estimateDurationMin,
  estimateOutAndBackMin,
  hikeEffortOf,
  isFamilyFriendly,
  qualityScore,
  QUALITY_WEIGHTS,
  reverseProfile,
  sacScaleRank,
  toblerSpeedKmh,
  type QualityFields,
} from "@/server/trails/estimate";

/** Profile with a point every `step` m and elevation = start + slope · distance. */
const slopeProfile = (lengthM: number, slope: number, step = 100, start = 1000): [number, number][] =>
  Array.from({ length: Math.round(lengthM / step) + 1 }, (_, i) => [i * step, start + slope * i * step]);

describe("Tobler's hiking function", () => {
  it("matches worked values", () => {
    expect(toblerSpeedKmh(0)).toBeCloseTo(5.0367, 4); // 6·e^(−0.175)
    expect(toblerSpeedKmh(-0.05)).toBe(6); // fastest: gentle descent
    expect(toblerSpeedKmh(0.1)).toBeCloseTo(3.5493, 4); // 6·e^(−0.525)
    expect(toblerSpeedKmh(-0.1)).toBeCloseTo(5.0367, 4); // |−0.1 + 0.05| = 0.05
    expect(toblerSpeedKmh(0.5)).toBeCloseTo(0.8753, 4); // 6·e^(−1.925)
    expect(toblerSpeedKmh(-0.5)).toBeCloseTo(1.2420, 4); // 6·e^(−1.575)
  });

  it("clamps extreme slopes and ignores non-finite ones", () => {
    expect(toblerSpeedKmh(3)).toBe(toblerSpeedKmh(0.5));
    expect(toblerSpeedKmh(-3)).toBe(toblerSpeedKmh(-0.5));
    expect(toblerSpeedKmh(NaN)).toBe(toblerSpeedKmh(0));
  });
});

describe("estimateDurationMin", () => {
  it("uses 4.5 km/h without a profile", () => {
    expect(estimateDurationMin({ distanceM: 9000, profile: null })).toBe(120);
    expect(estimateDurationMin({ distanceM: 1000, profile: null })).toBe(13); // 13.3
    expect(estimateDurationMin({ distanceM: 300, profile: null })).toBe(5); // 4 → minimum 5
    expect(estimateDurationMin({ distanceM: 0, profile: null })).toBe(5);
  });

  it("applies the pace factor to the time", () => {
    expect(estimateDurationMin({ distanceM: 9000, profile: null, paceFactor: 1.5 })).toBe(180);
    expect(estimateDurationMin({ distanceM: 9000, profile: null, paceFactor: 0.75 })).toBe(90);
    for (const bad of [0, -1, NaN, Infinity]) expect(estimateDurationMin({ distanceM: 9000, profile: null, paceFactor: bad })).toBe(120);
  });

  it("walks a flat profile at Tobler's flat speed", () => {
    // 10 km / 5.0367 km/h = 119.1 min
    expect(estimateDurationMin({ distanceM: 10_000, profile: slopeProfile(10_000, 0) })).toBe(119);
  });

  it("slows down uphill and speeds up on gentle descents (worked example)", () => {
    // 5 km at +10 %: 5 / 3.5493 km/h = 84.5 min; reversed (−10 %): 5 / 5.0367 = 59.6 min.
    const climb = slopeProfile(5000, 0.1);
    expect(estimateDurationMin({ distanceM: 5000, profile: climb })).toBe(85);
    expect(estimateDurationMin({ distanceM: 5000, profile: reverseProfile(climb) })).toBe(60);
    // Smoothing must not change a steady slope, whatever the point spacing.
    expect(estimateDurationMin({ distanceM: 5000, profile: slopeProfile(5000, 0.1, 10) })).toBe(85);
  });

  it("clamps very steep terrain to ±50 %", () => {
    // 1 km at +60 % → treated as +50 %: 1 / 0.8753 km/h = 68.5 min
    expect(estimateDurationMin({ distanceM: 1000, profile: slopeProfile(1000, 0.6) })).toBe(69);
  });

  it("smooths DEM noise so it does not turn into phantom slopes", () => {
    // ±2 m alternating every 10 m: raw slopes of ±40 % would take ~41 min for 1 km.
    const noisy: [number, number][] = Array.from({ length: 101 }, (_, i) => [i * 10, 500 + (i % 2 ? 2 : -2)]);
    const minutes = estimateDurationMin({ distanceM: 1000, profile: noisy });
    expect(minutes).toBeGreaterThanOrEqual(12); // flat: 11.9 min
    expect(minutes).toBeLessThanOrEqual(13);
  });

  it("does not walk the jump between disconnected lines", () => {
    const profile: [number, number][] = [
      [0, 100],
      [1000, 100],
      [1000, 900],
      [2000, 900],
    ];
    // Two flat kilometres: 2 / 5.0367 km/h = 23.8 min
    expect(estimateDurationMin({ distanceM: 2000, profile })).toBe(24);
  });

  it("scales the profile's time to the authoritative distance", () => {
    expect(estimateDurationMin({ distanceM: 2000, profile: slopeProfile(1000, 0) })).toBe(24);
  });

  it("falls back to the flat speed for unusable profiles and never throws on bad points", () => {
    const junk = [[NaN, 1], "x", [0], null, [5, Infinity]] as unknown as [number, number][];
    expect(estimateDurationMin({ distanceM: 9000, profile: junk })).toBe(120);
    expect(estimateDurationMin({ distanceM: 9000, profile: [[0, 100]] })).toBe(120);
    expect(estimateDurationMin({ distanceM: 9000, profile: [] })).toBe(120);
    const unsorted: [number, number][] = [
      [1000, 500],
      [0, 500],
      [500, 500],
    ];
    expect(estimateDurationMin({ distanceM: 1000, profile: unsorted })).toBe(12);
  });

  it("rejects invalid distances", () => {
    expect(() => estimateDurationMin({ distanceM: NaN, profile: null })).toThrow(RangeError);
    expect(() => estimateDurationMin({ distanceM: -1, profile: null })).toThrow(RangeError);
  });
});

describe("estimateOutAndBackMin", () => {
  it("walks out along the profile and back along its reverse", () => {
    // 84.52 + 59.56 = 144.1 min (rounded once)
    expect(estimateOutAndBackMin(5000, slopeProfile(5000, 0.1))).toBe(144);
    expect(estimateOutAndBackMin(5000, slopeProfile(5000, 0.1), 2)).toBe(288);
    expect(estimateOutAndBackMin(9000, null)).toBe(240);
    expect(estimateOutAndBackMin(100, null)).toBe(5);
    expect(() => estimateOutAndBackMin(Infinity, null)).toThrow(RangeError);
  });

  it("reverses profiles including discontinuities", () => {
    expect(reverseProfile([
      [0, 10],
      [400, 50],
      [400, 80],
      [1000, 20],
    ])).toEqual([
      [0, 20],
      [600, 80],
      [600, 50],
      [1000, 10],
    ]);
    expect(reverseProfile([])).toEqual([]);
  });
});

describe("SAC scale", () => {
  it("maps every OSM grade", () => {
    expect(difficultyFromSacScale("hiking")).toBe("easy");
    expect(difficultyFromSacScale("mountain_hiking")).toBe("moderate");
    expect(difficultyFromSacScale("demanding_mountain_hiking")).toBe("hard");
    expect(difficultyFromSacScale("alpine_hiking")).toBe("expert");
    expect(difficultyFromSacScale("demanding_alpine_hiking")).toBe("expert");
    expect(difficultyFromSacScale("difficult_alpine_hiking")).toBe("expert");
  });

  it("accepts T1–T6, case and whitespace variants, and lists (hardest wins)", () => {
    expect(difficultyFromSacScale("T1")).toBe("easy");
    expect(difficultyFromSacScale("t3")).toBe("hard");
    expect(difficultyFromSacScale(" Mountain_Hiking ")).toBe("moderate");
    expect(difficultyFromSacScale("hiking;alpine_hiking")).toBe("expert");
    expect(sacScaleRank("hiking")).toBe(0);
    expect(sacScaleRank("difficult_alpine_hiking")).toBe(5);
  });

  it("returns null for missing or unknown values", () => {
    for (const v of [null, undefined, "", "  ", "yes", "T7", "hiking;foo", "alpine"]) {
      expect(difficultyFromSacScale(v)).toBeNull();
    }
  });
});

describe("effort difficulty", () => {
  it("scores km + gain/100 against the documented thresholds", () => {
    expect(effortScore({ distanceM: 5000, gainM: 100 })).toBe(6);
    expect(effortDifficulty({ distanceM: 5990, gainM: 0 })).toBe("easy");
    expect(effortDifficulty({ distanceM: 6000, gainM: 0 })).toBe("moderate");
    expect(effortDifficulty({ distanceM: 5000, gainM: 99 })).toBe("easy"); // 5.99
    expect(effortDifficulty({ distanceM: 5000, gainM: 100 })).toBe("moderate"); // 6
    expect(effortDifficulty({ distanceM: 10_000, gainM: 290 })).toBe("moderate"); // 12.9
    expect(effortDifficulty({ distanceM: 10_000, gainM: 300 })).toBe("hard"); // 13
    expect(effortDifficulty({ distanceM: 15_000, gainM: 690 })).toBe("hard"); // 21.9
    expect(effortDifficulty({ distanceM: 15_000, gainM: 700 })).toBe("expert"); // 22
  });

  it("uses distance alone when gain is unknown", () => {
    expect(effortDifficulty({ distanceM: 21_900, gainM: null })).toBe("hard");
    expect(effortDifficulty({ distanceM: 22_000, gainM: null })).toBe("expert");
    expect(effortDifficulty({ distanceM: 4000, gainM: NaN })).toBe("easy");
    expect(effortDifficulty({ distanceM: 4000, gainM: -50 })).toBe("easy");
  });

  it("is unknown for invalid distances", () => {
    expect(effortDifficulty({ distanceM: NaN, gainM: 100 })).toBe("unknown");
    expect(effortDifficulty({ distanceM: -5, gainM: 100 })).toBe("unknown");
    expect(effortScore({ distanceM: Infinity, gainM: null })).toBeNull();
  });

  it("uses the out-and-back hike for linear routes", () => {
    expect(hikeEffortOf({ distanceM: 4000, gainM: 300, routeType: "linear" })).toEqual({ distanceM: 8000, gainM: 300 });
    expect(hikeEffortOf({ distanceM: 4000, gainM: 300, lossM: 120, routeType: "linear" })).toEqual({ distanceM: 8000, gainM: 420 });
    expect(hikeEffortOf({ distanceM: 4000, gainM: 300, lossM: 120, routeType: "loop" })).toEqual({ distanceM: 4000, gainM: 300 });
    expect(hikeEffortOf({ distanceM: 4000, gainM: null, lossM: 120, routeType: "linear" })).toEqual({ distanceM: 8000, gainM: null });
  });
});

describe("classifyDifficulty", () => {
  it("credits the SAC grade when it decides (including ties)", () => {
    // effort 3 + 1 = 4 → easy; SAC hiking → easy: tie → SAC
    expect(classifyDifficulty({ sacScale: "hiking", distanceM: 3000, gainM: 100, routeType: "loop" })).toEqual({ difficulty: "easy", source: "osm_sac_scale" });
    // effort 4 + 2 = 6 → moderate; SAC T3 → hard
    expect(classifyDifficulty({ sacScale: "demanding_mountain_hiking", distanceM: 4000, gainM: 200, routeType: "loop" })).toEqual({
      difficulty: "hard",
      source: "osm_sac_scale",
    });
    expect(classifyDifficulty({ sacScale: "alpine_hiking", distanceM: 2000, gainM: null, routeType: "linear" })).toEqual({
      difficulty: "expert",
      source: "osm_sac_scale",
    });
  });

  it("uses the effort grade when it is harder than the SAC grade", () => {
    // Linear 8 km one way, 300 m up: out-and-back 16 km + 3 = 19 → hard (SAC says easy)
    expect(classifyDifficulty({ sacScale: "hiking", distanceM: 8000, gainM: 300, routeType: "linear" })).toEqual({ difficulty: "hard", source: "estimated" });
    // …and with 300 m of descent to climb back: 16 + 6 = 22 → expert
    expect(classifyDifficulty({ sacScale: "hiking", distanceM: 8000, gainM: 300, lossM: 300, routeType: "linear" })).toEqual({
      difficulty: "expert",
      source: "estimated",
    });
  });

  it("estimates when no usable SAC grade exists", () => {
    expect(classifyDifficulty({ sacScale: null, distanceM: 4000, gainM: null, routeType: "loop" })).toEqual({ difficulty: "easy", source: "estimated" });
    // Same 4 km as a linear route is an 8 km out-and-back → moderate
    expect(classifyDifficulty({ sacScale: null, distanceM: 4000, gainM: null, routeType: "linear" })).toEqual({ difficulty: "moderate", source: "estimated" });
    expect(classifyDifficulty({ sacScale: "weird", distanceM: 4000, gainM: 0, routeType: "network" })).toEqual({ difficulty: "easy", source: "estimated" });
    expect(classifyDifficulty({ sacScale: null, distanceM: NaN, gainM: null, routeType: "loop" }).difficulty).toBe("unknown");
    expect(classifyDifficulty({ sacScale: "mountain_hiking", distanceM: NaN, gainM: null, routeType: "loop" })).toEqual({
      difficulty: "moderate",
      source: "osm_sac_scale",
    });
  });
});

describe("isFamilyFriendly", () => {
  const base = { difficulty: "easy" as const, sacScale: null, distanceM: 4000, gainM: 100, routeType: "loop" as const };

  it("accepts short, gentle, easy routes with known climb", () => {
    expect(isFamilyFriendly(base)).toBe(true);
    expect(isFamilyFriendly({ ...base, sacScale: "hiking" })).toBe(true);
    expect(isFamilyFriendly({ ...base, distanceM: 6000, gainM: 250 })).toBe(true); // limits are inclusive
  });

  it("uses the out-and-back hike for linear routes", () => {
    expect(isFamilyFriendly({ ...base, routeType: "linear", distanceM: 2500, gainM: 100, lossM: 100 })).toBe(true); // 5 km, 200 m
    expect(isFamilyFriendly({ ...base, routeType: "linear", distanceM: 3500 })).toBe(false); // 7 km
    expect(isFamilyFriendly({ ...base, routeType: "linear", distanceM: 2500, gainM: 100, lossM: 200 })).toBe(false); // 300 m
  });

  it("rejects anything not clearly suitable", () => {
    expect(isFamilyFriendly({ ...base, difficulty: "moderate" })).toBe(false);
    expect(isFamilyFriendly({ ...base, difficulty: "unknown" })).toBe(false);
    expect(isFamilyFriendly({ ...base, sacScale: "mountain_hiking" })).toBe(false);
    expect(isFamilyFriendly({ ...base, sacScale: "garbage" })).toBe(false);
    expect(isFamilyFriendly({ ...base, gainM: null })).toBe(false);
    expect(isFamilyFriendly({ ...base, gainM: 251 })).toBe(false);
    expect(isFamilyFriendly({ ...base, distanceM: 6001 })).toBe(false);
    expect(isFamilyFriendly({ ...base, distanceM: NaN })).toBe(false);
  });
});

describe("qualityScore", () => {
  const complete: QualityFields = {
    name: "Mount Si Trail",
    distanceM: 6400,
    elevationGainM: 960,
    sacScale: "mountain_hiking",
    surfaces: ["dirt"],
    trailheadSource: "osm_trailhead",
    description: "Steep forest trail to a viewpoint.",
    website: "https://example.org/mount-si",
    operator: "Washington DNR",
    trailVisibility: "excellent",
    routeType: "linear",
    dogPolicy: "leashed",
    feeRequired: true,
  };

  it("has weights that sum to 100", () => {
    expect(Object.values(QUALITY_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("scores a complete record 100 and an empty one 0", () => {
    expect(qualityScore(complete)).toBe(100);
    expect(qualityScore({})).toBe(0);
  });

  it("scores worked partial examples", () => {
    // name 20 + geometry 15 + elevation 15 + route_start 3 + route type 2
    expect(qualityScore({ name: "Ridge Loop", distanceM: 2400, elevationGainM: 120, trailheadSource: "route_start", routeType: "linear" })).toBe(55);
    // fallback name 5 + 450 m geometry 8; unknown route type / dog policy earn nothing
    expect(qualityScore({ name: "Path 12", nameIsFallback: true, distanceM: 450, routeType: "unknown", dogPolicy: "unknown" })).toBe(13);
    expect(qualityScore({ distanceM: 120, trailheadSource: "parking", feeRequired: false, elevationGainM: 0 })).toBe(3 + 7 + 2 + 15);
  });

  it("only credits usable values", () => {
    const without = (patch: Partial<QualityFields>) => qualityScore({ ...complete, ...patch });
    expect(without({ website: "www.example.org" })).toBe(96);
    expect(without({ website: "javascript:alert(1)" })).toBe(96);
    expect(without({ sacScale: "foo" })).toBe(90);
    expect(without({ surfaces: ["", " "] })).toBe(94);
    expect(without({ name: "   " })).toBe(80);
    expect(without({ description: "" })).toBe(92);
    expect(without({ elevationGainM: null })).toBe(85);
    expect(without({ distanceM: NaN })).toBe(85);
    expect(without({ trailheadSource: null })).toBe(90);
  });
});
