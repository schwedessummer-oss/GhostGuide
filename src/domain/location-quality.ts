/**
 * Location-quality filtering for the active-hike companion (pure, no I/O).
 *
 * Browser geolocation fixes vary wildly: cold starts, tree canopy and
 * canyons produce poor accuracy, cached fixes arrive out of order, and the
 * occasional fix "teleports" hundreds of metres. Every decision the app
 * makes (narration triggers, off-route prompts, progress) is gated on this
 * module so a single bad fix cannot cause a wrong prompt.
 *
 *  - accepted        the fix is plausible and may be recorded / shown
 *  - decisionGrade   additionally accurate enough to drive decisions
 */
import { haversineM } from "./geo";

export interface GeoFix {
  lat: number;
  lng: number;
  /** horizontal accuracy radius in metres (as reported by the device) */
  accuracyM: number;
  /** device timestamp, ms since epoch */
  timestamp: number;
  altitudeM?: number | null;
}

export interface LocationQualityConfig {
  /** fixes with worse accuracy are recorded but never drive decisions */
  maxDecisionAccuracyM: number;
  /** fixes with worse accuracy than this are discarded entirely (e.g. IP/cell-tower guesses) */
  rejectAccuracyM: number;
  /** speed implied between fixes (after subtracting both accuracy radii) above which a fix is a jump */
  maxSpeedMps: number;
  /** device clocks drift; fixes further in the future than this are discarded */
  maxFutureSkewMs: number;
  /** after this many consecutive jump rejections accept the new position (the previous fix was probably wrong) */
  jumpResetAfter: number;
  /** a last fix younger than this is "fresh" */
  freshForMs: number;
  /** a last fix older than this is "stale" (between fresh and stale it is "aging") */
  staleAfterMs: number;
}

export const DEFAULT_LOCATION_QUALITY: LocationQualityConfig = {
  maxDecisionAccuracyM: 35,
  rejectAccuracyM: 1500,
  maxSpeedMps: 8,
  maxFutureSkewMs: 2 * 60_000,
  jumpResetAfter: 3,
  freshForMs: 30_000,
  staleAfterMs: 2 * 60_000,
};

export type FixRejectReason = "invalid" | "out_of_order" | "duplicate" | "future" | "implausible_speed" | "too_inaccurate";

export interface LocationFilterState {
  /** last ACCEPTED fix */
  last: GeoFix | null;
  /** consecutive fixes rejected as implausible jumps */
  jumpRejects: number;
}

export const INITIAL_LOCATION_FILTER: LocationFilterState = { last: null, jumpRejects: 0 };

export interface FixAssessment {
  accepted: boolean;
  /** accurate enough to drive geofences, deviation and progress */
  decisionGrade: boolean;
  reason?: FixRejectReason;
  state: LocationFilterState;
}

export function isValidFix(fix: GeoFix): boolean {
  return (
    Number.isFinite(fix.lat) &&
    Number.isFinite(fix.lng) &&
    Math.abs(fix.lat) <= 90 &&
    Math.abs(fix.lng) <= 180 &&
    Number.isFinite(fix.accuracyM) &&
    fix.accuracyM >= 0 &&
    Number.isFinite(fix.timestamp)
  );
}

/**
 * Assess a new fix against the previously accepted one. Pure: returns the
 * next filter state rather than mutating.
 */
export function assessFix(
  state: LocationFilterState,
  fix: GeoFix,
  now: number,
  cfg: LocationQualityConfig = DEFAULT_LOCATION_QUALITY,
): FixAssessment {
  const reject = (reason: FixRejectReason, next: LocationFilterState = state): FixAssessment => ({
    accepted: false,
    decisionGrade: false,
    reason,
    state: next,
  });
  if (!isValidFix(fix)) return reject("invalid");
  if (fix.timestamp > now + cfg.maxFutureSkewMs) return reject("future");
  if (fix.accuracyM > cfg.rejectAccuracyM) return reject("too_inaccurate");
  const prev = state.last;
  if (prev) {
    if (fix.timestamp === prev.timestamp && fix.lat === prev.lat && fix.lng === prev.lng) return reject("duplicate");
    if (fix.timestamp <= prev.timestamp) return reject("out_of_order");
    const dtSec = Math.max(1, (fix.timestamp - prev.timestamp) / 1000);
    const dist = haversineM(prev, fix);
    const unexplained = Math.max(0, dist - (prev.accuracyM + fix.accuracyM));
    if (unexplained / dtSec > cfg.maxSpeedMps) {
      const jumpRejects = state.jumpRejects + 1;
      if (jumpRejects < cfg.jumpResetAfter) return reject("implausible_speed", { last: prev, jumpRejects });
      // Several consecutive "jumps" agree with each other: the old fix was the outlier.
    }
  }
  return {
    accepted: true,
    decisionGrade: fix.accuracyM <= cfg.maxDecisionAccuracyM,
    state: { last: fix, jumpRejects: 0 },
  };
}

export type Staleness = "none" | "fresh" | "aging" | "stale";

/** How old the last known location is, for "stale location" styling and warnings. */
export function classifyStaleness(
  lastFixAt: number | null | undefined,
  now: number,
  cfg: Pick<LocationQualityConfig, "freshForMs" | "staleAfterMs"> = DEFAULT_LOCATION_QUALITY,
): Staleness {
  if (lastFixAt == null || !Number.isFinite(lastFixAt)) return "none";
  const age = now - lastFixAt;
  if (age <= cfg.freshForMs) return "fresh";
  if (age <= cfg.staleAfterMs) return "aging";
  return "stale";
}

export type AccuracyGrade = "good" | "fair" | "poor" | "unknown";

/** Human grade for an accuracy radius (shown alongside the number, never colour alone). */
export function accuracyGrade(accuracyM: number | null | undefined): AccuracyGrade {
  if (accuracyM == null || !Number.isFinite(accuracyM)) return "unknown";
  if (accuracyM <= 15) return "good";
  if (accuracyM <= 35) return "fair";
  return "poor";
}
