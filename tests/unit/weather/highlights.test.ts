/**
 * Forecast highlights (src/server/weather/highlights.ts): each rule with a
 * fixed `now` and time zone, thresholds at their edges, wording of times
 * ("around 4 PM", "tomorrow", "overnight") and the output limit.
 *
 * Reference: now = 2026-11-12T14:00:00Z = 9 AM in America/New_York (EST),
 * hourly entries from 14:00Z, so entry i is (9 + i) o'clock local.
 */
import { describe, expect, it } from "vitest";
import {
  HIGHLIGHT_LIMITS,
  clockTime,
  forecastHighlights,
  formatTemp,
  formatWind,
} from "@/server/weather/highlights";
import { parseMetnoResponse, type MetnoSeries } from "@/server/weather/metno";
import { hourlyForecast } from "@/server/weather/forecast";
import { fixtureJson, hours } from "./helpers";

const NY = "America/New_York";
const NOW = new Date("2026-11-12T14:00:00Z");
const START = "2026-11-12T14:00:00Z";
/** Hour index for a local EST hour today (9 AM = 0). */
const at = (localHour: number) => localHour - 9;

const hl = (spec: Parameters<typeof hours>[2], count = 24) => forecastHighlights(hours(START, count, spec), NOW, NY);

describe("formatting", () => {
  it("formats temperatures with a real minus sign", () => {
    expect(formatTemp(-3.4)).toBe("−3 °C");
    expect(formatTemp(-0.3)).toBe("−0.3 °C");
    expect(formatTemp(0)).toBe("0 °C");
    expect(formatTemp(31.6)).toBe("32 °C");
  });

  it("formats wind in m/s and km/h", () => {
    expect(formatWind(18)).toBe("18 m/s (65 km/h)");
    expect(formatWind(12)).toBe("12 m/s (43 km/h)");
  });

  it("formats clock times in the trail's zone", () => {
    expect(clockTime(new Date("2026-11-12T21:00:00Z"), NY)).toBe("4 PM");
    expect(clockTime(new Date("2026-11-12T21:30:00Z"), NY)).toBe("4:30 PM");
    expect(clockTime(new Date("2026-11-12T10:00:00Z"), "Asia/Kolkata")).toBe("3:30 PM");
  });
});

describe("precipitation with published probabilities", () => {
  it("says 'likely' at the first hour reaching 60 %", () => {
    expect(hl((i) => (i === at(16) ? { prob: 70, sym: "rain", mm: 0.8 } : i > at(16) ? { prob: 90, sym: "rain" } : { prob: 20 }))).toEqual([
      "Rain likely around 4 PM (70% chance)",
    ]);
    expect(hl((i) => ({ prob: i === at(13) ? 60 : 5, sym: "lightsnow" }))).toEqual(["Snow likely around 1 PM (60% chance)"]);
  });

  it("says 'possible' from 30 % and nothing below", () => {
    expect(hl((i) => ({ prob: i === at(11) ? 30.4 : 5, sym: "lightsleet" }))).toEqual(["Sleet possible around 11 AM (30% chance)"]);
    expect(hl((i) => ({ prob: i === at(11) ? 29.9 : 15 }))).toEqual([]);
  });

  it("uses 'Precipitation' when the symbol names no type", () => {
    expect(hl((i) => ({ prob: i === at(10) ? 65 : 0, sym: "cloudy" }))).toEqual(["Precipitation likely around 10 AM (65% chance)"]);
  });

  it("adds a heavy-precipitation highlight from 4 mm in an hour", () => {
    expect(hl((i) => (i === at(15) ? { prob: 95, mm: 6.24, sym: "heavyrain" } : { prob: 10, mm: 0 }))).toEqual([
      "Heavy rain around 3 PM (up to 6.2 mm per hour)",
      "Rain likely around 3 PM (95% chance)",
    ]);
    expect(hl((i) => (i === at(15) ? { prob: 95, mm: 3.9, sym: "rain" } : { prob: 10 }))).toEqual(["Rain likely around 3 PM (95% chance)"]);
  });
});

