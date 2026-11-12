/**
 * Nearby services (src/server/trails/nearby.ts) and GET /api/trails/:id/nearby
 * against PostGIS: grouping, per-group limits, distance ordering, radius
 * edges (exact geodesic offsets via ST_Project), layer separation, coverage
 * states and notes, 404/429/500 and Cache-Control.
 *
 * The coverage service belongs to another workstream and is mocked.
 * Rows live around lat -47, lng -160…-150 (open ocean; no other test file
 * uses this area); each test gets its own area ~70 km from the others.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoverageDto, NearbyResponse } from "@/domain/catalog";

const coverage = vi.hoisted(() => ({ ensureCoverage: vi.fn(), getCoverage: vi.fn() }));
vi.mock("@/server/trails/coverage", () => coverage);

const limiter = vi.hoisted(() => ({ forceLimited: false }));
vi.mock("@/server/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/rate-limit")>();
  return {
    ...actual,
    checkRateLimit: vi.fn(async (key: string, limit: number, windowSec: number) => {
      if (limiter.forceLimited) return { allowed: false, remaining: 0, resetAt: new Date(Date.now() + 30_000) };
      return actual.checkRateLimit(key, limit, windowSec);
    }),
  };
});

const failure = vi.hoisted(() => ({ throwFromService: false }));
vi.mock("@/server/trails/nearby", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/trails/nearby")>();
  return {
    ...actual,
    getNearbyServices: vi.fn(async (...args: Parameters<typeof actual.getNearbyServices>) => {
      if (failure.throwFromService) throw new Error("relation catalog_pois does not exist (internal detail)");
      return actual.getNearbyServices(...args);
    }),
  };
});

import { GET } from "@/app/api/trails/[id]/nearby/route";
import { closeDb, withSystem, type JsonValue } from "@/server/db";
import { bboxAround } from "@/server/geo/tiles";
import { checkRateLimit } from "@/server/rate-limit";
import { NEARBY_COVERAGE_FAILED, NEARBY_GROUP_LIMIT, getNearbyServices } from "@/server/trails/nearby";

afterAll(closeDb);

const coverageOf = (state: CoverageDto["state"]): CoverageDto => ({
  layer: "services",
  state,
  tilesTotal: 4,
  tilesReady: state === "ready" ? 4 : 1,
  tilesLoading: state === "loading" ? 3 : 0,
  tilesFailed: state === "partial" ? 3 : 0,
  oldestSyncAt: "2026-11-10T00:00:00.000Z",
  message: `services ${state}`,
});

beforeEach(() => {
  limiter.forceLimited = false;
  failure.throwFromService = false;
  coverage.ensureCoverage.mockReset();
  coverage.ensureCoverage.mockImplementation(async () => coverageOf("ready"));
  vi.mocked(checkRateLimit).mockClear();
  vi.mocked(getNearbyServices).mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      throw new Error(`unexpected fetch ${String(input)}`);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let areaSeq = 0;
function newArea() {
  return { lng: -160 + areaSeq++ * 1, lat: -47 };
}

async function insertTrail(o: { lng: number; lat: number; trailhead?: boolean; hidden?: boolean }): Promise<string> {
  const geojson = JSON.stringify({
    type: "MultiLineString",
    coordinates: [
      [
        [o.lng, o.lat],
        [o.lng + 0.02, o.lat],
      ],
    ],
  });
  const [row] = await withSystem(
    (tx) => tx<{ id: string }[]>`
      with g as (select st_setsrid(st_geomfromgeojson(${geojson}), 4326) as geom)
      insert into public.catalog_trails (provider, provider_id, name, slug, country_code, region_slug, centroid, trailhead,
        trailhead_source, geom, distance_m, route_type, source_name, source_license, hidden, tags)
      select 'osm', ${`relation/${randomUUID()}`}, 'Nearby Test Trail', ${`nearby-${randomUUID().slice(0, 8)}`}, 'xx', 'nearby-test',
             st_centroid(g.geom)::geography,
             case when ${o.trailhead ?? true} then st_setsrid(st_makepoint(${o.lng}::float8, ${o.lat}::float8), 4326)::geography end,
             case when ${o.trailhead ?? true} then 'osm_trailhead' end,
             g.geom, 1500, 'linear', 'OpenStreetMap', 'ODbL 1.0', ${o.hidden ?? false}, ${tx.json({} as JsonValue)}
        from g
      returning id`,
  );
  return row.id;
}

/** A POI exactly `distanceM` (geodesic) from (lng, lat) at `bearingDeg`. */
async function insertPoi(
  origin: { lng: number; lat: number },
  category: string,
  distanceM: number,
  o: { layer?: "services" | "outdoor"; bearingDeg?: number; name?: string; provider?: string } = {},
): Promise<string> {
  const layer = o.layer ?? (["parking", "toilets", "viewpoint", "trailhead"].includes(category) ? "outdoor" : "services");
  const [row] = await withSystem(
    (tx) => tx<{ id: string }[]>`
      insert into public.catalog_pois (provider, provider_id, layer, category, name, location, tags, opening_hours, phone,
                                       website, source_name, source_license)
      values (${o.provider ?? "osm"}, ${`node/${randomUUID()}`}, ${layer}, ${category}, ${o.name ?? `${category} ${distanceM}`},
              st_project(st_setsrid(st_makepoint(${origin.lng}::float8, ${origin.lat}::float8), 4326)::geography,
                         ${distanceM}::float8, radians(${o.bearingDeg ?? 0}::float8)),
              ${tx.json({} as JsonValue)}, 'Mo-Su 07:00-21:00', '+64 3 000 0000', 'https://example.org/poi', 'OpenStreetMap', 'ODbL 1.0')
      returning id`,
  );
  return row.id;
}

