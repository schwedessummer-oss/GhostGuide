/**
 * Trail detail and summaries-by-id reads against PostGIS: every detail
 * field, path/id lookup rules, hidden trails, outdoor POI proximity and
 * order, the geometry simplification threshold, attribution, and the pure
 * mappers' handling of unexpected values.
 *
 * Rows live around lng 10–20, lat 46 (no other test file uses this area).
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, withAnon, withSystem, type JsonValue } from "@/server/db";
import {
  DETAIL_SIMPLIFY_VERTEX_THRESHOLD,
  POI_LIMIT,
  catalogAttribution,
  elevationAttribution,
  getTrailDetailById,
  getTrailDetailByPath,
  getTrailSummariesByIds,
  parseElevationProfile,
  parseGeometry,
  toDetailDto,
  toPoiDto,
  toSummaryDto,
  type PoiRow,
  type TrailDetailRow,
} from "@/server/trails/read";

afterAll(closeDb);

const OSM_ATTRIBUTION = { name: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright", license: "ODbL 1.0" };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
type Line = [number, number][];

interface TrailSeed {
  name?: string;
  slug?: string;
  regionSlug?: string;
  countryCode?: string;
  lines?: Line[];
  /** Build a wavy line with this many vertices (~0.77 m apart) in SQL instead of `lines` (starting at lines[0][0]). */
  vertices?: number;
  /** Sine-wave amplitude in degrees of latitude (default 1e-7 ≈ 1 cm); one period = 100 vertices. */
  amplitudeDeg?: number;
  trailhead?: [number, number] | null;
  hidden?: boolean;
  provider?: string;
  extra?: Partial<Record<string, unknown>>;
}

let areaSeq = 0;
function newArea() {
  const lng = 10 + areaSeq++ * 0.3;
  const lat = 46;
  return { lng, lat };
}

