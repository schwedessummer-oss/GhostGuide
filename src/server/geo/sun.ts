import "server-only";
import { parseDateKey, zonedTimeToUtc } from "./timezone";

/**
 * Sunrise, sunset, civil twilight and solar noon, computed locally with the
 * NOAA solar position algorithm (NOAA Global Monitoring Laboratory "Solar
 * Calculator", after Meeus, Astronomical Algorithms). No network calls.
 *
 * Accuracy: about ±1 minute between ±72° latitude for the stated position at
 * sea level with standard refraction; worse near the poles where the sun
 * grazes the horizon. Terrain, elevation and actual atmospheric refraction
 * are not modelled, so real sunrise in a valley can be much later.
 *
 * Zenith angles: 90.833° for sunrise/sunset (34′ refraction + 16′ solar
 * semi-diameter) and 96° for civil dawn/dusk.
 */

export interface SunTimes {
  sunrise: Date | null;
  sunset: Date | null;
  civilDawn: Date | null;
  civilDusk: Date | null;
  solarNoon: Date;
  /** "day": the sun never sets that day; "night": it never rises; null otherwise. */
  polar: "day" | "night" | null;
}

export const SUNRISE_ZENITH_DEG = 90.833;
export const CIVIL_ZENITH_DEG = 96;

const DEG = Math.PI / 180;
const DAY_MS = 86_400_000;
/** Julian Day of the Unix epoch. */
const JD_UNIX_EPOCH = 2_440_587.5;

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Julian centuries since J2000.0 for a Julian Day. */
function julianCentury(jd: number): number {
  return (jd - 2_451_545) / 36_525;
}

/**
 * Solar declination (radians) and equation of time (minutes) for a Julian
 * century, per the NOAA spreadsheet formulas.
 */
export function solarParameters(t: number): { declination: number; equationOfTimeMin: number } {
  const meanLong = mod(280.46646 + t * (36000.76983 + t * 0.0003032), 360); // °
  const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t); // °
  const ecc = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const m = meanAnom * DEG;
  const center =
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * m) * (0.019993 - 0.000101 * t) + Math.sin(3 * m) * 0.000289;
  const trueLong = meanLong + center;
  const omega = (125.04 - 1934.136 * t) * DEG;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega);
  const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliq = (meanObliq + 0.00256 * Math.cos(omega)) * DEG;
  const declination = Math.asin(Math.sin(obliq) * Math.sin(appLong * DEG));
  const y = Math.tan(obliq / 2) ** 2;
  const l0 = meanLong * DEG;
  const eqTimeRad =
    y * Math.sin(2 * l0) -
    2 * ecc * Math.sin(m) +
    4 * ecc * y * Math.sin(m) * Math.cos(2 * l0) -
    0.5 * y * y * Math.sin(4 * l0) -
    1.25 * ecc * ecc * Math.sin(2 * m);
  return { declination, equationOfTimeMin: (4 * eqTimeRad) / DEG };
}

/** cos(hour angle) at which the sun's centre reaches `zenithDeg` (may be outside [-1, 1]). */
function cosHourAngle(latDeg: number, declination: number, zenithDeg: number): number {
  const lat = latDeg * DEG;
  return Math.cos(zenithDeg * DEG) / (Math.cos(lat) * Math.cos(declination)) - Math.tan(lat) * Math.tan(declination);
}

type Event = { minutes: number } | { never: "above" | "below" };

/**
 * Minutes after 00:00 UTC of the anchor day at which the sun crosses
 * `zenithDeg` (rising or setting), refined by re-evaluating the solar
 * parameters at the event time. The always-above / always-below decision is
 * made with the parameters at solar noon of that day.
 */
function crossing(jd0: number, noonMin: number, lat: number, lng: number, zenithDeg: number, rising: boolean): Event {
  let minutes = noonMin;
  for (let i = 0; i < 4; i++) {
    const { declination, equationOfTimeMin } = solarParameters(julianCentury(jd0 + minutes / 1440));
    const c = cosHourAngle(lat, declination, zenithDeg);
    if (c > 1 || c < -1) {
      if (i === 0) return { never: c > 1 ? "below" : "above" };
      // Borderline day: the refined time slipped past the threshold; keep the last estimate.
      break;
    }
    const hourAngleDeg = Math.acos(c) / DEG;
    minutes = 720 - 4 * (lng + (rising ? hourAngleDeg : -hourAngleDeg)) - equationOfTimeMin;
  }
  return { minutes };
}

/**
 * Sun times for the local calendar day `dateKey` ("YYYY-MM-DD") at a place.
 *
 * The solar day is anchored on local mean solar noon (12:00 − lng/15 h UTC).
 * That matches the civil date everywhere whose clock is within ±12 h of solar
 * time; pass `timeZone` (IANA) to anchor on 12:00 local clock time instead,
 * which is exact for zones far from their solar time (e.g. Kiribati, Samoa).
 * Callers compute dateKey with localDateKey() from timezone.ts.
 *
 * Returned instants are absolute (Date). sunrise/sunset are null on polar
 * days/nights (`polar` says which); civilDawn/civilDusk are null when the sun
 * never reaches 6° below the horizon (white nights) or never rises above it.
 * Throws RangeError for a malformed dateKey, out-of-range coordinates or an
 * unknown timeZone.
 */
export function sunTimes(dateKey: string, lat: number, lng: number, timeZone?: string): SunTimes {
  const { year, month, day } = parseDateKey(dateKey);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new RangeError("lat/lng out of range");
  }
  // Keep away from the exact poles where the hour-angle formula divides by cos(lat) = 0.
  const safeLat = Math.max(-89.9999, Math.min(89.9999, lat));

  let midnightUtc = Date.UTC(year, month - 1, day);
  if (timeZone) {
    // Shift the anchor by whole days so solar noon is the one nearest local clock noon.
    const clockNoon = zonedTimeToUtc(dateKey, "12:00", timeZone).getTime();
    const meanNoon = midnightUtc + (720 - 4 * lng) * 60_000;
    midnightUtc += Math.round((clockNoon - meanNoon) / DAY_MS) * DAY_MS;
  }
  const jd0 = midnightUtc / DAY_MS + JD_UNIX_EPOCH;
  const at = (minutes: number) => new Date(midnightUtc + Math.round(minutes * 60_000));

  // Solar noon: iterate the equation of time at the noon estimate.
  let noonMin = 720 - 4 * lng;
  for (let i = 0; i < 3; i++) {
    noonMin = 720 - 4 * lng - solarParameters(julianCentury(jd0 + noonMin / 1440)).equationOfTimeMin;
  }

  const rise = crossing(jd0, noonMin, safeLat, lng, SUNRISE_ZENITH_DEG, true);
  const set = crossing(jd0, noonMin, safeLat, lng, SUNRISE_ZENITH_DEG, false);
  const dawn = crossing(jd0, noonMin, safeLat, lng, CIVIL_ZENITH_DEG, true);
  const dusk = crossing(jd0, noonMin, safeLat, lng, CIVIL_ZENITH_DEG, false);
  const time = (e: Event) => ("minutes" in e ? at(e.minutes) : null);

  let polar: SunTimes["polar"] = null;
  if ("never" in rise) polar = rise.never === "above" ? "day" : "night";

  return {
    sunrise: time(rise),
    sunset: time(set),
    civilDawn: time(dawn),
    civilDusk: time(dusk),
    solarNoon: at(noonMin),
    polar,
  };
}
