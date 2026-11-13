/**
 * searchTrails against PostGIS: bbox intersection (including edges), every
 * filter of trailSearchQuerySchema, out-and-back semantics for linear
 * routes, text search, sorts, limit/total and RLS-hidden rows.
 *
 * Each test inserts its own trails into its own area (no other test file
 * uses these longitudes), so tests do not see each other's rows.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { formatBbox, trailSearchQuerySchema, type Bbox } from "@/domain/catalog";
import { closeDb, withSystem, type JsonValue } from "@/server/db";
import { searchTrails } from "@/server/trails/read";

afterAll(closeDb);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
type Line = [number, number][];

interface TrailSeed {
  name?: string;
  nameEn?: string | null;
  lines: Line[];
  routeType?: "loop" | "linear" | "network" | "unknown";
  distanceM?: number;
  gain?: number | null;
  loss?: number | null;
  duration?: number | null;
  difficulty?: string;
  features?: string[];
  activities?: string[];
  dogPolicy?: string;
  fee?: boolean | null;
  permit?: boolean | null;
  parking?: boolean;
  toilets?: boolean;
  camping?: boolean;
  family?: boolean;
  quality?: number;
  hidden?: boolean;
  nearestPlace?: string | null;
  regionName?: string | null;
  trailhead?: [number, number] | null;
}

async function insertTrail(seed: TrailSeed): Promise<string> {
  const geojson = { type: "MultiLineString", coordinates: seed.lines };
  const name = seed.name ?? `Trail ${randomUUID().slice(0, 6)}`;
  const slug = `t-${randomUUID().slice(0, 12)}`;
  const th = seed.trailhead === undefined ? seed.lines[0][0] : seed.trailhead;
  const [row] = await withSystem(
    (tx) => tx<{ id: string }[]>`
      with g as (select st_setsrid(st_geomfromgeojson(${JSON.stringify(geojson)}), 4326) as geom)
      insert into public.catalog_trails (
        provider, provider_id, name, name_en, slug, country_code, region_name, region_slug, nearest_place,
        centroid, trailhead, trailhead_source, geom, distance_m, route_type,
        elevation_gain_m, elevation_loss_m, estimated_duration_min, difficulty, difficulty_source,
        features, activities, dog_policy, fee_required, permit_required,
        has_parking, has_toilets, has_camping, family_friendly,
        source_name, source_license, quality_score, hidden, tags)
      select 'osm', ${`way/${randomUUID()}`}, ${name}, ${seed.nameEn ?? null}, ${slug}, 'us', ${seed.regionName ?? "Testland"},
        'testland', ${seed.nearestPlace ?? null},
        st_centroid(g.geom)::geography,
        case when ${th ? th[0] : null}::float8 is null then null
             else st_setsrid(st_makepoint(${th ? th[0] : null}::float8, ${th ? th[1] : null}::float8), 4326)::geography end,
        case when ${th ? th[0] : null}::float8 is null then null else 'route_start' end,
        g.geom, ${seed.distanceM ?? 1000}, ${seed.routeType ?? "loop"},
        ${seed.gain === undefined ? 100 : seed.gain}, ${seed.loss === undefined ? null : seed.loss},
        ${seed.duration === undefined ? 30 : seed.duration}, ${seed.difficulty ?? "easy"}, 'estimated',
        ${seed.features ?? []}::text[], ${seed.activities ?? ["hiking"]}::text[], ${seed.dogPolicy ?? "unknown"},
        ${seed.fee === undefined ? null : seed.fee}::boolean, ${seed.permit === undefined ? null : seed.permit}::boolean,
        ${seed.parking ?? false}, ${seed.toilets ?? false}, ${seed.camping ?? false}, ${seed.family ?? false},
        'OpenStreetMap', 'ODbL 1.0', ${seed.quality ?? 50}, ${seed.hidden ?? false}, ${tx.json({} as JsonValue)}
      from g
      returning id`,
  );
  return row.id;
}

let areaSeq = 0;
/** A fresh 0.2° × 0.2° search area; `seg(dx, dy)` is a short east-west line at an offset from its centre. */
function newArea() {
  const lng = -119.5 + areaSeq++ * 0.4;
  const lat = 38;
  const bbox: Bbox = [lng - 0.1, lat - 0.1, lng + 0.1, lat + 0.1];
  const seg = (dx = 0, dy = 0, len = 0.01): Line => [
    [lng + dx, lat + dy],
    [lng + dx + len, lat + dy],
  ];
  return { lng, lat, bbox, seg };
}

