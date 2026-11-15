/**
 * The weather provider clients against the real database with `fetch`
 * stubbed (no network): MET Norway caching in public.weather_cache (write,
 * read, hit counting, Expires, If-Modified-Since + 304, failures not cached,
 * stale-if-error, races), and NWS alerts caching and coverage.
 *
 * Weather-cache keys used here belong to this file only.
 */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, sql } from "@/server/db";
import { getMetnoForecast } from "@/server/weather/metno";
import { getNwsAlerts } from "@/server/weather/nws-alerts";

afterAll(closeDb);

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");
const TABLE_ROCK = fixture("metno/complete-table-rock-sc.json");
const BANFF = fixture("metno/complete-banff-ab.json");
const NOW = new Date("2026-11-12T15:00:00Z");
const MIN = 60_000;

// ---------------------------------------------------------------------------
// fetch stub: per-host reply queues; a reply may be a function (for races).
// ---------------------------------------------------------------------------
type Reply =
  | { status: number; body?: string; headers?: Record<string, string> }
  | Error
  | ((url: string, init?: RequestInit) => Promise<Response>);
const queues: { metno: Reply[]; nws: Reply[] } = { metno: [], nws: [] };
const requests: { url: string; headers: Headers }[] = [];

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  requests.push({ url, headers: new Headers(init?.headers) });
  const queue = url.startsWith("https://api.met.no/") ? queues.metno : url.startsWith("https://api.weather.gov/") ? queues.nws : null;
  if (!queue) throw new Error(`unexpected fetch ${url}`);
  const next = queue.shift() ?? new Error(`no stubbed reply for ${url}`);
  if (next instanceof Error) throw next;
  if (typeof next === "function") return next(url, init);
  const nullBody = next.status === 304 || next.status === 204;
  return new Response(nullBody ? null : (next.body ?? ""), { status: next.status, headers: next.headers });
});

/** MET-style freshness headers relative to the real clock. */
const metHeaders = (ttlMin = 30, lastModified = new Date(Date.now() - 60_000).toUTCString()) => ({
  "content-type": "application/json",
  date: new Date().toUTCString(),
  expires: new Date(Date.now() + ttlMin * MIN).toUTCString(),
  "last-modified": lastModified,
});
const metOk = (body = TABLE_ROCK, ttlMin = 30, lastModified?: string): Reply => ({ status: 200, body, headers: metHeaders(ttlMin, lastModified) });
const nwsOk = (body: string): Reply => ({ status: 200, body, headers: { "content-type": "application/geo+json" } });

beforeEach(async () => {
  queues.metno = [];
  queues.nws = [];
  requests.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  await sql()`delete from public.weather_cache where provider in ('metno', 'nws_alerts') and cache_key = any(${KEYS}::text[])`;
});
afterEach(() => vi.unstubAllGlobals());

const KEYS = [
  "35.100,-82.800",
  "35.200,-82.800",
  "35.033,-82.700,340",
  "35.033,-82.700",
  "51.176,-115.563",
  "43.700,-79.400",
  "36.100,-82.800",
];

async function usage(provider: string) {
  const [row] = await sql()<{ requests: number; errors: number; cacheHits: number }[]>`
    select requests, errors, cache_hits from public.external_api_usage
     where provider = ${provider} and day = (now() at time zone 'utc')::date`;
  return row ?? { requests: 0, errors: 0, cacheHits: 0 };
}

interface CacheRow {
  payload: { v: number; updatedAt?: string; steps?: unknown[]; kind?: string; alerts?: unknown[] };
  ttlSec: number;
  ageSec: number;
  lastModified: string | null;
}
async function cacheRow(provider: string, key: string): Promise<CacheRow | undefined> {
  const [row] = await sql()<CacheRow[]>`
    select payload, extract(epoch from (expires_at - now()))::float8 as ttl_sec,
           extract(epoch from (now() - fetched_at))::float8 as age_sec, last_modified
      from public.weather_cache where provider = ${provider} and cache_key = ${key}`;
  return row;
}

