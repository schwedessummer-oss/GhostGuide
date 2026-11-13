/**
 * GET /api/trails/:id/conditions called directly with Request objects:
 * 404 rules, per-IP rate limit (429), Cache-Control (short shared caching
 * only when every provider part is current; no-store when the forecast or
 * the alerts are unavailable or the forecast is the stale fallback) and JSON
 * errors without internals. `fetch` is stubbed (no network); the rate
 * limiter runs for real except where a test forces a "limited" answer.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrailConditionsDto } from "@/domain/catalog";

const limiter = vi.hoisted(() => ({ forceLimited: false }));
vi.mock("@/server/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/rate-limit")>();
  return {
    ...actual,
    checkRateLimit: vi.fn(async (key: string, limit: number, windowSec: number) => {
      if (limiter.forceLimited) return { allowed: false, remaining: 0, resetAt: new Date(Date.now() + 42_000) };
      return actual.checkRateLimit(key, limit, windowSec);
    }),
  };
});

const failure = vi.hoisted(() => ({ throwFromService: false }));
vi.mock("@/server/weather/conditions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/weather/conditions")>();
  return {
    ...actual,
    loadTrailConditions: vi.fn(async (...args: Parameters<typeof actual.loadTrailConditions>) => {
      if (failure.throwFromService) throw new Error("connect ECONNREFUSED 10.0.0.5:5432 (secret internals)");
      return actual.loadTrailConditions(...args);
    }),
  };
});

import { GET } from "@/app/api/trails/[id]/conditions/route";
import { closeDb, sql, withSystem, type JsonValue } from "@/server/db";
import { checkRateLimit } from "@/server/rate-limit";
import { loadTrailConditions } from "@/server/weather/conditions";

afterAll(closeDb);

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");
let metReply: () => Response = () => new Response("", { status: 500 });
const nwsOk = () => new Response(fixture("nws/alerts-active-table-rock-sc.json"), { status: 200 });
let nwsReply: () => Response = nwsOk;
const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
  const url = String(input);
  if (url.startsWith("https://api.met.no/")) return metReply();
  if (url.startsWith("https://api.weather.gov/")) return nwsReply();
  throw new Error(`unexpected fetch ${url}`);
});

/** Max seconds a shared cache may serve the response for, s-maxage plus stale-while-revalidate (0 when it must not). */
function sharedLifetimeS(cacheControl: string | null): number {
  const cc = (cacheControl ?? "").toLowerCase();
  if (/\b(no-store|private)\b/.test(cc)) return 0;
  const n = (name: string) => Number(new RegExp(`\\b${name}=(\\d+)`).exec(cc)?.[1] ?? 0);
  return n("s-maxage") + n("stale-while-revalidate");
}

// Cache keys of the trail below (trailhead 36.1005, -82.8003; no profile → no altitude) start with these.
const KEY_PATTERN = "36.10_,-82.800%";
beforeEach(async () => {
  limiter.forceLimited = false;
  failure.throwFromService = false;
  nwsReply = nwsOk;
  metReply = () =>
    new Response(fixture("metno/complete-table-rock-sc.json"), {
      status: 200,
      headers: { expires: new Date(Date.now() + 30 * 60_000).toUTCString(), date: new Date().toUTCString() },
    });
  vi.mocked(checkRateLimit).mockClear();
  vi.mocked(loadTrailConditions).mockClear();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  await sql()`delete from public.weather_cache where provider in ('metno', 'nws_alerts') and cache_key like ${KEY_PATTERN}`;
});
afterEach(() => vi.unstubAllGlobals());

const newIp = () => `203.0.113.${Math.floor(Math.random() * 250) + 1}-${randomUUID().slice(0, 6)}`;
const get = (id: string, ip = newIp()) =>
  GET(new Request(`http://localhost/api/trails/${id}/conditions`, { headers: { "x-real-ip": ip } }), { params: Promise.resolve({ id }) });

async function insertTrail(hidden = false): Promise<string> {
  const [row] = await withSystem(
    (tx) => tx<{ id: string }[]>`
      with g as (select st_setsrid(st_geomfromgeojson(${JSON.stringify({
        type: "MultiLineString",
        coordinates: [
          [
            [-82.8003, 36.1005],
            [-82.79, 36.11],
          ],
        ],
      })}), 4326) as geom)
      insert into public.catalog_trails (provider, provider_id, name, slug, country_code, region_slug, timezone, centroid,
        trailhead, trailhead_source, geom, distance_m, route_type, estimated_duration_min, source_name, source_license, hidden, tags)
      select 'osm', ${`relation/${randomUUID()}`}, 'Route Test Trail', ${`cond-route-${randomUUID().slice(0, 8)}`}, 'us',
             'conditions-route-test', 'America/New_York', st_centroid(g.geom)::geography,
             st_setsrid(st_makepoint(-82.8003, 36.1005), 4326)::geography, 'osm_trailhead', g.geom, 1400, 'linear', 40,
             'OpenStreetMap', 'ODbL 1.0', ${hidden}, ${tx.json({} as JsonValue)}
        from g
      returning id`,
  );
  return row.id;
}