const search = (bbox: Bbox, params: Record<string, string> = {}) =>
  searchTrails(trailSearchQuerySchema.parse({ bbox: formatBbox(bbox), ...params }));
const idsOf = (r: { trails: { id: string }[] }) => r.trails.map((t) => t.id);
const sorted = (ids: string[]) => [...ids].sort();

// ---------------------------------------------------------------------------
describe("searchTrails: area", () => {
  it("returns trails intersecting the bbox, including ones crossing or touching its edge", async () => {
    const a = newArea();
    const [, , e, n] = a.bbox;
    const inside = await insertTrail({ lines: [a.seg()] });
    const crossing = await insertTrail({ lines: [[[e - 0.01, a.lat], [e + 0.05, a.lat]]] });
    const touching = await insertTrail({ lines: [[[e, a.lat + 0.02], [e + 0.05, a.lat + 0.02]]] });
    const outside = await insertTrail({ lines: [[[e + 0.01, a.lat], [e + 0.05, a.lat]]] });
    // Its bounding box overlaps the area's north-east corner but the line itself passes outside it:
    // a bbox-only (&&) test would wrongly include it.
    // (Every point of the line has x + y = e + n + 0.045; inside the area x + y <= e + n.)
    const cornerMiss = await insertTrail({ lines: [[[e + 0.05, n - 0.005], [e - 0.005, n + 0.05]]] });
    const r = await search(a.bbox);
    expect(sorted(idsOf(r))).toEqual(sorted([inside, crossing, touching]));
    expect(r.total).toBe(3);
    expect(idsOf(r)).not.toContain(outside);
    expect(idsOf(r)).not.toContain(cornerMiss);
  });

  it("never returns hidden (moderated) trails", async () => {
    const a = newArea();
    const visible = await insertTrail({ lines: [a.seg()] });
    await insertTrail({ lines: [a.seg(0.02)], hidden: true });
    const r = await search(a.bbox);
    expect(idsOf(r)).toEqual([visible]);
    expect(r.total).toBe(1);
  });

  it("returns an empty result for an empty area", async () => {
    const a = newArea();
    expect(await search(a.bbox)).toEqual({ trails: [], total: 0 });
  });

  it("maps rows to summary DTOs with the canonical path and one-traversal values", async () => {
    const a = newArea();
    const id = await insertTrail({
      name: "Ridge Loop",
      nameEn: "Ridge Loop EN",
      lines: [a.seg(0, 0, 0.02)],
      routeType: "linear",
      distanceM: 1800,
      gain: 120,
      duration: 40,
      difficulty: "moderate",
      features: ["waterfall", "viewpoint"],
      dogPolicy: "leashed",
      fee: false,
      permit: null,
      parking: true,
      family: true,
      nearestPlace: "Pinesville",
      trailhead: [a.lng, a.lat],
    });
    const [t] = (await search(a.bbox)).trails;
    expect(t).toMatchObject({
      id,
      name: "Ridge Loop",
      nameEn: "Ridge Loop EN",
      countryCode: "us",
      regionName: "Testland",
      nearestPlace: "Pinesville",
      trailhead: { lng: a.lng, lat: a.lat },
      distanceM: 1800,
      routeType: "linear",
      elevationGainM: 120,
      estimatedDurationMin: 40,
      difficulty: "moderate",
      difficultySource: "estimated",
      features: ["waterfall", "viewpoint"],
      dogPolicy: "leashed",
      feeRequired: false,
      permitRequired: null,
      hasParking: true,
      hasToilets: false,
      hasCamping: false,
      familyFriendly: true,
      provider: "osm",
      sourceName: "OpenStreetMap",
    });
    expect(t.path).toMatch(/^\/trail\/us\/testland\/t-[0-9a-f-]+$/);
    expect(t.centroid.lng).toBeCloseTo(a.lng + 0.01, 6);
    expect(t.centroid.lat).toBeCloseTo(a.lat, 6);
    expect(new Date(t.lastSyncedAt).toISOString()).toBe(t.lastSyncedAt);
  });
});

