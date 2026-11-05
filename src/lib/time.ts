/**
 * Time-zone helpers (isomorphic, Intl-based; no tz library needed).
 * Trip dates/times are entered in the REGION's local time zone
 * (regions.timezone) and stored as `date` + `time`; instants are UTC.
 */

function partsInZone(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
export function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = partsInZone(date, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Convert a local wall-clock date ("2026-11-14") and time ("08:30") in
 * `timeZone` to a UTC Date. Handles DST by re-checking the offset.
 */
export function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [h, mi] = timeStr.split(":").map(Number);
  if (![y, m, d, h, mi].every(Number.isFinite)) throw new Error(`Invalid local date/time: ${dateStr} ${timeStr}`);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let offset = zoneOffsetMs(new Date(guess), timeZone);
  let utc = guess - offset;
  const offset2 = zoneOffsetMs(new Date(utc), timeZone);
  if (offset2 !== offset) {
    offset = offset2;
    utc = guess - offset;
  }
  return new Date(utc);
}

/** Local calendar date (YYYY-MM-DD) of an instant in a zone. */
export function localDateInZone(date: Date, timeZone: string): string {
  const p = partsInZone(date, timeZone);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Local wall-clock time (HH:MM) of an instant in a zone. */
export function localTimeInZone(date: Date, timeZone: string): string {
  const p = partsInZone(date, timeZone);
  return `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
}

/** Add minutes to an "HH:MM" string (wraps past midnight; returns HH:MM). */
export function addMinutesToClock(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = (((h * 60 + m + Math.round(minutes)) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function formatInZone(date: Date | string, timeZone: string, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }) {
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone }).format(new Date(date));
}
