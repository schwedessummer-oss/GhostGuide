import { describe, expect, it } from "vitest";
import {
  approxDuration,
  climbMToInput,
  formatClimb,
  formatEstimate,
  formatLength,
  inputToClimbM,
  inputToKm,
  kmToInput,
  parseUnits,
  unitsForLocale,
} from "@/lib/units";

describe("units preference", () => {
  it("parses only known values", () => {
    expect(parseUnits("metric")).toBe("metric");
    expect(parseUnits("imperial")).toBe("imperial");
    expect(parseUnits("METRIC")).toBeNull();
    expect(parseUnits(undefined)).toBeNull();
  });

  it("defaults by Accept-Language: imperial for US English, metric elsewhere", () => {
    expect(unitsForLocale("en-US,en;q=0.9")).toBe("imperial");
    expect(unitsForLocale("en")).toBe("imperial");
    expect(unitsForLocale("en-GB,en;q=0.8")).toBe("metric");
    expect(unitsForLocale("de-DE")).toBe("metric");
    expect(unitsForLocale("fr")).toBe("metric");
    expect(unitsForLocale("zh-Hant-TW")).toBe("metric");
    expect(unitsForLocale("es-US")).toBe("imperial");
    expect(unitsForLocale("")).toBe("imperial");
    expect(unitsForLocale(null)).toBe("imperial");
    expect(unitsForLocale("*")).toBe("imperial");
  });
});

describe("formatLength", () => {
  it("rounds miles to 0.1 and short distances to 10 ft", () => {
    expect(formatLength(10_966, "imperial")).toBe("6.8 mi");
    expect(formatLength(1609.344, "imperial")).toBe("1.0 mi");
    expect(formatLength(160, "imperial")).toBe("0.1 mi");
    expect(formatLength(97, "imperial")).toBe("320 ft");
    expect(formatLength(250_000, "imperial")).toBe("155 mi");
  });

  it("rounds kilometres to 0.1 and short distances to 10 m", () => {
    expect(formatLength(10_966, "metric")).toBe("11.0 km");
    expect(formatLength(5_848, "metric")).toBe("5.8 km");
    expect(formatLength(848, "metric")).toBe("850 m");
    expect(formatLength(999.6, "metric")).toBe("1.0 km");
    expect(formatLength(123_456, "metric")).toBe("123 km");
  });

  it("never prints negative or NaN distances", () => {
    expect(formatLength(-5, "metric")).toBe("0 m");
    expect(formatLength(Number.NaN, "imperial")).toBe("0 ft");
  });
});

describe("formatClimb", () => {
  it("rounds feet to 10 with separators and metres to 5", () => {
    expect(formatClimb(695, "imperial")).toBe("2,280 ft");
    expect(formatClimb(695, "metric")).toBe("695 m");
    expect(formatClimb(222, "metric")).toBe("220 m");
    expect(formatClimb(0, "imperial")).toBe("0 ft");
  });
});

describe("time estimates", () => {
  it("rounds to 5 minutes and pads minutes after hours", () => {
    expect(formatEstimate(186)).toBe("3 h 05 min");
    expect(formatEstimate(82)).toBe("1 h 20 min");
    expect(formatEstimate(44)).toBe("45 min");
    expect(formatEstimate(239)).toBe("4 h");
    expect(formatEstimate(676)).toBe("11 h 15 min");
    expect(formatEstimate(1)).toBe("under 5 min");
  });

  it("labels the value as an estimate", () => {
    expect(approxDuration(186)).toBe("≈ 3 h 05 min");
  });
});

describe("filter input conversion", () => {
  it("round-trips lengths typed in miles", () => {
    const km = inputToKm(5, "imperial");
    expect(km).toBe(8.047);
    expect(kmToInput(km, "imperial")).toBe(5);
    expect(inputToKm(12.5, "metric")).toBe(12.5);
    expect(kmToInput(12.5, "metric")).toBe(12.5);
  });

  it("round-trips climbs typed in feet", () => {
    for (const ft of [500, 1000, 2005, 3280]) {
      expect(climbMToInput(inputToClimbM(ft, "imperial"), "imperial")).toBe(ft);
    }
    expect(inputToClimbM(600, "metric")).toBe(600);
    expect(climbMToInput(600, "metric")).toBe(600);
  });
});