describe("MET Norway cache (weather_cache)", () => {
  it("downloads once, stores the normalized forecast with Expires and Last-Modified, then serves the cache", async () => {
    const before = await usage("metno");
    queues.metno = [metOk(TABLE_ROCK, 20, "Thu, 12 Nov 2026 03:41:31 GMT")];

    const first = await getMetnoForecast(35.1, -82.8);
    expect(first).toMatchObject({ status: "ok", source: "provider" });
    expect(requests[0].url).toBe("https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=35.1&lon=-82.8");
    expect(requests[0].headers.get("user-agent")).toMatch(/GhostGuide/);
    expect(requests[0].headers.get("if-modified-since")).toBeNull();

    const row = (await cacheRow("metno", "35.100,-82.800"))!;
    expect(row.payload.v).toBe(1);
    expect(row.payload.updatedAt).toBe("2026-11-12T01:17:18.000Z");
    expect(row.payload.steps).toHaveLength(91);
    expect(row.lastModified).toBe("Thu, 12 Nov 2026 03:41:31 GMT");
    expect(row.ttlSec).toBeGreaterThan(19 * 60);
    expect(row.ttlSec).toBeLessThanOrEqual(20 * 60 + 1);

    const second = await getMetnoForecast(35.1001, -82.8002); // same 3-decimal cell
    expect(second).toMatchObject({ status: "ok", source: "cache" });
    expect(second.status === "ok" && first.status === "ok" && second.series).toEqual(first.status === "ok" && first.series);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const after = await usage("metno");
    expect(after.requests - before.requests).toBe(1);
    expect(after.cacheHits - before.cacheHits).toBe(1);
  });

  it("honours Expires: no request while fresh, a conditional request once expired", async () => {
    queues.metno = [metOk(TABLE_ROCK, 10, "Thu, 12 Nov 2026 03:41:31 GMT")];
    await getMetnoForecast(35.1, -82.8);
    await getMetnoForecast(35.1, -82.8);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await sql()`update public.weather_cache set expires_at = now() - interval '1 second' where provider = 'metno' and cache_key = '35.100,-82.800'`;
    queues.metno = [metOk(BANFF, 30, "Thu, 12 Nov 2026 04:41:31 GMT")];
    const refreshed = await getMetnoForecast(35.1, -82.8);
    expect(refreshed).toMatchObject({ status: "ok", source: "provider" });
    expect(requests[1].headers.get("if-modified-since")).toBe("Thu, 12 Nov 2026 03:41:31 GMT");
    // 200 on revalidation replaces the payload and the validator.
    const row = (await cacheRow("metno", "35.100,-82.800"))!;
    expect(row.payload.updatedAt).toBe("2026-11-12T01:17:06.000Z");
    expect(row.lastModified).toBe("Thu, 12 Nov 2026 04:41:31 GMT");
    expect(row.ttlSec).toBeGreaterThan(29 * 60);
  });

  it("304 Not Modified extends the cached forecast without replacing it", async () => {
    queues.metno = [metOk(TABLE_ROCK, 10, "Thu, 12 Nov 2026 03:41:31 GMT")];
    await getMetnoForecast(35.1, -82.8);
    await sql()`update public.weather_cache set expires_at = now() - interval '5 minutes', fetched_at = now() - interval '40 minutes'
                 where provider = 'metno' and cache_key = '35.100,-82.800'`;
    const before = await usage("metno");
    queues.metno = [{ status: 304, headers: { date: new Date().toUTCString(), expires: new Date(Date.now() + 15 * MIN).toUTCString() } }];

    const r = await getMetnoForecast(35.1, -82.8);
    expect(r).toMatchObject({ status: "ok", source: "revalidated" });
    expect(r.status === "ok" && r.series.updatedAt).toBe("2026-11-12T01:17:18.000Z");
    expect(requests[1].headers.get("if-modified-since")).toBe("Thu, 12 Nov 2026 03:41:31 GMT");

    const row = (await cacheRow("metno", "35.100,-82.800"))!;
    expect(row.payload.updatedAt).toBe("2026-11-12T01:17:18.000Z");
    expect(row.lastModified).toBe("Thu, 12 Nov 2026 03:41:31 GMT");
    expect(row.ttlSec).toBeGreaterThan(14 * 60);
    expect(row.ttlSec).toBeLessThanOrEqual(15 * 60 + 1);
    expect(row.ageSec).toBeLessThan(5);
    // A 304 is a successful request, not an error.
    const after = await usage("metno");
    expect(after.requests - before.requests).toBe(1);
    expect(after.errors - before.errors).toBe(0);
  });

  it("203 (deprecated version) is still a valid, cached forecast", async () => {
    queues.metno = [{ status: 203, body: TABLE_ROCK, headers: metHeaders() }];
    expect(await getMetnoForecast(35.1, -82.8)).toMatchObject({ status: "ok", deprecated: true });
    expect(await cacheRow("metno", "35.100,-82.800")).toBeDefined();
  });

  it.each([
    ["HTTP 500", { status: 500, body: "oops" }],
    ["HTTP 429", { status: 429, body: "slow down" }],
    ["network error", new TypeError("fetch failed")],
    ["invalid JSON", { status: 200, body: "<html>maintenance</html>" }],
  ])("%s with nothing cached → unavailable and nothing stored", async (_label, reply) => {
    const before = await usage("metno");
    queues.metno = [reply as Reply];
    expect(await getMetnoForecast(35.2, -82.8)).toEqual({
      status: "unavailable",
      message: "The weather forecast from MET Norway is unavailable right now.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // one attempt: no tight retry loop against the provider
    expect(await cacheRow("metno", "35.200,-82.800")).toBeUndefined();
    const after = await usage("metno");
    expect(after.requests - before.requests).toBe(1);
    if (!(reply instanceof Error) && reply.status !== 200) expect(after.errors - before.errors).toBe(1);
  });

  it("stale-if-error: a recently confirmed forecast is served when the refresh fails, an old one is not", async () => {
    queues.metno = [metOk()];
    await getMetnoForecast(35.1, -82.8);
    await sql()`update public.weather_cache set expires_at = now() - interval '1 minute', fetched_at = now() - interval '1 hour'
                 where provider = 'metno' and cache_key = '35.100,-82.800'`;
    queues.metno = [{ status: 503, body: "" }];
    expect(await getMetnoForecast(35.1, -82.8)).toMatchObject({ status: "ok", source: "stale" });
    // Untouched: the failure is not cached.
    expect((await cacheRow("metno", "35.100,-82.800"))!.ttlSec).toBeLessThan(0);

    await sql()`update public.weather_cache set fetched_at = now() - interval '4 hours' where provider = 'metno' and cache_key = '35.100,-82.800'`;
    queues.metno = [{ status: 503, body: "" }];
    expect((await getMetnoForecast(35.1, -82.8)).status).toBe("unavailable");
  });

  it("concurrent misses both succeed and leave exactly one row", async () => {
    queues.metno = [metOk(), metOk()];
    const [a, b] = await Promise.all([getMetnoForecast(35.1, -82.8), getMetnoForecast(35.1, -82.8)]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    const [{ n }] = await sql()<{ n: number }[]>`
      select count(*)::int as n from public.weather_cache where provider = 'metno' and cache_key = '35.100,-82.800'`;
    expect(n).toBe(1);
  });

  it("a 304 never extends a row that another request replaced meanwhile", async () => {
    queues.metno = [metOk(TABLE_ROCK, 10, "Thu, 12 Nov 2026 03:41:31 GMT")];
    await getMetnoForecast(35.1, -82.8);
    await sql()`update public.weather_cache set expires_at = now() - interval '1 minute' where provider = 'metno' and cache_key = '35.100,-82.800'`;
    queues.metno = [
      async () => {
        // Another instance downloads a newer forecast while our conditional request is in flight.
        await sql()`update public.weather_cache
                       set last_modified = 'Thu, 12 Nov 2026 05:00:00 GMT', expires_at = now() + interval '45 minutes', fetched_at = now()
                     where provider = 'metno' and cache_key = '35.100,-82.800'`;
        return new Response(null, { status: 304, headers: { expires: new Date(Date.now() + 5 * MIN).toUTCString() } });
      },
    ];
    expect(await getMetnoForecast(35.1, -82.8)).toMatchObject({ status: "ok", source: "revalidated" });
    const row = (await cacheRow("metno", "35.100,-82.800"))!;
    expect(row.lastModified).toBe("Thu, 12 Nov 2026 05:00:00 GMT");
    expect(row.ttlSec).toBeGreaterThan(44 * 60);
  });
});

// ---------------------------------------------------------------------------
describe("NWS alerts cache and coverage", () => {
  it("caches an empty US answer for 5 minutes and counts cache hits", async () => {
    const before = await usage("nws");
    queues.nws = [nwsOk(fixture("nws/alerts-active-table-rock-sc.json"))];
    expect(await getNwsAlerts(35.033, -82.7, { countryCode: "us", now: NOW })).toEqual({
      status: "ok",
      alerts: [],
      fromCache: false,
      checkedAt: expect.any(Date),
    });
    expect(requests[0].url).toBe("https://api.weather.gov/alerts/active?point=35.033,-82.7");
    expect(requests[0].headers.get("accept")).toBe("application/geo+json");
    const row = (await cacheRow("nws_alerts", "35.033,-82.700"))!;
    expect(row.payload).toEqual({ v: 1, kind: "alerts", alerts: [] });
    expect(row.ttlSec).toBeGreaterThan(290);
    expect(row.ttlSec).toBeLessThanOrEqual(300);

    // A cache hit reports when NWS actually answered (the row's fetched_at), not "now".
    await sql()`update public.weather_cache set fetched_at = now() - interval '4 minutes' where provider = 'nws_alerts' and cache_key = '35.033,-82.700'`;
    const hit = await getNwsAlerts(35.033, -82.7, { countryCode: "us", now: NOW });
    expect(hit).toMatchObject({ status: "ok", alerts: [], fromCache: true });
    const age = Date.now() - (hit.status === "ok" && hit.checkedAt ? hit.checkedAt.getTime() : 0);
    expect(age).toBeGreaterThan(3.9 * MIN);
    expect(age).toBeLessThan(4.5 * MIN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const after = await usage("nws");
    expect(after.requests - before.requests).toBe(1);
    expect(after.cacheHits - before.cacheHits).toBe(1);
  });

  it("maps and caches active alerts", async () => {
    queues.nws = [nwsOk(fixture("nws/alerts-active-synthetic.json"))];
    const r = await getNwsAlerts(35.033, -82.7, { countryCode: "us", now: NOW });
    expect(r.alerts.map((a) => a.event)).toEqual(["Flash Flood Emergency", "Winter Storm Warning", "Wind Advisory", "Frost Advisory"]);
    expect((await cacheRow("nws_alerts", "35.033,-82.700"))!.payload.alerts).toHaveLength(4);
  });

  it("outside the US: not_supported without a request", async () => {
    expect(await getNwsAlerts(51.176, -115.563, { countryCode: "ca", now: NOW })).toMatchObject({ status: "not_supported", alerts: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await cacheRow("nws_alerts", "51.176,-115.563")).toBeUndefined();
  });

  it("unknown country inside the coarse US box: NWS's 'out of bounds' answer → not_supported, cached for a week", async () => {
    queues.nws = [{ status: 400, body: fixture("nws/alerts-active-out-of-bounds-toronto.json"), headers: { "content-type": "application/problem+json" } }];
    expect(await getNwsAlerts(43.7, -79.4, { countryCode: "xx", now: NOW })).toMatchObject({ status: "not_supported" });
    const row = (await cacheRow("nws_alerts", "43.700,-79.400"))!;
    expect(row.payload).toEqual({ v: 1, kind: "out_of_bounds" });
    expect(row.ttlSec).toBeGreaterThan(6.9 * 86_400);
    expect(await getNwsAlerts(43.7, -79.4, { countryCode: null, now: NOW })).toMatchObject({ status: "not_supported" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a failing NWS → unavailable, not cached", async () => {
    queues.nws = [{ status: 502, body: "bad gateway" }];
    expect(await getNwsAlerts(35.033, -82.7, { countryCode: "us", now: NOW })).toMatchObject({ status: "unavailable", alerts: [] });
    expect(await cacheRow("nws_alerts", "35.033,-82.700")).toBeUndefined();
  });
});
