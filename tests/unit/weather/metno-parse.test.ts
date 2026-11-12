/**
 * MET Norway Locationforecast parsing and request shaping (pure functions):
 * real fixtures, defensive parsing of malformed documents, the cached
 * payload round trip, coordinate/altitude rounding and Expires handling.
 */
import { describe, expect, it } from "vitest";
import {
  METNO_ATTRIBUTION,
  METNO_DEFAULT_TTL_MS,
  METNO_MAX_TTL_MS,
  METNO_MIN_TTL_MS,
  METNO_PAYLOAD_VERSION,
  expiresAtFrom,
  metnoQuery,
  metnoUrl,
  parseHttpDate,
  parseMetnoResponse,
  seriesFromCachePayload,
  toCachePayload,
  toHourlyDto,
  type MetnoSeries,
} from "@/server/weather/metno";
import { fixtureJson, step } from "./helpers";

const tableRock = () => parseMetnoResponse(fixtureJson("metno/complete-table-rock-sc.json")) as MetnoSeries;
const preikestolen = () => parseMetnoResponse(fixtureJson("metno/complete-preikestolen-no.json")) as MetnoSeries;

describe("parseMetnoResponse: real fixtures", () => {
  it("Table Rock (global model): hourly then 6-hourly steps, no gusts or probabilities", () => {
    const s = tableRock();
    expect(s.updatedAt).toBe("2026-11-12T01:17:18.000Z");
    expect(s.steps).toHaveLength(91);
    expect(s.steps[0]).toEqual({
      time: "2026-11-12T03:00:00.000Z",
      temperatureC: 11.5,
      windSpeedMs: 4.6,
      windGustMs: null,
      next1h: { precipitationMm: 0, probability: null, symbol: "clearsky_night" },
      next6h: { precipitationMm: 0, probability: null, symbol: "partlycloudy_night", minC: 10.8, maxC: 11.7 },
    });
    // Hourly part ends with 1-hour-only steps, then 6-hourly steps without next_1_hours.
    const i = s.steps.findIndex((x) => x.time === "2026-11-14T17:00:00.000Z");
    expect(s.steps[i].next1h).not.toBeNull();
    expect(s.steps[i].next6h).toBeNull();
    expect(s.steps[i + 1]).toMatchObject({ time: "2026-11-14T18:00:00.000Z", next1h: null });
    expect(s.steps[i + 1].next6h?.symbol).toBeTruthy();
    // The last step has only instant values.
    expect(s.steps.at(-1)).toMatchObject({ time: "2026-11-21T12:00:00.000Z", next1h: null, next6h: null, temperatureC: 5 });
    // Sorted, unique.
    const times = s.steps.map((x) => Date.parse(x.time));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
    expect(s.steps.every((x) => x.windGustMs === null && x.next1h?.probability == null)).toBe(true);
  });

  it("Preikestolen (Nordic model): gusts and hourly precipitation probabilities", () => {
    const s = preikestolen();
    expect(s.updatedAt).toBe("2026-11-12T03:31:10.000Z");
    expect(s.steps).toHaveLength(88);
    expect(s.steps[0]).toMatchObject({
      time: "2026-11-12T03:00:00.000Z",
      temperatureC: -2,
      windGustMs: 3.3,
      next1h: { precipitationMm: 0.1, probability: 36.2, symbol: "lightsnow" },
      next6h: { precipitationMm: 0.8, probability: 44.2, symbol: "lightsnowshowers_night" },
    });
    expect(toHourlyDto(s.steps[0])).toEqual({
      time: "2026-11-12T03:00:00.000Z",
      temperatureC: -2,
      precipitationMm: 0.1,
      precipitationProbability: 36.2,
      windSpeedMs: 0.7,
      windGustMs: 3.3,
      symbol: "lightsnow",
    });
  });

  it("Banff parses with sub-zero temperatures", () => {
    const s = parseMetnoResponse(fixtureJson("metno/complete-banff-ab.json")) as MetnoSeries;
    expect(s.steps).toHaveLength(91);
    expect(s.steps[0].temperatureC).toBe(-1.1);
  });
});

