import { describe, expect, it } from "vitest";
import { DEFAULT_SIMULATOR_CONFIG, createSimulatorState, detourOffsetM, simulatorStep, type SimulatorConfig } from "@/domain/gps-simulator";
import { projectOntoLine } from "@/domain/geo";
import type { GeoFix } from "@/domain/location-quality";
import { lineModel } from "./fixtures";

const model = lineModel(2000);

function walk(seed: number, config: SimulatorConfig, steps: number, dtMs = 2000) {
  let state = createSimulatorState(seed);
  const fixes: (GeoFix | null)[] = [];
  for (let i = 0; i < steps; i++) {
    const r = simulatorStep(state, model, config, dtMs, 1_000_000 + i * dtMs);
    state = r.state;
    fixes.push(r.fix);
  }
  return { state, fixes };
}

describe("GPS simulator", () => {
  it("is deterministic for a given seed", () => {
    const a = walk(42, DEFAULT_SIMULATOR_CONFIG, 50);
    const b = walk(42, DEFAULT_SIMULATOR_CONFIG, 50);
    expect(a.fixes).toEqual(b.fixes);
    const c = walk(7, DEFAULT_SIMULATOR_CONFIG, 50);
    expect(c.fixes).not.toEqual(a.fixes);
  });

  it("walks the route at the configured speed, with speed-up, and stops at the end", () => {
    const { state } = walk(1, { ...DEFAULT_SIMULATOR_CONFIG, speedMps: 1.5 }, 10, 2000);
    expect(state.alongM).toBeCloseTo(30, 5);
    const fast = walk(1, { ...DEFAULT_SIMULATOR_CONFIG, speedMps: 1.5, speedUp: 10 }, 10, 2000);
    expect(fast.state.alongM).toBeCloseTo(300, 5);
    const done = walk(1, { ...DEFAULT_SIMULATOR_CONFIG, speedMps: 5, speedUp: 20 }, 50, 2000);
    expect(done.state.finished).toBe(true);
    expect(done.state.alongM).toBe(model.totalM);
  });

  it("stays near the route with noise and varying accuracy", () => {
    const { fixes } = walk(3, { ...DEFAULT_SIMULATOR_CONFIG, poorFixChance: 0 }, 100);
    const accs = new Set<number>();
    for (const f of fixes) {
      expect(f).not.toBeNull();
      const d = projectOntoLine(f!, model.coords, model.cum).distanceFromRouteM;
      expect(d).toBeLessThan(30);
      accs.add(f!.accuracyM);
    }
    expect(accs.size).toBeGreaterThan(10);
  });

  it("detours away from the route to demonstrate off-route prompts", () => {
    const detour = { startAlongM: 100, lengthM: 400, offsetM: 90 };
    expect(detourOffsetM(detour, 50)).toBe(0);
    expect(detourOffsetM(detour, 300)).toBe(90);
    const cfg = { ...DEFAULT_SIMULATOR_CONFIG, speedMps: 2, noiseM: 1, driftM: 1, poorFixChance: 0, detour };
    const { fixes } = walk(9, cfg, 150, 1000);
    const dists = fixes.map((f) => projectOntoLine(f!, model.coords, model.cum).distanceFromRouteM);
    expect(Math.max(...dists)).toBeGreaterThan(80);
  });

  it("produces no fixes while the signal is lost but keeps walking", () => {
    const { fixes, state } = walk(5, { ...DEFAULT_SIMULATOR_CONFIG, signalLost: true }, 10);
    expect(fixes.every((f) => f === null)).toBe(true);
    expect(state.alongM).toBeGreaterThan(0);
  });
});
