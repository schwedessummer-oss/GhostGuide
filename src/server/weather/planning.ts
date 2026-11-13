import "server-only";
import type { PlanningDto, RouteType, SunTimesDto } from "@/domain/catalog";
import { sunTimes, type SunTimes } from "@/server/geo/sun";
import { addDaysToKey, localDateKey } from "@/server/geo/timezone";
import { durationBasis, estimateOutAndBackMin, type Profile } from "@/server/trails/estimate";
import { clockTime } from "./highlights";

/**
 * Daylight planning for a hike: sun times for the next days and start/finish
 * times from the trail's duration estimate. Pure and deterministic.
 *
 * DEFINITIONS
 *   hike duration         loop / network / unknown route: estimatedDurationMin
 *                         (one traversal, stored by ingestion);
 *                         linear route: out-and-back (estimateOutAndBackMin on
 *                         the stored profile; flat pace without one), since
 *                         that is the hike most people do (see read.ts)
 *   latestRecommendedStart  today's sunset − hike duration − 60 min; when that
 *                         is already past, the same for TOMORROW's sunset, and
 *                         the FIRST note says so in words ("…for tomorrow's
 *                         sunset…: start by 2:26 PM tomorrow…"); never in the
 *                         past (null when tomorrow's is past too); null when the
 *                         duration or a sunset is unknown (polar day / night).
 *                         Clients label the day from the instant's local date
 *                         in the trail's zone (compare sun[0].date /
 *                         sun[1].date), not from "today's" heading
 *   duration basis        when the trail has no usable elevation profile, the
 *                         duration is distance at a flat pace with NO time for
 *                         climbing (estimate.ts durationBasis); a note says so
 *                         near the top, and nothing claims climbs were counted
 *   finishIfStartNow      now + hike duration
 *   daylightRemainingMin  minutes of daylight left today: sunset − max(now, sunrise);
 *                         0 after sunset and on polar nights; null on polar days
 *                         (the sun does not set) or when sun times are unknown
 * Sun times come from src/server/geo/sun.ts (NOAA algorithm, flat horizon).
 */

/** Minutes of daylight to keep in hand at the end of a hike. */
export const DAYLIGHT_BUFFER_MIN = 60;
/** Sun-time days returned: today + the next two. */
export const SUN_DAY_COUNT = 3;

const MIN_MS = 60_000;

export interface SunDay {
  date: string;
  /** Null when the computation failed (invalid input); never invented. */
  times: SunTimes | null;
}

/** Sun times for `count` local days from today in `timeZone`. Never throws. */
export function sunDays(lat: number, lng: number, timeZone: string, now: Date, count = SUN_DAY_COUNT): SunDay[] {
  let today: string;
  try {
    today = localDateKey(now, timeZone);
  } catch {
    return [];
  }
  const out: SunDay[] = [];
  for (let i = 0; i < count; i++) {
    const date = addDaysToKey(today, i);
    let times: SunTimes | null = null;
    try {
      times = sunTimes(date, lat, lng, timeZone);
    } catch {
      times = null;
    }
    out.push({ date, times });
  }
  return out;
}

const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toSunTimesDto(d: SunDay): SunTimesDto {
  return {
    date: d.date,
    sunrise: isoOrNull(d.times?.sunrise),
    sunset: isoOrNull(d.times?.sunset),
    civilDusk: isoOrNull(d.times?.civilDusk),
    polar: d.times?.polar ?? null,
  };
}

