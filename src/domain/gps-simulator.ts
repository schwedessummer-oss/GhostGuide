/**
 * Deterministic GPS simulator for demos and end-to-end tests (pure, no I/O).
 * Walks the planned route at a configurable speed, adding seeded noise,
 * slow drift and accuracy variation, an optional detour (to demonstrate
 * off-route prompts) and a "signal lost" mode (to demonstrate stale
 * locations and the offline queue). Output is labelled "Simulated GPS" in
 * the UI and is only available in demo mode.
 */
import { offsetMeters, pointAtDistance, posToLatLng, type LatLng } from "./geo";
import type { GeoFix } from "./location-quality";
import type { RouteModel } from "./progress";

export interface SimulatorDetour {
  /** where along the route the detour starts (m) */
  startAlongM: number;
  /** length of route over which the hiker is off to the side (m) */
  lengthM: number;
  /** how far from the route the hiker wanders (m) */
  offsetM: number;
}

export interface SimulatorConfig {
  speedMps: number;
  /** each real second simulates this many seconds of walking */
  speedUp: number;
  /** random per-fix noise (m, ~1 sigma) */
  noiseM: number;
  /** slowly wandering bias (m, bound) */
  driftM: number;
  baseAccuracyM: number;
  accuracyJitterM: number;
  /** probability of an occasional poor fix (canopy / canyon) */
  poorFixChance: number;
  detour: SimulatorDetour | null;
  signalLost: boolean;
}

export const DEFAULT_SIMULATOR_CONFIG: SimulatorConfig = {
  speedMps: 1.3,
  speedUp: 1,
  noiseM: 3,
  driftM: 4,
  baseAccuracyM: 8,
  accuracyJitterM: 6,
  poorFixChance: 0.05,
  detour: null,
  signalLost: false,
};

export interface SimulatorState {
  alongM: number;
  rng: number;
  driftE: number;
  driftN: number;
  finished: boolean;
  steps: number;
}

export function createSimulatorState(seed: number, startAlongM = 0): SimulatorState {
  return { alongM: Math.max(0, startAlongM), rng: seed >>> 0 || 1, driftE: 0, driftN: 0, finished: false, steps: 0 };
}

/** mulberry32: tiny, fast, deterministic PRNG. Returns [value in [0,1), next state]. */
export function nextRandom(state: number): [number, number] {
  const s = (state + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

/** Lateral offset (m) of the detour at a given progress: a smooth bump. */
export function detourOffsetM(detour: SimulatorDetour | null, alongM: number): number {
  if (!detour || detour.lengthM <= 0) return 0;
  const t = (alongM - detour.startAlongM) / detour.lengthM;
  if (t <= 0 || t >= 1) return 0;
  // ramp out over the first 15 %, stay out, ramp back over the last 15 %
  const ramp = t < 0.15 ? t / 0.15 : t > 0.85 ? (1 - t) / 0.15 : 1;
  return detour.offsetM * ramp;
}

function headingAt(model: RouteModel, alongM: number): { e: number; n: number } {
  const a = pointAtDistance(model.coords, Math.max(0, alongM - 5), model.cum);
  const b = pointAtDistance(model.coords, Math.min(model.totalM, alongM + 5), model.cum);
  const kx = Math.cos((a.lat * Math.PI) / 180) * 111_320;
  const e = (b.lng - a.lng) * kx;
  const n = (b.lat - a.lat) * 111_320;
  const len = Math.hypot(e, n) || 1;
  return { e: e / len, n: n / len };
}

/**
 * Advance the simulated hiker by `dtMs` of real time and produce a fix
 * timestamped `now` (or none while the signal is "lost").
 */
export function simulatorStep(
  state: SimulatorState,
  model: RouteModel,
  config: SimulatorConfig,
  dtMs: number,
  now: number,
): { state: SimulatorState; fix: GeoFix | null } {
  let rng = state.rng;
  const rand = () => {
    const [v, s] = nextRandom(rng);
    rng = s;
    return v;
  };
  const gauss = () => {
    // Irwin–Hall approximation of a unit normal (deterministic, cheap).
    let s = 0;
    for (let i = 0; i < 6; i++) s += rand();
    return (s - 3) / Math.sqrt(0.5);
  };
  const simSeconds = (Math.max(0, dtMs) / 1000) * Math.max(0, config.speedUp);
  const alongM = Math.min(model.totalM, state.alongM + config.speedMps * simSeconds);
  const finished = alongM >= model.totalM;

  // bounded random-walk drift
  const clamp = (v: number) => Math.max(-config.driftM, Math.min(config.driftM, v));
  const driftE = clamp(state.driftE + gauss() * config.driftM * 0.25);
  const driftN = clamp(state.driftN + gauss() * config.driftM * 0.25);

  const poor = rand() < config.poorFixChance;
  const accuracyM = poor ? 60 + rand() * 90 : Math.max(3, config.baseAccuracyM + (rand() * 2 - 1) * config.accuracyJitterM);
  const noiseScale = poor ? 3 : 1;
  const noiseE = gauss() * config.noiseM * noiseScale;
  const noiseN = gauss() * config.noiseM * noiseScale;

  const next: SimulatorState = { alongM, rng, driftE, driftN, finished, steps: state.steps + 1 };
  if (config.signalLost) return { state: next, fix: null };

  const onRoute: LatLng = model.coords.length ? pointAtDistance(model.coords, alongM, model.cum) : posToLatLng([0, 0]);
  const lateral = detourOffsetM(config.detour, alongM);
  const h = headingAt(model, alongM);
  // perpendicular to the direction of travel (to the right)
  const eastM = driftE + noiseE + lateral * h.n;
  const northM = driftN + noiseN - lateral * h.e;
  const p = offsetMeters(onRoute, eastM, northM);
  return {
    state: next,
    fix: { lat: p.lat, lng: p.lng, accuracyM: Math.round(accuracyM * 10) / 10, timestamp: now, altitudeM: null },
  };
}
