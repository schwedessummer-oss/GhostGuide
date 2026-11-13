/**
 * Stable trail URLs and place names during ingestion (review findings
 * #11, #16, #25, #31, #37), against PostGIS with a FAKE provider and
 * injected admin / country / elevation functions (no network):
 *
 *  - a failed reverse-geocoding lookup is retried for the next trail of the
 *    cell (not reused for the run), lookups pause after repeated failures,
 *    and a tile that stored trails without names refreshes within hours;
 *  - when a trail's path changes (region filled in later, country
 *    corrected), the old path permanently redirects to the new one through
 *    the trail page, and is never given to another trail;
 *  - terrain tiles are fetched with no transaction, advisory lock or row
 *    lock held, and a geometry that changed meanwhile is re-sampled.
 *
 * Tiles live around lng 95–100, lat −52.5 (row iy = 150 of the 0.25° grid);
 * no other test file uses this area.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { offsetMeters } from "@/domain/geo";
import type { Bbox } from "@/domain/catalog";
import { closeDb, isUniqueViolation, sql, withSystem } from "@/server/db";
import { adminCellKey, type AdminArea } from "@/server/geo/geocode";
import { linesLengthM } from "@/server/geo/geodesy";
import { tileFromKey, type Tile } from "@/server/geo/tiles";
import { ADMIN_ATTEMPTS_PER_CELL, ADMIN_FAILURES_BEFORE_PAUSE, NAMES_RETRY_TTL_HOURS, ingestTile, type IngestDeps } from "@/server/trails/ingest";
import { getTrailDetailByPath } from "@/server/trails/read";
import { findTrailRedirect } from "@/server/trails/redirects";
import * as repo from "@/server/trails/repository";
import type { Line, NormalizedPoi, NormalizedTrail, ProviderAreaResult, TrailDataProvider } from "@/server/trails/types";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
  headers: async () => new Headers(),
}));
// The trail page is called directly here, outside Next.js: its unstable_cache (which only shortens how
// long a 404 / redirect render is cached) needs Next's incremental cache, so it runs the lookup as is.
vi.mock("next/cache", async (orig) => ({
  ...(await orig<typeof import("next/cache")>()),
  unstable_cache: <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => fn,
}));

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

const IY = 150;
let nextIx = 1100;
function freshTiles(n = 1): Tile[] {
  const out: Tile[] = [];
  for (let i = 0; i < n; i++) out.push(tileFromKey("outdoor", `0.25/${nextIx + i}/${IY}`)!);
  nextIx += n + 1;
  return out;
}

const r7 = (n: number) => Math.round(n * 1e7) / 1e7;
function pos(ref: { lng: number; lat: number }, east: number, north = 0): [number, number] {
  const p = offsetMeters(ref, east, north);
  return [r7(p.lng), r7(p.lat)];
}
const center = (t: Tile) => ({ lng: (t.bbox[0] + t.bbox[2]) / 2, lat: (t.bbox[1] + t.bbox[3]) / 2 });
const eastEdge = (t: Tile) => ({ lng: t.bbox[2], lat: (t.bbox[1] + t.bbox[3]) / 2 });
/** A straight line `lengthM` long, eastwards from `east0` metres east / `north` metres north of `ref`. */
const lineAt = (ref: { lng: number; lat: number }, east0: number, lengthM: number, north = 0): Line => [
  pos(ref, east0, north),
  pos(ref, east0 + lengthM / 2, north),
  pos(ref, east0 + lengthM, north),
];

let seq = 5_000_000;
const id = (kind: "relation" | "waygroup") => `${kind}/${seq++}`;
beforeEach(() => {
  seq += 1000;
});

function trail(providerId: string, name: string, lines: Line[]): NormalizedTrail {
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
    tags: {},
    sourceName: "OpenStreetMap contributors",
    sourceUrl: null,
    sourceLicense: "ODbL 1.0",
    sourceUpdatedAt: null,
  };
}

const area = (trails: NormalizedTrail[]): ProviderAreaResult => ({ trails, pois: [], dataTimestamp: new Date() });

function fakeProvider(respond: (bbox: Bbox) => ProviderAreaResult): TrailDataProvider {
  return {
    id: "osm",
    label: "OpenStreetMap",
    homepage: "https://www.openstreetmap.org",
    license: "ODbL 1.0",
    attribution: "© OpenStreetMap contributors",
    layers: ["outdoor", "services"],
    isEnabled: () => true,
    covers: () => true,
    async fetchArea(_layer, bbox) {
      return respond(bbox);
    },
  };
}