const summary = (r: NearbyResponse) => r.groups.map((g) => [g.label, g.items.map((i) => [i.category, i.distanceM])]);

// ---------------------------------------------------------------------------
describe("getNearbyServices", () => {
  it("groups, limits to 3 per group, orders by distance and respects both radii", async () => {
    const a = newArea();
    const id = await insertTrail(a);
    for (const m of [3000, 500, 2000, 1000]) await insertPoi(a, "fuel", m, { bearingDeg: m / 10 });
    await insertPoi(a, "restaurant", 800, { bearingDeg: 90 });
    await insertPoi(a, "fast_food", 300, { bearingDeg: 180 });
    await insertPoi(a, "restaurant", 5000, { bearingDeg: 270 });
    await insertPoi(a, "fast_food", 6000);
    await insertPoi(a, "cafe", 14_990, { bearingDeg: 45 });
    await insertPoi(a, "cafe", 15_010, { bearingDeg: 45 }); // outside 15 km
    await insertPoi(a, "lodging", 10_000);
    await insertPoi(a, "supermarket", 4000);
    await insertPoi(a, "convenience", 1500);
    await insertPoi(a, "outdoor_shop", 2500);
    await insertPoi(a, "pharmacy", 7000);
    await insertPoi(a, "clinic", 9000);
    await insertPoi(a, "hospital", 12_000);
    await insertPoi(a, "parking", 200);
    await insertPoi(a, "parking", 990, { bearingDeg: 200 });
    await insertPoi(a, "parking", 1010, { bearingDeg: 200 }); // outside 1 km
    await insertPoi(a, "toilets", 50);
    await insertPoi(a, "viewpoint", 100); // outdoor, not a service
    await insertPoi(a, "toilets", 120, { layer: "services" }); // wrong layer: ignored
    await insertPoi(a, "parking", 3000, { layer: "services" }); // wrong layer: ignored

    const r = (await getNearbyServices(id))!;
    expect(r.trailId).toBe(id);
    expect(r.origin).toEqual({ lng: a.lng, lat: a.lat });
    expect(r.radiusM).toBe(15_000);
    expect(summary(r)).toEqual([
      ["Gas", [["fuel", 500], ["fuel", 1000], ["fuel", 2000]]],
      ["Food", [["fast_food", 300], ["restaurant", 800], ["restaurant", 5000]]],
      ["Coffee", [["cafe", 14_990]]],
      ["Lodging", [["lodging", 10_000]]],
      ["Supplies", [["convenience", 1500], ["outdoor_shop", 2500], ["supermarket", 4000]]],
      ["Medical", [["pharmacy", 7000], ["clinic", 9000], ["hospital", 12_000]]],
      ["Parking", [["parking", 200], ["parking", 990]]],
      ["Restrooms", [["toilets", 50]]],
    ]);
    expect(r.groups.map((g) => g.category)).toEqual(["fuel", "restaurant", "cafe", "lodging", "supermarket", "hospital", "parking", "toilets"]);
    expect(r.groups.every((g) => g.items.length <= NEARBY_GROUP_LIMIT)).toBe(true);
    // No EV chargers mapped → no empty group.
    expect(r.groups.some((g) => g.label === "EV charging")).toBe(false);
    expect(r.groups[0].items[0]).toMatchObject({
      name: "fuel 500",
      openingHours: "Mo-Su 07:00-21:00",
      phone: "+64 3 000 0000",
      website: "https://example.org/poi",
      sourceName: "OpenStreetMap",
      elevationM: null,
    });
    expect(r.coverage.state).toBe("ready");
    expect(r.notes).toEqual([
      "Distances are straight-line distances from the trailhead, not driving distances.",
      "Ratings are not available from OpenStreetMap.",
      "Opening hours are as mapped by volunteers — confirm before relying on them.",
    ]);
    expect(r.attribution).toEqual([{ name: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright", license: "ODbL 1.0" }]);
    expect(coverage.ensureCoverage).toHaveBeenCalledWith("services", bboxAround(a, 15_000), { request: true, inlineTiles: 1 });
  });

  it("while services are loading: returns what is stored and says more will appear", async () => {
    const a = newArea();
    const id = await insertTrail(a);
    await insertPoi(a, "fuel", 700);
    coverage.ensureCoverage.mockResolvedValue(coverageOf("loading"));
    const r = (await getNearbyServices(id))!;
    expect(r.coverage).toEqual(coverageOf("loading"));
    expect(r.notes[0]).toBe("Nearby services for this area are still loading. More results will appear shortly.");
    expect(summary(r)).toEqual([["Gas", [["fuel", 700]]]]);
  });

  it.each([
    ["partial", "Some nearby services could not be loaded, so this list may be incomplete."],
    ["failed", "Nearby services could not be loaded right now, so this list may be incomplete."],
    ["too_large", "This area is too large to load at once, so this list may be incomplete."],
  ] as const)("coverage %s is said plainly", async (state, note) => {
    const a = newArea();
    const id = await insertTrail(a);
    coverage.ensureCoverage.mockResolvedValue(coverageOf(state));
    expect((await getNearbyServices(id))!.notes[0]).toBe(note);
  });

  it("a failing coverage service still returns stored results with coverage 'failed'", async () => {
    const a = newArea();
    const id = await insertTrail(a);
    await insertPoi(a, "cafe", 400);
    coverage.ensureCoverage.mockRejectedValue(new Error("ensureCoverage: not implemented"));
    const r = (await getNearbyServices(id))!;
    expect(r.coverage).toEqual(NEARBY_COVERAGE_FAILED);
    expect(summary(r)).toEqual([["Coffee", [["cafe", 400]]]]);
  });

  it("a fully loaded area with nothing mapped says so", async () => {
    const a = newArea();
    const id = await insertTrail(a);
    const r = (await getNearbyServices(id))!;
    expect(r.groups).toEqual([]);
    expect(r.notes[0]).toBe("No services are mapped in OpenStreetMap within 15 km.");
  });

  it("without a trailhead, measures from the trail's centre and says so", async () => {
    const a = newArea();
    const id = await insertTrail({ ...a, trailhead: false });
    const r = (await getNearbyServices(id))!;
    expect(r.origin.lng).toBeCloseTo(a.lng + 0.01, 6);
    expect(r.origin.lat).toBeCloseTo(a.lat, 6);
    expect(r.notes).toContain(
      "Distances are straight-line distances from the middle of the trail (no trailhead is mapped), not driving distances.",
    );
  });

  it("clamps the radius option to 1–25 km", async () => {
    const a = newArea();
    const id = await insertTrail(a);
    await insertPoi(a, "lodging", 20_000);
    expect((await getNearbyServices(id, { radiusM: 100 }))!.radiusM).toBe(1000);
    const wide = (await getNearbyServices(id, { radiusM: 99_000 }))!;
    expect(wide.radiusM).toBe(25_000);
    expect(summary(wide)).toEqual([["Lodging", [["lodging", 20_000]]]]);
    expect((await getNearbyServices(id, { radiusM: Number.NaN }))!.radiusM).toBe(15_000);
  });

  it("credits non-OSM providers too", async () => {
    const a = newArea();
    const id = await insertTrail(a);
    await insertPoi(a, "lodging", 900, { provider: "ridb" });
    const r = (await getNearbyServices(id))!;
    expect(r.attribution.map((x) => x.name)).toEqual(["© OpenStreetMap contributors", "Recreation.gov (RIDB)"]);
  });

  it("returns null for hidden, unknown and malformed ids without asking for coverage", async () => {
    const a = newArea();
    const hidden = await insertTrail({ ...a, hidden: true });
    expect(await getNearbyServices(hidden)).toBeNull();
    expect(await getNearbyServices(randomUUID())).toBeNull();
    expect(await getNearbyServices("nope")).toBeNull();
    expect(coverage.ensureCoverage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("GET /api/trails/:id/nearby", () => {
  const newIp = () => `192.0.2.${Math.floor(Math.random() * 250) + 1}-${randomUUID().slice(0, 6)}`;
  const get = (id: string, ip = newIp()) =>
    GET(new Request(`http://localhost/api/trails/${id}/nearby`, { headers: { "x-real-ip": ip } }), { params: Promise.resolve({ id }) });

  it("404 for malformed, unknown and hidden ids", async () => {
    const a = newArea();
    for (const id of ["bad", randomUUID(), await insertTrail({ ...a, hidden: true })]) {
      const res = await get(id);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Trail not found" });
    }
  });

  it("shared caching only once the area is fully loaded", async () => {
    const a = newArea();
    const id = await insertTrail(a);
    await insertPoi(a, "fuel", 600);
    const ip = newIp();
    const ready = await get(id, ip);
    expect(ready.status).toBe(200);
    expect(ready.headers.get("cache-control")).toBe("public, s-maxage=600, stale-while-revalidate=3600");
    const body = (await ready.json()) as NearbyResponse;
    expect(body.groups[0]).toMatchObject({ category: "fuel", label: "Gas" });
    expect(checkRateLimit).toHaveBeenCalledWith(`trails:nearby:ip:${ip}`, 60, 60);

    coverage.ensureCoverage.mockResolvedValue(coverageOf("loading"));
    const loading = await get(id);
    expect(loading.status).toBe(200);
    expect(loading.headers.get("cache-control")).toBe("no-store");
  });

  it("429 with Retry-After", async () => {
    const a = newArea();
    const id = await insertTrail(a);
    limiter.forceLimited = true;
    const res = await get(id);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(getNearbyServices).not.toHaveBeenCalled();
  });

  it("500 as JSON without internals", async () => {
    const a = newArea();
    const id = await insertTrail(a);
    failure.throwFromService = true;
    const res = await get(id);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Could not load nearby services. Please try again." });
    expect(text).not.toMatch(/catalog_pois|internal/);
  });
});
