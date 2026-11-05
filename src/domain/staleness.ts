/**
 * Location freshness (pure). A last-known location older than the configured
 * threshold (app_settings.stale_location_minutes, default 15) is STALE: it
 * says where the phone was, not where the person is now.
 */
export type LocationFreshness = "fresh" | "stale" | "none";

export const DEFAULT_STALE_MINUTES = 15;

export interface LocationAge {
  state: LocationFreshness;
  /** whole minutes since the fix was recorded (null when there is no fix) */
  ageMin: number | null;
  /** "just now", "4 min old", "2 h 5 min old", "3 days old" */
  ageText: string;
  /** short, human label suitable for UI and notices */
  label: string;
}

/** Human age text for a duration in minutes. */
export function ageText(ageMin: number): string {
  if (ageMin < 1) return "just now";
  if (ageMin < 60) return `${ageMin} min old`;
  if (ageMin < 48 * 60) {
    const h = Math.floor(ageMin / 60);
    const m = ageMin % 60;
    return m ? `${h} h ${m} min old` : `${h} h old`;
  }
  return `${Math.floor(ageMin / (24 * 60))} days old`;
}

/**
 * Classify a last-known location timestamp. Future timestamps (device clock
 * skew) count as age 0. `thresholdMin` must be >= 1; invalid values fall
 * back to the default.
 */
export function classifyLocation(
  recordedAt: Date | string | null | undefined,
  now: Date,
  thresholdMin: number = DEFAULT_STALE_MINUTES,
): LocationAge {
  if (!recordedAt) return { state: "none", ageMin: null, ageText: "no location", label: "No location has been reported" };
  const t = new Date(recordedAt).getTime();
  if (!Number.isFinite(t)) return { state: "none", ageMin: null, ageText: "no location", label: "No location has been reported" };
  const threshold = Number.isFinite(thresholdMin) && thresholdMin >= 1 ? thresholdMin : DEFAULT_STALE_MINUTES;
  const ageMin = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
  const text = ageText(ageMin);
  if (ageMin >= threshold) {
    return { state: "stale", ageMin, ageText: text, label: `STALE — ${ageMin < 180 ? `${ageMin} min old` : text}` };
  }
  return { state: "fresh", ageMin, ageText: text, label: ageMin < 1 ? "Updated just now" : `Updated ${ageMin} min ago` };
}