async function insertTrail(seed: TrailSeed): Promise<{ id: string; slug: string; regionSlug: string; countryCode: string }> {
  const slug = seed.slug ?? `trail-${randomUUID().slice(0, 8)}`;
  const regionSlug = seed.regionSlug ?? "test-region";
  const countryCode = seed.countryCode ?? "ch";
  const x = seed.extra ?? {};
  const th = seed.trailhead === undefined ? (seed.lines?.[0]?.[0] ?? null) : seed.trailhead;
  const geomSql = (tx: Parameters<Parameters<typeof withSystem>[0]>[0]) =>
    seed.vertices
      ? tx`st_multi(st_makeline(array(
          select st_makepoint(${seed.lines![0][0][0]}::float8 + i * 0.00001, ${seed.lines![0][0][1]}::float8 + ${seed.amplitudeDeg ?? 0.0000001}::float8 * sin(i * 2 * pi() / 100))
            from generate_series(0, ${seed.vertices - 1}::int) i)))`
      : tx`st_geomfromgeojson(${JSON.stringify({ type: "MultiLineString", coordinates: seed.lines })})`;
  const [row] = await withSystem(
    (tx) => tx<{ id: string }[]>`
      with g as (select st_setsrid(${geomSql(tx)}, 4326) as geom)
      insert into public.catalog_trails (
        provider, provider_id, name, name_en, slug, country_code, region_name, region_slug, nearest_place, timezone,
        centroid, trailhead, trailhead_source, geom, distance_m, route_type,
        elevation_gain_m, elevation_loss_m, max_elevation_m, min_elevation_m, elevation_profile, elevation_source,
        estimated_duration_min, difficulty, difficulty_source, sac_scale, trail_visibility, surfaces, activities, features,
        description, dog_policy, wheelchair, fee_required, permit_required, access, seasonality, operator, website,
        has_parking, has_toilets, has_drinking_water, has_camping, family_friendly,
        tags, source_name, source_url, source_license, source_updated_at, quality_score, hidden)
      select ${seed.provider ?? "osm"}, ${`relation/${randomUUID()}`}, ${seed.name ?? "Test Trail"}, ${(x.nameEn as string) ?? null},
        ${slug}, ${countryCode}, ${(x.regionName as string) ?? "Test Region"}, ${regionSlug}, ${(x.nearestPlace as string) ?? null},
        ${(x.timezone as string) ?? null},
        st_centroid(g.geom)::geography,
        case when ${th ? th[0] : null}::float8 is null then null
             else st_setsrid(st_makepoint(${th ? th[0] : null}::float8, ${th ? th[1] : null}::float8), 4326)::geography end,
        ${th ? ((x.trailheadSource as string) ?? "osm_trailhead") : null},
        g.geom, ${(x.distanceM as number) ?? 1500}, ${(x.routeType as string) ?? "loop"},
        ${(x.gain as number) ?? null}, ${(x.loss as number) ?? null}, ${(x.maxEle as number) ?? null}, ${(x.minEle as number) ?? null},
        ${x.profile === undefined ? null : tx.json(x.profile as JsonValue)}, ${(x.elevationSource as string) ?? null},
        ${(x.duration as number) ?? null}, ${(x.difficulty as string) ?? "unknown"}, ${(x.difficultySource as string) ?? null},
        ${(x.sacScale as string) ?? null}, ${(x.visibility as string) ?? null}, ${(x.surfaces as string[]) ?? []}::text[],
        ${(x.activities as string[]) ?? []}::text[], ${(x.features as string[]) ?? []}::text[],
        ${(x.description as string) ?? null}, ${(x.dogPolicy as string) ?? "unknown"}, ${(x.wheelchair as string) ?? "unknown"},
        ${x.fee === undefined ? null : (x.fee as boolean)}::boolean, ${x.permit === undefined ? null : (x.permit as boolean)}::boolean,
        ${(x.access as string) ?? null}, ${(x.seasonality as string) ?? null}, ${(x.operator as string) ?? null},
        ${(x.website as string) ?? null},
        ${(x.parking as boolean) ?? false}, ${(x.toilets as boolean) ?? false}, ${(x.water as boolean) ?? false},
        ${(x.camping as boolean) ?? false}, ${(x.family as boolean) ?? false},
        ${tx.json({ route: "hiking" } as JsonValue)}, ${(x.sourceName as string) ?? "OpenStreetMap"}, ${(x.sourceUrl as string) ?? null},
        ${(x.sourceLicense as string) ?? "ODbL 1.0"}, ${(x.sourceUpdatedAt as Date) ?? null}::timestamptz, 50, ${seed.hidden ?? false}
      from g
      returning id`,
  );
  return { id: row.id, slug, regionSlug, countryCode };
}

async function insertPoi(category: string, lng: number, lat: number, opts: { layer?: string; name?: string; provider?: string } = {}) {
  const [row] = await withSystem(
    (tx) => tx<{ id: string }[]>`
      insert into public.catalog_pois (provider, provider_id, layer, category, name, location, elevation_m, tags,
                                       opening_hours, phone, website, source_name, source_license)
      values (${opts.provider ?? "osm"}, ${`node/${randomUUID()}`}, ${opts.layer ?? "outdoor"}, ${category}, ${opts.name ?? null},
              st_setsrid(st_makepoint(${lng}::float8, ${lat}::float8), 4326)::geography, 812, ${tx.json({} as JsonValue)},
              'Mo-Su 06:00-20:00', '+41 00 000 00 00', 'https://example.org/poi', 'OpenStreetMap', 'ODbL 1.0')
      returning id`,
  );
  return row.id;
}

/** Metres → degrees at latitude 46°. */
const dLat = (m: number) => m / 111_320;
const dLng = (m: number) => m / (111_320 * Math.cos((46 * Math.PI) / 180));

