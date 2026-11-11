import { describe, expect, it } from "vitest";
import { INITIAL_GEOFENCE_STATE, geofenceStep, mergeHeardPois, recordManualPlay, DEFAULT_GEOFENCE_SETTINGS } from "@/domain/geofence";
import { at } from "./fixtures";

describe("mergeHeardPois (stops the server already saw in this session)", () => {
  it("marks them heard without touching existing local records", () => {
    const local = recordManualPlay(INITIAL_GEOFENCE_STATE, "a", 1000);
    const merged = mergeHeardPois(local, ["a", "b"], 5000);
    expect(merged.triggered.a).toEqual({ at: 1000, source: "manual" });
    expect(merged.triggered.b).toEqual({ at: 5000, source: "gps" });
    expect(mergeHeardPois(merged, ["a", "b"], 9000)).toBe(merged); // nothing new → same object
  });

  it("merged stops never auto-trigger again", () => {
    const poi = { id: "b", seq: 1, ...at(100), triggerRadiusM: 30, alongM: 100 };
    let state = mergeHeardPois({ ...INITIAL_GEOFENCE_STATE, candidates: { b: { count: 2, firstAt: 0, lastAt: 1 } } }, ["b"], 0);
    expect(state.candidates.b).toBeUndefined();
    const fired: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = geofenceStep(state, { ...at(100), accuracyM: 5, timestamp: 10_000 + i * 2000, progressAlongM: 100 }, [poi], DEFAULT_GEOFENCE_SETTINGS);
      state = r.state;
      fired.push(...r.triggered);
    }
    expect(fired).toEqual([]);
  });
});