describe("GET /api/trails/:id/conditions", () => {
  it.each([["not-a-uuid"], ["12345"], ["00000000-0000-0000-0000-00000000000g"]])("404 for a malformed id (%s) before any work", async (id) => {
    const res = await get(id);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Trail not found" });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(loadTrailConditions).not.toHaveBeenCalled();
  });

  it("404 for unknown and hidden trails alike", async () => {
    for (const id of [randomUUID(), await insertTrail(true)]) {
      const res = await get(id);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Trail not found" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("200 with short shared caching (no stale-while-revalidate) when everything is current", async () => {
    const id = await insertTrail();
    const ip = newIp();
    const res = await get(id, ip);
    expect(res.status).toBe(200);
    // The body is built for this moment (daylight left, finish if you start now, the current hour,
    // active alerts): a CDN may share it for a minute at most, never serve it stale.
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60");
    expect(sharedLifetimeS(res.headers.get("cache-control"))).toBeLessThanOrEqual(60);
    const body = (await res.json()) as TrailConditionsDto;
    expect(body).toMatchObject({ trailId: id, timezone: "America/New_York", forecastStatus: "ok", alertsStatus: "ok" });
    expect(body.sun).toHaveLength(3);
    expect(body.attribution.map((a) => a.license)).toEqual(["CC BY 4.0", "US Government work (public domain)"]);
    expect(body.planning.notes.some((n) => n.startsWith("Official weather alerts were last checked "))).toBe(true);
    expect(checkRateLimit).toHaveBeenCalledWith(`trails:conditions:ip:${ip}`, 60, 60);
  });

  it("200 with no-store when the forecast is unavailable, so the next request retries", async () => {
    const id = await insertTrail();
    metReply = () => new Response("unavailable", { status: 503 });
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as TrailConditionsDto).forecastStatus).toBe("unavailable");
  });

  it("200 with no-store when NWS fails but MET answers, so 'alerts unavailable' is never shared", async () => {
    const id = await insertTrail();
    nwsReply = () => new Response("service unavailable", { status: 503 });
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as TrailConditionsDto;
    expect(body).toMatchObject({ forecastStatus: "ok", alertsStatus: "unavailable", alerts: [] });

    // NWS recovers: the very next request gets real alerts (and may be cached again).
    nwsReply = nwsOk;
    const again = await get(id);
    expect(((await again.json()) as TrailConditionsDto).alertsStatus).toBe("ok");
    expect(again.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60");
  });

  it("200 with no-store when MET fails and the stale-if-error forecast is served", async () => {
    const id = await insertTrail();
    expect((await get(id)).headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60"); // fills the MET cache
    await sql()`update public.weather_cache set expires_at = now() - interval '1 minute', fetched_at = now() - interval '50 minutes'
                 where provider = 'metno' and cache_key like ${KEY_PATTERN}`;
    metReply = () => new Response("unavailable", { status: 503 });
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as TrailConditionsDto;
    expect(body.forecastStatus).toBe("ok");
    expect(body.planning.notes[0]).toMatch(/^The latest forecast could not be loaded just now, so an earlier forecast is shown\./);
  });

  it("alerts are never shared by caches for longer than the conditions TTL (no stale-while-revalidate)", async () => {
    const id = await insertTrail();
    for (const cc of [(await get(id)).headers.get("cache-control"), (await get(id)).headers.get("cache-control")]) {
      expect(cc).not.toMatch(/stale-while-revalidate/);
      expect(sharedLifetimeS(cc)).toBeLessThanOrEqual(60);
    }
  });

  it("429 with Retry-After when the client is over its limit", async () => {
    const id = await insertTrail();
    limiter.forceLimited = true;
    const res = await get(id);
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(41);
    expect(await res.json()).toEqual({ error: "Too many requests. Please wait a moment and try again." });
    expect(loadTrailConditions).not.toHaveBeenCalled();
  });

  it("the real limiter allows 60 requests per minute per IP", async () => {
    const id = randomUUID(); // unknown trail: cheap 404s still count
    const ip = newIp();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await get(id, ip)).status);
    expect(statuses.slice(0, 60).every((s) => s === 404)).toBe(true);
    expect(statuses[60]).toBe(429);
    // Another client is unaffected.
    expect((await get(id)).status).toBe(404);
  });

  it("500 as JSON without internals when the service fails", async () => {
    const id = await insertTrail();
    failure.throwFromService = true;
    const res = await get(id);
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Could not load trail conditions. Please try again." });
    expect(text).not.toMatch(/ECONNREFUSED|secret|stack|at /);
  });
});