// ---------------------------------------------------------------------------
describe("getTrailDetailById / getTrailDetailByPath", () => {
  it("returns every detail field with geometry, bbox, profile and attribution", async () => {
    const a = newArea();
    const lines: Line[] = [
      [
        [a.lng, a.lat],
        [a.lng + 0.01, a.lat],
        [a.lng + 0.01, a.lat + 0.01],
      ],
      [
        [a.lng + 0.02, a.lat + 0.01],
        [a.lng + 0.03, a.lat + 0.02],
      ],
    ];
    const profile = [
      [0, 800],
      [750, 845.5],
      [1500, 900],
    ];
    const t = await insertTrail({
      name: "Gipfelweg",
      lines,
      trailhead: [a.lng, a.lat],
      extra: {
        nameEn: "Summit Path",
        regionName: "Bern",
        nearestPlace: "Grindelwald",
        timezone: "Europe/Zurich",
        distanceM: 4200,
        routeType: "linear",
        gain: 310,
        loss: 20,
        maxEle: 1120,
        minEle: 800,
        profile,
        elevationSource: "AWS Terrain Tiles, ~27 m DEM (estimate)",
        duration: 95,
        difficulty: "hard",
        difficultySource: "osm_sac_scale",
        sacScale: "mountain_hiking",
        visibility: "good",
        surfaces: ["gravel", "rock"],
        activities: ["hiking"],
        features: ["peak", "viewpoint"],
        description: "Steep path to the summit.",
        dogPolicy: "leashed",
        wheelchair: "no",
        fee: false,
        permit: false,
        access: "yes",
        seasonality: "May-Oct",
        operator: "Wanderwege",
        website: "https://example.org/trail",
        parking: true,
        toilets: true,
        water: true,
        camping: false,
        family: false,
        sourceUrl: "https://www.openstreetmap.org/relation/1",
        sourceUpdatedAt: new Date("2026-10-01T12:00:00Z"),
      },
    });
    const d = await getTrailDetailById(t.id);
    expect(d).not.toBeNull();
    expect(d).toMatchObject({
      id: t.id,
      path: `/trail/ch/test-region/${t.slug}`,
      name: "Gipfelweg",
      nameEn: "Summit Path",
      countryCode: "ch",
      regionName: "Bern",
      regionSlug: "test-region",
      slug: t.slug,
      nearestPlace: "Grindelwald",
      timezone: "Europe/Zurich",
      trailhead: { lng: a.lng, lat: a.lat },
      trailheadSource: "osm_trailhead",
      distanceM: 4200,
      routeType: "linear",
      elevationGainM: 310,
      elevationLossM: 20,
      maxElevationM: 1120,
      minElevationM: 800,
      elevationProfile: profile,
      elevationSource: "AWS Terrain Tiles, ~27 m DEM (estimate)",
      estimatedDurationMin: 95,
      difficulty: "hard",
      difficultySource: "osm_sac_scale",
      sacScale: "mountain_hiking",
      trailVisibility: "good",
      surfaces: ["gravel", "rock"],
      activities: ["hiking"],
      features: ["peak", "viewpoint"],
      description: "Steep path to the summit.",
      dogPolicy: "leashed",
      wheelchair: "no",
      feeRequired: false,
      permitRequired: false,
      access: "yes",
      seasonality: "May-Oct",
      operator: "Wanderwege",
      website: "https://example.org/trail",
      hasParking: true,
      hasToilets: true,
      hasDrinkingWater: true,
      hasCamping: false,
      familyFriendly: false,
      provider: "osm",
      sourceName: "OpenStreetMap",
      sourceUrl: "https://www.openstreetmap.org/relation/1",
      sourceLicense: "ODbL 1.0",
      sourceUpdatedAt: "2026-10-01T12:00:00.000Z",
      pois: [],
    });
    expect(d!.geometry).toEqual({ type: "MultiLineString", coordinates: lines.map((l) => l.map(([x, y]) => [Number(x.toFixed(6)), Number(y.toFixed(6))])) });
    const [w, s, e, n] = d!.bbox;
    expect(w).toBeCloseTo(a.lng, 9);
    expect(s).toBeCloseTo(a.lat, 9);
    expect(e).toBeCloseTo(a.lng + 0.03, 9);
    expect(n).toBeCloseTo(a.lat + 0.02, 9);
    expect(d!.attribution).toEqual([
      OSM_ATTRIBUTION,
      {
        name: "Elevation: AWS Terrain Tiles, ~27 m DEM (estimate)",
        url: "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
        license: null,
      },
    ]);

    // The same trail by its canonical path.
    expect(await getTrailDetailByPath("ch", "test-region", t.slug)).toEqual(d);
  });

  it("leaves unknown values null instead of inventing them", async () => {
    const a = newArea();
    const t = await insertTrail({ lines: [[[a.lng, a.lat], [a.lng + 0.01, a.lat]]], trailhead: null });
    const d = (await getTrailDetailById(t.id))!;
    expect(d).toMatchObject({
      nameEn: null,
      nearestPlace: null,
      timezone: null,
      trailhead: null,
      trailheadSource: null,
      elevationGainM: null,
      elevationLossM: null,
      maxElevationM: null,
      minElevationM: null,
      elevationProfile: null,
      elevationSource: null,
      estimatedDurationMin: null,
      difficulty: "unknown",
      difficultySource: null,
      dogPolicy: "unknown",
      wheelchair: "unknown",
      feeRequired: null,
      permitRequired: null,
      description: null,
      sourceUrl: null,
      sourceUpdatedAt: null,
      features: [],
      surfaces: [],
    });
    expect(d.attribution).toEqual([OSM_ATTRIBUTION]);
  });

  it("returns null for unknown, hidden and malformed lookups", async () => {
    const a = newArea();
    const hidden = await insertTrail({ lines: [[[a.lng, a.lat], [a.lng + 0.01, a.lat]]], hidden: true });
    expect(await getTrailDetailById(hidden.id)).toBeNull();
    expect(await getTrailDetailByPath(hidden.countryCode, hidden.regionSlug, hidden.slug)).toBeNull();
    // Even a trusted read confirms the row exists: only the public read hides it.
    const [{ n }] = await withSystem((tx) => tx<{ n: number }[]>`select count(*)::int as n from public.catalog_trails where id = ${hidden.id}`);
    expect(n).toBe(1);
    // RLS alone (without the explicit filter) hides it from anon too.
    expect(await withAnon((tx) => tx`select id from public.catalog_trails where id = ${hidden.id}`)).toHaveLength(0);

    expect(await getTrailDetailById(randomUUID())).toBeNull();
    expect(await getTrailDetailById("not-a-uuid")).toBeNull();
    expect(await getTrailDetailById("")).toBeNull();
    expect(await getTrailDetailById("'; drop table public.catalog_trails; --")).toBeNull();
    expect(await getTrailDetailByPath("ch", "test-region", "no-such-trail")).toBeNull();
    expect(await getTrailDetailByPath("CH", "test-region", "x")).toBeNull();
    expect(await getTrailDetailByPath("che", "test-region", "x")).toBeNull();
    expect(await getTrailDetailByPath("ch", "Test Region", "x")).toBeNull();
    expect(await getTrailDetailByPath("ch", "test-region", "x/../y")).toBeNull();
    expect(await getTrailDetailByPath("ch", "test-region", "a".repeat(121))).toBeNull();
  });

  it("finds a trail by path only with all three parts matching", async () => {
    const a = newArea();
    const slug = `shared-${randomUUID().slice(0, 6)}`;
    const one = await insertTrail({ slug, regionSlug: "region-one", lines: [[[a.lng, a.lat], [a.lng + 0.01, a.lat]]] });
    const two = await insertTrail({ slug, regionSlug: "region-two", lines: [[[a.lng, a.lat + 0.01], [a.lng + 0.01, a.lat + 0.01]]] });
    expect((await getTrailDetailByPath("ch", "region-one", slug))?.id).toBe(one.id);
    expect((await getTrailDetailByPath("ch", "region-two", slug))?.id).toBe(two.id);
    expect(await getTrailDetailByPath("fr", "region-one", slug)).toBeNull();
  });
});