describe("precipitation without probabilities (amounts only)", () => {
  it("reports the onset and the peak hourly amount", () => {
    expect(hl((i) => (i === at(13) ? { mm: 0.6, sym: "lightrain" } : i === at(14) ? { mm: 1.2, sym: "rain" } : { mm: 0.1 }))).toEqual([
      "Rain forecast around 1 PM (up to 1.2 mm per hour)",
    ]);
  });

  it("ignores amounts below 0.5 mm per hour", () => {
    expect(hl(() => ({ mm: 0.4, sym: "lightrain" }))).toEqual([]);
  });

  it("calls a peak of 4 mm or more heavy", () => {
    expect(hl((i) => (i === at(13) ? { mm: 0.6, sym: "lightsnow" } : i === at(15) ? { mm: 4, sym: "heavysnow" } : {}))).toEqual([
      "Heavy snow forecast around 1 PM (up to 4 mm per hour)",
    ]);
  });

  it("says 'tomorrow' for the next local day from 5 AM, not overnight", () => {
    // 2026-11-13T15:00Z = 10 AM tomorrow; 2026-11-13T07:00Z = 2 AM tomorrow.
    const rainAt = (iso: string) =>
      forecastHighlights(hours(START, 26, (i) => (Date.parse(START) + i * 3_600_000 === Date.parse(iso) ? { mm: 2, sym: "rain" } : {})), NOW, NY);
    expect(rainAt("2026-11-13T15:00:00Z")).toEqual(["Rain forecast around 10 AM tomorrow (up to 2 mm per hour)"]);
    expect(rainAt("2026-11-13T07:00:00Z")).toEqual(["Rain forecast around 2 AM (up to 2 mm per hour)"]);
  });
});

describe("thunder", () => {
  it("comes only from thunder symbol codes, with the part of the day", () => {
    expect(hl((i) => (i === at(14) ? { sym: "rainshowersandthunder_day" } : {}))[0]).toBe("Thunderstorms possible this afternoon (around 2 PM)");
    expect(hl((i) => (i === at(10) ? { sym: "lightrainandthunder" } : {}))[0]).toBe("Thunderstorms possible this morning (around 10 AM)");
    expect(hl((i) => (i === at(19) ? { sym: "heavyrainandthunder" } : {}))[0]).toBe("Thunderstorms possible this evening (around 7 PM)");
    expect(hl((i) => (i === at(22) ? { sym: "rainandthunder" } : {}))[0]).toBe("Thunderstorms possible tonight (around 10 PM)");
    expect(hl((i) => (i === 18 ? { sym: "snowandthunder" } : {}))[0]).toBe("Thunderstorms possible overnight (around 3 AM)");
    expect(hl((i) => (i === 23 ? { sym: "rainandthunder" } : {}))[0]).toBe("Thunderstorms possible tomorrow morning (around 8 AM)");
  });

  it("is not inferred from rain or probabilities", () => {
    expect(hl(() => ({ prob: 99, mm: 10, sym: "heavyrain" })).some((s) => s.includes("Thunder"))).toBe(false);
  });

  it("suppresses the dry highlight", () => {
    expect(hl((i) => (i === at(14) ? { sym: "rainshowersandthunder_day", mm: 0 } : { mm: 0 }))).toEqual([
      "Thunderstorms possible this afternoon (around 2 PM)",
    ]);
  });
});

describe("wind", () => {
  it("reports gusts from 15 m/s at the time of the strongest gust", () => {
    expect(hl((i) => ({ gust: i === at(14) ? 18 : 8 }))).toEqual(["Gusts up to 18 m/s (65 km/h) around 2 PM", "No precipitation forecast in the next 24 hours"]);
    expect(hl(() => ({ gust: 14.9, wind: 12 }))).toEqual(["No precipitation forecast in the next 24 hours"]);
  });

  it("uses sustained wind (≥ 10.8 m/s) only when no gusts are published", () => {
    expect(hl((i) => ({ wind: i === at(14) ? 12 : 4 }))[0]).toBe("Strong wind up to 12 m/s (43 km/h) around 2 PM");
    expect(hl(() => ({ wind: 10.7 }))).toEqual(["No precipitation forecast in the next 24 hours"]);
  });
});

