import { describe, expect, it } from "vitest";
import { SUNRISE_ZENITH_DEG, CIVIL_ZENITH_DEG, sunTimes } from "@/server/geo/sun";
import { addDaysToKey, zonedTimeToUtc } from "@/server/geo/timezone";

const MIN = 60_000;

/** |actual − expected| in minutes; expected is a local wall-clock time. */
function minutesOff(actual: Date | null, dateKey: string, hhmm: string, timeZone: string): number {
  if (!actual) return Infinity;
  return Math.abs(actual.getTime() - zonedTimeToUtc(dateKey, hhmm, timeZone).getTime()) / MIN;
}

// ---------------------------------------------------------------------------
// Independent cross-check: the US Naval Observatory "Almanac for Computers"
// (1990) sunrise/sunset algorithm. Different formulation (mean anomaly,
// right ascension, fixed obliquity), quoted accuracy ~±2 min. Returns UTC
// hours on the given day, or null when the sun does not cross the zenith.
// ---------------------------------------------------------------------------
function almanacUtcHours(dayOfYear: number, lat: number, lng: number, zenith: number, rising: boolean): number | null {
  const rad = Math.PI / 180;
  const lngHour = lng / 15;
  const t = dayOfYear + ((rising ? 6 : 18) - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  let L = M + 1.916 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 282.634;
  L = ((L % 360) + 360) % 360;
  let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
  RA = ((RA % 360) + 360) % 360;
  RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90;
  RA /= 15;
  const sinDec = 0.39782 * Math.sin(L * rad);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(zenith * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
  if (cosH > 1 || cosH < -1) return null;
  const H = (rising ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad) / 15;
  const T = H + RA - 0.06571 * t - 6.622;
  return T - lngHour;
}

function dayOfYear(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86_400_000;
}

/** Almanac event as an instant, choosing the UTC day that puts it nearest `near`. */
function almanacEvent(dateKey: string, lat: number, lng: number, zenith: number, rising: boolean, near: Date): Date | null {
  const h = almanacUtcHours(dayOfYear(dateKey), lat, lng, zenith, rising);
  if (h === null) return null;
  const [y, m, d] = dateKey.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d) + h * 3_600_000;
  const k = Math.round((near.getTime() - base) / 86_400_000);
  return new Date(base + k * 86_400_000);
}

describe("sunTimes: published reference times (±2 min)", () => {
  // Local clock times as published for these dates (timeanddate.com / NOAA).
  const cases: { place: string; lat: number; lng: number; tz: string; date: string; rise: string; set: string }[] = [
    { place: "London (summer solstice)", lat: 51.5074, lng: -0.1278, tz: "Europe/London", date: "2024-06-20", rise: "04:43", set: "21:21" },
    { place: "London (winter solstice)", lat: 51.5074, lng: -0.1278, tz: "Europe/London", date: "2024-12-21", rise: "08:04", set: "15:53" },
    { place: "New York (June)", lat: 40.7128, lng: -74.006, tz: "America/New_York", date: "2024-06-20", rise: "05:25", set: "20:31" },
    { place: "New York (December)", lat: 40.7128, lng: -74.006, tz: "America/New_York", date: "2024-12-21", rise: "07:17", set: "16:32" },
    { place: "Sydney (southern summer)", lat: -33.8688, lng: 151.2093, tz: "Australia/Sydney", date: "2024-12-21", rise: "05:41", set: "20:05" },
    { place: "Sydney (southern winter)", lat: -33.8688, lng: 151.2093, tz: "Australia/Sydney", date: "2024-06-21", rise: "07:00", set: "16:54" },
    { place: "Tokyo (June)", lat: 35.6762, lng: 139.6503, tz: "Asia/Tokyo", date: "2024-06-21", rise: "04:25", set: "19:00" },
    { place: "Helsinki (midsummer)", lat: 60.1699, lng: 24.9384, tz: "Europe/Helsinki", date: "2024-06-21", rise: "03:54", set: "22:50" },
  ];

  for (const c of cases) {
    it(`${c.place} ${c.date}`, () => {
      const s = sunTimes(c.date, c.lat, c.lng);
      expect(s.polar).toBeNull();
      expect(minutesOff(s.sunrise, c.date, c.rise, c.tz)).toBeLessThanOrEqual(2);
      expect(minutesOff(s.sunset, c.date, c.set, c.tz)).toBeLessThanOrEqual(2);
    });
  }

  it("puts solar noon where the equation of time says (London, June: ~13:02 BST)", () => {
    const s = sunTimes("2024-06-20", 51.5074, -0.1278);
    expect(minutesOff(s.solarNoon, "2024-06-20", "13:02", "Europe/London")).toBeLessThanOrEqual(1);
    // Early November the equation of time peaks at ~+16.4 min: noon at Greenwich ≈ 11:43:35 UTC.
    const nov = sunTimes("2024-11-03", 51.4779, 0);
    expect(Math.abs(nov.solarNoon.getTime() - Date.UTC(2024, 10, 3, 11, 43, 35)) / MIN).toBeLessThan(0.5);
  });

  it("gives ~12 h 07 min of daylight on the equator at the equinox, centred on ~12:07 UTC at 0°", () => {
    const s = sunTimes("2024-03-20", 0, 0);
    const lengthMin = (s.sunset!.getTime() - s.sunrise!.getTime()) / MIN;
    expect(Math.abs(lengthMin - (12 * 60 + 7))).toBeLessThanOrEqual(2);
    expect(Math.abs(s.solarNoon.getTime() - Date.UTC(2024, 2, 20, 12, 7, 30)) / MIN).toBeLessThan(1.5);
    expect(s.civilDawn!.getTime()).toBeLessThan(s.sunrise!.getTime());
    expect(s.civilDusk!.getTime()).toBeGreaterThan(s.sunset!.getTime());
  });
});

describe("sunTimes: agreement with an independent algorithm", () => {
  const places: [string, number, number][] = [
    ["Quito", -0.1807, -78.4678],
    ["Nairobi", -1.2921, 36.8219],
    ["Denver", 39.7392, -104.9903],
    ["Cape Town", -33.9249, 18.4241],
    ["Christchurch", -43.532, 172.6306],
    ["Ushuaia", -54.8019, -68.303],
    ["Reykjavik", 64.1466, -21.9426],
    ["Anchorage", 61.2181, -149.9003],
    ["Kathmandu", 27.7172, 85.324],
  ];
  const dates = ["2024-01-15", "2024-03-20", "2024-05-01", "2024-06-21", "2024-08-15", "2024-09-22", "2024-11-05", "2024-12-21"];

  it("matches sunrise/sunset and civil twilight within 2 minutes (or both report no event)", () => {
    let compared = 0;
    for (const [, lat, lng] of places) {
      for (const date of dates) {
        const s = sunTimes(date, lat, lng);
        const checks: [Date | null, number, boolean][] = [
          [s.sunrise, SUNRISE_ZENITH_DEG, true],
          [s.sunset, SUNRISE_ZENITH_DEG, false],
          [s.civilDawn, CIVIL_ZENITH_DEG, true],
          [s.civilDusk, CIVIL_ZENITH_DEG, false],
        ];
        for (const [ours, zenith, rising] of checks) {
          const ref = almanacEvent(date, lat, lng, zenith, rising, ours ?? s.solarNoon);
          if (ours === null || ref === null) {
            expect(ours === null && ref === null).toBe(true);
            continue;
          }
          expect(Math.abs(ours.getTime() - ref.getTime()) / MIN).toBeLessThanOrEqual(2);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(250);
  });
});

describe("sunTimes: polar and high-latitude cases", () => {
  it("Tromsø: polar night in December (civil twilight still occurs), midnight sun in June", () => {
    const dec = sunTimes("2024-12-21", 69.6492, 18.9553);
    expect(dec).toMatchObject({ polar: "night", sunrise: null, sunset: null });
    expect(dec.civilDawn).not.toBeNull();
    expect(dec.civilDusk).not.toBeNull();
    expect(dec.civilDawn!.getTime()).toBeLessThan(dec.solarNoon.getTime());
    expect(dec.civilDusk!.getTime()).toBeGreaterThan(dec.solarNoon.getTime());

    const jun = sunTimes("2024-06-21", 69.6492, 18.9553);
    expect(jun).toMatchObject({ polar: "day", sunrise: null, sunset: null, civilDawn: null, civilDusk: null });
  });

  it("Longyearbyen in December: no sunrise and not even civil twilight", () => {
    const s = sunTimes("2024-12-21", 78.2232, 15.6267);
    expect(s).toMatchObject({ polar: "night", sunrise: null, sunset: null, civilDawn: null, civilDusk: null });
    expect(s.solarNoon).toBeInstanceOf(Date);
  });

  it("McMurdo Station: polar night in June, polar day in December (southern hemisphere)", () => {
    expect(sunTimes("2024-06-21", -77.8463, 166.6682).polar).toBe("night");
    expect(sunTimes("2024-12-21", -77.8463, 166.6682).polar).toBe("day");
  });

  it("Reykjavik at midsummer: sun sets after local midnight, civil twilight lasts all night", () => {
    const s = sunTimes("2024-06-21", 64.1466, -21.9426);
    expect(s.polar).toBeNull();
    // Published: sunrise 02:55, sunset 00:04 the next calendar day (UTC+0, no DST).
    expect(minutesOff(s.sunrise, "2024-06-21", "02:55", "Atlantic/Reykjavik")).toBeLessThanOrEqual(2);
    expect(minutesOff(s.sunset, addDaysToKey("2024-06-21", 1), "00:04", "Atlantic/Reykjavik")).toBeLessThanOrEqual(2);
    expect(s.civilDawn).toBeNull();
    expect(s.civilDusk).toBeNull();
  });

  it("does not blow up exactly at the poles", () => {
    const north = sunTimes("2024-06-21", 90, 0);
    expect(north.polar).toBe("day");
    const south = sunTimes("2024-06-21", -90, 0);
    expect(south.polar).toBe("night");
  });
});

describe("sunTimes: anchoring and validation", () => {
  it("returns the events of the requested local day for east and west longitudes", () => {
    // Sydney sunrise on 2024-12-21 local is 2024-12-20 ~18:41 UTC.
    const syd = sunTimes("2024-12-21", -33.8688, 151.2093);
    expect(syd.sunrise!.toISOString().slice(0, 10)).toBe("2024-12-20");
    // Denver sunset on 2024-06-20 local is 2024-06-21 ~02:31 UTC.
    const den = sunTimes("2024-06-20", 39.7392, -104.9903);
    expect(den.sunset!.toISOString().slice(0, 10)).toBe("2024-06-21");
    expect(minutesOff(den.sunset, "2024-06-20", "20:31", "America/Denver")).toBeLessThanOrEqual(2);
  });

  it("uses the time zone (when given) for places far from solar time, e.g. Kiritimati (UTC+14)", () => {
    const key = "2024-06-21";
    const withZone = sunTimes(key, 1.87, -157.4, "Pacific/Kiritimati");
    // Local sunrise around 06:24 on the requested local date.
    expect(minutesOff(withZone.sunrise, key, "06:24", "Pacific/Kiritimati")).toBeLessThanOrEqual(3);
    // Without the zone the solar day anchors to the local *solar* date, a day earlier on the clock.
    const solarOnly = sunTimes(key, 1.87, -157.4);
    expect(Math.round((withZone.sunrise!.getTime() - solarOnly.sunrise!.getTime()) / 86_400_000)).toBe(-1);
    // For ordinary places the zone changes nothing.
    const a = sunTimes(key, 39.7392, -104.9903);
    const b = sunTimes(key, 39.7392, -104.9903, "America/Denver");
    expect(b.sunrise!.getTime()).toBe(a.sunrise!.getTime());
  });

  it("orders the events of a normal day", () => {
    const s = sunTimes("2024-04-15", 46.5, 8.0);
    const seq = [s.civilDawn, s.sunrise, s.solarNoon, s.sunset, s.civilDusk].map((d) => d!.getTime());
    expect([...seq].sort((x, y) => x - y)).toEqual(seq);
  });

  it("rejects malformed dates and coordinates", () => {
    expect(() => sunTimes("2024-02-30", 0, 0)).toThrow(RangeError);
    expect(() => sunTimes("June 1", 0, 0)).toThrow(RangeError);
    expect(() => sunTimes("2024-06-01", 91, 0)).toThrow(RangeError);
    expect(() => sunTimes("2024-06-01", 0, NaN)).toThrow(RangeError);
  });
});