/** "45 min", "2 h", "3 h 10 min". */
export function formatDuration(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

export interface PlanningInput {
  now: Date;
  /** IANA zone used for clock times in notes. */
  timeZone: string;
  /** False when the trail's zone is unknown and `timeZone` is a UTC fallback. */
  timeZoneKnown: boolean;
  routeType: RouteType;
  /** One traversal, metres. */
  distanceM: number | null;
  /** One traversal, minutes (stored estimate). */
  estimatedDurationMin: number | null;
  profile: Profile | null;
  /** [today, tomorrow, ...] from sunDays(). */
  sun: SunDay[];
}

const validMinutes = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null;

/** Out-and-back minutes for a linear route; null otherwise or when the distance is unusable. */
export function outAndBackMinutes(routeType: RouteType, distanceM: number | null, profile: Profile | null): number | null {
  if (routeType !== "linear" || typeof distanceM !== "number" || !Number.isFinite(distanceM) || distanceM <= 0) return null;
  try {
    return estimateOutAndBackMin(distanceM, profile);
  } catch {
    return null;
  }
}

/** "today", "tomorrow" or "on 2026-11-14": the local day of `instant` relative to `now` in `timeZone`. */
export function dayWord(instant: Date, now: Date, timeZone: string): string {
  const day = localDateKey(instant, timeZone);
  const today = localDateKey(now, timeZone);
  if (day === today) return "today";
  if (day === addDaysToKey(today, 1)) return "tomorrow";
  return `on ${day}`;
}

/** Planning numbers and plain-language notes (see the module header). */
export function buildPlanning(input: PlanningInput): PlanningDto {
  const { now, timeZone } = input;
  const at = (d: Date) => clockTime(d, timeZone);
  /** "2:26 PM tomorrow" — the day is always named. */
  const atDay = (d: Date) => `${at(d)} ${dayWord(d, now, timeZone)}`;
  /** "5:30 PM", or "4:10 AM tomorrow" when the instant is not today. */
  const atOrDay = (d: Date) => {
    const day = dayWord(d, now, timeZone);
    return day === "today" ? at(d) : `${at(d)} ${day}`;
  };
  const notes: string[] = [];

  const oneWay = validMinutes(input.estimatedDurationMin);
  const outAndBack = outAndBackMinutes(input.routeType, input.distanceM, input.profile);
  const hikeMin = input.routeType === "linear" ? (outAndBack ?? oneWay) : oneWay;

  const today = input.sun[0]?.times ?? null;
  const tomorrow = input.sun[1]?.times ?? null;
  const n = now.getTime();

  // Latest recommended start: today, else tomorrow; never a time already past.
  // Its notes come FIRST: they change what the headline time means.
  let latestRecommendedStart: Date | null = null;
  let latestDay: SunTimes | null = null;
  if (hikeMin !== null && today && today.polar === null && today.sunset) {
    const startFor = (sunset: Date) => new Date(sunset.getTime() - (hikeMin + DAYLIGHT_BUFFER_MIN) * MIN_MS);
    const candidate = startFor(today.sunset);
    const tomorrowSunset = tomorrow && tomorrow.polar === null ? tomorrow.sunset : null;
    const next = tomorrowSunset ? startFor(tomorrowSunset) : null;
    if (candidate.getTime() >= n) {
      latestRecommendedStart = candidate;
      latestDay = today;
    } else if (tomorrowSunset && next && next.getTime() >= n) {
      latestRecommendedStart = next;
      latestDay = tomorrow;
      notes.push(
        `It is too late today to finish an hour before sunset. The latest recommended start shown is for tomorrow's sunset ` +
          `(${at(tomorrowSunset)}): start by ${atDay(next)} at the latest.`,
      );
    } else if (next) {
      notes.push(
        "It is too late today to finish an hour before sunset, and from now this hike cannot finish an hour before tomorrow's sunset either, " +
          "so Ghost Guide cannot suggest a latest start time.",
      );
    } else {
      notes.push("It is too late today to finish an hour before sunset.");
    }
  }
  if (latestRecommendedStart && latestDay?.sunrise && latestRecommendedStart.getTime() < latestDay.sunrise.getTime()) {
    notes.push(
      `That start is before sunrise (${atDay(latestDay.sunrise)}): this hike takes longer than the daylight available, so part of it would be in the dark.`,
    );
  }

  if (input.routeType === "linear" && outAndBack !== null) {
    notes.push(
      `This is a one-way route. Times assume you hike out and back (about ${formatDuration(outAndBack)})` +
        (oneWay !== null ? `; one way takes about ${formatDuration(oneWay)}.` : "."),
    );
  }
  if (hikeMin !== null && durationBasis(input.profile) === "distance_only") {
    notes.push(
      "There is no elevation data for this trail, so its hiking time is based on distance only, at a flat-ground pace, " +
        "with no extra time for climbing. On a hilly trail the hike takes longer than shown: allow extra time and start earlier.",
    );
  }
  if (hikeMin === null) {
    notes.push("The hiking time for this trail is not known, so Ghost Guide cannot suggest a latest start time.");
  }

  // Daylight left today.
  let daylightRemainingMin: number | null = null;
  if (today?.polar === "night") {
    daylightRemainingMin = 0;
    notes.push("The sun does not rise here today. Plan for hiking in darkness or twilight.");
  } else if (today?.polar === "day") {
    notes.push("The sun does not set here today, so daylight does not limit your start time.");
  } else if (today?.sunset) {
    const set = today.sunset.getTime();
    if (n >= set) {
      daylightRemainingMin = 0;
      notes.push(`The sun has already set today (${at(today.sunset)}).`);
    } else {
      const start = today.sunrise ? Math.max(n, today.sunrise.getTime()) : n;
      daylightRemainingMin = Math.max(0, Math.round((set - start) / MIN_MS));
    }
  }

  // Starting now.
  const finishIfStartNow = hikeMin !== null ? new Date(n + hikeMin * MIN_MS) : null;
  if (finishIfStartNow && today?.polar === null && today.sunset && n < today.sunset.getTime() && finishIfStartNow > today.sunset) {
    notes.push(
      `Starting now, you would finish around ${atOrDay(finishIfStartNow)}, after sunset (${at(today.sunset)}). Bring a headlamp or choose a shorter hike.`,
    );
  }

  if (hikeMin !== null) notes.push("Estimates assume an average pace and do not include long breaks.");
  if (latestRecommendedStart) notes.push("The latest recommended start leaves an hour of daylight to spare before sunset.");
  notes.push("Sunrise and sunset are calculated for a flat horizon; mountains and valleys can bring darkness earlier.");
  if (!input.timeZoneKnown) notes.push("The trail's time zone is unknown, so times are shown in UTC.");

  return {
    estimatedDurationMin: oneWay,
    outAndBackDurationMin: outAndBack,
    latestRecommendedStart: isoOrNull(latestRecommendedStart),
    finishIfStartNow: isoOrNull(finishIfStartNow),
    daylightRemainingMin,
    durationBasis: hikeMin === null ? null : durationBasis(input.profile),
    notes,
  };
}
