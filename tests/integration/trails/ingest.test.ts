/**
 * Tile ingestion against PostGIS with a FAKE provider and injected
 * elevation / admin-name / time-zone functions (no network: fetch is
 * stubbed to throw). Covers derived fields, POIs from neighbouring tiles,
 * in-place refresh with stable slugs, slug collisions (incl. a race),
 * cross-tile way-group merges with aliases, retirement and un-hiding, tile
 * status transitions, the concurrency cap, stale-claim recovery and
 * fencing, time budgets and failure classification.
 *
 * Tiles live around lng 145–160, lat −40 (row iy = 200 of the 0.25° grid);
 * no other test file uses this area.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { offsetMeters } from "@/domain/geo";
import type { Bbox } from "@/domain/catalog";
import { closeDb, sql, withSystem } from "@/server/db";
import { countryCodeAt } from "@/server/geo/country";
import { linesLengthM } from "@/server/geo/geodesy";
import { tileForPoint, tileFromKey, type Tile } from "@/server/geo/tiles";
import { ProviderError } from "@/server/providers/http";
import { ingestTile, ingestTilesNow, type IngestDeps } from "@/server/trails/ingest";
import { parseOverpassResponse } from "@/server/trails/providers/osm/parse";
import { getTrailDetailById } from "@/server/trails/read";
import { SLUG_RE } from "@/server/trails/slug";
import * as repo from "@/server/trails/repository";
import type { Line, NormalizedPoi, NormalizedTrail, ProviderAreaResult, TrailDataProvider } from "@/server/trails/types";

beforeAll(() => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("network access is disabled in tests");
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await closeDb();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IY = 200;
let nextIx = 1300;
/** `n` fresh, adjacent (west → east) outdoor tiles. */
function freshTiles(n = 1): Tile[] {
  const out: Tile[] = [];
  for (let i = 0; i < n; i++) out.push(tileFromKey("outdoor", `0.25/${nextIx + i}/${IY}`)!);
  nextIx += n + 1;
  return out;
}

const r7 = (n: number) => Math.round(n * 1e7) / 1e7;
/** [lng, lat] at metres east/north of a reference point. */
function pos(ref: { lng: number; lat: number }, east: number, north = 0): [number, number] {
  const p = offsetMeters(ref, east, north);
  return [r7(p.lng), r7(p.lat)];
}
const center = (t: Tile) => ({ lng: (t.bbox[0] + t.bbox[2]) / 2, lat: (t.bbox[1] + t.bbox[3]) / 2 });
/** Midpoint of a tile's east edge (shared with the next tile). */
const eastEdge = (t: Tile) => ({ lng: t.bbox[2], lat: (t.bbox[1] + t.bbox[3]) / 2 });

function trail(providerId: string, name: string, lines: Line[], over: Partial<NormalizedTrail> = {}): NormalizedTrail {
  return {
    provider: "osm",
    providerId,
    name,
    nameEn: null,
    lines,
    routeType: "linear",
    sacScale: null,
    trailVisibility: null,
    surfaces: [],
    activities: ["hiking"],
    description: null,
    dogPolicy: "unknown",
    wheelchair: "unknown",
    feeRequired: null,
    permitRequired: null,
    access: null,
    seasonality: null,
    operator: null,
    website: null,
    tags: { route: "hiking" },
    sourceName: "OpenStreetMap contributors",
    sourceUrl: `https://www.openstreetmap.org/${providerId.replace("waygroup", "way")}`,
    sourceLicense: "ODbL 1.0",
    sourceUpdatedAt: new Date("2026-11-10T12:00:00Z"),
    ...over,
  };
}

function poi(providerId: string, category: NormalizedPoi["category"], at: [number, number], layer: NormalizedPoi["layer"] = "outdoor"): NormalizedPoi {
  return {
    provider: "osm",
    providerId,
    layer,
    category,
    name: null,
    nameEn: null,
    lng: at[0],
    lat: at[1],
    elevationM: null,
    tags: {},
    openingHours: null,
    phone: null,
    website: null,
    sourceName: "OpenStreetMap contributors",
    sourceUrl: null,
    sourceLicense: "ODbL 1.0",
  };
}

const area = (trails: NormalizedTrail[], pois: NormalizedPoi[] = []): ProviderAreaResult => ({ trails, pois, dataTimestamp: new Date() });

type Responder = (layer: string, bbox: Bbox, opts?: { signal?: AbortSignal }) => ProviderAreaResult | Promise<ProviderAreaResult>;

function fakeProvider(respond: Responder): TrailDataProvider & { calls: Bbox[] } {
  const calls: Bbox[] = [];
  return {
    id: "osm",
    label: "OpenStreetMap",
    homepage: "https://www.openstreetmap.org",
    license: "ODbL 1.0",
    attribution: "© OpenStreetMap contributors",
    layers: ["outdoor", "services"],
    isEnabled: () => true,
    covers: () => true,
    calls,
    async fetchArea(layer, bbox, opts) {
      calls.push(bbox);
      return respond(layer, bbox, opts);
    },
  };
}

interface TestDeps extends IngestDeps {
  elevationCalls: Line[][];
}

const ADMIN = { countryCode: "nz", regionName: "Canterbury", nearestPlace: "Arthur's Pass" };

/** Fake DEM: climbs 60 m over the route (an "estimate"). */
function deps(respond: Responder | ProviderAreaResult, over: Partial<IngestDeps> = {}): TestDeps {
  const elevationCalls: Line[][] = [];
  const responder: Responder = typeof respond === "function" ? respond : () => respond;
  return {
    provider: fakeProvider(responder),
    elevation: async (lines) => {
      elevationCalls.push(lines);
      const len = Math.max(1, Math.round(linesLengthM(lines)));
      return { profile: [[0, 100], [len, 160]], gainM: 60, lossM: 0, maxM: 160, minM: 100, source: "Test DEM (estimate)" };
    },
    reverseAdmin: async () => ADMIN,
    // The test tiles lie at sea off Australia; pretend they are in New Zealand like ADMIN
    // (the country comes from the exact point, and names must agree with it).
    countryAt: () => "nz",
    timezone: () => "Pacific/Auckland",
    now: () => new Date("2026-11-12T10:00:00Z"),
    concurrencyCap: 1000,
    ttlDays: 30,
    elevationCalls,
    ...over,
  };
}

