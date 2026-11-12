import { describe, expect, it } from "vitest";
import {
  addDaysToKey,
  formatLocalTime,
  isValidTimeZone,
  localDateKey,
  parseDateKey,
  timeZoneOffsetMs,
  timezoneAt,
  zonedTimeToUtc,
} from "@/server/geo/timezone";

const H = 3_600_000;
const iso = (d: Date) => d.toISOString();

describe("timezoneAt", () => {
  it("finds the IANA zone for places on land", () => {
    expect(timezoneAt(39.7392, -104.9903)).toBe("America/Denver");
    expect(timezoneAt(35.6762, 139.6503)).toBe("Asia/Tokyo");
    expect(timezoneAt(-33.8688, 151.2093)).toBe("Australia/Sydney");
    expect(timezoneAt(46.8529, -121.7604)).toBe("America/Los_Angeles");
    expect(timezoneAt(51.5074, -0.1278)).toBe("Europe/London");
  });

  it("passes through nautical zones over the ocean", () => {
    const zone = timezoneAt(0, -30);
    expect(zone).toBe("Etc/GMT+2");
    expect(isValidTimeZone(zone)).toBe(true);
  });

  it("returns null for invalid coordinates instead of throwing", () => {
    expect(timezoneAt(NaN, 0)).toBeNull();
    expect(timezoneAt(0, Infinity)).toBeNull();
    expect(timezoneAt(91, 0)).toBeNull();
    expect(timezoneAt(0, -181)).toBeNull();
    expect(timezoneAt("40" as unknown as number, 0)).toBeNull();
  });
});

