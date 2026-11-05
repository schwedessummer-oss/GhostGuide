/**
 * Geofenced narration triggers (pure, no I/O).
 *
 * A POI's narration plays automatically at most ONCE per hike session, when:
 *  - the fix is accurate enough (accuracy gating: poor fixes never trigger
 *    and never reset progress towards a trigger),
 *  - the hiker is inside the (configurable) trigger radius on N consecutive
 *    qualifying fixes, or on ≥ 2 fixes spanning a minimum dwell time,
 *  - the hiker's progress along the route is near the POI's place in the
 *    sequence (so POIs passed again on the return leg of an out-and-back, or
 *    a loop's last POI near the trailhead, do not fire at the wrong time),
 *  - no other narration was auto-triggered within the cooldown.
 * Leaving requires going beyond a larger exit radius (hysteresis), so GPS
 * drift oscillating across the boundary cannot build up false triggers.
 * Manual replay is always available and never blocked by any of this.
 */
import { haversineM } from "./geo";

export interface GeofencePoi {
  id: string;
  seq: number;
  lat: number;
  lng: number;
  triggerRadiusM: number;
  /** position along the route (m), from poiAlongPositions(); null = unknown */
  alongM?: number | null;
}

export interface GeofenceSettings {
  /** multiplier applied to each POI's radius (user setting: 0.5×–2×) */
  radiusMultiplier: number;
  /** fixed trigger distance overriding every POI radius (m), or null */
  radiusOverrideM: number | null;
  /** fixes less accurate than this never count towards a trigger */
  maxAccuracyM: number;
  /** consecutive qualifying fixes required */
  requiredConsecutive: number;
  /** alternatively: ≥ 2 qualifying fixes spanning at least this long (0 disables) */
  minDwellMs: number;
  /** exit radius = trigger radius × exitFactor (hysteresis band) */
  exitFactor: number;
  /** minimum time between two automatic triggers */
  cooldownMs: number;
  /** auto-trigger only when |progress − POI position| ≤ this (m) */
  sequenceWindowM: number;
}

export const DEFAULT_GEOFENCE_SETTINGS: GeofenceSettings = {
  radiusMultiplier: 1,
  radiusOverrideM: null,
  maxAccuracyM: 35,
  requiredConsecutive: 3,
  minDwellMs: 5_000,
  exitFactor: 1.5,
  cooldownMs: 20_000,
  sequenceWindowM: 250,
};

export const RADIUS_MULTIPLIER_MIN = 0.5;
export const RADIUS_MULTIPLIER_MAX = 2;
export const RADIUS_OVERRIDE_MIN_M = 10;
export const RADIUS_OVERRIDE_MAX_M = 300;

export interface TriggerRecord {
  at: number;
  source: "gps" | "manual";
}

export interface GeofenceState {
  /** POIs already narrated this session (auto-trigger never repeats) */
  triggered: Record<string, TriggerRecord>;
  /** POIs the hiker is currently approaching: qualifying-fix counters */
  candidates: Record<string, { count: number; firstAt: number; lastAt: number }>;
  lastAutoTriggerAt: number | null;
  /** manual plays (always allowed), for "stops heard" summaries */
  manualPlays: Record<string, number>;
}

export const INITIAL_GEOFENCE_STATE: GeofenceState = { triggered: {}, candidates: {}, lastAutoTriggerAt: null, manualPlays: {} };

export function clampMultiplier(m: number): number {
  if (!Number.isFinite(m)) return 1;
  return Math.min(RADIUS_MULTIPLIER_MAX, Math.max(RADIUS_MULTIPLIER_MIN, m));
}

export function effectiveRadiusM(poi: Pick<GeofencePoi, "triggerRadiusM">, settings: GeofenceSettings): number {
  if (settings.radiusOverrideM != null && Number.isFinite(settings.radiusOverrideM)) {
    return Math.min(RADIUS_OVERRIDE_MAX_M, Math.max(RADIUS_OVERRIDE_MIN_M, settings.radiusOverrideM));
  }
  return Math.max(5, poi.triggerRadiusM * clampMultiplier(settings.radiusMultiplier));
}

export function exitRadiusM(poi: Pick<GeofencePoi, "triggerRadiusM">, settings: GeofenceSettings): number {
  return effectiveRadiusM(poi, settings) * Math.max(1, settings.exitFactor);
}

export interface GeofenceFix {
  lat: number;
  lng: number;
  accuracyM: number;
  timestamp: number;
  /** hiker's progress along the route (m); null when unknown/off route */
  progressAlongM?: number | null;
}

export interface GeofenceStepResult {
  state: GeofenceState;
  /** POI ids that should play now (at most one per step) */
  triggered: string[];
}

export function geofenceStep(state: GeofenceState, fix: GeofenceFix, pois: GeofencePoi[], settings: GeofenceSettings): GeofenceStepResult {
  // Accuracy gating: a poor fix tells us nothing reliable — ignore it entirely.
  if (!(fix.accuracyM <= settings.maxAccuracyM)) return { state, triggered: [] };
  const candidates = { ...state.candidates };
  const triggered = { ...state.triggered };
  let lastAutoTriggerAt = state.lastAutoTriggerAt;
  const fired: string[] = [];
  const inCooldown = lastAutoTriggerAt !== null && fix.timestamp - lastAutoTriggerAt < settings.cooldownMs;

  for (const poi of [...pois].sort((a, b) => a.seq - b.seq)) {
    if (triggered[poi.id]) {
      delete candidates[poi.id];
      continue;
    }
    const d = haversineM(fix, poi);
    const inSequence =
      fix.progressAlongM == null || poi.alongM == null || Math.abs(fix.progressAlongM - poi.alongM) <= settings.sequenceWindowM;
    if (d <= effectiveRadiusM(poi, settings) && inSequence) {
      const prev = candidates[poi.id];
      const c = prev ? { count: prev.count + 1, firstAt: prev.firstAt, lastAt: fix.timestamp } : { count: 1, firstAt: fix.timestamp, lastAt: fix.timestamp };
      candidates[poi.id] = c;
      const qualifies =
        c.count >= Math.max(1, settings.requiredConsecutive) ||
        (settings.minDwellMs > 0 && c.count >= 2 && c.lastAt - c.firstAt >= settings.minDwellMs);
      if (qualifies && !inCooldown && fired.length === 0) {
        triggered[poi.id] = { at: fix.timestamp, source: "gps" };
        delete candidates[poi.id];
        lastAutoTriggerAt = fix.timestamp;
        fired.push(poi.id);
      }
    } else if (d > exitRadiusM(poi, settings) || !inSequence) {
      // Clearly outside (beyond the hysteresis band): start over.
      delete candidates[poi.id];
    }
    // Inside the hysteresis band: neither counts nor resets.
  }
  return { state: { ...state, candidates, triggered, lastAutoTriggerAt }, triggered: fired };
}

/**
 * Manual replay: always allowed (no cooldown, accuracy or sequence checks).
 * Playing a stop manually counts as heard, so GPS will not auto-play the
 * same narration again later in the session.
 */
export function recordManualPlay(state: GeofenceState, poiId: string, now: number): GeofenceState {
  return {
    ...state,
    triggered: state.triggered[poiId] ? state.triggered : { ...state.triggered, [poiId]: { at: now, source: "manual" } },
    candidates: Object.fromEntries(Object.entries(state.candidates).filter(([id]) => id !== poiId)),
    manualPlays: { ...state.manualPlays, [poiId]: (state.manualPlays[poiId] ?? 0) + 1 },
  };
}

export function heardPoiIds(state: GeofenceState): string[] {
  return Object.keys(state.triggered);
}
