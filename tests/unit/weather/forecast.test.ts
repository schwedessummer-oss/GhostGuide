/**
 * Forecast views (src/server/weather/forecast.ts): current hour, the next
 * 24 hours, the non-overlapping period chain and daily aggregation in the
 * trail's time zone — including 23- and 25-hour days at DST changes and
 * 6-hour periods that straddle local midnight.
 */
import { describe, expect, it } from "vitest";
import {
  currentStep,
  dailyForecast,
  forecastPeriods,
  hourlyForecast,
  symbolSeverity,
} from "@/server/weather/forecast";
import { parseMetnoResponse, type MetnoSeries } from "@/server/weather/metno";
import { HOUR, fixtureJson, series, step } from "./helpers";

const tableRock = () => (parseMetnoResponse(fixtureJson("metno/complete-table-rock-sc.json")) as MetnoSeries).steps;
const NY = "America/New_York";

describe("currentStep", () => {
  const steps = tableRock();

  it("is the hourly step covering now", () => {
    expect(currentStep(steps, new Date("2026-11-12T15:00:00Z"))?.time).toBe("2026-11-12T15:00:00.000Z");
    expect(currentStep(steps, new Date("2026-11-12T15:59:59Z"))?.time).toBe("2026-11-12T15:00:00.000Z");
    expect(currentStep(steps, new Date("2026-11-14T17:30:00Z"))?.time).toBe("2026-11-14T17:00:00.000Z");
  });

  it("is null before the series, in the 6-hourly part and after it", () => {
    expect(currentStep(steps, new Date("2026-11-12T02:59:59Z"))).toBeNull();
    expect(currentStep(steps, new Date("2026-11-15T03:00:00Z"))).toBeNull();
    expect(currentStep(steps, new Date("2026-11-22T00:00:00Z"))).toBeNull();
    expect(currentStep([], new Date())).toBeNull();
  });

  it("accepts a step without a 1-hour period when the next step is an hour later", () => {
    const s = [step("2026-11-12T03:00:00Z", { t: 1 }), step("2026-11-12T04:00:00Z", { t: 2 })];
    expect(currentStep(s, new Date("2026-11-12T03:10:00Z"))?.temperatureC).toBe(1);
    // ...but not the last step with no period (its resolution is unknown).
    expect(currentStep(s, new Date("2026-11-12T04:10:00Z"))).toBeNull();
  });
});

describe("hourlyForecast", () => {
  const steps = tableRock();

  it("returns 24 hours from the current hour", () => {
    const h = hourlyForecast(steps, new Date("2026-11-12T15:20:00Z"));
    expect(h).toHaveLength(24);
    expect(h[0]).toEqual({
      time: "2026-11-12T15:00:00.000Z",
      temperatureC: 15.9,
      precipitationMm: 0,
      precipitationProbability: null,
      windSpeedMs: 5.4,
      windGustMs: null,
      symbol: "fair_day",
    });
    expect(h[23].time).toBe("2026-11-13T14:00:00.000Z");
    for (let i = 1; i < h.length; i++) expect(Date.parse(h[i].time) - Date.parse(h[i - 1].time)).toBe(HOUR);
  });

  it("stops where the hourly part ends and never presents 6-hourly steps as hours", () => {
    const h = hourlyForecast(steps, new Date("2026-11-14T10:00:00Z"));
    expect(h.map((x) => x.time.slice(11, 13))).toEqual(["10", "11", "12", "13", "14", "15", "16", "17"]);
  });

  it("honours count and returns nothing for a series that has ended", () => {
    expect(hourlyForecast(steps, new Date("2026-11-12T15:00:00Z"), 3)).toHaveLength(3);
    expect(hourlyForecast(steps, new Date("2026-11-25T00:00:00Z"))).toEqual([]);
  });
});