async function ingest(tile: Tile, d: IngestDeps) {
  return ingestTile("outdoor", "osm", tile.key, d);
}

async function makeDue(tile: Tile, layer = "outdoor") {
  await sql()`update public.catalog_tiles set next_refresh_at = now() - interval '1 second'
               where layer = ${layer} and provider = 'osm' and tile_key = ${tile.key}`;
}

interface TrailRow {
  id: string;
  providerId: string;
  aliasIds: string[];
  name: string;
  slug: string;
  countryCode: string;
  regionSlug: string;
  regionName: string | null;
  nearestPlace: string | null;
  timezone: string | null;
  distanceM: number;
  routeType: string;
  trailheadSource: string | null;
  trailheadLng: number | null;
  trailheadLat: number | null;
  hasParking: boolean;
  hasToilets: boolean;
  hasDrinkingWater: boolean;
  hasCamping: boolean;
  features: string[];
  elevationGainM: number | null;
  elevationSource: string | null;
  elevationProfile: unknown;
  estimatedDurationMin: number | null;
  difficulty: string;
  difficultySource: string | null;
  familyFriendly: boolean;
  qualityScore: number;
  hidden: boolean;
  hiddenReason: string | null;
  retiredAt: Date | null;
  lastSyncedAt: Date;
  geomHash: string | null;
  sourceUrl: string | null;
}

async function trailByProviderId(providerId: string): Promise<TrailRow | undefined> {
  const [row] = await sql()<TrailRow[]>`
    select t.*, st_x(t.trailhead::geometry) as trailhead_lng, st_y(t.trailhead::geometry) as trailhead_lat
      from public.catalog_trails t where t.provider = 'osm' and t.provider_id = ${providerId}`;
  return row;
}

async function trailsNamed(name: string): Promise<TrailRow[]> {
  return sql()<TrailRow[]>`
    select t.*, null as trailhead_lng, null as trailhead_lat from public.catalog_trails t
     where t.provider = 'osm' and t.name = ${name} order by t.created_at, t.id`;
}

async function tileRow(tile: Tile, layer = "outdoor") {
  const [row] = await sql()<
    {
      status: string;
      attempts: number;
      lastError: string | null;
      trailCount: number;
      poiCount: number;
      lastSyncedAt: Date | null;
      nextRefreshAt: Date | null;
      refreshInDays: number | null;
      retryInMinutes: number | null;
    }[]
  >`
    select status, attempts, last_error, trail_count, poi_count, last_synced_at, next_refresh_at,
           extract(epoch from (next_refresh_at - now())) / 86400 as refresh_in_days,
           extract(epoch from (next_refresh_at - now())) / 60 as retry_in_minutes
      from public.catalog_tiles where layer = ${layer} and provider = 'osm' and tile_key = ${tile.key}`;
  return row;
}

let seq = 1_000_000;
const id = (kind: "relation" | "waygroup" | "node" | "way") => `${kind}/${seq++}`;

/** Linear trail of `lengthM` metres eastwards from (east0, north) relative to the tile centre. */
const eastLine = (tile: Tile, east0: number, lengthM: number, north = 0): Line => {
  const c = center(tile);
  const pts: [number, number][] = [];
  for (let x = 0; x <= lengthM; x += 250) pts.push(pos(c, east0 + x, north));
  if ((lengthM / 250) % 1 !== 0) pts.push(pos(c, east0 + lengthM, north));
  return pts;
};

beforeEach(() => {
  seq += 1000;
});

