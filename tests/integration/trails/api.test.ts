/**
 * Public API route handlers called directly with Request objects:
 * validation (400), rate limits (429), response shapes and Cache-Control.
 *
 * The coverage service belongs to another workstream: it is mocked here.
 * The rate limiter runs for real (per-IP keys in Postgres) except where a
 * test forces a "limited" answer. `fetch` is stubbed: no network.
 *
 * Trail rows live around lng 140–150, lat -30 (no other test file uses this area).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bbox, CoverageDto, TrailDetailDto, TrailSearchResponse } from "@/domain/catalog";

const coverage = vi.hoisted(() => ({
  ensureCoverage: vi.fn(),
  getCoverage: vi.fn(),
}));
vi.mock("@/server/trails/coverage", () => coverage);

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

import { closeDb, withSystem, type JsonValue } from "@/server/db";
import { checkRateLimit } from "@/server/rate-limit";
import { GET as geocodeGET } from "@/app/api/geocode/route";
import { GET as searchGET } from "@/app/api/trails/search/route";
import { GET as detailGET } from "@/app/api/trails/[id]/route";

afterAll(closeDb);

const READY = (bbox: Bbox): CoverageDto => ({
  layer: "outdoor",
  state: "ready",
  tilesTotal: 1,
  tilesReady: 1,
  tilesLoading: 0,
  tilesFailed: 0,
  oldestSyncAt: "2026-11-10T00:00:00.000Z",
  message: `Loaded ${bbox.join(",")}`,
});
const LOADING: CoverageDto = {
  layer: "outdoor",
  state: "loading",
  tilesTotal: 4,
  tilesReady: 1,
  tilesLoading: 3,
  tilesFailed: 0,
  oldestSyncAt: null,
  message: "Loading trails for this area…",
};

const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
  throw new Error(`unexpected fetch ${String(input)}`);
});

beforeEach(async () => {
  limiter.forceLimited = false;
  coverage.ensureCoverage.mockReset();
  coverage.ensureCoverage.mockImplementation(async (_layer: string, bbox: Bbox) => READY(bbox));
  vi.mocked(checkRateLimit).mockClear();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  await withSystem((tx) => tx`delete from public.provider_throttle where provider = 'nominatim'`);
});
afterEach(() => vi.unstubAllGlobals());

/** A unique client IP per test, so real rate-limit windows never collide. */
const newIp = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}-${randomUUID().slice(0, 6)}`;
const get = (path: string, ip = newIp()) => new Request(`http://localhost${path}`, { headers: { "x-real-ip": ip } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let areaSeq = 0;
function newArea() {
  const lng = 140 + areaSeq++ * 0.4;
  const lat = -30;
  const bbox: Bbox = [lng - 0.1, lat - 0.1, lng + 0.1, lat + 0.1];
  return { lng, lat, bbox, q: bbox.join(",") };
}

async function insertTrail(lng: number, lat: number, opts: { name?: string; hidden?: boolean; difficulty?: string } = {}) {
  const geojson = JSON.stringify({ type: "MultiLineString", coordinates: [[[lng, lat], [lng + 0.01, lat + 0.005]]] });
  const [row] = await withSystem(
    (tx) => tx<{ id: string }[]>`
      with g as (select st_setsrid(st_geomfromgeojson(${geojson}), 4326) as geom)
      insert into public.catalog_trails (provider, provider_id, name, slug, country_code, region_slug, centroid, trailhead,
        trailhead_source, geom, distance_m, route_type, difficulty, source_name, source_license, hidden, tags)
      select 'osm', ${`way/${randomUUID()}`}, ${opts.name ?? "Api Trail"}, ${`api-${randomUUID().slice(0, 8)}`}, 'au', 'new-south-wales',
             st_centroid(g.geom)::geography, st_startpoint(st_geometryn(g.geom, 1))::geography, 'route_start',
             g.geom, 1100, 'linear', ${opts.difficulty ?? "easy"}, 'OpenStreetMap', 'ODbL 1.0', ${opts.hidden ?? false},
             ${tx.json({} as JsonValue)}
        from g
      returning id`,
  );
  return row.id;
}