describe("forecastPeriods", () => {
  it("chains 1-hour periods, then 6-hour periods, without overlap", () => {
    const steps = tableRock();
    const periods = forecastPeriods(steps);
    for (let i = 1; i < periods.length; i++) expect(periods[i].start).toBeGreaterThanOrEqual(periods[i - 1].end);
    const oneHour = periods.filter((p) => p.end - p.start === HOUR);
    const sixHour = periods.filter((p) => p.end - p.start === 6 * HOUR);
    expect(oneHour.length + sixHour.length).toBe(periods.length);
    // Hourly from 03:00Z on 11-12 to 17:00Z on 11-14 (63 steps), then 6-hourly from 18:00Z.
    expect(oneHour).toHaveLength(63);
    expect(new Date(oneHour.at(-1)!.start).toISOString()).toBe("2026-11-14T17:00:00.000Z");
    expect(new Date(sixHour[0].start).toISOString()).toBe("2026-11-14T18:00:00.000Z");
  });

  it("does not double count overlapping 1-hour and 6-hour forecasts", () => {
    // Hourly steps each forecasting 1 mm/h and 6 mm per 6 h, then a 6-hourly step.
    const steps = [
      ...series("2026-11-12T00:00:00Z", 6, 1, () => ({ p1: 1, p6: 6 })),
      step("2026-11-12T06:00:00Z", { p6: 12 }),
      step("2026-11-12T12:00:00Z", { t: 1 }),
    ];
    const periods = forecastPeriods(steps);
    expect(periods.map((p) => p.precipitationMm)).toEqual([1, 1, 1, 1, 1, 1, 12]);
    expect(periods.reduce((a, p) => a + (p.precipitationMm ?? 0), 0)).toBe(18);
  });

  it("uses the 6-hour period when the next step is more than an hour away", () => {
    const steps = [step("2026-11-12T12:00:00Z", { p1: 1, p6: 4 }), step("2026-11-12T18:00:00Z", { p6: 2 })];
    expect(forecastPeriods(steps).map((p) => [p.end - p.start, p.precipitationMm])).toEqual([
      [6 * HOUR, 4],
      [6 * HOUR, 2],
    ]);
  });

  it("starts at fromMs", () => {
    const steps = series("2026-11-12T00:00:00Z", 4, 1, () => ({ p1: 1 }));
    expect(forecastPeriods(steps, Date.parse("2026-11-12T02:00:00Z"))).toHaveLength(2);
  });
});

describe("symbolSeverity", () => {
  it("orders symbols from fair to thunder", () => {
    const ordered = [
      "clearsky_day",
      "fair_night",
      "partlycloudy_polartwilight",
      "cloudy",
      "fog",
      "lightrainshowers_day",
      "lightrain",
      "lightsnow",
      "rainshowers_night",
      "rain",
      "sleet",
      "snow",
      "heavyrain",
      "heavysnow",
      "lightrainshowersandthunder_day",
      "rainandthunder",
      "heavysnowandthunder",
    ];
    const ranks = ordered.map(symbolSeverity);
    for (let i = 1; i < ranks.length; i++) expect(ranks[i], ordered[i]).toBeGreaterThan(ranks[i - 1]);
  });

  it("knows MET's misspelled thunder codes and ranks unknown codes lowest", () => {
    expect(symbolSeverity("lightssleetshowersandthunder_day")).toBeGreaterThan(symbolSeverity("heavysnow"));
    expect(symbolSeverity("lightssnowshowersandthunder_night")).toBeGreaterThan(symbolSeverity("heavysnow"));
    expect(symbolSeverity("sandstorm")).toBe(-1);
    expect(symbolSeverity(null)).toBe(-1);
    expect(symbolSeverity(undefined)).toBe(-1);
  });
});

describe("dailyForecast: real fixture", () => {
  it("returns 7 local days from today, aggregating only the future", () => {
    const daily = dailyForecast(tableRock(), new Date("2026-11-12T15:00:00Z"), NY);
    expect(daily.map((d) => d.date)).toEqual([
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
    ]);
    // Today (EST) = 15:00Z .. 05:00Z: warmest 16.3 °C at 16:00Z, coolest 7.7 °C at 04:00Z;
    // earlier steps (11.5 °C at 03:00Z, ...) are in the past and ignored.
    expect(daily[0]).toEqual({ date: "2026-11-12", minC: 7.7, maxC: 16.3, precipitationMm: 0, maxWindMs: 6.3, symbol: "fair_day" });
    expect(daily[3]).toMatchObject({ date: "2026-11-15", minC: -1.3, maxC: 11.6, precipitationMm: 0 });
    for (const d of daily) expect(d.minC as number).toBeLessThanOrEqual(d.maxC as number);
  });

  it("omits days the series does not reach", () => {
    const daily = dailyForecast(tableRock(), new Date("2026-11-19T15:00:00Z"), NY);
    expect(daily.map((d) => d.date)).toEqual(["2026-11-19", "2026-11-20", "2026-11-21"]);
    expect(dailyForecast([], new Date(), NY)).toEqual([]);
  });

  it("throws for an unknown time zone", () => {
    expect(() => dailyForecast(tableRock(), new Date("2026-11-12T15:00:00Z"), "Mars/Olympus")).toThrow(RangeError);
  });
});

