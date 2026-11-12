import "server-only";
import tzLookup from "@photostructure/tz-lookup";

/**
 * Time zone helpers built on the platform Intl API (IANA zones, DST-aware).
 *
 * Date keys are local calendar dates "YYYY-MM-DD"; times of day are "HH:MM"
 * on a 24-hour clock. Formatter instances are cached per zone/locale (bounded)
 * because constructing Intl.DateTimeFormat is comparatively expensive.
 */

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_OF_DAY = /^(\d{1,2}):(\d{2})$/;
const DAY_MS = 86_400_000;
const FORMATTER_CACHE_MAX = 64;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function cachedFormatter(key: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  const hit = formatterCache.get(key);
  if (hit) return hit;
  const f = make();
  if (formatterCache.size >= FORMATTER_CACHE_MAX) {
    const oldest = formatterCache.keys().next().value as string;
    formatterCache.delete(oldest);
  }
  formatterCache.set(key, f);
  return f;
}

/** Wall-clock parts formatter (24 h, with seconds) for a zone. Throws RangeError for unknown zones. */
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  return cachedFormatter(`parts|${timeZone}`, () =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  );
}

/** True when the runtime knows this IANA zone. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    partsFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * IANA time zone at a location, from @photostructure/tz-lookup's compact
 * boundary model. Over the open ocean it returns the nautical zone
 * (e.g. "Etc/GMT+2"), which is a valid IANA zone with the correct offset;
 * that value is passed through. Returns null for invalid coordinates, a
 * lookup error, or a zone the runtime does not know. The model is
 * approximate within a few kilometres of zone borders (see the package docs).
 */
export function timezoneAt(lat: number, lng: number): string | null {
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return null;
  }
  try {
    const zone = tzLookup(lat, lng);
    return isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(date: Date, timeZone: string): WallClock {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    // Some ICU versions print midnight as "24" even with h23; normalize.
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

function assertValidDate(date: Date): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new RangeError("Invalid Date");
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/**
 * Local calendar date "YYYY-MM-DD" of an instant in a zone.
 * Throws RangeError for an invalid date or unknown zone.
 */
export function localDateKey(date: Date, timeZone: string): string {
  assertValidDate(date);
  const w = wallClock(date, timeZone);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** Parse a strict "YYYY-MM-DD" key that names a real calendar date. Throws RangeError otherwise. */
export function parseDateKey(key: string): { year: number; month: number; day: number } {
  const m = typeof key === "string" ? DATE_KEY.exec(key) : null;
  if (!m) throw new RangeError(`Invalid date key: ${String(key)}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const t = new Date(Date.UTC(year, month - 1, day));
  if (t.getUTCFullYear() !== year || t.getUTCMonth() !== month - 1 || t.getUTCDate() !== day) {
    throw new RangeError(`Invalid date key: ${key}`);
  }
  return { year, month, day };
}

/** Calendar arithmetic on date keys (no time zone involved). */
export function addDaysToKey(key: string, n: number): string {
  if (!Number.isInteger(n)) throw new RangeError("n must be an integer number of days");
  const { year, month, day } = parseDateKey(key);
  const t = new Date(Date.UTC(year, month - 1, day) + n * DAY_MS);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** UTC offset of a zone at an instant, in milliseconds (local − UTC), to the second. */
export function timeZoneOffsetMs(date: Date, timeZone: string): number {
  assertValidDate(date);
  const w = wallClock(date, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const truncated = Math.floor(date.getTime() / 1000) * 1000;
  return asUtc - truncated;
}

/**
 * The instant at which the wall clock in `timeZone` shows `time` ("HH:MM")
 * on `dateKey`. DST is resolved like Temporal's "compatible" disambiguation:
 *  - skipped times (spring forward) move forward by the gap
 *    (02:30 on a 02:00→03:00 night becomes 03:30 in the new offset);
 *  - repeated times (fall back) resolve to the earlier instant.
 * Throws RangeError for a malformed key/time or an unknown zone.
 */
export function zonedTimeToUtc(dateKey: string, time: string, timeZone: string): Date {
  const { year, month, day } = parseDateKey(dateKey);
  const m = typeof time === "string" ? TIME_OF_DAY.exec(time) : null;
  if (!m) throw new RangeError(`Invalid time of day: ${String(time)}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new RangeError(`Invalid time of day: ${time}`);
  if (!isValidTimeZone(timeZone)) throw new RangeError(`Unknown time zone: ${String(timeZone)}`);

  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Offsets in force a day either side; real zones change offset at most once in 48 h.
  const before = timeZoneOffsetMs(new Date(wall - DAY_MS), timeZone);
  const after = timeZoneOffsetMs(new Date(wall + DAY_MS), timeZone);
  const valid: number[] = [];
  for (const offset of new Set([before, after])) {
    const t = wall - offset;
    if (timeZoneOffsetMs(new Date(t), timeZone) === offset) valid.push(t);
  }
  if (valid.length > 0) return new Date(Math.min(...valid));
  // In a gap: interpret with the pre-transition offset, which lands after the gap.
  return new Date(wall - before);
}

/**
 * Localized wall-clock time, e.g. "4:35 PM" (en-US) or "16:35" (en-GB).
 * Narrow / no-break spaces that ICU puts before AM/PM are normalized to a
 * plain space so server and client output match across ICU versions.
 * Throws RangeError for an invalid date, zone or locale.
 */
export function formatLocalTime(date: Date, timeZone: string, locale = "en-US"): string {
  assertValidDate(date);
  const f = cachedFormatter(`time|${locale}|${timeZone}`, () =>
    new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }),
  );
  return f.format(date).replace(/[  ]/g, " ");
}
