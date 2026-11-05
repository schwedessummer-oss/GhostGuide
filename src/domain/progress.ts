/**
 * Route progress, remaining distance/time and active (un-paused) elapsed
 * time for the hike companion. Pure functions; no I/O.
 *
 * Progress is the distance ALONG the planned route, not the GPS track
 * length. It only moves forward (backtracking does not "un-walk" the route)
 * and uses the previous progress as a projection hint so overlapping
 * out-and-back legs never make progress jump between legs.
 */
import { cumulativeDistancesM, projectOntoLine, type LatLng, type Position, type Projection } from "./geo";
import type { RouteType } from "./types";

export interface RouteModel {
  coords: Position[];
  cum: number[];
  totalM: number;
  routeType: RouteType;
}

export function buildRouteModel(coords: Position[], routeType: RouteType): RouteModel {
  if (coords.length < 2) throw new Error("A route needs at least 2 coordinates");
  const cum = cumulativeDistancesM(coords);
  return { coords, cum, totalM: cum[cum.length - 1], routeType };
}

export interface ProgressOptions {
  /** fixes less accurate than this never move progress */
  maxAccuracyM: number;
  /** fixes further than this from the route never move progress (you are off route) */
  offRouteIgnoreM: number;
  /** fastest plausible travel along the route */
  maxSpeedMps: number;
  /** fixed allowance added to the plausible forward movement */
  slackM: number;
}

export const DEFAULT_PROGRESS_OPTIONS: ProgressOptions = {
  maxAccuracyM: 50,
  offRouteIgnoreM: 150,
  maxSpeedMps: 3.5,
  slackM: 60,
};

export interface ProgressState {
  /** furthest plausible distance along the route (m) */
  alongM: number;
  /** timestamp of the last fix that updated progress */
  lastAt: number | null;
}

export const INITIAL_PROGRESS: ProgressState = { alongM: 0, lastAt: null };

export interface ProgressFix extends LatLng {
  accuracyM: number;
  timestamp: number;
}

export interface ProgressStepResult {
  state: ProgressState;
  projection: Projection | null;
  /** true when the fix was used to update progress */
  used: boolean;
}

/** Advance progress with a new fix (monotonic, hint-based, speed-capped). */
export function progressStep(
  state: ProgressState,
  fix: ProgressFix,
  model: RouteModel,
  opts: ProgressOptions = DEFAULT_PROGRESS_OPTIONS,
): ProgressStepResult {
  const projection = projectOntoLine(fix, model.coords, model.cum, state.alongM);
  if (fix.accuracyM > opts.maxAccuracyM || projection.distanceFromRouteM > opts.offRouteIgnoreM) {
    return { state, projection, used: false };
  }
  let candidate = projection.alongM;
  if (state.lastAt !== null) {
    const dtSec = Math.max(0, (fix.timestamp - state.lastAt) / 1000);
    const allowed = dtSec * opts.maxSpeedMps + opts.slackM + fix.accuracyM;
    candidate = Math.min(candidate, state.alongM + allowed);
  }
  const alongM = Math.min(model.totalM, Math.max(state.alongM, candidate));
  return { state: { alongM, lastAt: fix.timestamp }, projection, used: true };
}

export function remainingM(model: RouteModel, alongM: number): number {
  return Math.max(0, model.totalM - alongM);
}

export function progressFraction(model: RouteModel, alongM: number): number {
  return model.totalM > 0 ? Math.min(1, Math.max(0, alongM / model.totalM)) : 0;
}

/** Index of the last route vertex at or before `alongM` (for drawing the walked portion). */
export function vertexIndexAt(model: RouteModel, alongM: number): number {
  let lo = 0;
  let hi = model.cum.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (model.cum[mid] <= alongM) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Position of each POI along the route, assigned in sequence order with the
 * previous POI as a hint so POIs on overlapping out-and-back legs are placed
 * on the OUTBOUND leg (the order they are meant to be heard in).
 */
export function poiAlongPositions(
  model: RouteModel,
  pois: { id: string; seq: number; lat: number; lng: number }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  let hint = 0;
  for (const p of [...pois].sort((a, b) => a.seq - b.seq)) {
    const proj = projectOntoLine(p, model.coords, model.cum, hint);
    out[p.id] = proj.alongM;
    hint = proj.alongM;
  }
  return out;
}

export interface PauseInterval {
  start: number;
  end: number | null;
}

/** Elapsed time since start excluding paused intervals (ms). */
export function activeElapsedMs(startedAt: number | null, pauses: PauseInterval[], now: number, finishedAt?: number | null): number {
  if (startedAt == null) return 0;
  const end = finishedAt ?? now;
  let paused = 0;
  for (const p of pauses) {
    const s = Math.max(p.start, startedAt);
    const e = Math.min(p.end ?? end, end);
    if (e > s) paused += e - s;
  }
  return Math.max(0, end - startedAt - paused);
}

/** Rebuild pause intervals from ordered pause/resume events (server-side summaries). */
export function pausesFromEvents(events: { kind: string; at: number }[]): PauseInterval[] {
  const out: PauseInterval[] = [];
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    const open = out.length ? out[out.length - 1] : null;
    if (e.kind === "pause" && (!open || open.end !== null)) out.push({ start: e.at, end: null });
    else if (e.kind === "resume" && open && open.end === null) open.end = e.at;
  }
  return out;
}

/**
 * ESTIMATED remaining time. Uses the observed moving pace once there is
 * enough data (≥ 500 m and ≥ 10 min), otherwise the planned pace from the
 * itinerary. Always labelled as an estimate in the UI.
 */
export function estimateRemainingMin(input: {
  remainingM: number;
  alongM: number;
  activeElapsedMs: number;
  plannedTotalMin: number | null;
  totalM: number;
}): { minutes: number | null; basis: "observed" | "planned" | "none" } {
  const { remainingM: rem, alongM, activeElapsedMs: elapsed, plannedTotalMin, totalM } = input;
  if (rem <= 0) return { minutes: 0, basis: alongM > 0 ? "observed" : "planned" };
  if (alongM >= 500 && elapsed >= 10 * 60_000) {
    const minPerM = elapsed / 60_000 / alongM;
    return { minutes: Math.round(rem * minPerM), basis: "observed" };
  }
  if (plannedTotalMin && totalM > 0) return { minutes: Math.round((rem / totalM) * plannedTotalMin), basis: "planned" };
  return { minutes: null, basis: "none" };
}