describe("searchTrails: very large areas", () => {
  it("scans only the middle of an area larger than the coverage limit (bounded work), with an exact total there", async () => {
    const name = `Window ${randomUUID().slice(0, 8)}`;
    const cx = -61.3;
    const cy = -11.2;
    const near = await insertTrail({ name, lines: [[[cx + 0.05, cy], [cx + 0.06, cy]]] });
    const far = await insertTrail({ name, lines: [[[cx + 8, cy + 5], [cx + 8.01, cy + 5]]] });
    const big: Bbox = [cx - 10, cy - 10, cx + 10, cy + 10];
    const q = trailSearchQuerySchema.parse({ bbox: formatBbox(big), q: name });

    const r = await searchTrails(q, { maxTiles: 16 });
    expect(idsOf(r)).toEqual([near]);
    expect(r.total).toBe(1);

    // Within the limit (here raised to cover the whole box), the whole box is searched.
    const all = await searchTrails(q, { maxTiles: 80 * 80 });
    expect(sorted(idsOf(all))).toEqual(sorted([near, far]));
    expect(all.total).toBe(2);
  });

  it("a world-sized box is answered quickly (the window, not the whole catalog)", async () => {
    const started = Date.now();
    const r = await search([-180, -90, 180, 90], { q: "e" });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(Array.isArray(r.trails)).toBe(true);
  });
});