describe("trail detail POIs", () => {
  it("includes outdoor POIs within 250 m of the route or 600 m of the trailhead, nearest first", async () => {
    const a = newArea();
    // Route: 2 km east from the trailhead.
    const end = a.lng + dLng(2000);
    const t = await insertTrail({ lines: [[[a.lng, a.lat], [end, a.lat]]], trailhead: [a.lng, a.lat] });
    const mid = a.lng + dLng(1000);
    const on = await insertPoi("viewpoint", mid, a.lat + dLat(20), { name: "On route" });
    const near = await insertPoi("drinking_water", mid, a.lat + dLat(200));
    const farFromRoute = await insertPoi("waterfall", mid, a.lat + dLat(300)); // excluded: 300 m from route, far from trailhead
    const byTrailhead = await insertPoi("parking", a.lng - dLng(500), a.lat); // 500 m from route start/trailhead
    const tooFarFromTrailhead = await insertPoi("toilets", a.lng - dLng(700), a.lat);
    const service = await insertPoi("restaurant", mid, a.lat + dLat(10), { layer: "services" });

    const d = (await getTrailDetailById(t.id))!;
    expect(d.pois.map((p) => p.id)).toEqual([on, near, byTrailhead]);
    const ids = d.pois.map((p) => p.id);
    for (const excluded of [farFromRoute, tooFarFromTrailhead, service]) expect(ids).not.toContain(excluded);

    const [p0, p1, p2] = d.pois;
    expect(p0).toMatchObject({
      category: "viewpoint",
      name: "On route",
      elevationM: 812,
      openingHours: "Mo-Su 06:00-20:00",
      website: "https://example.org/poi",
      phone: "+41 00 000 00 00",
      sourceName: "OpenStreetMap",
    });
    expect(p0.lng).toBeCloseTo(mid, 9);
    // distanceM is the distance to the ROUTE (metres, rounded).
    expect(p0.distanceM).toBeGreaterThanOrEqual(18);
    expect(p0.distanceM).toBeLessThanOrEqual(22);
    expect(p1.distanceM).toBeGreaterThanOrEqual(195);
    expect(p1.distanceM).toBeLessThanOrEqual(205);
    expect(p2.distanceM).toBeGreaterThanOrEqual(495);
    expect(p2.distanceM).toBeLessThanOrEqual(505);
  });

  it("without a trailhead, only route proximity counts", async () => {
    const a = newArea();
    const t = await insertTrail({ lines: [[[a.lng, a.lat], [a.lng + dLng(1000), a.lat]]], trailhead: null });
    await insertPoi("parking", a.lng - dLng(400), a.lat);
    const close = await insertPoi("parking", a.lng - dLng(100), a.lat);
    expect((await getTrailDetailById(t.id))!.pois.map((p) => p.id)).toEqual([close]);
  });

  it(`caps the list at ${POI_LIMIT} POIs`, async () => {
    const a = newArea();
    const t = await insertTrail({ lines: [[[a.lng, a.lat], [a.lng + dLng(3000), a.lat]]] });
    await withSystem(
      (tx) => tx`
        insert into public.catalog_pois (provider, provider_id, layer, category, location, source_name, source_license)
        select 'osm', 'node/cap-' || ${t.id}::text || '-' || i, 'outdoor', 'viewpoint',
               st_setsrid(st_makepoint(${a.lng}::float8 + i * ${dLng(15)}::float8, ${a.lat + dLat(30)}::float8), 4326)::geography,
               'OpenStreetMap', 'ODbL 1.0'
          from generate_series(1, 160) i`,
    );
    const d = (await getTrailDetailById(t.id))!;
    expect(d.pois).toHaveLength(POI_LIMIT);
    const distances = d.pois.map((p) => p.distanceM!);
    expect([...distances].sort((x, y) => x - y)).toEqual(distances);
  });

  it("credits POI providers in the attribution", async () => {
    const a = newArea();
    const t = await insertTrail({ lines: [[[a.lng, a.lat], [a.lng + dLng(500), a.lat]]] });
    await insertPoi("campsite", a.lng + dLng(100), a.lat, { provider: "ridb" });
    const d = (await getTrailDetailById(t.id))!;
    expect(d.attribution.map((x) => x.name)).toEqual(["© OpenStreetMap contributors", "Recreation.gov (RIDB)"]);
  });
});