describe("temperature", () => {
  it("says overnight when the low falls between 9 PM and 9 AM", () => {
    // 2026-11-13T10:00Z = 5 AM tomorrow.
    expect(hl((i) => ({ t: i === 20 ? -3.2 : 4 }))[0]).toBe("Below freezing overnight (down to −3 °C around 5 AM tomorrow)");
    expect(hl((i) => ({ t: i === at(23) ? -1 : 4 }))[0]).toBe("Below freezing overnight (down to −1 °C around 11 PM)");
  });

  it("drops 'overnight' for a daytime low and keeps sub-zero decimals", () => {
    expect(hl((i) => ({ t: i === at(13) ? -0.3 : 0.5 }))[0]).toBe("Below freezing (down to −0.3 °C around 1 PM)");
    expect(hl(() => ({ t: 0 }))).toEqual(["No precipitation forecast in the next 24 hours"]);
  });

  it("reports heat from 30 °C", () => {
    expect(hl((i) => ({ t: i === at(15) ? 32.4 : 25 }))[0]).toBe("Hot around 3 PM (up to 32 °C)");
    expect(hl(() => ({ t: 29.9 }))).toEqual(["No precipitation forecast in the next 24 hours"]);
  });
});

describe("dry", () => {
  it("needs every hour known and dry, low probabilities and at least 12 hours", () => {
    expect(hl(() => ({}))).toEqual(["No precipitation forecast in the next 24 hours"]);
    expect(hl(() => ({}), 12)).toEqual(["No precipitation forecast in the next 12 hours"]);
    expect(hl(() => ({}), 11)).toEqual([]);
    expect(hl((i) => ({ mm: i === 3 ? null : 0 }))).toEqual([]);
    expect(hl(() => ({ mm: 0, prob: 12 }))).toEqual([]);
    expect(hl(() => ({ mm: 0.1 }))).toEqual([]);
  });
});

describe("combined", () => {
  it("orders rules and caps the list", () => {
    const out = hl((i) => ({
      sym: i === at(14) ? "heavyrainandthunder" : "rain",
      prob: 80,
      mm: i === at(15) ? 7 : 1,
      gust: i === at(16) ? 21 : 10,
      t: i === 20 ? -2 : i === at(12) ? 31 : 10,
    }));
    expect(out).toHaveLength(HIGHLIGHT_LIMITS.max);
    expect(out).toEqual([
      "Thunderstorms possible this afternoon (around 2 PM)",
      "Heavy rain around 3 PM (up to 7 mm per hour)",
      "Rain likely around 9 AM (80% chance)",
      "Gusts up to 21 m/s (76 km/h) around 4 PM",
      "Below freezing overnight (down to −2 °C around 5 AM tomorrow)",
    ]);
  });

  it("returns nothing for an empty or invalid forecast", () => {
    expect(forecastHighlights([], NOW, NY)).toEqual([]);
    expect(forecastHighlights([{ ...hours(START, 1)[0], time: "not a time" }], NOW, NY)).toEqual([]);
  });

  it("works on real fixtures", () => {
    const banff = parseMetnoResponse(fixtureJson("metno/complete-banff-ab.json")) as MetnoSeries;
    const now = new Date("2026-11-12T15:00:00Z");
    expect(forecastHighlights(hourlyForecast(banff.steps, now), now, "America/Edmonton")).toEqual([
      // 2026-11-13T08:00Z, local time per the runtime's tz database.
      `Below freezing overnight (down to −3 °C around ${clockTime(new Date("2026-11-13T08:00:00Z"), "America/Edmonton")})`,
      "No precipitation forecast in the next 24 hours",
    ]);
    const oslo = parseMetnoResponse(fixtureJson("metno/complete-preikestolen-no.json")) as MetnoSeries;
    const n2 = new Date("2026-11-12T08:30:00Z");
    // Probabilities stay below 30 % and above 10 %: neither precipitation nor dry.
    expect(forecastHighlights(hourlyForecast(oslo.steps, n2), n2, "Europe/Oslo")).toEqual(["Below freezing overnight (down to −3 °C around 1 AM)"]);
  });
});
