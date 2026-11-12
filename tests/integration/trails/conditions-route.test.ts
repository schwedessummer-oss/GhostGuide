/**
 * GET /api/trails/:id/conditions called directly with Request objects:
 * 404 rules, per-IP rate limit (429), Cache-Control by forecast status and
 * JSON errors without internals. `fetch` is stubbed (no network); the rate
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
    getTrailConditions: vi.fn(async (...args: Parameters<typeof actual.getTrailConditions>) => {
      if (failure.throwFromService) throw new Error("connect ECONNREFUSED 10.0.0.5:5432 (secret internals)");
      return actual.getTrailConditions(...args);
    }),
  };
});

import { GET } from "@/app/api/trails/[id]/conditions/route";
import { closeDb, sql, withSystem, type JsonValue } from "@/server/db";
import { checkRateLimit } from "@/server/rate-limit";
import { getTrailConditions } from "@/server/weather/conditions";

afterAll(closeDb);

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");
let metReply: () => Response = () => new Response("", { status: 500 });
const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
  const url = String(input);
  if (url.startsWith("https://api.met.no/")) return metReply();
  if (url.startsWith("https://api.weather.gov/")) return new Response(fixture("nws/alerts-active-table-rock-sc.json"), { status: 200 });
  throw new Error(`unexpected fetch ${url}`);
});

// Cache keys of the trail below (trailhead 36.1005, -82.8003; no profile → no altitude) start with these.
const KEY_PATTERN = "36.10_,-82.800%";
beforeEach(async () => {
  limiter.forceLimited = false;
  failure.throwFromService = false;
  metReply = () =>
    new Response(fixture("metno/complete-table-rock-sc.json"), {
      status: 200,
      headers: { expires: new Date(Date.now() + 30 * 60_000).toUTCString(), date: new Date().toUTCString() },
    });
  vi.mocked(checkRateLimit).mockClear();
  vi.mocked(getTrailConditions).mockClear();
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
    expect(getTrailConditions).not.toHaveBeenCalled();
  });

  it("404 for unknown and hidden trails alike", async () => {
    for (const id of [randomUUID(), await insertTrail(true)]) {
      const res = await get(id);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Trail not found" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("200 with shared caching while the forecast is available", async () => {
    const id = await insertTrail();
    const ip = newIp();
    const res = await get(id, ip);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=600");
    const body = (await res.json()) as TrailConditionsDto;
    expect(body).toMatchObject({ trailId: id, timezone: "America/New_York", forecastStatus: "ok", alertsStatus: "ok" });
    expect(body.sun).toHaveLength(3);
    expect(body.attribution.map((a) => a.license)).toEqual(["CC BY 4.0", "US Government work (public domain)"]);
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

  it("429 with Retry-After when the client is over its limit", async () => {
    const id = await insertTrail();
    limiter.forceLimited = true;
    const res = await get(id);
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(41);
    expect(await res.json()).toEqual({ error: "Too many requests. Please wait a moment and try again." });
    expect(getTrailConditions).not.toHaveBeenCalled();
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