describe("detail geometry simplification", () => {
  it(`returns geometry up to ${DETAIL_SIMPLIFY_VERTEX_THRESHOLD} vertices unchanged`, async () => {
    const a = newArea();
    const t = await insertTrail({ lines: [[[a.lng, a.lat]]], vertices: DETAIL_SIMPLIFY_VERTEX_THRESHOLD, trailhead: null });
    const d = (await getTrailDetailById(t.id))!;
    expect(d.geometry.coordinates).toHaveLength(1);
    expect(d.geometry.coordinates[0]).toHaveLength(DETAIL_SIMPLIFY_VERTEX_THRESHOLD);
  });

  it("simplifies larger geometry (~5 m tolerance), keeping its endpoints and full bbox", async () => {
    const a = newArea();
    const n = DETAIL_SIMPLIFY_VERTEX_THRESHOLD + 1;
    const t = await insertTrail({ lines: [[[a.lng, a.lat]]], vertices: n, trailhead: null });
    const d = (await getTrailDetailById(t.id))!;
    const line = d.geometry.coordinates[0];
    // The wave deviates ~1 cm from a straight line: well under the tolerance.
    expect(line.length).toBeGreaterThanOrEqual(2);
    expect(line.length).toBeLessThan(100);
    expect(line[0][0]).toBeCloseTo(a.lng, 6);
    expect(line[line.length - 1][0]).toBeCloseTo(a.lng + (n - 1) * 0.00001, 6);
    expect(d.bbox[2]).toBeCloseTo(a.lng + (n - 1) * 0.00001, 9);
  });

  it("removes only deviations below ~5 m", async () => {
    const n = DETAIL_SIMPLIFY_VERTEX_THRESHOLD + 1;
    const a = newArea();
    // 3 m wiggles disappear entirely.
    const small = await insertTrail({ lines: [[[a.lng, a.lat]]], vertices: n, amplitudeDeg: dLat(3), trailhead: null });
    expect((await getTrailDetailById(small.id))!.geometry.coordinates[0].length).toBeLessThan(100);
    // 20 m bends survive: fewer vertices, but every crest/trough is still within ~5 m.
    const base = a.lat + 0.05;
    const large = await insertTrail({ lines: [[[a.lng, base]]], vertices: n, amplitudeDeg: dLat(20), trailhead: null });
    const line = (await getTrailDetailById(large.id))!.geometry.coordinates[0];
    expect(line.length).toBeLessThan(n);
    expect(line.length).toBeGreaterThan(400); // ≥ 2 vertices per bend for 200 bends
    const lats = line.map(([, y]) => y);
    expect(Math.max(...lats)).toBeGreaterThan(base + dLat(15));
    expect(Math.min(...lats)).toBeLessThan(base - dLat(15));
  });
});

