/**
 * getMetnoForecast control flow with the database and provider client
 * mocked: request shape (terms of service), conditional requests, 203/304,
 * stale-if-error, and "never throws" on database and provider failures.
 * Real cache-table behaviour is in tests/integration/trails/conditions.test.ts.
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
import { getMetnoForecast, parseMetnoResponse, toCachePayload, type MetnoSeries } from "@/server/weather/metno";
import { fixtureJson, fixtureText } from "./helpers";

const BODY = fixtureText("metno/complete-table-rock-sc.json");
const SERIES = parseMetnoResponse(fixtureJson("metno/complete-table-rock-sc.json")) as MetnoSeries;
const LAST_MODIFIED = "Thu, 12 Nov 2026 03:41:31 GMT";

const response = (status: number, text: string, headers: Record<string, string> = {}) => ({
  status,
  headers: new Headers(headers),
  bytes: new ArrayBuffer(0),
  text: () => text,
  json: () => JSON.parse(text),
});

function cacheRow(o: { fresh?: boolean; staleUsable?: boolean; lastModified?: string | null; payload?: unknown } = {}) {
  return {
    payload: o.payload ?? toCachePayload(SERIES),
    fetchedAt: new Date("2026-11-12T03:41:31Z"),
    expiresAt: new Date("2026-11-12T04:13:30Z"),
    lastModified: o.lastModified === undefined ? LAST_MODIFIED : o.lastModified,
    fresh: o.fresh ?? false,
    staleUsable: o.staleUsable ?? true,
  };
}

const kinds = () => db.calls.map((c) => c.text.split(" ")[0]);

beforeEach(() => {
  db.calls = [];
  db.respond = () => [];
  http.providerFetch.mockReset();
  http.recordProviderCacheHit.mockClear();
});

describe("getMetnoForecast", () => {
  it("serves a fresh cache entry without a request and counts the hit", async () => {
    db.respond = (text) => (text.startsWith("select") ? [cacheRow({ fresh: true })] : []);
    const r = await getMetnoForecast(35.033, -82.7, { altitudeM: 340 });
    expect(r).toMatchObject({ status: "ok", source: "cache", deprecated: false });
    expect(r.status === "ok" && r.series).toEqual(SERIES);
    expect(http.providerFetch).not.toHaveBeenCalled();
    expect(http.recordProviderCacheHit).toHaveBeenCalledWith("metno");
    expect(db.calls[0].values).toContain("35.033,-82.700,340");
  });

  it("downloads on a miss with the policy-compliant request and caches it", async () => {
    http.providerFetch.mockResolvedValue(
      response(200, BODY, { date: "Thu, 12 Nov 2026 03:41:31 GMT", expires: "Thu, 12 Nov 2026 04:13:30 GMT", "last-modified": LAST_MODIFIED }),
    );
    const before = Date.now();
    const r = await getMetnoForecast(35.03312, -82.70049, { altitudeM: 337 });
    expect(r).toMatchObject({ status: "ok", source: "provider" });
    expect(http.providerFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "metno",
        url: "https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=35.033&lon=-82.7&altitude=340",
        headers: undefined,
        okStatuses: [304],
        retries: 0,
        timeoutMs: 8000,
      }),
    );
    const insert = db.calls.find((c) => c.text.startsWith("insert"))!;
    expect(insert.values[0]).toBe("metno");
    expect(insert.values[1]).toBe("35.033,-82.700,340");
    expect(insert.values[2]).toEqual(toCachePayload(SERIES));
    const expires = (insert.values[3] as Date).getTime();
    expect(expires - before).toBeGreaterThanOrEqual((31 * 60 + 59) * 1000 - 50);
    expect(expires - Date.now()).toBeLessThanOrEqual((31 * 60 + 59) * 1000);
    expect(insert.values[4]).toBe(LAST_MODIFIED);
  });

  it("revalidates an expired entry with If-Modified-Since; 304 extends it", async () => {
    db.respond = (text) => (text.startsWith("select") ? [cacheRow()] : []);
    http.providerFetch.mockResolvedValue(response(304, "", { expires: new Date(Date.now() + 20 * 60_000).toUTCString() }));
    const r = await getMetnoForecast(35.033, -82.7, { altitudeM: 340 });
    expect(r).toMatchObject({ status: "ok", source: "revalidated" });
    expect(r.status === "ok" && r.series).toEqual(SERIES);
    expect(http.providerFetch.mock.calls[0][0].headers).toEqual({ "If-Modified-Since": LAST_MODIFIED });
    const update = db.calls.find((c) => c.text.startsWith("update"))!;
    expect(update.text).toContain("last_modified = ?");
    expect(update.values.at(-1)).toBe(LAST_MODIFIED);
    expect(kinds()).not.toContain("insert");
  });

  it("does not send If-Modified-Since for an entry it could not serve", async () => {
    db.respond = (text) => (text.startsWith("select") ? [cacheRow({ payload: { v: 99 } })] : []);
    http.providerFetch.mockResolvedValue(response(200, BODY));
    const r = await getMetnoForecast(35.033, -82.7);
    expect(r).toMatchObject({ status: "ok", source: "provider" });
    expect(http.providerFetch.mock.calls[0][0].headers).toBeUndefined();
  });

  it("accepts 203 (deprecated version) and logs it", async () => {
    http.providerFetch.mockResolvedValue(response(203, BODY));
    const r = await getMetnoForecast(35.033, -82.7);
    expect(r).toMatchObject({ status: "ok", source: "provider", deprecated: true });
    expect(kinds()).toContain("insert");
  });

  it.each([
    ["429", () => Promise.reject(new ProviderError("metno", "HTTP 429", 429, true))],
    ["503", () => Promise.reject(new ProviderError("metno", "HTTP 503", 503, true))],
    ["timeout", () => Promise.reject(new ProviderError("metno", "Timed out after 8000 ms", null, true))],
    ["invalid JSON", () => Promise.resolve(response(200, "<html>"))],
    ["not a forecast", () => Promise.resolve(response(200, JSON.stringify({ error: "x" })))],
    ["empty timeseries", () => Promise.resolve(response(200, JSON.stringify({ properties: { timeseries: [] } })))],
    ["unexpected status", () => Promise.resolve(response(204, ""))],
  ])("%s without a usable cache → unavailable, nothing cached", async (_label, impl) => {
    http.providerFetch.mockImplementation(impl);
    const r = await getMetnoForecast(35.033, -82.7);
    expect(r).toEqual({ status: "unavailable", message: "The weather forecast from MET Norway is unavailable right now." });
    expect(kinds()).toEqual(["select"]);
  });

  it("serves a recently confirmed forecast when the refresh fails (stale-if-error)", async () => {
    db.respond = (text) => (text.startsWith("select") ? [cacheRow({ staleUsable: true })] : []);
    http.providerFetch.mockRejectedValue(new ProviderError("metno", "HTTP 500", 500, true));
    const r = await getMetnoForecast(35.033, -82.7);
    expect(r).toMatchObject({ status: "ok", source: "stale" });
    expect(kinds()).toEqual(["select"]);
  });

  it("never serves a forecast older than the stale window", async () => {
    db.respond = (text) => (text.startsWith("select") ? [cacheRow({ staleUsable: false })] : []);
    http.providerFetch.mockRejectedValue(new ProviderError("metno", "HTTP 500", 500, true));
    expect((await getMetnoForecast(35.033, -82.7)).status).toBe("unavailable");
  });

  it("a 304 for an entry we did not send is not trusted", async () => {
    http.providerFetch.mockResolvedValue(response(304, ""));
    expect((await getMetnoForecast(35.033, -82.7)).status).toBe("unavailable");
  });

  it("cache read/write/extend failures never fail the request", async () => {
    db.respond = () => new Error("db down");
    http.providerFetch.mockResolvedValue(response(200, BODY));
    expect(await getMetnoForecast(35.033, -82.7)).toMatchObject({ status: "ok", source: "provider" });

    db.respond = (text) => (text.startsWith("select") ? [cacheRow()] : new Error("db down"));
    http.providerFetch.mockResolvedValue(response(304, ""));
    expect(await getMetnoForecast(35.033, -82.7)).toMatchObject({ status: "ok", source: "revalidated" });
  });

  it("invalid coordinates → unavailable without any I/O", async () => {
    expect((await getMetnoForecast(Number.NaN, 0)).status).toBe("unavailable");
    expect((await getMetnoForecast(0, 200)).status).toBe("unavailable");
    expect(db.calls).toHaveLength(0);
    expect(http.providerFetch).not.toHaveBeenCalled();
  });
});
