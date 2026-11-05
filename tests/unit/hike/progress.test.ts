import { describe, expect, it } from "vitest";
import {
  INITIAL_PROGRESS,
  activeElapsedMs,
  estimateRemainingMin,
  pausesFromEvents,
  poiAlongPositions,
  progressFraction,
  progressStep,
  remainingM,
  vertexIndexAt,
  type ProgressState,
} from "@/domain/progress";
import { at, lineModel, outAndBackModel } from "./fixtures";

describe("route progress", () => {
  it("is monotonic along an out-and-back thanks to the progress hint", () => {
    const model = outAndBackModel(1000); // 2 km total
    let state: ProgressState = INITIAL_PROGRESS;
    const seen: number[] = [];
    // walk out to 1000 m and back to the start, one fix every 20 m / 15 s
    for (let d = 0, t = 0; d <= 2000; d += 20, t += 15) {
      const east = d <= 1000 ? d : 2000 - d;
      const r = progressStep(state, { ...at(east, 3), accuracyM: 8, timestamp: t * 1000 }, model);
      state = r.state;
      seen.push(state.alongM);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    // on the return leg near the start we are near the END of the route, not back at the beginning
    expect(state.alongM).toBeGreaterThan(1950);
    expect(remainingM(model, state.alongM)).toBeLessThan(50);
    expect(progressFraction(model, state.alongM)).toBeGreaterThan(0.97);
  });

  it("never moves backwards when the hiker backtracks", () => {
    const model = lineModel(2000);
    let s = progressStep(INITIAL_PROGRESS, { ...at(600), accuracyM: 5, timestamp: 0 }, model).state;
    s = progressStep(s, { ...at(400), accuracyM: 5, timestamp: 60_000 }, model).state;
    expect(s.alongM).toBeCloseTo(600, 0);
  });

  it("ignores poor-accuracy and far-off-route fixes and caps implausible forward jumps", () => {
    const model = lineModel(2000);
    let s = progressStep(INITIAL_PROGRESS, { ...at(100), accuracyM: 5, timestamp: 0 }, model).state;
    const poor = progressStep(s, { ...at(900), accuracyM: 120, timestamp: 10_000 }, model);
    expect(poor.used).toBe(false);
    const off = progressStep(s, { ...at(300, 400), accuracyM: 5, timestamp: 10_000 }, model);
    expect(off.used).toBe(false);
    expect(off.projection?.distanceFromRouteM).toBeGreaterThan(390);
    // 1.5 km in 10 s is impossible on foot → capped to plausible movement
    s = progressStep(s, { ...at(1600), accuracyM: 5, timestamp: 10_000 }, model).state;
    expect(s.alongM).toBeLessThan(100 + 10 * 3.5 + 60 + 5 + 1);
  });

  it("maps progress to the walked vertex and places POIs in sequence on the outbound leg", () => {
    const model = outAndBackModel(1000);
    expect(vertexIndexAt(model, 0)).toBe(0);
    expect(vertexIndexAt(model, 125)).toBe(2);
    expect(vertexIndexAt(model, 5000)).toBe(model.coords.length - 1);
    const pois = [
      { id: "p1", seq: 1, ...at(200) },
      { id: "p2", seq: 2, ...at(950) },
    ];
    const along = poiAlongPositions(model, pois);
    expect(along.p1).toBeCloseTo(200, 0);
    expect(along.p2).toBeCloseTo(950, 0);
  });

  it("computes active elapsed time excluding pauses", () => {
    const start = 0;
    const pauses = [
      { start: 10 * 60_000, end: 15 * 60_000 },
      { start: 40 * 60_000, end: null },
    ];
    expect(activeElapsedMs(start, pauses, 30 * 60_000)).toBe(25 * 60_000);
    expect(activeElapsedMs(start, pauses, 50 * 60_000)).toBe(35 * 60_000);
    expect(activeElapsedMs(null, pauses, 50 * 60_000)).toBe(0);
    expect(
      pausesFromEvents([
        { kind: "resume", at: 5 },
        { kind: "pause", at: 10 },
        { kind: "pause", at: 12 },
        { kind: "resume", at: 20 },
      ]),
    ).toEqual([{ start: 10, end: 20 }]);
  });

  it("estimates remaining time from observed pace when there is enough data, else from the plan", () => {
    const planned = estimateRemainingMin({ remainingM: 1500, alongM: 500 - 1, activeElapsedMs: 5 * 60_000, plannedTotalMin: 60, totalM: 2000 });
    expect(planned).toEqual({ minutes: 45, basis: "planned" });
    const observed = estimateRemainingMin({ remainingM: 1000, alongM: 1000, activeElapsedMs: 20 * 60_000, plannedTotalMin: 60, totalM: 2000 });
    expect(observed).toEqual({ minutes: 20, basis: "observed" });
    expect(estimateRemainingMin({ remainingM: 10, alongM: 0, activeElapsedMs: 0, plannedTotalMin: null, totalM: 2000 }).basis).toBe("none");
  });
});
