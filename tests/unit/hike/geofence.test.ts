import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEOFENCE_SETTINGS,
  INITIAL_GEOFENCE_STATE,
  effectiveRadiusM,
  geofenceStep,
  recordManualPlay,
  type GeofenceFix,
  type GeofencePoi,
  type GeofenceSettings,
  type GeofenceState,
} from "@/domain/geofence";
import { offsetMeters } from "@/domain/geo";
import { poiAlongPositions } from "@/domain/progress";
import { at, outAndBackModel } from "./fixtures";

const settings: GeofenceSettings = { ...DEFAULT_GEOFENCE_SETTINGS, requiredConsecutive: 3, minDwellMs: 0, cooldownMs: 20_000 };
const poiA: GeofencePoi = { id: "a", seq: 1, ...at(500), triggerRadiusM: 40, alongM: 500 };
const poiB: GeofencePoi = { id: "b", seq: 2, ...at(560), triggerRadiusM: 40, alongM: 560 };

function run(fixes: GeofenceFix[], pois: GeofencePoi[], s = settings, start: GeofenceState = INITIAL_GEOFENCE_STATE) {
  let state = start;
  const fired: { id: string; at: number }[] = [];
  for (const f of fixes) {
    const r = geofenceStep(state, f, pois, s);
    state = r.state;
    for (const id of r.triggered) fired.push({ id, at: f.timestamp });
  }
  return { state, fired };
}

const fix = (eastM: number, northM: number, t: number, accuracyM = 8, progressAlongM: number | null = eastM): GeofenceFix => ({
  ...at(eastM, northM),
  accuracyM,
  timestamp: t * 1000,
  progressAlongM,
});