describe("date keys", () => {
  it("gives the local calendar date of an instant", () => {
    // 23:59 MST on 9 March vs 00:00 MST on 10 March.
    expect(localDateKey(new Date("2024-03-10T06:59:00Z"), "America/Denver")).toBe("2024-03-09");
    expect(localDateKey(new Date("2024-03-10T07:00:00Z"), "America/Denver")).toBe("2024-03-10");
    // Tokyo (UTC+9) is already in the new year.
    expect(localDateKey(new Date("2024-12-31T15:00:00Z"), "Asia/Tokyo")).toBe("2025-01-01");
    expect(localDateKey(new Date("2024-12-31T14:59:59Z"), "Asia/Tokyo")).toBe("2024-12-31");
    // Sydney winter (AEST, UTC+10) and summer (AEDT, UTC+11).
    expect(localDateKey(new Date("2024-06-30T14:00:00Z"), "Australia/Sydney")).toBe("2024-07-01");
    expect(localDateKey(new Date("2024-01-14T13:00:00Z"), "Australia/Sydney")).toBe("2024-01-15");
    expect(localDateKey(new Date("2024-01-14T12:59:00Z"), "Australia/Sydney")).toBe("2024-01-14");
  });

  it("rejects invalid dates and zones", () => {
    expect(() => localDateKey(new Date(NaN), "UTC")).toThrow(RangeError);
    expect(() => localDateKey(new Date(), "Mars/Olympus_Mons")).toThrow(RangeError);
  });

  it("adds days across month, year and leap-day boundaries", () => {
    expect(addDaysToKey("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDaysToKey("2024-02-28", 2)).toBe("2024-03-01");
    expect(addDaysToKey("2023-02-28", 1)).toBe("2023-03-01");
    expect(addDaysToKey("2024-12-31", 1)).toBe("2025-01-01");
    expect(addDaysToKey("2025-01-01", -1)).toBe("2024-12-31");
    expect(addDaysToKey("2024-03-10", 0)).toBe("2024-03-10");
    expect(addDaysToKey("2024-01-31", 366)).toBe("2025-01-31");
  });

  it("validates keys strictly", () => {
    expect(parseDateKey("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 });
    expect(() => parseDateKey("2023-02-29")).toThrow(RangeError);
    expect(() => addDaysToKey("2024-02-30", 1)).toThrow(RangeError);
    expect(() => addDaysToKey("2024-1-01", 1)).toThrow(RangeError);
    expect(() => addDaysToKey("2024-01-01T00:00", 1)).toThrow(RangeError);
    expect(() => addDaysToKey("2024-01-01", 1.5)).toThrow(RangeError);
    expect(() => parseDateKey(null as unknown as string)).toThrow(RangeError);
  });
});

describe("timeZoneOffsetMs", () => {
  it("reports standard, daylight and fractional offsets", () => {
    expect(timeZoneOffsetMs(new Date("2024-01-15T12:00:00Z"), "America/Denver")).toBe(-7 * H);
    expect(timeZoneOffsetMs(new Date("2024-07-15T12:00:00Z"), "America/Denver")).toBe(-6 * H);
    expect(timeZoneOffsetMs(new Date("2024-07-15T12:00:00.789Z"), "Asia/Kolkata")).toBe(5.5 * H);
    expect(timeZoneOffsetMs(new Date("2024-07-15T12:00:00Z"), "Asia/Kathmandu")).toBe(5.75 * H);
    expect(timeZoneOffsetMs(new Date("2024-01-15T12:00:00Z"), "Australia/Sydney")).toBe(11 * H);
    expect(timeZoneOffsetMs(new Date("2024-07-15T12:00:00Z"), "Australia/Sydney")).toBe(10 * H);
  });
});

describe("zonedTimeToUtc", () => {
  it("converts ordinary wall times", () => {
    expect(iso(zonedTimeToUtc("2024-07-04", "12:00", "America/Denver"))).toBe("2024-07-04T18:00:00.000Z");
    expect(iso(zonedTimeToUtc("2024-01-04", "12:00", "America/Denver"))).toBe("2024-01-04T19:00:00.000Z");
    expect(iso(zonedTimeToUtc("2024-06-21", "09:00", "Asia/Tokyo"))).toBe("2024-06-21T00:00:00.000Z");
    expect(iso(zonedTimeToUtc("2025-01-01", "00:00", "Asia/Tokyo"))).toBe("2024-12-31T15:00:00.000Z");
    expect(iso(zonedTimeToUtc("2024-01-15", "12:00", "Australia/Sydney"))).toBe("2024-01-15T01:00:00.000Z");
    expect(iso(zonedTimeToUtc("2024-07-15", "12:00", "Australia/Sydney"))).toBe("2024-07-15T02:00:00.000Z");
    expect(iso(zonedTimeToUtc("2024-07-15", "7:05", "UTC"))).toBe("2024-07-15T07:05:00.000Z");
  });

  it("America/Denver spring forward (2024-03-10, 02:00 → 03:00)", () => {
    expect(iso(zonedTimeToUtc("2024-03-10", "01:30", "America/Denver"))).toBe("2024-03-10T08:30:00.000Z"); // MST
    expect(iso(zonedTimeToUtc("2024-03-10", "03:30", "America/Denver"))).toBe("2024-03-10T09:30:00.000Z"); // MDT
    // 02:30 does not exist: moved forward by the gap, to 03:30 MDT.
    expect(iso(zonedTimeToUtc("2024-03-10", "02:30", "America/Denver"))).toBe("2024-03-10T09:30:00.000Z");
    expect(iso(zonedTimeToUtc("2024-03-10", "02:00", "America/Denver"))).toBe("2024-03-10T09:00:00.000Z");
  });

  it("America/Denver fall back (2024-11-03, 02:00 → 01:00)", () => {
    expect(iso(zonedTimeToUtc("2024-11-03", "00:30", "America/Denver"))).toBe("2024-11-03T06:30:00.000Z"); // MDT
    // 01:30 happens twice: the earlier (MDT) instant is used.
    expect(iso(zonedTimeToUtc("2024-11-03", "01:30", "America/Denver"))).toBe("2024-11-03T07:30:00.000Z");
    expect(iso(zonedTimeToUtc("2024-11-03", "02:30", "America/Denver"))).toBe("2024-11-03T09:30:00.000Z"); // MST
  });

  it("Australia/Sydney DST start (2024-10-06) and end (2024-04-07)", () => {
    // 02:30 skipped → 03:30 AEDT (UTC+11).
    expect(iso(zonedTimeToUtc("2024-10-06", "02:30", "Australia/Sydney"))).toBe("2024-10-05T16:30:00.000Z");
    // 02:30 repeated → earlier instant, still AEDT (UTC+11).
    expect(iso(zonedTimeToUtc("2024-04-07", "02:30", "Australia/Sydney"))).toBe("2024-04-06T15:30:00.000Z");
    expect(iso(zonedTimeToUtc("2024-04-07", "03:30", "Australia/Sydney"))).toBe("2024-04-06T17:30:00.000Z");
  });

  it("round-trips every half hour of the DST-change days", () => {
    for (const [key, zone] of [
      ["2024-03-10", "America/Denver"],
      ["2024-11-03", "America/Denver"],
      ["2024-10-06", "Australia/Sydney"],
      ["2024-04-07", "Australia/Sydney"],
    ]) {
      for (let m = 0; m < 24 * 60; m += 30) {
        const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
        const t = zonedTimeToUtc(key, hhmm, zone);
        expect(localDateKey(t, zone)).toBe(key);
        const localMin = (((t.getTime() + timeZoneOffsetMs(t, zone)) / 60_000) % 1440 + 1440) % 1440;
        // Either the requested time or (inside a gap) exactly one hour later.
        expect([m, m + 60]).toContain(localMin);
        if (localMin !== m) expect(formatLocalTime(t, zone, "en-GB")).not.toBe(hhmm);
      }
    }
  });

  it("rejects malformed input", () => {
    expect(() => zonedTimeToUtc("2024-01-01", "24:00", "UTC")).toThrow(RangeError);
    expect(() => zonedTimeToUtc("2024-01-01", "12:60", "UTC")).toThrow(RangeError);
    expect(() => zonedTimeToUtc("2024-01-01", "noon", "UTC")).toThrow(RangeError);
    expect(() => zonedTimeToUtc("2024-13-01", "12:00", "UTC")).toThrow(RangeError);
    expect(() => zonedTimeToUtc("2024-01-01", "12:00", "Not/AZone")).toThrow(RangeError);
  });
});

describe("formatLocalTime", () => {
  const t = new Date("2024-06-21T23:35:00Z");

  it("formats in the zone with a plain space before AM/PM", () => {
    expect(formatLocalTime(t, "America/Denver")).toBe("5:35 PM");
    expect(formatLocalTime(t, "Asia/Tokyo")).toBe("8:35 AM");
    expect(formatLocalTime(t, "Australia/Sydney")).toBe("9:35 AM");
    expect(formatLocalTime(new Date("2024-12-21T23:35:00Z"), "Australia/Sydney")).toBe("10:35 AM");
    expect(formatLocalTime(t, "America/Denver")).not.toMatch(/[  ]/);
  });

  it("supports other locales", () => {
    expect(formatLocalTime(t, "America/Denver", "en-GB")).toBe("17:35");
    expect(formatLocalTime(t, "Europe/Berlin", "en-GB")).toMatch(/^0?1:35$/);
  });

  it("rejects invalid dates and zones", () => {
    expect(() => formatLocalTime(new Date(NaN), "UTC")).toThrow(RangeError);
    expect(() => formatLocalTime(t, "Nowhere/Zone")).toThrow(RangeError);
  });
});