// ---------------------------------------------------------------------------
describe("ingestTile: creating trails and POIs", () => {
  it("stores trails with derived fields and the tile's POIs, and marks the tile ready", async () => {
    const [tile] = freshTiles();
    const c = center(tile);
    const route = [eastLine(tile, 0, 2000)];
    const rid = id("relation");
    const d = deps(
      area(
        [trail(rid, "Arthur's Pass Ridge Track", route, { sacScale: "mountain_hiking", surfaces: ["gravel"], website: "https://example.org/track" })],
        [
          poi(id("node"), "trailhead", pos(c, -40, 10)),
          poi(id("way"), "parking", pos(c, -120, 30)),
          poi(id("node"), "toilets", pos(c, -90, 60)),
          poi(id("node"), "waterfall", pos(c, 1200, 150)),
          poi(id("node"), "drinking_water", pos(c, 700, -50)),
          poi(id("node"), "campsite", pos(c, 1900, 450)),
          poi(id("node"), "peak", pos(c, 1000, 900)), // too far for a feature
        ],
      ),
    );
    const r = await ingest(tile, d);
    expect(r).toMatchObject({ outcome: "done", trails: 1, inserted: 1, pois: 7, retired: 0 });

    const t = (await trailByProviderId(rid))!;
    expect(t.name).toBe("Arthur's Pass Ridge Track");
    expect(t.slug).toBe("arthurs-pass-ridge-track");
    expect(t.countryCode).toBe("nz");
    expect(t.regionSlug).toBe("canterbury");
    expect(t.regionName).toBe("Canterbury");
    expect(t.nearestPlace).toBe("Arthur's Pass");
    expect(t.timezone).toBe("Pacific/Auckland");
    expect(t.distanceM).toBeGreaterThan(1990);
    expect(t.distanceM).toBeLessThan(2010);
    expect(t.routeType).toBe("linear");
    expect(t.trailheadSource).toBe("osm_trailhead");
    expect(t.trailheadLng).toBeCloseTo(pos(c, -40, 10)[0], 6);
    expect(t.hasParking).toBe(true);
    expect(t.hasToilets).toBe(true);
    expect(t.hasDrinkingWater).toBe(true);
    expect(t.hasCamping).toBe(true);
    expect(t.features).toEqual(["waterfall"]);
    expect(t.elevationGainM).toBe(60);
    expect(t.elevationSource).toBe("Test DEM (estimate)");
    expect(t.estimatedDurationMin).toBeGreaterThan(0);
    expect(t.difficulty).toBe("moderate");
    expect(t.difficultySource).toBe("osm_sac_scale");
    expect(t.qualityScore).toBeGreaterThan(50);
    expect(t.hidden).toBe(false);
    expect(t.geomHash).toMatch(/^[0-9a-f]{32}$/);

    const tr = (await tileRow(tile))!;
    expect(tr).toMatchObject({ status: "ready", attempts: 0, lastError: null, trailCount: 1, poiCount: 7 });
    expect(tr.refreshInDays).toBeGreaterThan(26.9);
    expect(tr.refreshInDays).toBeLessThan(33.1);

    // Public read model sees it (RLS) with its POIs.
    const detail = await getTrailDetailById(t.id);
    expect(detail?.path).toBe("/trail/nz/canterbury/arthurs-pass-ridge-track");
    expect(detail?.pois.map((p) => p.category)).toContain("trailhead");
  });

  it("uses POIs already stored from a neighbouring tile and the same response", async () => {
    const [west, tile] = freshTiles(2);
    const edge = eastEdge(west);
    // The trail starts 30 m inside `tile`; its trailhead POI lies 40 m inside `west`.
    const route = [[pos(edge, 30), pos(edge, 800), pos(edge, 1600)]];
    await withSystem((tx) => repo.upsertPois(tx, [poi("node/neighbour-th-1", "trailhead", pos(edge, -40, 5))]));
    const rid = id("relation");
    const r = await ingest(tile, deps(area([trail(rid, "Neighbour Track", route)], [poi(id("node"), "viewpoint", pos(edge, 900, 100))])));
    expect(r.outcome).toBe("done");
    const t = (await trailByProviderId(rid))!;
    expect(t.trailheadSource).toBe("osm_trailhead");
    expect(t.trailheadLng).toBeCloseTo(pos(edge, -40, 5)[0], 6);
    expect(t.features).toEqual(["viewpoint"]);
  });

  it("stores unknown admin names as xx/unknown and nothing invented when elevation is unavailable", async () => {
    const [tile] = freshTiles();
    const rid = id("relation");
    const r = await ingest(
      tile,
      deps(area([trail(rid, "Quiet Path", [eastLine(tile, 0, 1500)])]), { reverseAdmin: async () => null, countryAt: () => null, elevation: async () => null, timezone: () => null }),
    );
    expect(r.outcome).toBe("done");
    const t = (await trailByProviderId(rid))!;
    expect(t.countryCode).toBe("xx");
    expect(t.regionSlug).toBe("unknown");
    expect(t.nearestPlace).toBeNull();
    expect(t.timezone).toBeNull();
    expect(t.elevationGainM).toBeNull();
    expect(t.elevationSource).toBeNull();
    expect(t.elevationProfile).toBeNull();
    expect(t.familyFriendly).toBe(false);
    expect(t.trailheadSource).toBe("route_start");
    // No climb data and no SAC grade: the rating would rest on the missing climb, so it is
    // unknown rather than a distance-only guess labelled "estimated from distance and climb".
    expect(t.difficulty).toBe("unknown");
    expect(t.difficultySource).toBeNull();
  });

  it("skips trails without usable geometry and handles a services tile as POIs only", async () => {
    const [tile] = freshTiles();
    const c = center(tile);
    const bad = trail(id("relation"), "Broken", [[pos(c, 0), pos(c, 0)]]);
    const ok = trail(id("relation"), "Fine Track", [eastLine(tile, 0, 1000)]);
    const r = await ingest(tile, deps(area([bad, ok])));
    expect(r).toMatchObject({ outcome: "done", trails: 1, skipped: 1 });
    expect(await trailByProviderId(bad.providerId)).toBeUndefined();

    const services = await ingestTile("services", "osm", tile.key, deps(area([trail(id("relation"), "Ignored", [eastLine(tile, 0, 1000)])], [poi(id("node"), "fuel", pos(c, 10, 10), "services")])));
    expect(services).toMatchObject({ outcome: "done", trails: 0, pois: 1 });
    expect((await tileRow(tile, "services"))!.status).toBe("ready");
    expect(await trailsNamed("Ignored")).toHaveLength(0);
  });

  it("skips POIs with an invalid category or position instead of failing the batch", async () => {
    const [tile] = freshTiles();
    const c = center(tile);
    const ok = poi(id("node"), "parking", pos(c, 10, 10));
    const wrongLayer = poi(id("node"), "fuel", pos(c, 20, 20)); // a services category on the outdoor layer
    const bogus = { ...poi(id("node"), "toilets", pos(c, 30, 30)), category: "volcano" } as unknown as NormalizedPoi;
    const offWorld = poi(id("node"), "toilets", [200, 95]);
    const r = await ingest(tile, deps(area([], [ok, wrongLayer, bogus, offWorld])));
    expect(r).toMatchObject({ outcome: "done", pois: 1 });
    const rows = await sql()<{ providerId: string }[]>`
      select provider_id from public.catalog_pois where provider_id in (${ok.providerId}, ${wrongLayer.providerId}, ${bogus.providerId}, ${offWorld.providerId})`;
    expect(rows.map((x) => x.providerId)).toEqual([ok.providerId]);
  });

  it("skips invalid tiles and unknown providers without touching anything", async () => {
    expect(await ingestTile("outdoor", "osm", "0.5/1/1", deps(area([])))).toMatchObject({ outcome: "noop", reason: "invalid_tile" });
    expect(await ingestTile("outdoor", "osm", "nonsense", deps(area([])))).toMatchObject({ outcome: "noop", reason: "invalid_tile" });
    const [tile] = freshTiles();
    expect(await ingestTile("outdoor", "ridb", tile.key, {})).toMatchObject({ outcome: "noop", reason: "provider_unavailable" });
    expect(await tileRow(tile)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("ingestTile: refresh", () => {
  it("updates in place, keeps id, slug and known region, and reuses elevation for unchanged geometry", async () => {
    const [tile] = freshTiles();
    const rid = id("relation");
    const d1 = deps(area([trail(rid, "Original Name Track", [eastLine(tile, 0, 1500)])]));
    await ingest(tile, d1);
    const before = (await trailByProviderId(rid))!;
    expect(before.slug).toBe("original-name-track");
    expect(d1.elevationCalls).toHaveLength(1);

    // Renamed, longer, and reverse geocoding now says something else: identity stays.
    await makeDue(tile);
    const d2 = deps(area([trail(rid, "Renamed Track", [eastLine(tile, 0, 2500)])]), {
      reverseAdmin: async () => ({ countryCode: "au", regionName: "Tasmania", nearestPlace: "Hobart" }),
    });
    expect(await ingest(tile, d2)).toMatchObject({ outcome: "done", updated: 1, inserted: 0 });
    const after = (await trailByProviderId(rid))!;
    expect(after.id).toBe(before.id);
    expect(after.slug).toBe("original-name-track");
    expect(after.countryCode).toBe("nz");
    expect(after.regionSlug).toBe("canterbury");
    // The cell's names belong to another country than the trail's exact point: dropped, never mixed in.
    expect(after.nearestPlace).toBe("Arthur's Pass");
    expect(after.name).toBe("Renamed Track");
    expect(after.distanceM).toBeGreaterThan(2490);
    expect(after.lastSyncedAt.getTime()).toBeGreaterThan(before.lastSyncedAt.getTime());
    expect(d2.elevationCalls).toHaveLength(1); // geometry changed → re-sampled

    // Same geometry, terrain service down: the stored profile is reused, not dropped.
    await makeDue(tile);
    const d3 = deps(area([trail(rid, "Renamed Track", [eastLine(tile, 0, 2500)])]), { elevation: async () => null });
    await ingest(tile, d3);
    const kept = (await trailByProviderId(rid))!;
    expect(kept.elevationGainM).toBe(60);
    expect(kept.elevationSource).toBe("Test DEM (estimate)");
    expect(kept.nearestPlace).toBe("Arthur's Pass"); // known values only overwrite
  });

  it("moves a trail out of the unknown region once admin names become available, then keeps it", async () => {
    const [tile] = freshTiles();
    const rid = id("relation");
    await ingest(tile, deps(area([trail(rid, "Late Region Walk", [eastLine(tile, 0, 1200)])]), { reverseAdmin: async () => null }));
    // The country is known from the exact point even while reverse geocoding is unavailable.
    expect(await trailByProviderId(rid)).toMatchObject({ countryCode: "nz", regionSlug: "unknown", slug: "late-region-walk" });

    await makeDue(tile);
    await ingest(tile, deps(area([trail(rid, "Late Region Walk", [eastLine(tile, 0, 1200)])])));
    expect(await trailByProviderId(rid)).toMatchObject({ countryCode: "nz", regionSlug: "canterbury", slug: "late-region-walk" });

    await makeDue(tile);
    await ingest(tile, deps(area([trail(rid, "Late Region Walk", [eastLine(tile, 0, 1200)])]), { reverseAdmin: async () => ({ countryCode: "au", regionName: "Victoria", nearestPlace: null }) }));
    expect(await trailByProviderId(rid)).toMatchObject({ countryCode: "nz", regionSlug: "canterbury" });
  });

  it("retries with the next suffix when a concurrent writer takes the slug first", async () => {
    const [tile] = freshTiles();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    // A competing transaction inserts the slug and keeps it uncommitted.
    const competitor = sql().begin(async (tx) => {
      await tx`
        insert into public.catalog_trails (provider, provider_id, name, slug, country_code, region_slug, centroid, geom, distance_m, source_name, source_license)
        values ('osm', ${id("relation")}, 'Contested Pass Track', 'contested-pass-track', 'nz', 'canterbury',
                st_setsrid(st_makepoint(170, -43), 4326)::geography,
                st_multi(st_setsrid(st_makeline(st_makepoint(170, -43), st_makepoint(170.01, -43)), 4326)), 800, 'test', 'test')`;
      held();
      await gate;
    });
    await holding;
    const rid = id("relation");
    const run = ingest(tile, deps(area([trail(rid, "Contested Pass Track", [eastLine(tile, 0, 1000)])])));
    // Wait until the ingest's insert is blocked on the competitor's uncommitted row, then commit it.
    let blocked = false;
    for (let i = 0; i < 100 && !blocked; i++) {
      const [w] = await sql()<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where wait_event_type = 'Lock' and query ilike '%insert into public.catalog_trails%'`;
      blocked = w.n > 0;
      if (!blocked) await new Promise((r) => setTimeout(r, 25));
    }
    expect(blocked).toBe(true);
    release();
    await competitor;
    expect(await run).toMatchObject({ outcome: "done", inserted: 1, failedTrails: 0 });
    expect((await trailByProviderId(rid))!.slug).toBe("contested-pass-track-2");
  });

  it("gives same-named trails in one region -2, -3 suffixes, also when two tiles race", async () => {
    const [tile] = freshTiles();
    const ids = [id("relation"), id("relation"), id("relation")];
    await ingest(tile, deps(area(ids.map((rid, i) => trail(rid, "Collision Creek Track", [eastLine(tile, 0, 1000 + i * 300, i * 400)])))));
    const slugs = (await Promise.all(ids.map(trailByProviderId))).map((t) => t!.slug).sort();
    expect(slugs).toEqual(["collision-creek-track", "collision-creek-track-2", "collision-creek-track-3"]);

    // Two tiles ingested concurrently, each with several same-named trails in the same region.
    const [a, b] = freshTiles(2);
    const make = (tile: Tile) => [0, 1, 2].map((i) => trail(id("relation"), "Race Ridge Track", [eastLine(tile, -2000, 1000, i * 500 - 1000)]));
    const ta = make(a);
    const tb = make(b);
    const [ra, rb] = await Promise.all([ingest(a, deps(area(ta))), ingest(b, deps(area(tb)))]);
    expect(ra).toMatchObject({ outcome: "done", inserted: 3, failedTrails: 0 });
    expect(rb).toMatchObject({ outcome: "done", inserted: 3, failedTrails: 0 });
    const raced = (await trailsNamed("Race Ridge Track")).map((t) => t.slug).sort();
    expect(new Set(raced).size).toBe(6);
    expect(raced[0]).toBe("race-ridge-track");
  });
});

// ---------------------------------------------------------------------------
describe("ingestTile: cross-tile way groups", () => {
  /** A 3 km trail centred on the A|B edge: A sees ways w1+w2, B sees w2+w3 (w2 straddles). */
  function straddle(a: Tile) {
    const e = eastEdge(a);
    return {
      west: [[pos(e, -1500), pos(e, -900), pos(e, -300), pos(e, 300)]] as Line[],
      east: [[pos(e, -300), pos(e, 300), pos(e, 900), pos(e, 1500)]] as Line[],
      edge: e,
    };
  }

  it("merges the pieces into the existing row, records the alias, and refreshes either tile in place", async () => {
    const [a, b] = freshTiles(2);
    const s = straddle(a);
    const idA = id("waygroup");
    const idB = id("waygroup");
    await ingest(a, deps(area([trail(idA, "Ridge Walk", s.west, { sacScale: "hiking" })])));
    const first = (await trailByProviderId(idA))!;
    expect(first.distanceM).toBeGreaterThan(1790);
    expect(first.distanceM).toBeLessThan(1810);

    const dB = deps(area([trail(idB, "Ridge  walk", s.east, { sacScale: "demanding_mountain_hiking" })]));
    expect(await ingest(b, dB)).toMatchObject({ outcome: "done", merged: 1, inserted: 0 });
    const rows = (await sql()<TrailRow[]>`select * from public.catalog_trails where provider = 'osm' and (provider_id = ${idA} or provider_id = ${idB})`);
    expect(rows).toHaveLength(1);
    const merged = rows[0];
    expect(merged.id).toBe(first.id);
    expect(merged.slug).toBe(first.slug);
    expect(merged.aliasIds).toEqual([idB]);
    expect(merged.distanceM).toBeGreaterThan(2990); // the straddling way is counted once
    expect(merged.distanceM).toBeLessThan(3010);
    expect(merged.routeType).toBe("linear");
    expect(merged.difficulty).toBe("hard"); // hardest SAC grade of the pieces
    expect(dB.elevationCalls).toHaveLength(1);
    expect(linesLengthM(dB.elevationCalls[0])).toBeGreaterThan(2990); // DEM sampled on the merged geometry

    // Refreshing B finds the row by alias; refreshing A by provider id. Still one row, full geometry.
    await makeDue(b);
    expect(await ingest(b, deps(area([trail(idB, "Ridge Walk", s.east)])))).toMatchObject({ updated: 1, merged: 0, inserted: 0 });
    await makeDue(a);
    expect(await ingest(a, deps(area([trail(idA, "Ridge Walk", s.west)])))).toMatchObject({ updated: 1, inserted: 0 });
    const after = await trailsNamed("Ridge Walk");
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(first.id);
    expect(after[0].distanceM).toBeGreaterThan(2990);
    expect(after[0].distanceM).toBeLessThan(3010);
    const parts = await sql()<{ partId: string; tileKey: string }[]>`
      select part_id, tile_key from public.catalog_trail_parts where trail_id = ${first.id} order by tile_key`;
    expect(parts).toEqual([
      { partId: idA, tileKey: a.key },
      { partId: idB, tileKey: b.key },
    ].sort((x, y) => (x.tileKey < y.tileKey ? -1 : 1)));
  });

  it("joins pieces that arrive under the SAME way-group id from both tiles", async () => {
    const [a, b] = freshTiles(2);
    const s = straddle(a);
    const shared = id("waygroup");
    await ingest(a, deps(area([trail(shared, "Saddle Link", s.west)])));
    await ingest(b, deps(area([trail(shared, "Saddle Link", s.east)])));
    const rows = await trailsNamed("Saddle Link");
    expect(rows).toHaveLength(1);
    expect(rows[0].aliasIds).toEqual([]);
    expect(rows[0].distanceM).toBeGreaterThan(2990);
    expect(rows[0].distanceM).toBeLessThan(3010);
  });

  it("does not merge different names, distant pieces, or same-named pieces the tile kept apart", async () => {
    const [a, b] = freshTiles(2);
    const s = straddle(a);
    await ingest(a, deps(area([trail(id("waygroup"), "Pine Walk", s.west)])));
    // Different name on the very same ways.
    await ingest(b, deps(area([trail(id("waygroup"), "Cedar Walk", s.east)])));
    expect(await trailsNamed("Cedar Walk")).toHaveLength(1);
    expect((await trailsNamed("Pine Walk"))[0].aliasIds).toEqual([]);

    // Same name 60 m away (parallel): not the same trail.
    const [c, d] = freshTiles(2);
    const s2 = straddle(c);
    await ingest(c, deps(area([trail(id("waygroup"), "Parallel Walk", s2.west)])));
    const shifted = [[pos(s2.edge, -300, 60), pos(s2.edge, 300, 60), pos(s2.edge, 1500, 60)]];
    await ingest(d, deps(area([trail(id("waygroup"), "Parallel Walk", shifted)])));
    expect(await trailsNamed("Parallel Walk")).toHaveLength(2);

    // Two same-named pieces 22 m apart inside ONE tile stay separate.
    const [t] = freshTiles();
    const cc = center(t);
    await ingest(t, deps(area([
      trail(id("waygroup"), "Gap Creek Path", [[pos(cc, 0), pos(cc, 1000)]]),
      trail(id("waygroup"), "Gap Creek Path", [[pos(cc, 1022), pos(cc, 2000)]]),
    ])));
    expect(await trailsNamed("Gap Creek Path")).toHaveLength(2);
  });

  it("keeps a merged trail when one tile loses its piece, and makes the other tile due to rebuild it", async () => {
    const [a, b] = freshTiles(2);
    const s = straddle(a);
    const idA = id("waygroup");
    const idB = id("waygroup");
    await ingest(a, deps(area([trail(idA, "Fading Walk", s.west)])));
    await ingest(b, deps(area([trail(idB, "Fading Walk", s.east)])));
    const [row] = await trailsNamed("Fading Walk");

    await makeDue(a);
    expect(await ingest(a, deps(area([])))).toMatchObject({ outcome: "done", retired: 0 });
    const still = (await trailsNamed("Fading Walk"))[0];
    expect(still.hidden).toBe(false);
    const bTile = (await tileRow(b))!;
    expect(bTile.nextRefreshAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // B's refresh rebuilds the trail from what remains (B's piece only).
    expect(await ingest(b, deps(area([trail(idB, "Fading Walk", s.east)])))).toMatchObject({ updated: 1 });
    const rebuilt = (await trailsNamed("Fading Walk"))[0];
    expect(rebuilt.id).toBe(row.id);
    expect(rebuilt.distanceM).toBeGreaterThan(1790);
    expect(rebuilt.distanceM).toBeLessThan(1810);

    // B loses it too: no part left anywhere → retired.
    await makeDue(b);
    expect(await ingest(b, deps(area([])))).toMatchObject({ retired: 1 });
    expect((await trailsNamed("Fading Walk"))[0]).toMatchObject({ hidden: true });
  });
});

// ---------------------------------------------------------------------------
describe("ingestTile: retirement", () => {
  it("hides trails the source no longer has, un-hides them when they return, and never touches moderated trails", async () => {
    const [tile] = freshTiles();
    const c = center(tile);
    const rel = trail(id("relation"), "Coming And Going Track", [eastLine(tile, 0, 1500)]);
    const wg = trail(id("waygroup"), "Coming And Going Path", [eastLine(tile, -3000, 1500, 500)]);
    const moderated = trail(id("relation"), "Moderated Track", [eastLine(tile, 0, 1500, -800)]);
    const gonePoi = poi(id("node"), "toilets", pos(c, 50, 50));
    const keptPoi = poi(id("node"), "parking", pos(c, -50, 50));
    await ingest(tile, deps(area([rel, wg, moderated], [gonePoi, keptPoi])));
    const relRow = (await trailByProviderId(rel.providerId))!;
    await sql()`update public.catalog_trails set hidden = true, hidden_reason = 'Reported: private land' where provider_id = ${moderated.providerId}`;

    // The relation and the moderated trail vanish; the way group and one POI stay.
    await makeDue(tile);
    expect(await ingest(tile, deps(area([wg], [keptPoi])))).toMatchObject({ outcome: "done", retired: 1, poisRemoved: 1 });
    expect(await trailByProviderId(rel.providerId)).toMatchObject({ hidden: true, hiddenReason: "Not found in OpenStreetMap on 2026-11-12" });
    expect((await trailByProviderId(rel.providerId))!.retiredAt).not.toBeNull();
    expect(await trailByProviderId(wg.providerId)).toMatchObject({ hidden: false });
    expect(await trailByProviderId(moderated.providerId)).toMatchObject({ hidden: true, hiddenReason: "Reported: private land", retiredAt: null });
    expect(await getTrailDetailById(relRow.id)).toBeNull();
    const pois = await sql()<{ providerId: string }[]>`select provider_id from public.catalog_pois where provider_id in (${gonePoi.providerId}, ${keptPoi.providerId})`;
    expect(pois.map((p) => p.providerId)).toEqual([keptPoi.providerId]);

    // Now the way group disappears too (no part left) and both others come back.
    await makeDue(tile);
    expect(await ingest(tile, deps(area([rel, moderated])))).toMatchObject({ retired: 1 });
    expect(await trailByProviderId(wg.providerId)).toMatchObject({ hidden: true });
    const back = (await trailByProviderId(rel.providerId))!;
    expect(back).toMatchObject({ hidden: false, hiddenReason: null, retiredAt: null, id: relRow.id, slug: relRow.slug });
    expect(await trailByProviderId(moderated.providerId)).toMatchObject({ hidden: true, hiddenReason: "Reported: private land" });
  });

  it("does not retire a trail owned by another tile (its first vertex lies elsewhere)", async () => {
    const [west, tile] = freshTiles(2);
    const e = eastEdge(west);
    const crossing = trail(id("relation"), "Border Crossing Track", [[pos(e, -800), pos(e, -100), pos(e, 1500), pos(e, 3000)]]);
    await ingest(tile, deps(area([crossing])));
    await makeDue(tile);
    expect(await ingest(tile, deps(area([])))).toMatchObject({ retired: 0 });
    expect(await trailByProviderId(crossing.providerId)).toMatchObject({ hidden: false });
  });

  it("retires nothing after a failed, capped or partially failed sync", async () => {
    const [tile] = freshTiles();
    const a = trail(id("relation"), "Survivor One", [eastLine(tile, 0, 1200)]);
    const b = trail(id("relation"), "Survivor Two", [eastLine(tile, 0, 1200, 600)]);
    await ingest(tile, deps(area([a, b])));

    await makeDue(tile);
    const failed = await ingest(tile, deps(() => {
      throw new ProviderError("overpass", "HTTP 504", 504, true);
    }));
    expect(failed).toMatchObject({ outcome: "failed", retryable: true });
    // A tile that already held data stays ready (its data is still served) with the error recorded.
    expect(await tileRow(tile)).toMatchObject({ status: "ready", attempts: 1 });
    expect((await tileRow(tile))!.lastError).toMatch(/504/);

    await makeDue(tile);
    expect(await ingest(tile, deps(area([a, b]), { maxTrails: 1 }))).toMatchObject({ outcome: "done", trails: 1, capped: { trails: true, pois: false }, retired: 0 });

    // A trail that cannot be stored (NUL byte rejected by Postgres): the rest is saved, nothing retired.
    await makeDue(tile);
    const broken = trail(id("relation"), "Broken\u0000Name", [eastLine(tile, 0, 1200, 900)]);
    const partial = await ingest(tile, deps(area([a, broken])));
    expect(partial).toMatchObject({ outcome: "done", trails: 1, failedTrails: 1, retired: 0 });
    expect((await tileRow(tile))!.lastError).toMatch(/1 of 2 trail\(s\) could not be saved/);
    expect(await trailByProviderId(b.providerId)).toMatchObject({ hidden: false });
  });
});

// ---------------------------------------------------------------------------
describe("tile status, backoff and concurrency", () => {
  beforeEach(async () => {
    // Nothing else may hold OSM fetch slots during these tests.
    await sql()`update public.catalog_tiles set status = 'failed' where provider = 'osm' and status = 'fetching'`;
  });

  it("marks failures with growing backoff and recovers on success", async () => {
    const [tile] = freshTiles();
    const boom = deps(() => {
      throw new ProviderError("overpass", "HTTP 429", 429, true);
    });
    const r1 = await ingest(tile, boom);
    expect(r1).toMatchObject({ outcome: "failed", retryable: true, attempts: 1 });
    let row = (await tileRow(tile))!;
    expect(row.status).toBe("failed");
    expect(row.lastError).toMatch(/OpenStreetMap Overpass API: HTTP 429/);
    expect(row.retryInMinutes).toBeGreaterThan(4.9);
    expect(row.retryInMinutes).toBeLessThan(5.1);

    // Failed tiles are claimable before their backoff (the job queue's quick retries). A failure
    // inside the backoff window records the error but does not escalate the backoff.
    expect(await ingest(tile, boom)).toMatchObject({ attempts: 1 });
    row = (await tileRow(tile))!;
    expect(row.retryInMinutes).toBeGreaterThan(4.8);
    expect(row.retryInMinutes).toBeLessThan(5.1);

    // Once the backoff has run out, the next failure escalates it.
    await sql()`update public.catalog_tiles set next_refresh_at = now() - interval '1 second' where tile_key = ${tile.key} and layer = 'outdoor'`;
    expect(await ingest(tile, boom)).toMatchObject({ attempts: 2 });
    row = (await tileRow(tile))!;
    expect(row.retryInMinutes).toBeGreaterThan(9.9);
    expect(row.retryInMinutes).toBeLessThan(10.1);

    await sql()`update public.catalog_tiles set attempts = 12, next_refresh_at = now() - interval '1 second' where tile_key = ${tile.key} and layer = 'outdoor'`;
    await ingest(tile, boom);
    row = (await tileRow(tile))!;
    expect(row.attempts).toBe(13);
    expect(row.retryInMinutes).toBeGreaterThan(359.9);
    expect(row.retryInMinutes).toBeLessThan(360.1);

    const ok = await ingest(tile, deps(area([trail(id("relation"), "Recovered Track", [eastLine(tile, 0, 1000)])])));
    expect(ok.outcome).toBe("done");
    expect(await tileRow(tile)).toMatchObject({ status: "ready", attempts: 0, lastError: null, trailCount: 1 });
    // Ready and not due: nothing to do.
    expect(await ingest(tile, deps(area([])))).toMatchObject({ outcome: "noop", reason: "not_due" });
  });

  it("classifies a rejected request as not retryable", async () => {
    const [tile] = freshTiles();
    const r = await ingest(tile, deps(() => {
      throw new ProviderError("overpass", "HTTP 400", 400, false);
    }));
    expect(r).toMatchObject({ outcome: "failed", retryable: false });
  });

  it("allows two concurrent OSM fetches and refuses a third (atomic claim)", async () => {
    const tiles = freshTiles(3);
    const results = await Promise.all(tiles.map((t) => repo.claimTile("outdoor", "osm", t, 2)));
    expect(results.filter((r) => r.status === "claimed")).toHaveLength(2);
    expect(results.filter((r) => r.status === "busy")).toHaveLength(1);
    const busyTile = tiles[results.findIndex((r) => r.status === "busy")];
    expect((await tileRow(busyTile))!.status).toBe("pending");
    // The cap is per provider across layers.
    const [svc] = freshTiles();
    expect(await repo.claimTile("services", "osm", tileFromKey("services", svc.key)!, 2)).toEqual({ status: "busy" });

    // A finished fetch frees its slot.
    const done = tiles[results.findIndex((r) => r.status === "claimed")];
    const token = (results.find((r) => r.status === "claimed") as Extract<repo.ClaimResult, { status: "claimed" }>).token;
    await withSystem((tx) => repo.markTileReady(tx, "outdoor", "osm", done.key, token, { trailCount: 0, poiCount: 0, ttlSeconds: 86_400, note: null }));
    expect((await repo.claimTile("outdoor", "osm", busyTile, 2)).status).toBe("claimed");
    // And the second claim on a tile being fetched reports it in progress.
    expect(await repo.claimTile("outdoor", "osm", busyTile, 2)).toEqual({ status: "in_progress" });
    await sql()`update public.catalog_tiles set status = 'failed' where provider = 'osm' and status = 'fetching'`;
  });

  it("reclaims a fetch stale for over 5 minutes and fences the old worker out", async () => {
    const [tile] = freshTiles();
    const old = await repo.claimTile("outdoor", "osm", tile, 2);
    expect(old.status).toBe("claimed");
    const oldToken = (old as Extract<repo.ClaimResult, { status: "claimed" }>).token;
    // Not stale yet → in progress.
    expect(await ingest(tile, deps(area([])))).toMatchObject({ outcome: "noop", reason: "in_progress" });

    await sql()`update public.catalog_tiles set fetch_started_at = now() - interval '6 minutes' where layer = 'outdoor' and tile_key = ${tile.key}`;
    // The stale claim neither blocks nor counts toward the cap.
    const r = await ingest(tile, deps(area([trail(id("relation"), "Reclaimed Track", [eastLine(tile, 0, 1000)])]), { concurrencyCap: 1 }));
    expect(r).toMatchObject({ outcome: "done", trails: 1 });

    // The old worker finishing late cannot overwrite the new state.
    expect(await withSystem((tx) => repo.markTileReady(tx, "outdoor", "osm", tile.key, oldToken, { trailCount: 99, poiCount: 99, ttlSeconds: 60, note: null }))).toBe(false);
    expect(await repo.markTileFailed("outdoor", "osm", tile.key, oldToken, "late failure")).toBeNull();
    expect(await tileRow(tile)).toMatchObject({ status: "ready", trailCount: 1, lastError: null });
  });

  it("fails the tile when the provider exceeds its time budget", async () => {
    const [tile] = freshTiles();
    const hang: Responder = (_l, _b, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new ProviderError("overpass", "Request aborted", null, false)), { once: true });
      });
    const r = await ingest(tile, deps(hang, { fetchBudgetMs: 150, budgetMs: 5_000 }));
    expect(r).toMatchObject({ outcome: "failed", retryable: true });
    expect((r as { error: string }).error).toMatch(/did not answer within/);
    expect(await tileRow(tile)).toMatchObject({ status: "failed", attempts: 1 });

    // External cancellation is reported as such (and retryable).
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const cancelled = await ingest(tile, deps(hang, { signal: controller.signal }));
    expect(cancelled).toMatchObject({ outcome: "failed", retryable: true });
    expect((cancelled as { error: string }).error).toMatch(/cancelled/);
  });

  it("loads several tiles at once for the inline path and never throws", async () => {
    const [a, b] = freshTiles(2);
    const d = deps((_layer, bbox) => {
      if (bbox[0] === b.bbox[0]) throw new Error("socket hang up");
      return area([trail(id("relation"), "Inline Loaded Track", [eastLine(a, 0, 1000)])]);
    });
    const results = await ingestTilesNow("outdoor", [
      { provider: "osm", tileKey: a.key },
      { provider: "osm", tileKey: b.key },
      { provider: "osm", tileKey: "garbage" },
    ], d);
    expect(results.map((r) => r.outcome)).toEqual(["done", "failed", "noop"]);
    expect(results[1]).toMatchObject({ retryable: true, error: "socket hang up" });
    expect(await tileRow(a)).toMatchObject({ status: "ready" });
    expect(await tileRow(b)).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("computes the documented backoff", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(repo.failureBackoffMinutes)).toEqual([5, 10, 20, 40, 80, 160, 320, 360]);
    expect(repo.failureBackoffMinutes(0)).toBe(5);
    expect(repo.failureBackoffMinutes(1000)).toBe(360);
  });
});

// ---------------------------------------------------------------------------
describe("real OpenStreetMap data (Table Rock fixture, see tests/fixtures/osm/README.md)", () => {
  const json = JSON.parse(readFileSync(path.resolve(__dirname, "../../fixtures/osm/table-rock-outdoor.json"), "utf8"));
  const parsed = parseOverpassResponse("outdoor", json);
  const tile = tileForPoint("outdoor", -82.7, 35.05);
  const providerIds = parsed.trails.map((t) => t.providerId);
  const sc = { countryCode: "us", regionName: "South Carolina", nearestPlace: "Pickens" };

  afterAll(async () => {
    // Leave the real-world area as other suites expect it.
    await sql()`delete from public.catalog_trails where provider = 'osm' and (provider_id = any(${providerIds}::text[]) or alias_ids && ${providerIds}::text[])`;
    await sql()`delete from public.catalog_pois where provider = 'osm' and provider_id = any(${parsed.pois.map((p) => p.providerId)}::text[])`;
    await sql()`delete from public.catalog_tiles where provider = 'osm' and tile_key = ${tile.key}`;
  });

  it("stores every parsed trail and POI with sane derived fields; an unchanged refresh changes nothing", async () => {
    expect(tile.key).toBe("0.25/389/500");
    // Real borders for the real data (the country comes from each trail's exact point).
    const d1 = deps(parsed, { reverseAdmin: async () => sc, countryAt: countryCodeAt, timezone: () => "America/New_York" });
    const r1 = await ingest(tile, d1);
    expect(r1).toMatchObject({ outcome: "done", trails: parsed.trails.length, inserted: parsed.trails.length, failedTrails: 0, skipped: 0, pois: parsed.pois.length });

    const rows = await sql()<TrailRow[]>`
      select t.*, null as trailhead_lng, null as trailhead_lat from public.catalog_trails t
       where t.provider = 'osm' and t.provider_id = any(${providerIds}::text[]) order by t.provider_id`;
    expect(rows).toHaveLength(parsed.trails.length);
    expect(new Set(rows.map((t) => t.slug)).size).toBe(rows.length);
    for (const t of rows) {
      expect(t.slug).toMatch(SLUG_RE);
      expect(t.countryCode).toBe("us");
      expect(t.regionSlug).toBe("south-carolina");
      expect(t.distanceM).toBeGreaterThanOrEqual(400); // the parser drops shorter trails
      expect(["parking", "route_start"]).toContain(t.trailheadSource); // the fixture maps no highway=trailhead
      expect(t.estimatedDurationMin).toBeGreaterThan(0);
      expect(t.difficulty).not.toBe("unknown");
      expect(["osm_sac_scale", "estimated"]).toContain(t.difficultySource);
      expect(t.elevationSource).toBe("Test DEM (estimate)");
      expect(t.hidden).toBe(false);
    }
    const byName = new Map(rows.map((t) => [t.name, t]));
    expect(byName.get("Table Rock Trail")?.slug).toBe("table-rock-trail");
    expect(byName.get("Jocassee Gorges Passage Of The Palmetto Trail")?.routeType).toBe("network");
    expect(rows.some((t) => t.features.includes("waterfall"))).toBe(true);
    expect(rows.some((t) => t.hasParking)).toBe(true);

    // Unchanged refresh: same rows and slugs, nothing retired, stored elevation reused (no DEM calls).
    await makeDue(tile);
    const d2 = deps(parsed, { reverseAdmin: async () => sc, countryAt: countryCodeAt, timezone: () => "America/New_York" });
    const r2 = await ingest(tile, d2);
    expect(r2).toMatchObject({ outcome: "done", inserted: 0, updated: parsed.trails.length, retired: 0, poisRemoved: 0 });
    expect(d2.elevationCalls).toHaveLength(0);
    const again = await sql()<{ id: string; slug: string }[]>`
      select id, slug from public.catalog_trails where provider = 'osm' and provider_id = any(${providerIds}::text[]) order by provider_id`;
    expect(again).toEqual(rows.map((t) => ({ id: t.id, slug: t.slug })));
  });
});