describe("searchTrails: filters", () => {
  it("difficulty and routeType lists", async () => {
    const a = newArea();
    const easyLoop = await insertTrail({ lines: [a.seg(0)], difficulty: "easy", routeType: "loop" });
    const hardLinear = await insertTrail({ lines: [a.seg(0.02)], difficulty: "hard", routeType: "linear" });
    const unknownNet = await insertTrail({ lines: [a.seg(0.04)], difficulty: "unknown", routeType: "network" });
    expect(sorted(idsOf(await search(a.bbox, { difficulty: "easy,hard" })))).toEqual(sorted([easyLoop, hardLinear]));
    expect(idsOf(await search(a.bbox, { difficulty: "unknown" }))).toEqual([unknownNet]);
    expect(idsOf(await search(a.bbox, { routeType: "linear" }))).toEqual([hardLinear]);
    expect(sorted(idsOf(await search(a.bbox, { routeType: "loop,network" })))).toEqual(sorted([easyLoop, unknownNet]));
    expect(idsOf(await search(a.bbox, { difficulty: "easy", routeType: "linear" }))).toEqual([]);
  });

  it("features must all be present; activity must be listed", async () => {
    const a = newArea();
    const both = await insertTrail({ lines: [a.seg(0)], features: ["waterfall", "lake", "peak"], activities: ["hiking", "running"] });
    const one = await insertTrail({ lines: [a.seg(0.02)], features: ["waterfall"], activities: ["biking"] });
    await insertTrail({ lines: [a.seg(0.04)], features: [], activities: [] });
    expect(sorted(idsOf(await search(a.bbox, { features: "waterfall" })))).toEqual(sorted([both, one]));
    expect(idsOf(await search(a.bbox, { features: "waterfall,lake" }))).toEqual([both]);
    expect(idsOf(await search(a.bbox, { features: "cave" }))).toEqual([]);
    expect(idsOf(await search(a.bbox, { activity: "running" }))).toEqual([both]);
    expect(idsOf(await search(a.bbox, { activity: "biking" }))).toEqual([one]);
    expect(idsOf(await search(a.bbox, { activity: "horse_riding" }))).toEqual([]);
  });

  it("distance filters use the out-and-back distance for linear routes", async () => {
    const a = newArea();
    const linear3k = await insertTrail({ lines: [a.seg(0)], routeType: "linear", distanceM: 3000 }); // hike 6 km
    const loop5k = await insertTrail({ lines: [a.seg(0.02)], routeType: "loop", distanceM: 5000 });
    const net4k = await insertTrail({ lines: [a.seg(0.04)], routeType: "network", distanceM: 4000 });
    expect(sorted(idsOf(await search(a.bbox, { maxDistanceKm: "5" })))).toEqual(sorted([loop5k, net4k]));
    expect(idsOf(await search(a.bbox, { minDistanceKm: "5.5" }))).toEqual([linear3k]);
    expect(sorted(idsOf(await search(a.bbox, { minDistanceKm: "4", maxDistanceKm: "6" })))).toEqual(sorted([linear3k, loop5k, net4k]));
    expect(idsOf(await search(a.bbox, { minDistanceKm: "4.5", maxDistanceKm: "5.5" }))).toEqual([loop5k]);
    // fractional bounds are compared exactly, not truncated to integers
    expect(idsOf(await search(a.bbox, { minDistanceKm: "5.9995", maxDistanceKm: "6.0005" }))).toEqual([linear3k]);
  });

  it("maxGainM uses gain + loss for linear routes and excludes unknown climb", async () => {
    const a = newArea();
    const linear = await insertTrail({ lines: [a.seg(0)], routeType: "linear", gain: 200, loss: 150 }); // round trip 350
    const linearNoLoss = await insertTrail({ lines: [a.seg(0.02)], routeType: "linear", gain: 200, loss: null }); // 200 (lower bound)
    const loop = await insertTrail({ lines: [a.seg(0.04)], routeType: "loop", gain: 300, loss: 300 });
    await insertTrail({ lines: [a.seg(0.06)], routeType: "loop", gain: null });
    expect(sorted(idsOf(await search(a.bbox, { maxGainM: "320" })))).toEqual(sorted([linearNoLoss, loop]));
    expect(sorted(idsOf(await search(a.bbox, { maxGainM: "400" })))).toEqual(sorted([linear, linearNoLoss, loop]));
    expect(idsOf(await search(a.bbox, { maxGainM: "250" }))).toEqual([linearNoLoss]);
    expect(idsOf(await search(a.bbox, { maxGainM: "0" }))).toEqual([]);
    expect((await search(a.bbox)).total).toBe(4);
  });

  it("maxDurationMin doubles linear durations and excludes unknown durations", async () => {
    const a = newArea();
    await insertTrail({ lines: [a.seg(0)], routeType: "linear", duration: 60 }); // 120
    const loop = await insertTrail({ lines: [a.seg(0.02)], routeType: "loop", duration: 100 });
    await insertTrail({ lines: [a.seg(0.04)], routeType: "loop", duration: null });
    expect(idsOf(await search(a.bbox, { maxDurationMin: "110" }))).toEqual([loop]);
    expect((await search(a.bbox, { maxDurationMin: "120" })).total).toBe(2);
  });

  it("dogFriendly accepts allowed and leashed only", async () => {
    const a = newArea();
    const allowed = await insertTrail({ lines: [a.seg(0)], dogPolicy: "allowed" });
    const leashed = await insertTrail({ lines: [a.seg(0.02)], dogPolicy: "leashed" });
    await insertTrail({ lines: [a.seg(0.04)], dogPolicy: "not_allowed" });
    await insertTrail({ lines: [a.seg(0.06)], dogPolicy: "unknown" });
    expect(sorted(idsOf(await search(a.bbox, { dogFriendly: "1" })))).toEqual(sorted([allowed, leashed]));
    expect((await search(a.bbox, { dogFriendly: "0" })).total).toBe(4);
  });

  it("amenity flags: familyFriendly, parking, toilets, camping", async () => {
    const a = newArea();
    const fam = await insertTrail({ lines: [a.seg(0)], family: true, parking: true });
    const toil = await insertTrail({ lines: [a.seg(0.02)], toilets: true, parking: true });
    const camp = await insertTrail({ lines: [a.seg(0.04)], camping: true });
    expect(idsOf(await search(a.bbox, { familyFriendly: "true" }))).toEqual([fam]);
    expect(sorted(idsOf(await search(a.bbox, { parking: "1" })))).toEqual(sorted([fam, toil]));
    expect(idsOf(await search(a.bbox, { toilets: "1" }))).toEqual([toil]);
    expect(idsOf(await search(a.bbox, { camping: "1" }))).toEqual([camp]);
    expect(idsOf(await search(a.bbox, { parking: "1", toilets: "1" }))).toEqual([toil]);
    expect(idsOf(await search(a.bbox, { camping: "1", familyFriendly: "1" }))).toEqual([]);
  });

  it("fee and permit filters exclude unknown values", async () => {
    const a = newArea();
    const free = await insertTrail({ lines: [a.seg(0)], fee: false, permit: true });
    const paid = await insertTrail({ lines: [a.seg(0.02)], fee: true, permit: false });
    await insertTrail({ lines: [a.seg(0.04)], fee: null, permit: null });
    expect(idsOf(await search(a.bbox, { fee: "free" }))).toEqual([free]);
    expect(idsOf(await search(a.bbox, { fee: "paid" }))).toEqual([paid]);
    expect(idsOf(await search(a.bbox, { permit: "required" }))).toEqual([free]);
    expect(idsOf(await search(a.bbox, { permit: "not_required" }))).toEqual([paid]);
  });

  it("q matches name / name_en substrings and place words, treating LIKE wildcards literally", async () => {
    const a = newArea();
    const falls = await insertTrail({ lines: [a.seg(0)], name: "Raven Cliff Falls Trail" });
    const en = await insertTrail({ lines: [a.seg(0.02)], name: "Sentier du Lac", nameEn: "Lake Path" });
    const place = await insertTrail({ lines: [a.seg(0.04)], name: "Unnamed Connector", nearestPlace: "Cleveland" });
    const pct = await insertTrail({ lines: [a.seg(0.06)], name: "100% Grade_Climb" });
    expect(idsOf(await search(a.bbox, { q: "raven falls" }))).toEqual([falls]); // full text: every word, any order
    expect(idsOf(await search(a.bbox, { q: "raven fall" }))).toEqual([]); // not a substring, "fall" is not a word of the name
    expect(idsOf(await search(a.bbox, { q: "Cliff Fa" }))).toEqual([falls]); // substring
    expect(idsOf(await search(a.bbox, { q: "lake path" }))).toEqual([en]);
    expect(idsOf(await search(a.bbox, { q: "cleveland" }))).toEqual([place]);
    expect(idsOf(await search(a.bbox, { q: "%" }))).toEqual([pct]);
    expect(idsOf(await search(a.bbox, { q: "e_C" }))).toEqual([pct]);
    expect(idsOf(await search(a.bbox, { q: "_" }))).toEqual([pct]);
    expect(idsOf(await search(a.bbox, { q: "nothing like this" }))).toEqual([]);
    // websearch syntax never errors
    expect(idsOf(await search(a.bbox, { q: '"raven" -lake OR (' }))).toEqual([falls]);
    expect((await search(a.bbox, { q: "   " })).total).toBe(4);
  });

  it("applies several filters together", async () => {
    const a = newArea();
    const match = await insertTrail({
      lines: [a.seg(0)],
      difficulty: "moderate",
      routeType: "loop",
      distanceM: 6000,
      gain: 300,
      duration: 120,
      dogPolicy: "allowed",
      parking: true,
      fee: false,
      features: ["viewpoint"],
    });
    await insertTrail({
      lines: [a.seg(0.02)],
      difficulty: "moderate",
      routeType: "loop",
      distanceM: 6000,
      gain: 300,
      duration: 120,
      dogPolicy: "not_allowed",
      parking: true,
      fee: false,
      features: ["viewpoint"],
    });
    const r = await search(a.bbox, {
      difficulty: "moderate",
      routeType: "loop",
      minDistanceKm: "5",
      maxDistanceKm: "7",
      maxGainM: "400",
      maxDurationMin: "150",
      dogFriendly: "1",
      parking: "1",
      fee: "free",
      features: "viewpoint",
    });
    expect(idsOf(r)).toEqual([match]);
  });
});