describe("getTrailSummariesByIds", () => {
  it("preserves input order and skips unknown, hidden, invalid and duplicate ids", async () => {
    const a = newArea();
    const seg = (dy: number): Line[] => [[[a.lng, a.lat + dy], [a.lng + 0.01, a.lat + dy]]];
    const t1 = await insertTrail({ name: "One", lines: seg(0) });
    const t2 = await insertTrail({ name: "Two", lines: seg(0.01) });
    const t3 = await insertTrail({ name: "Three", lines: seg(0.02) });
    const hidden = await insertTrail({ name: "Hidden", lines: seg(0.03), hidden: true });
    const r = await getTrailSummariesByIds([t3.id, randomUUID(), t1.id, "nope", hidden.id, t3.id.toUpperCase(), t2.id]);
    expect(r.map((x) => x.name)).toEqual(["Three", "One", "Two"]);
    expect(r[0]).toMatchObject({ id: t3.id, path: `/trail/ch/test-region/${t3.slug}` });
  });

  it("returns [] without querying for empty or invalid input", async () => {
    expect(await getTrailSummariesByIds([])).toEqual([]);
    expect(await getTrailSummariesByIds(["x", "1; select 1"])).toEqual([]);
    expect(await getTrailSummariesByIds(null as unknown as string[])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("mappers and attribution helpers", () => {
  const baseRow: TrailDetailRow = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Row",
    nameEn: null,
    slug: "row",
    countryCode: "us",
    regionSlug: "r",
    regionName: null,
    nearestPlace: null,
    centroidLng: 1,
    centroidLat: 2,
    trailheadLng: null,
    trailheadLat: null,
    distanceM: 100,
    routeType: "spiral",
    elevationGainM: null,
    estimatedDurationMin: null,
    difficulty: "insane",
    difficultySource: "guess",
    features: ["waterfall", "volcano"],
    dogPolicy: "cats_only",
    feeRequired: null,
    permitRequired: null,
    hasParking: false,
    hasToilets: false,
    hasCamping: false,
    familyFriendly: false,
    provider: "acme",
    sourceName: "ACME Trails",
    lastSyncedAt: new Date("2026-11-01T00:00:00Z"),
    timezone: null,
    geometryJson: '{"type":"MultiLineString","coordinates":[[[1,2,300],[3,4,310]],[[5,6]]]}',
    vertexCount: 3,
    bboxWest: 1,
    bboxSouth: 2,
    bboxEast: 3,
    bboxNorth: 4,
    trailheadSource: "telepathy",
    elevationLossM: null,
    maxElevationM: null,
    minElevationM: null,
    elevationProfile: [[0, 1], [10, "x"]],
    elevationSource: "Lidar survey",
    sacScale: null,
    trailVisibility: null,
    surfaces: null,
    activities: null,
    description: null,
    wheelchair: "rolling",
    access: null,
    seasonality: null,
    operator: null,
    website: null,
    hasDrinkingWater: false,
    sourceUrl: "https://acme.example/trails/1",
    sourceLicense: "CC BY 4.0",
    sourceUpdatedAt: null,
  };

  it("maps unexpected vocabulary values to unknown/null rather than passing them through", () => {
    const d = toDetailDto(baseRow, []);
    expect(d).toMatchObject({
      routeType: "unknown",
      difficulty: "unknown",
      difficultySource: null,
      features: ["waterfall"],
      dogPolicy: "unknown",
      wheelchair: "unknown",
      trailheadSource: null,
      elevationProfile: null,
      surfaces: [],
      activities: [],
      lastSyncedAt: "2026-11-01T00:00:00.000Z",
    });
    // 3D coordinates are reduced to 2D; one-point lines are dropped.
    expect(d.geometry).toEqual({ type: "MultiLineString", coordinates: [[[1, 2], [3, 4]]] });
    // Unknown provider: credited by its own stored source fields, no invented URL/license.
    expect(d.attribution).toEqual([
      { name: "ACME Trails", url: "https://acme.example/trails/1", license: "CC BY 4.0" },
      { name: "Elevation: Lidar survey", url: null, license: null },
    ]);
    expect(toSummaryDto(baseRow).path).toBe("/trail/us/r/row");
  });

  it("parseGeometry and parseElevationProfile reject malformed input", () => {
    expect(parseGeometry("not json")).toEqual({ type: "MultiLineString", coordinates: [] });
    expect(parseGeometry('{"type":"Point","coordinates":[1,2]}')).toEqual({ type: "MultiLineString", coordinates: [] });
    expect(parseGeometry('{"type":"LineString","coordinates":[[1,2],[3,4]]}')).toEqual({
      type: "MultiLineString",
      coordinates: [[[1, 2], [3, 4]]],
    });
    expect(parseElevationProfile(null)).toBeNull();
    expect(parseElevationProfile([[0, 1]])).toBeNull();
    expect(parseElevationProfile({ a: 1 })).toBeNull();
    expect(parseElevationProfile([[0, 100], [5, 101.5]])).toEqual([[0, 100], [5, 101.5]]);
  });

  it("toPoiDto drops rows outside the category vocabulary", () => {
    const poi: PoiRow = {
      id: "p",
      category: "spaceport",
      name: null,
      lng: 1,
      lat: 2,
      distanceM: 5,
      elevationM: null,
      openingHours: null,
      website: null,
      phone: null,
      sourceName: "OpenStreetMap",
      provider: "osm",
    };
    expect(toPoiDto(poi)).toBeNull();
    expect(toPoiDto({ ...poi, category: "peak" })).toMatchObject({ category: "peak", distanceM: 5 });
  });

  it("catalogAttribution de-duplicates and never invents URLs or licenses", () => {
    expect(catalogAttribution(["osm", "OSM", "ridb", "osm", "", "acme"])).toEqual([
      OSM_ATTRIBUTION,
      { name: "Recreation.gov (RIDB)", url: "https://ridb.recreation.gov", license: "US Government work (public domain)" },
      { name: "acme", url: null, license: null },
    ]);
    expect(catalogAttribution([])).toEqual([]);
    expect(elevationAttribution(null)).toBeNull();
  });
});