describe("dailyForecast: DST and midnight boundaries", () => {
  it("a 25-hour day at the end of DST (New York, 2026-11-01)", () => {
    // Local midnight 2026-11-01 = 04:00Z (EDT); next midnight = 2026-11-02T05:00Z (EST).
    const steps = series("2026-11-01T04:00:00Z", 49, 1, (i) => ({ p1: 1, t: i === 24 ? 30 : 10 }));
    const daily = dailyForecast(steps, new Date("2026-11-01T04:00:00Z"), NY);
    expect(daily.map((d) => [d.date, d.precipitationMm])).toEqual([
      ["2026-11-01", 25],
      ["2026-11-02", 24],
    ]);
    // 2026-11-02T04:00Z (step 24) is 23:00 EST on Nov 1 — not midnight of Nov 2.
    expect(daily[0].maxC).toBe(30);
    expect(daily[1].maxC).toBe(10);
  });

  it("a 23-hour day at the start of DST (New York, 2027-03-14)", () => {
    const steps = series("2027-03-14T05:00:00Z", 47, 1, () => ({ p1: 1 }));
    const daily = dailyForecast(steps, new Date("2027-03-14T05:00:00Z"), NY);
    expect(daily.map((d) => [d.date, d.precipitationMm])).toEqual([
      ["2027-03-14", 23],
      ["2027-03-15", 24],
    ]);
  });

  it("a 25-hour day in Europe (Oslo, 2026-10-25)", () => {
    const steps = series("2026-10-24T22:00:00Z", 25, 1, () => ({ p1: 0.2 }));
    const daily = dailyForecast(steps, new Date("2026-10-24T22:00:00Z"), "Europe/Oslo");
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({ date: "2026-10-25", precipitationMm: 5 });
  });

  it("assigns a 6-hour period across local midnight to the day holding its midpoint", () => {
    // EST: 00Z–06Z = 19:00–01:00 local (midpoint 22:00 → Nov 12); 06Z–12Z = 01:00–07:00 (→ Nov 13).
    const steps = [
      step("2026-11-12T18:00:00Z", { p6: 1 }),
      step("2026-11-13T00:00:00Z", { p6: 2 }),
      step("2026-11-13T06:00:00Z", { p6: 4 }),
      step("2026-11-13T12:00:00Z", { p6: 8 }),
    ];
    const daily = dailyForecast(steps, new Date("2026-11-12T18:00:00Z"), NY);
    expect(daily.map((d) => [d.date, d.precipitationMm])).toEqual([
      ["2026-11-12", 3],
      ["2026-11-13", 12],
    ]);
  });

  it("uses 6-hour min/max temperatures and reports null when nothing is known", () => {
    const steps = [
      step("2026-11-15T17:00:00Z", { t: 4, min6: -2, max6: 9, sym6: "cloudy" }),
      step("2026-11-15T23:00:00Z", { t: null }),
    ];
    const daily = dailyForecast(steps, new Date("2026-11-15T17:00:00Z"), NY);
    expect(daily[0]).toEqual({ date: "2026-11-15", minC: -2, maxC: 9, precipitationMm: null, maxWindMs: null, symbol: "cloudy" });
  });
});

describe("dailyForecast: representative symbol", () => {
  it("is the most significant daytime 6-hour symbol, ignoring the night", () => {
    // EST daytime 06:00–18:00 = 11:00Z–23:00Z.
    const steps = [
      step("2026-11-13T05:00:00Z", { sym6: "heavysnow" }), // 00:00 local — night
      step("2026-11-13T11:00:00Z", { sym6: "partlycloudy_day" }), // 06:00
      step("2026-11-13T17:00:00Z", { sym6: "lightrainshowers_day" }), // 12:00
      step("2026-11-13T23:00:00Z", { sym6: "rainandthunder" }), // 18:00 — evening, not daytime
    ];
    const [day] = dailyForecast(steps, new Date("2026-11-13T05:00:00Z"), NY);
    expect(day.symbol).toBe("lightrainshowers_day");
  });

  it("chains daytime periods without overlap across hourly steps", () => {
    // Hourly steps 06:00–17:00 local, each with a 6-hour symbol; only 06:00 and 12:00 count.
    const steps = series("2026-11-13T11:00:00Z", 12, 1, (i) => ({
      p1: 0,
      sym1: "cloudy",
      sym6: i === 0 ? "fair_day" : i === 6 ? "cloudy" : "heavyrain",
    }));
    const [day] = dailyForecast(steps, new Date("2026-11-13T11:00:00Z"), NY);
    expect(day.symbol).toBe("cloudy");
  });

  it("falls back to the day's periods when there is no daytime period (late evening)", () => {
    const steps = series("2026-11-13T02:00:00Z", 3, 1, (i) => ({ p1: 0, sym1: i === 1 ? "fog" : "clearsky_night" }));
    const [day] = dailyForecast(steps, new Date("2026-11-13T02:30:00Z"), NY);
    expect(day).toMatchObject({ date: "2026-11-12", symbol: "fog" });
  });
});
