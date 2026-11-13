/**
 * NWS alerts (src/server/weather/nws-alerts.ts): mapping real and synthetic
 * alert collections, coverage decisions, and the service's control flow
 * with the database and provider client mocked (failure paths that a real
 * database cannot easily produce). Cache semantics against real tables are
 * in tests/integration/trails/conditions.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Call {
  text: string;
  values: unknown[];
}
const db = vi.hoisted(() => ({
  calls: [] as Call[],
  respond: (() => []) as (text: string, values: unknown[]) => unknown[] | Error,
}));
vi.mock("@/server/db", () => ({
  withSystem: async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join("?").replace(/\s+/g, " ").trim();
        db.calls.push({ text, values });
        const r = db.respond(text, values);
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      },
      { json: (v: unknown) => v },
    );
    return fn(tx);
  },
}));

const http = vi.hoisted(() => ({
  providerFetch: vi.fn(),
  recordProviderCacheHit: vi.fn(async () => {}),
}));
vi.mock("@/server/providers/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/providers/http")>();
  return { ProviderError: actual.ProviderError, providerFetch: http.providerFetch, recordProviderCacheHit: http.recordProviderCacheHit };
});

import { ProviderError } from "@/server/providers/http";
import {
  NWS_ATTRIBUTION,
  NWS_TEXT_MAX,
  getNwsAlerts,
  isInNwsArea,
  isOutOfBoundsProblem,
  mapNwsAlerts,
  nwsAlertsSupported,
  nwsAlertsUrl,
  nwsCacheKey,
  sortAlerts,
} from "@/server/weather/nws-alerts";
import { fixtureJson, fixtureText } from "./helpers";

const NOW = new Date("2026-11-12T15:00:00Z");
const response = (status: number, text: string) => ({
  status,
  headers: new Headers(),
  bytes: new ArrayBuffer(0),
  text: () => text,
  json: () => JSON.parse(text),
});

beforeEach(() => {
  db.calls = [];
  db.respond = () => [];
  http.providerFetch.mockReset();
  http.recordProviderCacheHit.mockClear();
});

describe("mapNwsAlerts", () => {
  it("maps the real alert schema", () => {
    const alerts = mapNwsAlerts(fixtureJson("nws/alerts-sample-real.json"), new Date("2026-11-12T03:45:00Z"));
    expect(alerts).toHaveLength(2);
    expect(alerts![0]).toMatchObject({
      id: "urn:oid:2.49.0.1.840.0.dd22d554d240327af1a9f1309bf4630658ee8918.001.1",
      event: "Special Weather Statement",
      severity: "Moderate",
      headline: "Special Weather Statement issued November 11 at 10:18PM EST by NWS Jackson KY",
      onset: "2026-11-12T03:18:00.000Z",
      ends: "2026-11-12T04:00:00.000Z",
      source: "National Weather Service",
      url: "https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.dd22d554d240327af1a9f1309bf4630658ee8918.001.1",
    });
    expect(alerts![0].description).toContain("HAZARD...Wind gusts up to 40 mph.");
    expect(alerts![0].description).toContain("\n");
    expect(alerts![0].instruction).toBe("Monitor the weather situation closely and be alert for threatening\nweather conditions.");
  });

  it("drops alerts that have expired by `now`", () => {
    expect(mapNwsAlerts(fixtureJson("nws/alerts-sample-real.json"), new Date("2026-11-12T04:00:00Z"))).toEqual([]);
  });

  it("an empty collection is an empty list (the real Table Rock answer)", () => {
    expect(mapNwsAlerts(fixtureJson("nws/alerts-active-table-rock-sc.json"), NOW)).toEqual([]);
  });

  it("handles every edge case of the synthetic collection", () => {
    const alerts = mapNwsAlerts(fixtureJson("nws/alerts-active-synthetic.json"), NOW)!;
    expect(alerts.map((a) => [a.event, a.severity])).toEqual([
      ["Flash Flood Emergency", "Extreme"],
      ["Winter Storm Warning", "Severe"],
      ["Wind Advisory", "Moderate"],
      ["Frost Advisory", "Unknown"],
    ]);
    const [flood, winter, wind, frost] = alerts;
    // No @id → the feature id; no onset → effective; no ends → expires; whitespace cleaned.
    expect(flood).toMatchObject({
      url: "https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.synthetic.flood.002.1",
      onset: "2026-11-12T14:45:00.000Z",
      ends: "2026-11-12T17:45:00.000Z",
      instruction: null,
      description: "Life-threatening flash flooding of creeks and streams is ongoing.\n\nMove to higher ground now.",
    });
    expect(winter.description).toHaveLength(NWS_TEXT_MAX);
    expect(winter.description!.endsWith("…")).toBe(true);
    expect(winter).toMatchObject({ onset: "2026-11-13T06:00:00.000Z", ends: "2026-11-14T12:00:00.000Z" });
    expect(wind).toMatchObject({
      id: "urn:oid:2.49.0.1.840.0.synthetic.wind.001.1",
      ends: "2026-11-13T12:00:00.000Z",
      instruction: "Use extra caution on exposed ridges. Secure outdoor objects.",
    });
    // javascript: @id and a non-NWS feature id are never passed on as links.
    expect(frost.url).toBeNull();
    // Dropped: Test, Cancel, expired, duplicate, no event, malformed.
    expect(alerts.some((a) => /Test|Flood Watch|Fog|duplicate/.test(a.event))).toBe(false);
  });

  it.each([[null], ["text"], [{}], [{ features: "x" }], [[]]])("returns null for non-collections (%j)", (raw) => {
    expect(mapNwsAlerts(raw, NOW)).toBeNull();
  });

  it("sortAlerts: severity, then onset, then event", () => {
    const a = (event: string, severity: string, onset: string | null) =>
      ({ id: event, event, severity, onset, headline: null, description: null, instruction: null, ends: null, source: "x", url: null });
    expect(
      sortAlerts([a("B", "Minor", null), a("C", "Severe", "2026-11-13T00:00:00Z"), a("A", "Severe", "2026-11-12T00:00:00Z"), a("D", "Weird", null)]).map(
        (x) => x.event,
      ),
    ).toEqual(["A", "C", "B", "D"]);
  });
});

describe("coverage", () => {
  it.each([
    ["Table Rock, SC", 35.033, -82.7, true],
    ["Denali, AK", 63.07, -151.0, true],
    ["Attu, AK (west of 180°)", 52.9, 173.2, true],
    ["Haleakalā, HI", 20.71, -156.25, true],
    ["El Yunque, PR", 18.3, -65.79, true],
    ["Guam", 13.44, 144.79, true],
    ["American Samoa", -14.27, -170.7, true],
    ["Banff, AB", 51.176, -115.563, false],
    ["Mexico City", 19.43, -99.13, false],
    ["London", 51.5, -0.12, false],
    ["Tokyo", 35.68, 139.69, false],
  ])("isInNwsArea: %s", (_name, lat, lng, expected) => {
    expect(isInNwsArea(lat, lng)).toBe(expected);
  });

  it("decides by country code when known, by area otherwise", () => {
    expect(nwsAlertsSupported("us", 51.176, -115.563)).toBe(true);
    expect(nwsAlertsSupported("PR", 18.3, -65.79)).toBe(true);
    expect(nwsAlertsSupported("ca", 48.5, -123.4)).toBe(false); // Victoria, BC: inside the CONUS box
    expect(nwsAlertsSupported("xx", 35.033, -82.7)).toBe(true);
    expect(nwsAlertsSupported(null, 35.033, -82.7)).toBe(true);
    expect(nwsAlertsSupported(undefined, 51.176, -115.563)).toBe(false);
    expect(nwsAlertsSupported("usa", 51.176, -115.563)).toBe(false);
    expect(isInNwsArea(Number.NaN, 0)).toBe(false);
  });

  it("recognizes the out-of-bounds problem document", () => {
    expect(isOutOfBoundsProblem(fixtureJson("nws/alerts-active-out-of-bounds-toronto.json"))).toBe(true);
    expect(isOutOfBoundsProblem({ status: 400, detail: "Parameter \"point\" is invalid: bad format" })).toBe(false);
    expect(isOutOfBoundsProblem(null)).toBe(false);
  });

  it("keys and URLs use at most 3 decimals", () => {
    expect(nwsCacheKey(35.03312, -82.70049)).toBe("35.033,-82.700");
    expect(nwsCacheKey(-0.0001, 0.0001)).toBe("0.000,0.000");
    expect(nwsAlertsUrl(35.03312, -82.70049)).toBe("https://api.weather.gov/alerts/active?point=35.033,-82.7");
  });

  it("credits the National Weather Service", () => {
    expect(NWS_ATTRIBUTION).toMatchObject({ url: "https://www.weather.gov/", license: "US Government work (public domain)" });
  });
});

describe("getNwsAlerts control flow (mocked db and provider)", () => {
  it("not_supported outside coverage, without touching the cache or the provider", async () => {
    const r = await getNwsAlerts(51.176, -115.563, { countryCode: "ca", now: NOW });
    expect(r).toMatchObject({ status: "not_supported", alerts: [] });
    expect(db.calls).toHaveLength(0);
    expect(http.providerFetch).not.toHaveBeenCalled();
  });

  it("asks NWS with geo+json, a short timeout and no retries; caches the answer 5 minutes", async () => {
    http.providerFetch.mockResolvedValue(response(200, fixtureText("nws/alerts-active-synthetic.json")));
    const r = await getNwsAlerts(35.03312, -82.70049, { countryCode: "us", now: NOW });
    expect(r.status).toBe("ok");
    expect(r.alerts).toHaveLength(4);
    expect(http.providerFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "nws",
        url: "https://api.weather.gov/alerts/active?point=35.033,-82.7",
        headers: { Accept: "application/geo+json" },
        okStatuses: [400],
        retries: 0,
        timeoutMs: 8000,
      }),
    );
    const insert = db.calls.find((c) => c.text.startsWith("insert"))!;
    expect(insert.values.slice(0, 2)).toEqual(["nws_alerts", "35.033,-82.700"]);
    expect(insert.values[3]).toBe(300);
  });

  it("serves the cache, dropping alerts that ended since", async () => {
    const alerts = mapNwsAlerts(fixtureJson("nws/alerts-active-synthetic.json"), NOW)!;
    const fetchedAt = new Date("2026-11-12T17:56:00Z");
    db.respond = (text) => (text.startsWith("select") ? [{ payload: { v: 1, kind: "alerts", alerts }, fetchedAt }] : []);
    const later = new Date("2026-11-12T18:00:00Z"); // after the flash flood ends (17:45Z)
    const r = await getNwsAlerts(35.033, -82.7, { countryCode: "us", now: later });
    expect(r.status).toBe("ok");
    // The age of a cached answer is reported, never refreshed to "now".
    expect(r).toMatchObject({ fromCache: true, checkedAt: fetchedAt });
    expect(r.alerts.map((a) => a.event)).toEqual(["Winter Storm Warning", "Wind Advisory", "Frost Advisory"]);
    expect(http.providerFetch).not.toHaveBeenCalled();
    expect(http.recordProviderCacheHit).toHaveBeenCalledWith("nws");
  });

  it("a malformed cached payload is a miss", async () => {
    db.respond = (text) => (text.startsWith("select") ? [{ payload: { v: 1, kind: "alerts", alerts: [{ id: 1 }] } }] : []);
    http.providerFetch.mockResolvedValue(response(200, fixtureText("nws/alerts-active-table-rock-sc.json")));
    expect(await getNwsAlerts(35.033, -82.7, { countryCode: "us", now: NOW })).toEqual({ status: "ok", alerts: [], fromCache: false, checkedAt: expect.any(Date) });
  });

  it("cache read and write failures do not fail the request", async () => {
    db.respond = () => new Error("db down");
    http.providerFetch.mockResolvedValue(response(200, fixtureText("nws/alerts-active-table-rock-sc.json")));
    expect(await getNwsAlerts(35.033, -82.7, { countryCode: "us", now: NOW })).toEqual({ status: "ok", alerts: [], fromCache: false, checkedAt: expect.any(Date) });
  });

  it("400 out of bounds → not_supported, cached for a week", async () => {
    http.providerFetch.mockResolvedValue(response(400, fixtureText("nws/alerts-active-out-of-bounds-toronto.json")));
    const r = await getNwsAlerts(43.7, -79.4, { countryCode: null, now: NOW });
    expect(r).toMatchObject({ status: "not_supported", alerts: [] });
    const insert = db.calls.find((c) => c.text.startsWith("insert"))!;
    expect(insert.values[2]).toEqual({ v: 1, kind: "out_of_bounds" });
    expect(insert.values[3]).toBe(7 * 86_400);
  });

  it("another 400 is our bug: unavailable, not cached", async () => {
    http.providerFetch.mockResolvedValue(response(400, JSON.stringify({ status: 400, detail: "Parameter \"point\" is invalid" })));
    const r = await getNwsAlerts(35.033, -82.7, { countryCode: "us", now: NOW });
    expect(r.status).toBe("unavailable");
    expect(db.calls.some((c) => c.text.startsWith("insert"))).toBe(false);
  });

  it.each([
    ["HTTP 503", () => Promise.reject(new ProviderError("nws", "HTTP 503", 503, true))],
    ["HTTP 429", () => Promise.reject(new ProviderError("nws", "HTTP 429", 429, true))],
    ["network", () => Promise.reject(new Error("socket hang up"))],
    ["invalid JSON", () => Promise.resolve(response(200, "<html>"))],
    ["not a collection", () => Promise.resolve(response(200, JSON.stringify({ title: "x" })))],
  ])("%s → unavailable, not cached", async (_label, impl) => {
    http.providerFetch.mockImplementation(impl);
    const r = await getNwsAlerts(35.033, -82.7, { countryCode: "us", now: NOW });
    expect(r).toMatchObject({ status: "unavailable", alerts: [] });
    expect(db.calls.some((c) => c.text.startsWith("insert"))).toBe(false);
  });

  it("invalid coordinates → unavailable without any I/O", async () => {
    expect((await getNwsAlerts(Number.NaN, -82.7, { countryCode: "us" })).status).toBe("unavailable");
    expect((await getNwsAlerts(95, -82.7, { countryCode: "us" })).status).toBe("unavailable");
    expect(db.calls).toHaveLength(0);
    expect(http.providerFetch).not.toHaveBeenCalled();
  });
});
