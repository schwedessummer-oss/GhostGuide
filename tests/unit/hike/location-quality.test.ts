import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCATION_QUALITY,
  INITIAL_LOCATION_FILTER,
  accuracyGrade,
  assessFix,
  classifyStaleness,
  type GeoFix,
  type LocationFilterState,
} from "@/domain/location-quality";
import { at } from "./fixtures";

const fix = (east: number, t: number, accuracyM = 8): GeoFix => ({ ...at(east), accuracyM, timestamp: t * 1000 });
const NOW = 1_000_000;

describe("location quality", () => {
  it("accepts good fixes and marks only accurate ones as decision grade", () => {
    const a = assessFix(INITIAL_LOCATION_FILTER, fix(0, 0, 8), NOW);
    expect(a).toMatchObject({ accepted: true, decisionGrade: true });
    const b = assessFix(a.state, fix(10, 5, 60), NOW);
    expect(b).toMatchObject({ accepted: true, decisionGrade: false });
    expect(assessFix(b.state, fix(20, 10, 5000), NOW)).toMatchObject({ accepted: false, reason: "too_inaccurate" });
  });

  it("rejects stale/out-of-order, duplicate, future and invalid fixes", () => {
    const s = assessFix(INITIAL_LOCATION_FILTER, fix(0, 100), NOW).state;
    expect(assessFix(s, fix(5, 90), NOW).reason).toBe("out_of_order");
    expect(assessFix(s, fix(0, 100), NOW).reason).toBe("duplicate");
    expect(assessFix(s, fix(5, 100 + 10_000), 100_000).reason).toBe("future");
    expect(assessFix(s, { ...fix(5, 101), lat: Number.NaN }, NOW).reason).toBe("invalid");
  });

  it("rejects implausible speed jumps but recovers after consistent new fixes", () => {
    let state: LocationFilterState = assessFix(INITIAL_LOCATION_FILTER, fix(0, 0), NOW).state;
    // 2 km in 2 s
    const j1 = assessFix(state, fix(2000, 2), NOW);
    expect(j1).toMatchObject({ accepted: false, reason: "implausible_speed" });
    state = j1.state;
    const j2 = assessFix(state, fix(2001, 4), NOW);
    expect(j2.accepted).toBe(false);
    state = j2.state;
    // third consecutive "jump" → the old position was the outlier; accept
    const j3 = assessFix(state, fix(2002, 6), NOW);
    expect(j3.accepted).toBe(true);
    expect(j3.state.jumpRejects).toBe(0);
    // walking pace is fine; large accuracy radii explain larger moves
    expect(assessFix(j3.state, fix(2010, 10), NOW).accepted).toBe(true);
    const s2 = assessFix(INITIAL_LOCATION_FILTER, fix(0, 0, 40), NOW).state;
    expect(assessFix(s2, fix(90, 2, 40), NOW).accepted).toBe(true);
  });

  it("classifies staleness and accuracy grades", () => {
    const cfg = DEFAULT_LOCATION_QUALITY;
    expect(classifyStaleness(null, NOW)).toBe("none");
    expect(classifyStaleness(NOW - 5_000, NOW)).toBe("fresh");
    expect(classifyStaleness(NOW - cfg.freshForMs - 1, NOW)).toBe("aging");
    expect(classifyStaleness(NOW - cfg.staleAfterMs - 1, NOW)).toBe("stale");
    expect(accuracyGrade(5)).toBe("good");
    expect(accuracyGrade(30)).toBe("fair");
    expect(accuracyGrade(80)).toBe("poor");
    expect(accuracyGrade(null)).toBe("unknown");
  });
});