describe("searchTrails: sorting and limits", () => {
  it("relevance: quality desc, then distance from the bbox centre", async () => {
    const a = newArea();
    const farHigh = await insertTrail({ lines: [a.seg(0.08, 0.08, 0.005)], quality: 90 });
    const nearLow = await insertTrail({ lines: [a.seg(0, 0, 0.002)], quality: 40 });
    const farLow = await insertTrail({ lines: [a.seg(-0.09, -0.09, 0.002)], quality: 40 });
    const midLow = await insertTrail({ lines: [a.seg(0.03, 0.03, 0.002)], quality: 40 });
    expect(idsOf(await search(a.bbox))).toEqual([farHigh, nearLow, midLow, farLow]);
    expect(idsOf(await search(a.bbox, { sort: "relevance" }))).toEqual([farHigh, nearLow, midLow, farLow]);
  });

  it("relevance with q ranks exact, then prefix name matches first", async () => {
    const a = newArea();
    const contains = await insertTrail({ lines: [a.seg(0)], name: "Old Pine Loop", quality: 99 });
    const prefix = await insertTrail({ lines: [a.seg(0.02)], name: "Pine Loop Extension", quality: 10 });
    const exact = await insertTrail({ lines: [a.seg(0.04)], name: "pine loop", quality: 5 });
    expect(idsOf(await search(a.bbox, { q: "Pine Loop" }))).toEqual([exact, prefix, contains]);
  });

  it("length sorts by hike distance (linear doubled)", async () => {
    const a = newArea();
    const linear3k = await insertTrail({ lines: [a.seg(0)], routeType: "linear", distanceM: 3000 }); // 6 km
    const loop5k = await insertTrail({ lines: [a.seg(0.02)], routeType: "loop", distanceM: 5000 });
    const loop1k = await insertTrail({ lines: [a.seg(0.04)], routeType: "loop", distanceM: 1000 });
    expect(idsOf(await search(a.bbox, { sort: "length" }))).toEqual([loop1k, loop5k, linear3k]);
  });

  it("gain sorts by round-trip climb with unknown climb last", async () => {
    const a = newArea();
    const unknown = await insertTrail({ lines: [a.seg(0)], gain: null });
    const linear = await insertTrail({ lines: [a.seg(0.02)], routeType: "linear", gain: 100, loss: 150 }); // 250
    const loop = await insertTrail({ lines: [a.seg(0.04)], routeType: "loop", gain: 200 });
    const flat = await insertTrail({ lines: [a.seg(0.06)], routeType: "loop", gain: 0 });
    expect(idsOf(await search(a.bbox, { sort: "gain" }))).toEqual([flat, loop, linear, unknown]);
  });

  it("name sorts case-insensitively", async () => {
    const a = newArea();
    const b = await insertTrail({ lines: [a.seg(0)], name: "beta Trail" });
    const c = await insertTrail({ lines: [a.seg(0.02)], name: "Charlie Trail" });
    const al = await insertTrail({ lines: [a.seg(0.04)], name: "Alpha Trail" });
    expect(idsOf(await search(a.bbox, { sort: "name" }))).toEqual([al, b, c]);
  });

  it("limit cuts the page; total counts every match", async () => {
    const a = newArea();
    for (let i = 0; i < 5; i++) await insertTrail({ lines: [a.seg(i * 0.02)], name: `Trail ${i}` });
    const r = await search(a.bbox, { limit: "2", sort: "name" });
    expect(r.trails.map((t) => t.name)).toEqual(["Trail 0", "Trail 1"]);
    expect(r.total).toBe(5);
    const filtered = await search(a.bbox, { limit: "1", q: "Trail 4" });
    expect(filtered.total).toBe(1);
  });
});