const CANTERBURY: AdminArea = { countryCode: "nz", regionName: "Canterbury", nearestPlace: "Arthur's Pass" };

interface TestDeps extends IngestDeps {
  adminCalls: string[];
  elevationCalls: Line[][];
}

/** Deps with a fake DEM (60 m climb), the given admin answer per call, and country "nz" everywhere. */
function deps(respond: ProviderAreaResult | ((bbox: Bbox) => ProviderAreaResult), over: Partial<IngestDeps> & { admin?: (call: number) => AdminArea | null | Error } = {}): TestDeps {
  const adminCalls: string[] = [];
  const elevationCalls: Line[][] = [];
  const { admin, ...rest } = over;
  return {
    provider: fakeProvider(typeof respond === "function" ? respond : () => respond),
    elevation: async (lines) => {
      elevationCalls.push(lines);
      const len = Math.max(1, Math.round(linesLengthM(lines)));
      return { profile: [[0, 100], [len, 160]], gainM: 60, lossM: 0, maxM: 160, minM: 100, source: "Test DEM (estimate)" };
    },
    reverseAdmin: async (lat, lng) => {
      adminCalls.push(adminCellKey(lat, lng));
      const answer = admin ? admin(adminCalls.length) : CANTERBURY;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    countryAt: () => "nz",
    timezone: () => "Pacific/Auckland",
    now: () => new Date("2026-11-12T10:00:00Z"),
    concurrencyCap: 1000,
    ttlDays: 30,
    adminCalls,
    elevationCalls,
    ...rest,
  };
}

const ingest = (tile: Tile, d: IngestDeps) => ingestTile("outdoor", "osm", tile.key, d);

async function makeDue(tile: Tile) {
  await sql()`update public.catalog_tiles set next_refresh_at = now() - interval '1 second'
               where layer = 'outdoor' and provider = 'osm' and tile_key = ${tile.key}`;
}

interface Row {
  id: string;
  slug: string;
  countryCode: string;
  regionSlug: string;
  regionName: string | null;
  nearestPlace: string | null;
  distanceM: number;
  elevationProfile: [number, number][] | null;
}
async function byProviderId(providerId: string): Promise<Row> {
  const [row] = await sql()<Row[]>`
    select id, slug, country_code, region_slug, region_name, nearest_place, distance_m, elevation_profile
      from public.catalog_trails where provider = 'osm' and (provider_id = ${providerId} or alias_ids @> array[${providerId}]::text[])`;
  return row;
}
const pathOf = (r: Pick<Row, "countryCode" | "regionSlug" | "slug">) => `/trail/${r.countryCode}/${r.regionSlug}/${r.slug}`;

async function tileState(tile: Tile) {
  const [row] = await sql()<{ lastError: string | null; refreshInHours: number }[]>`
    select last_error, extract(epoch from (next_refresh_at - now())) / 3600 as refresh_in_hours
      from public.catalog_tiles where layer = 'outdoor' and provider = 'osm' and tile_key = ${tile.key}`;
  return row;
}

async function redirectsOf(trailId: string): Promise<string[]> {
  const rows = await sql()<{ countryCode: string; regionSlug: string; slug: string }[]>`
    select country_code, region_slug, slug from public.catalog_trail_redirects where trail_id = ${trailId} order by 1, 2, 3`;
  return rows.map(pathOf);
}

/** The digest a Next.js redirect / notFound throws (permanentRedirect: "NEXT_REDIRECT;replace;<url>;308;"). */
async function thrownDigest(p: Promise<unknown>): Promise<string> {
  const err = (await p.then(
    () => null,
    (e: unknown) => e,
  )) as { digest?: string } | null;
  return err?.digest ?? `no digest: ${String(err)}`;
}

async function trailPage() {
  return import("@/app/trail/[country]/[region]/[slug]/page");
}
const pageParams = (country: string, region: string, slug: string) => ({ params: Promise.resolve({ country, region, slug }) });

// ---------------------------------------------------------------------------
describe("place names during ingestion (#16)", () => {
  it("retries a failed lookup for the next trail of the same cell instead of reusing the failure", async () => {
    const [tile] = freshTiles();
    const c = center(tile);
    const first = trail(id("relation"), "Flaky Lookup Track", [lineAt(c, -1500, 900)]);
    const second = trail(id("relation"), "Second Lookup Track", [lineAt(c, -1500, 700, 300)]);
    // One timeout, then answers.
    const d = deps(area([first, second]), { admin: (n) => (n === 1 ? new Error("Nominatim timed out") : CANTERBURY) });
    expect(await ingest(tile, d)).toMatchObject({ outcome: "done", inserted: 2, namesMissing: 1 });
    expect(new Set(d.adminCalls).size).toBe(1); // one cell…
    expect(d.adminCalls).toHaveLength(2); // …asked again after the failure

    // The longer trail went first and got no names (but its exact country); the next one has them.
    expect(await byProviderId(first.providerId)).toMatchObject({ countryCode: "nz", regionSlug: "unknown", nearestPlace: null });
    expect(await byProviderId(second.providerId)).toMatchObject({ countryCode: "nz", regionSlug: "canterbury", nearestPlace: "Arthur's Pass" });

    // The tile says so and refreshes within hours, not after the 30-day TTL.
    const t = await tileState(tile);
    expect(t.lastError).toMatch(/Place names were unavailable for 1 trail\(s\)/);
    expect(t.refreshInHours).toBeGreaterThan(NAMES_RETRY_TTL_HOURS * 0.85);
    expect(t.refreshInHours).toBeLessThan(NAMES_RETRY_TTL_HOURS * 1.15);

    // That refresh fills the region in; the old path redirects permanently to the new one.
    const before = await byProviderId(first.providerId);
    await makeDue(tile);
    expect(await ingest(tile, deps(area([first, second])))).toMatchObject({ outcome: "done", updated: 2, namesMissing: 0 });
    const after = await byProviderId(first.providerId);
    expect(after).toMatchObject({ id: before.id, countryCode: "nz", regionSlug: "canterbury", slug: before.slug });
    expect(await redirectsOf(after.id)).toEqual([pathOf(before)]);
    expect(await findTrailRedirect("nz", "unknown", before.slug)).toBe(pathOf(after));
    const back = await tileState(tile);
    expect(back.lastError).toBeNull();
    expect(back.refreshInHours / 24).toBeGreaterThan(26.9);
  });

  it("gives up on a cell after repeated failures and pauses lookups when the service keeps failing", async () => {
    // Five trails in one cell, every lookup fails: the cell is asked at most ADMIN_ATTEMPTS_PER_CELL times.
    const [tile] = freshTiles();
    const c = center(tile);
    const sameCell = [0, 1, 2, 3, 4].map((i) => trail(id("relation"), `Same Cell Track ${i}`, [lineAt(c, -1500, 600 + i * 50, i * 150)]));
    const d1 = deps(area(sameCell), { admin: () => null });
    expect(await ingest(tile, d1)).toMatchObject({ outcome: "done", inserted: 5, namesMissing: 5 });
    expect(new Set(d1.adminCalls).size).toBe(1);
    expect(d1.adminCalls).toHaveLength(ADMIN_ATTEMPTS_PER_CELL);
    // Stored all the same, with the exact country and an honest unknown region.
    for (const t of sameCell) expect(await byProviderId(t.providerId)).toMatchObject({ countryCode: "nz", regionSlug: "unknown" });

    // Four trails in four cells, every lookup throws: lookups pause after ADMIN_FAILURES_BEFORE_PAUSE failures in a row.
    const [tile2] = freshTiles();
    const [w, s] = tile2.bbox;
    const corners = [
      { lng: w + 0.02, lat: s + 0.02 },
      { lng: w + 0.12, lat: s + 0.02 },
      { lng: w + 0.22, lat: s + 0.02 },
      { lng: w + 0.02, lat: s + 0.12 },
    ];
    const spread = corners.map((p, i) => trail(id("relation"), `Spread Track ${i}`, [lineAt(p, 0, 400 + i * 10)]));
    const d2 = deps(area(spread), { admin: () => new Error("Provider is busy (rate limit queue full)") });
    expect(await ingest(tile2, d2)).toMatchObject({ outcome: "done", inserted: 4, namesMissing: 4 });
    expect(new Set(spread.map((t) => adminCellKey(t.lines[0][1][1], t.lines[0][1][0]))).size).toBe(4);
    expect(d2.adminCalls).toHaveLength(ADMIN_FAILURES_BEFORE_PAUSE);
  });

  it("keeps a known region when a later lookup fails, and does not shorten the tile's refresh for it", async () => {
    const [tile] = freshTiles();
    const t = trail(id("relation"), "Settled Region Track", [lineAt(center(tile), -1500, 800)]);
    await ingest(tile, deps(area([t])));
    const before = await byProviderId(t.providerId);
    await makeDue(tile);
    expect(await ingest(tile, deps(area([t]), { admin: () => null }))).toMatchObject({ updated: 1, namesMissing: 0 });
    expect(await byProviderId(t.providerId)).toMatchObject({ slug: before.slug, regionSlug: "canterbury", nearestPlace: "Arthur's Pass" });
    expect((await tileState(tile)).lastError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("stable trail URLs (#25, #37)", () => {
  it("redirects a moved trail's old path through the trail page and never gives it to another trail", async () => {
    const [tileA, tileB] = freshTiles(2);
    const x = trail(id("relation"), "Shared Name Ridge", [lineAt(center(tileA), -1500, 900)]);
    // Stored while reverse geocoding was down, then the region is filled in.
    await ingest(tileA, deps(area([x]), { admin: () => null }));
    const old = await byProviderId(x.providerId);
    expect(pathOf(old)).toBe("/trail/nz/unknown/shared-name-ridge");
    await makeDue(tileA);
    await ingest(tileA, deps(area([x])));
    const moved = await byProviderId(x.providerId);
    expect(pathOf(moved)).toBe("/trail/nz/canterbury/shared-name-ridge");

    // The trail page answers the old path with a permanent redirect (also mixed case), and 404s unknown paths.
    const page = await trailPage();
    const redirect = /^NEXT_REDIRECT;[^;]*;\/trail\/nz\/canterbury\/shared-name-ridge;308;$/;
    expect(await thrownDigest(page.generateMetadata(pageParams("nz", "unknown", "shared-name-ridge")))).toMatch(redirect);
    expect(await thrownDigest(page.default(pageParams("nz", "unknown", "shared-name-ridge")))).toMatch(redirect);
    expect(await thrownDigest(page.generateMetadata(pageParams("NZ", "Unknown", "Shared-Name-Ridge")))).toMatch(redirect);
    expect(await thrownDigest(page.generateMetadata(pageParams("nz", "unknown", "no-such-ridge")))).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);

    // A different trail with the same name, stored in the same unknown region, never gets the old path.
    const y = trail(id("relation"), "Shared Name Ridge", [lineAt(center(tileB), -1500, 900)]);
    await ingest(tileB, deps(area([y]), { admin: () => null }));
    const other = await byProviderId(y.providerId);
    expect(pathOf(other)).toBe("/trail/nz/unknown/shared-name-ridge-2");
    expect(await getTrailDetailByPath("nz", "unknown", "shared-name-ridge")).toBeNull();
    expect(await findTrailRedirect("nz", "unknown", "shared-name-ridge")).toBe(pathOf(moved));

    // The database refuses it too (any writer): reported as a slug conflict.
    const err = await withSystem(
      (tx) => tx`update public.catalog_trails set slug = 'shared-name-ridge' where id = ${other.id}`,
    ).then(
      () => null,
      (e: unknown) => e as { constraint_name?: string },
    );
    expect(isUniqueViolation(err)).toBe(true);
    expect(err?.constraint_name).toBe("catalog_trails_country_code_region_slug_slug_key");

    // When `other` gets its region it moves too; both old paths stay with their own trails.
    await makeDue(tileB);
    await ingest(tileB, deps(area([y])));
    const otherMoved = await byProviderId(y.providerId);
    expect(pathOf(otherMoved)).toBe("/trail/nz/canterbury/shared-name-ridge-2");
    expect(await findTrailRedirect("nz", "unknown", "shared-name-ridge-2")).toBe(pathOf(otherMoved));
    expect(await findTrailRedirect("nz", "unknown", "shared-name-ridge")).toBe(pathOf(moved));

    // A hidden trail is not redirected to, and its old path stays reserved.
    await sql()`update public.catalog_trails set hidden = true, hidden_reason = 'test' where id = ${moved.id}`;
    expect(await findTrailRedirect("nz", "unknown", "shared-name-ridge")).toBeNull();
    expect(await thrownDigest(page.generateMetadata(pageParams("nz", "unknown", "shared-name-ridge")))).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);
    await sql()`update public.catalog_trails set hidden = false, hidden_reason = null where id = ${moved.id}`;
  });
});

// ---------------------------------------------------------------------------
describe("country from the exact point (#11)", () => {
  it("moves a row stored with a neighbouring cell's country to the real one, dropping the foreign names", async () => {
    const [tile] = freshTiles();
    const t = trail(id("relation"), "Border Pass Track", [lineAt(center(tile), -1500, 900)]);
    const alberta: AdminArea = { countryCode: "ca", regionName: "Alberta", nearestPlace: "Waterton Park" };
    // As stored before the fix: country and region from the cell (here: countryAt agrees with the cell).
    await ingest(tile, deps(area([t]), { admin: () => alberta, countryAt: () => "ca" }));
    const legacy = await byProviderId(t.providerId);
    expect(pathOf(legacy)).toBe("/trail/ca/alberta/border-pass-track");

    // The exact point is in the US: the trail moves; the Canadian region and town go; the old path redirects.
    await makeDue(tile);
    expect(await ingest(tile, deps(area([t]), { admin: () => alberta, countryAt: () => "us" }))).toMatchObject({ updated: 1 });
    const fixed = await byProviderId(t.providerId);
    expect(fixed).toMatchObject({ id: legacy.id, countryCode: "us", regionSlug: "unknown", regionName: null, nearestPlace: null });
    expect(await findTrailRedirect("ca", "alberta", "border-pass-track")).toBe(pathOf(fixed));

    // Moving back (say, the trailhead was re-mapped across the border) takes its own old path back.
    await makeDue(tile);
    await ingest(tile, deps(area([t]), { admin: () => alberta, countryAt: () => "ca" }));
    const again = await byProviderId(t.providerId);
    expect(pathOf(again)).toBe("/trail/ca/alberta/border-pass-track");
    expect(await redirectsOf(again.id)).toEqual(["/trail/us/unknown/border-pass-track"]);
    expect(await getTrailDetailByPath("ca", "alberta", "border-pass-track")).toMatchObject({ id: legacy.id });
  });
});

// ---------------------------------------------------------------------------
describe("terrain tiles are fetched outside the trail's transaction (#31)", () => {
  it("holds no advisory lock, row lock or open transaction while the DEM is sampled", async () => {
    const [tile] = freshTiles();
    const t = trail(id("relation"), "Unlocked Elevation Track", [lineAt(center(tile), -1500, 900)]);
    await ingest(tile, deps(area([t])));
    const row = await byProviderId(t.providerId);

    // Changed geometry → the DEM is sampled again; meanwhile another session can lock the row and the trail's key.
    const probes: { rowLocked: boolean; advisoryFree: boolean; idleInTx: number }[] = [];
    const longer = { ...t, lines: [lineAt(center(tile), -1500, 1400)] };
    const base = deps(area([longer]));
    const d = deps(area([longer]), {
      elevation: async (lines, opts) => {
        const probe = await withSystem(async (tx) => {
          await tx`set local lock_timeout = '200ms'`;
          const locked = await tx`select 1 from public.catalog_trails where id = ${row.id} for update nowait`.then(
            () => false,
            () => true,
          );
          const [a] = await tx<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(hashtext(${`catalog_trail:osm:id:${t.providerId}`})) as ok`;
          const [n] = await tx<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
             where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()`;
          return { rowLocked: locked, advisoryFree: a.ok, idleInTx: n.n };
        });
        probes.push(probe);
        return base.elevation!(lines, opts);
      },
    });
    await makeDue(tile);
    expect(await ingest(tile, d)).toMatchObject({ outcome: "done", updated: 1, failedTrails: 0 });
    expect(probes).toEqual([{ rowLocked: false, advisoryFree: true, idleInTx: 0 }]);
    const after = await byProviderId(t.providerId);
    expect(after.distanceM).toBeGreaterThan(1390);
    expect(after.elevationProfile!.at(-1)![0]).toBe(after.distanceM);
  });

  it("re-samples when a neighbouring tile changes the merged geometry meanwhile, and gives up after repeated changes", async () => {
    const [a, b] = freshTiles(2);
    const e = eastEdge(a);
    const west: Line[] = [[pos(e, -1500), pos(e, -900), pos(e, -300), pos(e, 300)]];
    const east: Line[] = [[pos(e, -300), pos(e, 300), pos(e, 900), pos(e, 1500)]];
    const idA = id("waygroup");
    const idB = id("waygroup");
    await ingest(a, deps(area([trail(idA, "Shifting Walk", west)])));
    const stored = await byProviderId(idA);

    // While B's piece is being sampled, tile A's part grows westwards (another worker's write).
    let grow = 0;
    const growA = async () => {
      grow += 300;
      const geo = JSON.stringify({ type: "MultiLineString", coordinates: [[pos(e, -1500 - grow), ...west[0]]] });
      await sql()`update public.catalog_trail_parts set geom = st_multi(st_setsrid(st_geomfromgeojson(${geo}), 4326))
                   where trail_id = ${stored.id} and tile_key = ${a.key}`;
    };
    const base = deps(area([]));
    const once = deps(area([trail(idB, "Shifting Walk", east)]), {
      elevation: async (lines, opts) => {
        if (grow === 0) await growA();
        return base.elevation!(lines, opts);
      },
    });
    const seen: number[] = [];
    const tracked: TestDeps = {
      ...once,
      elevation: async (lines, opts) => {
        seen.push(Math.round(linesLengthM(lines)));
        return once.elevation!(lines, opts);
      },
    };
    expect(await ingest(b, tracked)).toMatchObject({ outcome: "done", merged: 1, failedTrails: 0 });
    // Sampled twice: the first profile was for a geometry that no longer existed at write time.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0] + 250);
    const merged = await byProviderId(idA);
    expect(Math.abs(merged.distanceM - seen[1])).toBeLessThanOrEqual(1);
    expect(merged.elevationProfile!.at(-1)![0]).toBe(seen[1]);

    // A geometry that keeps changing fails the trail (retried next refresh) instead of storing a mismatched profile.
    await growA(); // changed since the last write, so the refresh needs a new profile
    await makeDue(b);
    const restless = deps(area([trail(idB, "Shifting Walk", east)]), {
      elevation: async (lines, opts) => {
        await growA();
        return base.elevation!(lines, opts);
      },
    });
    const r = await ingest(b, restless);
    expect(r).toMatchObject({ outcome: "failed" });
    expect((r as { error: string }).error).toMatch(/changed while its elevation was being computed/);
  });
});

// ---------------------------------------------------------------------------
describe("trailhead attribution (#28)", () => {
  const trailheadPoi = (provider: "osm" | "ridb", providerId: string, at: [number, number]): NormalizedPoi => ({
    provider,
    providerId,
    layer: "outdoor",
    category: "trailhead",
    name: null,
    nameEn: null,
    lng: at[0],
    lat: at[1],
    elevationM: null,
    tags: {},
    openingHours: null,
    phone: null,
    website: null,
    sourceName: provider === "ridb" ? "Recreation.gov (RIDB)" : "OpenStreetMap contributors",
    sourceUrl: null,
    sourceLicense: provider === "ridb" ? "US Government public domain" : "ODbL 1.0",
  });

  it("labels a stored Recreation.gov trailhead 'official' and an OSM one 'osm_trailhead'", async () => {
    const [tile] = freshTiles();
    const c = center(tile);
    const ridbTrail = trail(id("relation"), "Official Trailhead Track", [lineAt(c, -1500, 900)]);
    const osmTrail = trail(id("relation"), "Mapped Trailhead Track", [lineAt(c, -1500, 900, 2000)]);
    await withSystem((tx) =>
      repo.upsertPois(tx, [
        trailheadPoi("ridb", `facility/${seq++}`, pos(c, -1530, 10)),
        trailheadPoi("osm", `node/${seq++}`, pos(c, -1530, 2010)),
      ]),
    );
    await ingest(tile, deps(area([ridbTrail, osmTrail])));
    const sources = await sql()<{ providerId: string; trailheadSource: string }[]>`
      select provider_id, trailhead_source from public.catalog_trails
       where provider = 'osm' and provider_id in (${ridbTrail.providerId}, ${osmTrail.providerId})`;
    expect(Object.fromEntries(sources.map((r) => [r.providerId, r.trailheadSource]))).toEqual({
      [ridbTrail.providerId]: "official",
      [osmTrail.providerId]: "osm_trailhead",
    });
  });
});