describe("geofence triggers", () => {
  it("triggers once after N consecutive good-accuracy fixes inside the radius", () => {
    const { fired } = run([fix(440, 0, 1), fix(470, 0, 2), fix(490, 0, 3), fix(500, 0, 4), fix(505, 0, 5)], [poiA]);
    // 440 m is outside the 40 m radius; 470, 490 and 500 m are the three qualifying fixes
    expect(fired).toEqual([{ id: "a", at: 4000 }]);
  });

  it("gates on accuracy: poor fixes never trigger and never reset the counter", () => {
    const poor = run([fix(500, 0, 1, 80), fix(500, 0, 2, 80), fix(500, 0, 3, 80), fix(500, 0, 4, 80)], [poiA]);
    expect(poor.fired).toEqual([]);
    // two good fixes, a poor one in between, then a third good fix → trigger on the third good fix
    const mixed = run([fix(495, 0, 1), fix(498, 0, 2), fix(900, 0, 3, 200), fix(500, 0, 4)], [poiA]);
    expect(mixed.fired).toEqual([{ id: "a", at: 4000 }]);
  });

  it("requires consecutive qualifying fixes (a single inside fix does not trigger)", () => {
    const { fired, state } = run([fix(500, 0, 1), fix(500, 120, 2), fix(500, 0, 3), fix(500, 120, 4)], [poiA]);
    expect(fired).toEqual([]);
    expect(state.triggered.a).toBeUndefined();
  });

  it("supports a minimum dwell as an alternative to the fix count", () => {
    const s = { ...settings, requiredConsecutive: 5, minDwellMs: 10_000 };
    // sparse fixes: only 2 inside, but 12 s apart
    const { fired } = run([fix(495, 0, 0), fix(500, 0, 12)], [poiA], s);
    expect(fired).toEqual([{ id: "a", at: 12_000 }]);
    const short = run([fix(495, 0, 0), fix(500, 0, 3)], [poiA], s);
    expect(short.fired).toEqual([]);
  });

  it("GPS drift oscillating across the boundary does NOT retrigger", () => {
    const fixes: GeofenceFix[] = [];
    for (let t = 0; t < 60; t++) {
      // ±45 m north of the POI: alternately just inside (35 m) and just outside the 40 m radius
      fixes.push(fix(500, t % 2 ? 45 : 35, t));
    }
    // then leave and come back (still the same session)
    fixes.push(fix(800, 0, 100), fix(500, 0, 200), fix(500, 0, 201), fix(500, 0, 202), fix(500, 0, 203));
    const { fired } = run(fixes, [poiA], { ...settings, sequenceWindowM: 10_000 });
    expect(fired.map((f) => f.id)).toEqual(["a"]);
  });

  it("drift that never stays inside (beyond the hysteresis exit radius in between) never triggers", () => {
    const fixes: GeofenceFix[] = [];
    for (let t = 0; t < 30; t++) fixes.push(fix(500, t % 2 ? 70 : 30, t, 8, 500));
    expect(run(fixes, [poiA]).fired).toEqual([]);
  });

  it("does not retrigger on the return leg of an out-and-back (sequence awareness)", () => {
    const model = outAndBackModel(1000);
    const poi: GeofencePoi = { id: "mid", seq: 1, ...at(300), triggerRadiusM: 40 };
    poi.alongM = poiAlongPositions(model, [poi]).mid;
    expect(poi.alongM).toBeCloseTo(300, 0);
    // outbound pass: progress ≈ 300 → triggers
    const out = run([fix(300, 0, 1, 8, 300), fix(300, 0, 2, 8, 300), fix(300, 0, 3, 8, 300)], [poi]);
    expect(out.fired.map((f) => f.id)).toEqual(["mid"]);
    // return pass at the same place: progress ≈ 1700 → already triggered and out of sequence
    const back = run([fix(300, 0, 500, 8, 1700), fix(300, 0, 501, 8, 1700), fix(300, 0, 502, 8, 1700)], [poi], settings, out.state);
    expect(back.fired).toEqual([]);
    // a POI MISSED on the way out (e.g. bad GPS) is also not auto-played on the return leg
    const missed = run([fix(300, 0, 500, 8, 1700), fix(300, 0, 501, 8, 1700), fix(300, 0, 502, 8, 1700)], [poi]);
    expect(missed.fired).toEqual([]);
  });

  it("enforces a cooldown between automatic triggers, then plays the waiting POI", () => {
    const pois = [poiA, poiB];
    // both POIs within radius of x=530: A fires first (sequence order), B waits for cooldown
    const fixes = [1, 2, 3, 4, 5, 10, 22, 23].map((t) => fix(530, 0, t, 8, 530));
    const { fired } = run(fixes, pois);
    expect(fired[0]).toEqual({ id: "a", at: 3000 });
    expect(fired[1].id).toBe("b");
    expect(fired[1].at - fired[0].at).toBeGreaterThanOrEqual(settings.cooldownMs);
  });

  it("manual replay is always allowed and prevents a later duplicate auto-trigger", () => {
    let state = recordManualPlay(INITIAL_GEOFENCE_STATE, "a", 1000);
    state = recordManualPlay(state, "a", 1500); // replay again immediately — allowed
    expect(state.manualPlays.a).toBe(2);
    const { fired } = run([fix(500, 0, 10), fix(500, 0, 11), fix(500, 0, 12)], [poiA], settings, state);
    expect(fired).toEqual([]);
    // replaying a GPS-triggered POI keeps its gps record
    const auto = run([fix(500, 0, 10), fix(500, 0, 11), fix(500, 0, 12)], [poiA]);
    const replayed = recordManualPlay(auto.state, "a", 20_000);
    expect(replayed.triggered.a.source).toBe("gps");
  });

  it("uses a configurable trigger distance (multiplier and override)", () => {
    expect(effectiveRadiusM(poiA, { ...settings, radiusMultiplier: 2 })).toBe(80);
    expect(effectiveRadiusM(poiA, { ...settings, radiusMultiplier: 0.5 })).toBe(20);
    expect(effectiveRadiusM(poiA, { ...settings, radiusMultiplier: 9 })).toBe(80); // clamped to 2x
    expect(effectiveRadiusM(poiA, { ...settings, radiusOverrideM: 120 })).toBe(120);
    const p = offsetMeters(at(500), 0, 60);
    const near = (t: number): GeofenceFix => ({ ...p, accuracyM: 8, timestamp: t * 1000, progressAlongM: 500 });
    expect(run([near(1), near(2), near(3)], [poiA]).fired).toEqual([]);
    expect(run([near(1), near(2), near(3)], [poiA], { ...settings, radiusMultiplier: 2 }).fired.map((f) => f.id)).toEqual(["a"]);
    expect(run([near(1), near(2), near(3)], [poiA], { ...settings, radiusOverrideM: 75 }).fired.map((f) => f.id)).toEqual(["a"]);
  });
});