describe("parseMetnoResponse: defensive parsing", () => {
  const doc = (timeseries: unknown, meta: unknown = { updated_at: "2026-11-12T01:00:00Z" }) => ({
    type: "Feature",
    properties: { meta, timeseries },
  });
  const entry = (time: unknown, instant: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    time,
    data: { instant: { details: instant }, ...extra },
  });

  it.each([[null], [undefined], ["text"], [42], [[]], [{}], [{ properties: {} }], [{ properties: { timeseries: "x" } }]])(
    "returns null for non-forecast values (%j)",
    (raw) => {
      expect(parseMetnoResponse(raw)).toBeNull();
    },
  );

  it("an empty timeseries is a valid but empty series", () => {
    expect(parseMetnoResponse(doc([]))).toEqual({ updatedAt: "2026-11-12T01:00:00.000Z", steps: [] });
  });

  it("skips malformed entries and nulls implausible values", () => {
    const s = parseMetnoResponse(
      doc(
        [
          "nope",
          { data: {} },
          entry("not a date"),
          { time: "2026-11-12T05:00:00Z" },
          entry("2026-11-12T04:00:00Z", { air_temperature: "12", wind_speed: -1, wind_speed_of_gust: Number.NaN }, {
            next_1_hours: { summary: { symbol_code: "Rain!" }, details: { precipitation_amount: -0.5, probability_of_precipitation: 120 } },
            next_6_hours: { details: { air_temperature_min: 9, air_temperature_max: 3 } },
          }),
          entry("2026-11-12T03:00:00Z", { air_temperature: 150, wind_speed: 4 }, {
            next_1_hours: { summary: { symbol_code: "lightrain" }, details: { precipitation_amount: 0.4, probability_of_precipitation: 55 } },
          }),
          entry("2026-11-12T03:00:00Z", { air_temperature: 1 }),
        ],
        { updated_at: 12345 },
      ),
    ) as MetnoSeries;
    expect(s.updatedAt).toBeNull();
    // Sorted by time; the duplicate 03:00 entry keeps the first occurrence.
    expect(s.steps.map((x) => x.time)).toEqual(["2026-11-12T03:00:00.000Z", "2026-11-12T04:00:00.000Z"]);
    expect(s.steps[0]).toEqual({
      time: "2026-11-12T03:00:00.000Z",
      temperatureC: null,
      windSpeedMs: 4,
      windGustMs: null,
      next1h: { precipitationMm: 0.4, probability: 55, symbol: "lightrain" },
      next6h: null,
    });
    // Every 1-hour value was invalid → no period; 6-hour min > max → both dropped → no period.
    expect(s.steps[1]).toEqual({
      time: "2026-11-12T04:00:00.000Z",
      temperatureC: null,
      windSpeedMs: null,
      windGustMs: null,
      next1h: null,
      next6h: { precipitationMm: null, probability: null, symbol: null, minC: null, maxC: null },
    });
  });

  it("caps very long series", () => {
    const many = Array.from({ length: 1000 }, (_, i) => entry(new Date(Date.UTC(2026, 10, 12) + i * 3_600_000).toISOString(), { air_temperature: 1 }));
    expect((parseMetnoResponse(doc(many)) as MetnoSeries).steps.length).toBe(400);
  });
});

describe("toHourlyDto", () => {
  it("uses the 1-hour period, falling back to the 6-hour symbol", () => {
    expect(toHourlyDto(step("2026-11-12T03:00:00Z", { t: 1, sym6: "rain", p6: 3 }))).toEqual({
      time: "2026-11-12T03:00:00.000Z",
      temperatureC: 1,
      precipitationMm: null,
      precipitationProbability: null,
      windSpeedMs: null,
      windGustMs: null,
      symbol: "rain",
    });
  });
});

describe("cache payload", () => {
  it("round-trips through JSON", () => {
    const s = preikestolen();
    const payload = JSON.parse(JSON.stringify(toCachePayload(s)));
    expect(payload.v).toBe(METNO_PAYLOAD_VERSION);
    expect(seriesFromCachePayload(payload)).toEqual(s);
  });

  it("treats missing period keys as null", () => {
    const payload = { v: 1, updatedAt: null, steps: [{ time: "2026-11-12T03:00:00Z", temperatureC: 1, windSpeedMs: null, windGustMs: null }] };
    expect(seriesFromCachePayload(payload)?.steps[0]).toEqual({
      time: "2026-11-12T03:00:00.000Z",
      temperatureC: 1,
      windSpeedMs: null,
      windGustMs: null,
      next1h: null,
      next6h: null,
    });
  });

  it.each([
    ["another version", { v: 2, updatedAt: null, steps: [] }],
    ["no steps", { v: 1, updatedAt: null }],
    ["bad updatedAt", { v: 1, updatedAt: "yesterday", steps: [] }],
    ["bad time", { v: 1, updatedAt: null, steps: [{ time: "x", temperatureC: 1, windSpeedMs: null, windGustMs: null }] }],
    ["string number", { v: 1, updatedAt: null, steps: [{ time: "2026-11-12T03:00:00Z", temperatureC: "1", windSpeedMs: null, windGustMs: null }] }],
    [
      "bad symbol",
      {
        v: 1,
        updatedAt: null,
        steps: [
          {
            time: "2026-11-12T03:00:00Z",
            temperatureC: 1,
            windSpeedMs: null,
            windGustMs: null,
            next1h: { precipitationMm: 0, probability: null, symbol: "<script>" },
          },
        ],
      },
    ],
    ["not an object", "payload"],
  ])("a malformed payload is a cache miss (%s)", (_label, payload) => {
    expect(seriesFromCachePayload(payload)).toBeNull();
  });
});