// ---------------------------------------------------------------------------
describe("GET /api/geocode", () => {
  it.each([[""], ["?q="], ["?q=a"], ["?q=%20%20a%20%20"], [`?q=${"x".repeat(121)}`]])("400 for %s", async (qs) => {
    const res = await geocodeGET(get(`/api/geocode${qs}`));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "q must be between 2 and 120 characters" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns GeocodeResponse + nearMe with a private cache header", async () => {
    await withSystem((tx) => tx`delete from public.geocode_cache where provider = 'nominatim' and query_key = 'mount fuji'`);
    const body = readFileSync(new URL("../../fixtures/nominatim/search-mount-fuji.json", import.meta.url), "utf8");
    fetchMock.mockImplementationOnce(async () => new Response(body, { status: 200 }));
    const res = await geocodeGET(get("/api/geocode?q=hikes%20near%20Mount%20Fuji"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    const json = await res.json();
    expect(json).toMatchObject({ query: "hikes near Mount Fuji", placeQuery: "Mount Fuji", status: "ok", nearMe: false });
    expect(json.results).toHaveLength(3);
    expect(json.results[0]).toMatchObject({ kind: "volcano", countryCode: "jp", source: "OpenStreetMap Nominatim" });
    expect(json.attribution[0].name).toBe("© OpenStreetMap contributors");
  });

  it("flags near-me queries without calling the provider", async () => {
    const res = await geocodeGET(get("/api/geocode?q=trails%20near%20me"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ nearMe: true, placeQuery: "", status: "no_results", results: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unavailable provider is an honest 200 'unavailable' that is not cached by the browser", async () => {
    await withSystem((tx) => tx`delete from public.geocode_cache where provider = 'nominatim' and query_key = 'nowhere-land-unavailable'`);
    fetchMock.mockImplementation(async () => new Response("{}", { status: 403 }));
    const res = await geocodeGET(get("/api/geocode?q=nowhere-land-unavailable"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ status: "unavailable", results: [] });
  });

  it("rate limits per client IP: 30 requests per minute, then 429 with Retry-After", async () => {
    // Stay clear of a fixed-window boundary so all 31 calls share one window.
    const msLeft = 60_000 - (Date.now() % 60_000);
    if (msLeft < 8_000) await new Promise((r) => setTimeout(r, msLeft + 100));
    const ip = newIp();
    for (let i = 0; i < 30; i++) {
      const res = await geocodeGET(get("/api/geocode?q=near%20me", ip));
      expect(res.status).toBe(200);
    }
    const limited = await geocodeGET(get("/api/geocode?q=near%20me", ip));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await limited.json()).toEqual({ error: expect.stringMatching(/too many/i) });
    // Another client is unaffected.
    expect((await geocodeGET(get("/api/geocode?q=near%20me"))).status).toBe(200);
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith(`geocode:ip:${ip}`, 30, 60);
  });
});

// ---------------------------------------------------------------------------
describe("GET /api/trails/search", () => {
  it("400 with field names for an invalid query", async () => {
    const cases: [string, string[]][] = [
      ["", ["bbox"]],
      ["?bbox=1,2,3", ["bbox"]],
      ["?bbox=10,10,5,20", ["bbox"]],
      ["?bbox=1,2,3,4&difficulty=easy,impossible", ["difficulty"]],
      ["?bbox=1,2,3,4&sort=random&limit=0", ["sort", "limit"]],
      ["?bbox=1,2,3,4&fee=maybe&maxGainM=-5", ["maxGainM", "fee"]],
      ["?bbox=1,2,3,4&minDistanceKm=10&maxDistanceKm=2", ["minDistanceKm", "maxDistanceKm"]],
    ];
    for (const [qs, fields] of cases) {
      const res = await searchGET(get(`/api/trails/search${qs}`));
      expect(res.status, qs).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect(body.error).toMatch(/^Invalid search query/);
      expect([...body.fields].sort(), qs).toEqual([...fields].sort());
    }
    expect(coverage.ensureCoverage).not.toHaveBeenCalled();
  });

  it("returns trails, total, bbox, coverage and attribution; caches publicly once the area is ready", async () => {
    const a = newArea();
    const id = await insertTrail(a.lng, a.lat, { name: "Coastal Walk" });
    await insertTrail(a.lng + 0.02, a.lat, { hidden: true });
    const res = await searchGET(get(`/api/trails/search?bbox=${a.q}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=60");
    const body = (await res.json()) as TrailSearchResponse;
    expect(body.total).toBe(1);
    expect(body.bbox).toEqual(a.bbox);
    expect(body.coverage).toEqual(READY(a.bbox));
    expect(body.attribution).toEqual([
      { name: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright", license: "ODbL 1.0" },
    ]);
    expect(body.trails).toHaveLength(1);
    expect(body.trails[0]).toMatchObject({ id, name: "Coastal Walk", routeType: "linear", countryCode: "au" });
    expect(body.trails[0].path).toMatch(/^\/trail\/au\/new-south-wales\/api-/);
    // The client key charges new tile loads to this client's budget.
    expect(coverage.ensureCoverage).toHaveBeenCalledWith("outdoor", a.bbox, { request: true, inlineTiles: 2, client: expect.any(String) });
  });

  it("passes load=0 through and applies filters", async () => {
    const a = newArea();
    await insertTrail(a.lng, a.lat, { difficulty: "easy" });
    const hard = await insertTrail(a.lng + 0.03, a.lat, { difficulty: "hard" });
    const res = await searchGET(get(`/api/trails/search?bbox=${a.q}&load=0&difficulty=hard`));
    const body = (await res.json()) as TrailSearchResponse;
    expect(body.trails.map((t) => t.id)).toEqual([hard]);
    expect(coverage.ensureCoverage).toHaveBeenCalledWith("outdoor", a.bbox, { request: false, inlineTiles: 0, client: expect.any(String) });
  });

  it("is not cached while the area is still loading", async () => {
    const a = newArea();
    coverage.ensureCoverage.mockResolvedValue(LOADING);
    const res = await searchGET(get(`/api/trails/search?bbox=${a.q}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).coverage).toEqual(LOADING);
  });

  it("still returns stored trails with coverage 'failed' when the coverage service throws", async () => {
    const a = newArea();
    const id = await insertTrail(a.lng, a.lat);
    coverage.ensureCoverage.mockRejectedValue(new Error("queue down"));
    const res = await searchGET(get(`/api/trails/search?bbox=${a.q}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as TrailSearchResponse;
    expect(body.trails.map((t) => t.id)).toEqual([id]);
    expect(body.coverage).toMatchObject({ layer: "outdoor", state: "failed", tilesTotal: 0, oldestSyncAt: null });
    expect(body.coverage.message).toMatch(/unavailable/i);
    expect(JSON.stringify(body)).not.toMatch(/queue down/);
  });

  it("keys an IPv6 client by its /64: rotating addresses in the prefix share one rate limit and one load budget", async () => {
    const a = newArea();
    const net = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:${Math.floor(Math.random() * 0xffff).toString(16)}`;
    for (const host of ["::1", "::dead:beef", ":1:2:3:4"]) await searchGET(get(`/api/trails/search?bbox=${a.q}`, `${net}${host}`));
    const keys = vi.mocked(checkRateLimit).mock.calls.map(([key]) => key);
    expect(keys).toEqual(Array(3).fill(`trails:search:ip:${net}::/64`));
    const clients = coverage.ensureCoverage.mock.calls.map((c) => (c[2] as { client?: string }).client);
    expect(clients).toEqual(Array(3).fill(`${net}::/64`));
  });

  it("429 when the client is over its limit (60/min per IP)", async () => {
    const a = newArea();
    const ip = newIp();
    await searchGET(get(`/api/trails/search?bbox=${a.q}`, ip));
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith(`trails:search:ip:${ip}`, 60, 60);
    limiter.forceLimited = true;
    const res = await searchGET(get(`/api/trails/search?bbox=${a.q}`, ip));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(await res.json()).toEqual({ error: expect.stringMatching(/too many/i) });
  });
});

// ---------------------------------------------------------------------------
describe("GET /api/trails/[id]", () => {
  it("returns the detail DTO with a short shared cache", async () => {
    const a = newArea();
    const id = await insertTrail(a.lng, a.lat, { name: "Detail Trail" });
    const res = await detailGET(get(`/api/trails/${id}`), ctx(id));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=60");
    const body = (await res.json()) as TrailDetailDto;
    expect(body).toMatchObject({ id, name: "Detail Trail", regionSlug: "new-south-wales", trailheadSource: "route_start" });
    expect(body.geometry.type).toBe("MultiLineString");
    expect(body.geometry.coordinates[0]).toHaveLength(2);
    expect(body.attribution[0].license).toBe("ODbL 1.0");
  });

  it("404 for invalid ids, unknown and hidden trails, without leaking which", async () => {
    const a = newArea();
    const hidden = await insertTrail(a.lng, a.lat, { hidden: true });
    for (const id of ["nope", "1234", `${randomUUID()}x`, randomUUID(), hidden]) {
      const res = await detailGET(get(`/api/trails/${id}`), ctx(id));
      expect(res.status, id).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Trail not found" });
    }
  });

  it("429 when the client is over its limit", async () => {
    const a = newArea();
    const id = await insertTrail(a.lng, a.lat);
    const ip = newIp();
    limiter.forceLimited = true;
    const res = await detailGET(get(`/api/trails/${id}`, ip), ctx(id));
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith(`trails:detail:ip:${ip}`, 120, 60);
  });

  it("a trail hidden by staff is 404 at once, and shared caches may keep an earlier copy for minutes at most", async () => {
    const a = newArea();
    const id = await insertTrail(a.lng, a.lat, { name: "Soon Hidden" });
    const before = await detailGET(get(`/api/trails/${id}`), ctx(id));
    expect(before.status).toBe(200);
    // A CDN cannot be purged from the app, so the cached copy's lifetime bounds the takedown delay:
    // s-maxage + stale-while-revalidate must stay within ~6 minutes (it used to be 1 h + 24 h).
    const cc = before.headers.get("cache-control") ?? "";
    const seconds = (name: string) => Number(new RegExp(`\\b${name}=(\\d+)`).exec(cc)?.[1] ?? 0);
    expect(seconds("s-maxage")).toBeGreaterThan(0);
    expect(seconds("s-maxage") + seconds("stale-while-revalidate")).toBeLessThanOrEqual(360);

    await withSystem((tx) => tx`update public.catalog_trails set hidden = true where id = ${id}::uuid`);
    const after = await detailGET(get(`/api/trails/${id}`), ctx(id));
    expect(after.status).toBe(404);
    expect(after.headers.get("cache-control")).toBe("no-store");
    expect(await after.json()).toEqual({ error: "Trail not found" });
  });
});
