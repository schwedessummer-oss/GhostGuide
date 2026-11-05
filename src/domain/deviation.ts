/**
 * Route-deviation detection (pure, no I/O).
 *
 * "You may be off the route" is shown only after the hiker has been further
 * than (threshold + accuracy allowance) from the route on K consecutive
 * good-accuracy fixes spanning at least T seconds. Poor-accuracy fixes are
 * ignored (neither count nor reset). Clearing needs the hiker to come back
 * within a tighter clear threshold on several fixes (hysteresis), and a
 * dismissed prompt is snoozed so it does not nag.
 *
 * This is a navigation aid, not a safety system: the wording in the UI never
 * promises that being "on route" means being safe.
 */
export interface DeviationSettings {
  /** distance from the route considered off-route, before the accuracy allowance */
  thresholdM: number;
  /** fixes less accurate than this are ignored */
  maxAccuracyM: number;
  /** the allowance added to the threshold is min(accuracy, this) */
  maxAccuracyAllowanceM: number;
  /** K: consecutive off-route fixes required */
  requiredConsecutive: number;
  /** T: the off-route fixes must span at least this long */
  minDurationMs: number;
  /** back on route when closer than this ... */
  clearThresholdM: number;
  /** ... on this many consecutive good fixes */
  clearConsecutive: number;
  /** after "I'm fine", no new prompt for this long */
  snoozeMs: number;
  /** after "This is intentional", no new prompt for this long */
  intentionalSnoozeMs: number;
}

export const DEFAULT_DEVIATION_SETTINGS: DeviationSettings = {
  thresholdM: 40,
  maxAccuracyM: 35,
  maxAccuracyAllowanceM: 30,
  requiredConsecutive: 3,
  minDurationMs: 30_000,
  clearThresholdM: 25,
  clearConsecutive: 2,
  snoozeMs: 10 * 60_000,
  intentionalSnoozeMs: 30 * 60_000,
};

export interface DeviationState {
  status: "on_route" | "off_route";
  /** consecutive good fixes beyond the off-route threshold */
  offCount: number;
  offSince: number | null;
  /** consecutive good fixes inside the clear threshold (while off route) */
  onCount: number;
  promptVisible: boolean;
  snoozedUntil: number | null;
  lastPromptAt: number | null;
  lastDistanceM: number | null;
}

export const INITIAL_DEVIATION_STATE: DeviationState = {
  status: "on_route",
  offCount: 0,
  offSince: null,
  onCount: 0,
  promptVisible: false,
  snoozedUntil: null,
  lastPromptAt: null,
  lastDistanceM: null,
};

export interface DeviationInput {
  distanceFromRouteM: number;
  accuracyM: number;
  timestamp: number;
}

export type DeviationEvent = "prompt" | "cleared" | null;

export function offRouteLimitM(accuracyM: number, settings: DeviationSettings): number {
  return settings.thresholdM + Math.min(Math.max(0, accuracyM), settings.maxAccuracyAllowanceM);
}

export function deviationStep(
  state: DeviationState,
  input: DeviationInput,
  settings: DeviationSettings = DEFAULT_DEVIATION_SETTINGS,
): { state: DeviationState; event: DeviationEvent } {
  if (!(input.accuracyM <= settings.maxAccuracyM) || !Number.isFinite(input.distanceFromRouteM)) {
    return { state, event: null };
  }
  const ts = input.timestamp;
  const next: DeviationState = { ...state, lastDistanceM: input.distanceFromRouteM };
  let event: DeviationEvent = null;

  if (state.status === "on_route") {
    if (input.distanceFromRouteM > offRouteLimitM(input.accuracyM, settings)) {
      next.offCount = state.offCount + 1;
      next.offSince = state.offSince ?? ts;
      if (next.offCount >= settings.requiredConsecutive && ts - (next.offSince ?? ts) >= settings.minDurationMs) {
        next.status = "off_route";
        next.onCount = 0;
      }
    } else {
      next.offCount = 0;
      next.offSince = null;
    }
  } else if (input.distanceFromRouteM < settings.clearThresholdM) {
    next.onCount = state.onCount + 1;
    if (next.onCount >= settings.clearConsecutive) {
      next.status = "on_route";
      next.offCount = 0;
      next.offSince = null;
      next.onCount = 0;
      if (state.promptVisible) event = "cleared";
      next.promptVisible = false;
    }
  } else {
    next.onCount = 0;
  }

  if (next.status === "off_route" && !next.promptVisible && (next.snoozedUntil === null || ts >= next.snoozedUntil)) {
    next.promptVisible = true;
    next.lastPromptAt = ts;
    event = "prompt";
  }
  return { state: next, event };
}

/** The hiker dismissed the prompt ("I'm fine" or "This is intentional"). */
export function dismissDeviation(
  state: DeviationState,
  now: number,
  reason: "fine" | "intentional",
  settings: DeviationSettings = DEFAULT_DEVIATION_SETTINGS,
): DeviationState {
  return {
    ...state,
    promptVisible: false,
    snoozedUntil: now + (reason === "intentional" ? settings.intentionalSnoozeMs : settings.snoozeMs),
  };
}