describe("metnoQuery / metnoUrl", () => {
  it("rounds coordinates to 3 decimals and altitude to 10 m", () => {
    const q = metnoQuery(35.03312, -82.70049, 337);
    expect(q).toEqual({ lat: 35.033, lon: -82.7, altitude: 340, cacheKey: "35.033,-82.700,340" });
    expect(metnoUrl(q)).toBe("https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=35.033&lon=-82.7&altitude=340");
  });

  it("omits an unknown or implausible altitude", () => {
    expect(metnoQuery(51.17612, -115.5634)).toMatchObject({ altitude: null, cacheKey: "51.176,-115.563" });
    expect(metnoQuery(51.17612, -115.5634, null).altitude).toBeNull();
    expect(metnoQuery(51.17612, -115.5634, Number.NaN).altitude).toBeNull();
    expect(metnoQuery(51.17612, -115.5634, 9_500).altitude).toBeNull();
    expect(metnoQuery(51.17612, -115.5634, -600).altitude).toBeNull();
    expect(metnoUrl(metnoQuery(51.17612, -115.5634))).not.toContain("altitude");
  });

  it("never produces -0 keys and never more than 4 decimals", () => {
    expect(metnoQuery(-0.0001, -0.0004, -2).cacheKey).toBe("0.000,0.000,0");
    for (const [lat, lng] of [
      [12.3456789, 98.7654321],
      [-33.99999, 151.00001],
      [0.1 + 0.2, -(0.1 + 0.2)],
    ]) {
      const url = new URL(metnoUrl(metnoQuery(lat, lng)));
      for (const k of ["lat", "lon"]) expect(url.searchParams.get(k)).toMatch(/^-?\d+(\.\d{1,4})?$/);
    }
  });

  it.each([
    [91, 0],
    [-91, 0],
    [0, 181],
    [Number.NaN, 0],
    [0, Number.POSITIVE_INFINITY],
  ])("throws RangeError for invalid coordinates (%s, %s)", (lat, lng) => {
    expect(() => metnoQuery(lat, lng)).toThrow(RangeError);
  });
});

describe("Expires handling", () => {
  const now = Date.parse("2026-11-12T03:41:31Z");
  const h = (o: Record<string, string>) => new Headers(o);

  it("uses Expires − Date (robust to clock skew)", () => {
    // The real Table Rock response: 31 min 59 s of freshness.
    expect(expiresAtFrom(h({ date: "Thu, 12 Nov 2026 03:41:31 GMT", expires: "Thu, 12 Nov 2026 04:13:30 GMT" }), now).getTime()).toBe(
      now + (31 * 60 + 59) * 1000,
    );
    // Server clock 2 h ahead of ours: the TTL is still ~32 min.
    expect(expiresAtFrom(h({ date: "Thu, 12 Nov 2026 05:41:31 GMT", expires: "Thu, 12 Nov 2026 06:13:30 GMT" }), now).getTime()).toBe(
      now + (31 * 60 + 59) * 1000,
    );
  });

  it("falls back to the absolute Expires, then to the default TTL", () => {
    expect(expiresAtFrom(h({ expires: "Thu, 12 Nov 2026 04:11:31 GMT" }), now).getTime()).toBe(now + 30 * 60_000);
    expect(expiresAtFrom(h({}), now).getTime()).toBe(now + METNO_DEFAULT_TTL_MS);
    expect(expiresAtFrom(h({ expires: "soon" }), now).getTime()).toBe(now + METNO_DEFAULT_TTL_MS);
  });

  it("clamps to [1 min, 6 h]", () => {
    expect(expiresAtFrom(h({ expires: "Thu, 12 Nov 2026 03:00:00 GMT" }), now).getTime()).toBe(now + METNO_MIN_TTL_MS);
    expect(expiresAtFrom(h({ expires: "Fri, 20 Nov 2026 03:00:00 GMT" }), now).getTime()).toBe(now + METNO_MAX_TTL_MS);
  });

  it("parseHttpDate", () => {
    expect(parseHttpDate("Thu, 12 Nov 2026 04:13:30 GMT")?.toISOString()).toBe("2026-11-12T04:13:30.000Z");
    expect(parseHttpDate(null)).toBeNull();
    expect(parseHttpDate("")).toBeNull();
    expect(parseHttpDate("garbage")).toBeNull();
    expect(parseHttpDate("x".repeat(101))).toBeNull();
  });
});

describe("attribution", () => {
  it("credits MET Norway under CC BY 4.0", () => {
    expect(METNO_ATTRIBUTION).toEqual({
      name: "Weather data from MET Norway (The Norwegian Meteorological Institute)",
      url: "https://api.met.no/",
      license: "CC BY 4.0",
    });
  });
});
