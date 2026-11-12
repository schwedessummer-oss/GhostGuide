/**
 * Real Overpass samples (tests/fixtures/osm/*.json, see the README there):
 * the parser against genuine OSM data, plus query/parser agreement — every
 * element the production query returned must be accepted by the parser's
 * own rules.
 *
 * Assertions are facts about the samples (named routes, plausible lengths,
 * categories that must be present, invariants every element satisfies),
 * not exact element counts, so tuning the parser does not mean rewriting
 * this file. Refreshing a sample may still change the named facts.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OUTDOOR_POI_CATEGORIES, SERVICE_POI_CATEGORIES, type CatalogLayer } from "@/domain/catalog";
import {
  GAP_JOIN_TOLERANCE_M,
  LOOP_CLOSURE_TOLERANCE_M,
  dedupeConsecutive,
  isValidLngLat,
  totalLengthM,
} from "@/server/trails/providers/osm/geometry";
import { parseOverpassResponse } from "@/server/trails/providers/osm/parse";
import { TRAIL_PROVENANCE_KEYS, POI_PROVENANCE_KEYS, classifyPoi, isTrailWayCandidate } from "@/server/trails/providers/osm/tags";
import type { Line, NormalizedTrail, ProviderAreaResult } from "@/server/trails/types";

interface RawPoint {
  lat: number;
  lon: number;
}
interface RawElement {
  type: "node" | "way" | "relation";
  id: number;
  tags?: Record<string, string>;
  geometry?: RawPoint[];
  center?: RawPoint;
  members?: { type: string; ref: number; role: string; geometry?: RawPoint[] }[];
  lat?: number;
  lon?: number;
}
interface RawResponse {
  elements: RawElement[];
  osm3s: { timestamp_osm_base: string };
  remark?: string;
}

const fixtureUrl = (name: string) => new URL(`../../fixtures/osm/${name}`, import.meta.url);

function load(name: string): RawResponse {
  return JSON.parse(readFileSync(fixtureUrl(name), "utf8"));
}

const countBy = <T,>(items: readonly T[], key: (t: T) => string) => {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
};

const trailById = (r: ProviderAreaResult, id: string): NormalizedTrail => {
  const t = r.trails.find((x) => x.providerId === id);
  if (!t) throw new Error(`missing ${id}; have ${r.trails.map((x) => x.providerId).join(", ")}`);
  return t;
};

/** Invariants every parse result must satisfy, whatever the sample. */
function expectWellFormed(layer: CatalogLayer, raw: RawResponse, r: ProviderAreaResult) {
  expect(raw.remark).toBeUndefined(); // a runtime-error response must never become a fixture
  expect(r.dataTimestamp).toEqual(new Date(raw.osm3s.timestamp_osm_base));

  const ids = [...r.trails.map((t) => t.providerId), ...r.pois.map((p) => p.providerId)];
  expect(new Set(ids).size).toBe(ids.length);

  for (const t of r.trails) {
    expect(t.provider).toBe("osm");
    expect(t.providerId).toMatch(/^(relation|waygroup)\/[1-9]\d*$/);
    const [kind, id] = t.providerId.split("/");
    expect(t.sourceUrl).toBe(`https://www.openstreetmap.org/${kind === "waygroup" ? "way" : "relation"}/${id}`);
    expect(t.name.trim()).toBe(t.name);
    expect(t.name.length).toBeGreaterThan(0);
    expect(totalLengthM(t.lines)).toBeGreaterThanOrEqual(400);
    expect(["loop", "linear", "network"]).toContain(t.routeType);
    expect(t.lines.length).toBeGreaterThan(0);
    if (t.routeType !== "network") {
      // One walkable path: each line continues where the previous one ends (undrawn gaps ≤ 20 m).
      for (let i = 1; i < t.lines.length; i++) {
        const prev = t.lines[i - 1];
        expect(totalLengthM([[prev[prev.length - 1], t.lines[i][0]]])).toBeLessThanOrEqual(GAP_JOIN_TOLERANCE_M);
      }
      const last = t.lines[t.lines.length - 1];
      const endsApartM = totalLengthM([[t.lines[0][0], last[last.length - 1]]]);
      if (t.routeType === "loop") expect(endsApartM).toBeLessThanOrEqual(LOOP_CLOSURE_TOLERANCE_M);
      else expect(endsApartM).toBeGreaterThan(LOOP_CLOSURE_TOLERANCE_M);
    }
    for (const line of t.lines) {
      expect(line.length).toBeGreaterThanOrEqual(2);
      for (const [lng, lat] of line) expect(isValidLngLat(lng, lat)).toBe(true); // also rejects NaN
    }
    for (const k of Object.keys(t.tags)) expect(TRAIL_PROVENANCE_KEYS as readonly string[]).toContain(k);
    expect(t.sourceName).toBe("OpenStreetMap contributors");
    expect(t.sourceLicense).toBe("ODbL 1.0");
    expect(t.sourceUpdatedAt).toEqual(r.dataTimestamp);
    if (t.description !== null) expect([...t.description].length).toBeLessThanOrEqual(2000);
    if (t.website !== null) expect(t.website).toMatch(/^https?:\/\//);
  }

  const allowed: readonly string[] = layer === "outdoor" ? OUTDOOR_POI_CATEGORIES : SERVICE_POI_CATEGORIES;
  for (const p of r.pois) {
    expect(allowed).toContain(p.category);
    expect(p.layer).toBe(layer);
    expect(p.providerId).toMatch(/^(node|way|relation)\/[1-9]\d*$/);
    expect(p.sourceUrl).toBe(`https://www.openstreetmap.org/${p.providerId}`);
    expect(isValidLngLat(p.lng, p.lat)).toBe(true);
    for (const k of Object.keys(p.tags)) expect(POI_PROVENANCE_KEYS as readonly string[]).toContain(k);
    if (p.website !== null) expect(p.website).toMatch(/^https?:\/\/[^\s]+$/);
    if (p.elevationM !== null) expect(Number.isInteger(p.elevationM)).toBe(true);
    if (p.name !== null) expect(p.name.length).toBeGreaterThan(0);
  }
}

/** Every element returned by the production query is accepted by the parser's rules. */
function expectQueryParserAgreement(layer: CatalogLayer, elements: RawElement[]) {
  for (const e of elements) {
    if (e.type === "way" && e.geometry) expect(isTrailWayCandidate(e.tags ?? {}), `way/${e.id}`).toBe(true);
    else if (e.type === "node" || e.center) expect(classifyPoi(layer, e.type, e.tags ?? {}), `${e.type}/${e.id}`).not.toBeNull();
  }
}

/** Total length of a relation's unique member ways, straight from the raw geometry. */
function memberGeometryLengthM(rel: RawElement): number {
  const seen = new Set<number>();
  const lines: Line[] = [];
  for (const m of rel.members ?? []) {
    if (m.type !== "way" || !m.geometry || seen.has(m.ref)) continue;
    seen.add(m.ref);
    const line = dedupeConsecutive(m.geometry.map((p) => [p.lon, p.lat]));
    if (line) lines.push(line);
  }
  return totalLengthM(lines);
}

describe("osm fixtures: Table Rock State Park, SC (outdoor)", () => {
  const raw = load("table-rock-outdoor.json");
  const r = parseOverpassResponse("outdoor", raw);
  const routes = r.trails.filter((t) => t.providerId.startsWith("relation/"));
  const groups = r.trails.filter((t) => t.providerId.startsWith("waygroup/"));

  it("is well formed and agrees with the query", () => {
    expectWellFormed("outdoor", raw, r);
    expectQueryParserAgreement("outdoor", raw.elements);
  });

  it("finds the park's hiking route relations, built from their member geometry", () => {
    expect(routes.length).toBeGreaterThanOrEqual(8);
    expect(r.trails.map((t) => t.name)).toEqual(
      expect.arrayContaining(["Table Rock Trail", "Pinnacle Mountain Trail", "Carrick Creek Loop Trail", "Mountain Laurel Trail"]),
    );
    for (const t of routes) {
      const rel = raw.elements.find((e) => e.type === "relation" && `relation/${e.id}` === t.providerId)!;
      expect(rel.tags?.route).toBe("hiking");
      // Every mapped metre of the members is in the trail, and nothing is added (gaps are not drawn).
      expect(totalLengthM(t.lines)).toBeCloseTo(memberGeometryLengthM(rel), 0);
      // Plausible hiking-route lengths: from short spurs to multi-day passages.
      expect(totalLengthM(t.lines)).toBeLessThan(100_000);
    }
  });

  it("classifies route types from the geometry", () => {
    const types = new Set(r.trails.map((t) => t.routeType));
    expect(types.has("linear")).toBe(true);
    expect(types.has("network")).toBe(true);

    // Table Rock Trail: two members whose ends are 4 m apart but not joined → still one linear route.
    const tableRock = trailById(r, "relation/6011996");
    expect(tableRock.routeType).toBe("linear");
    expect(tableRock.lines).toHaveLength(2); // the gap is kept, not drawn
    expect(totalLengthM(tableRock.lines)).toBeGreaterThan(5000);
    expect(totalLengthM(tableRock.lines)).toBeLessThan(6000);

    // Palmetto Trail passage: real 68 m / 75 m gaps between its sections → network.
    expect(trailById(r, "relation/6110070").routeType).toBe("network");

    // Named "Loop", but the mapped relation does not close (its ends are ~220 m apart):
    // the geometry decides, never the name or a roundtrip tag.
    expect(trailById(r, "relation/6002349").routeType).toBe("linear");
  });

  it("aggregates attributes from member ways and keeps route-level text from the relation", () => {
    const tableRock = trailById(r, "relation/6011996");
    expect(tableRock.sacScale).toBe("mountain_hiking"); // from member ways, not the relation
    expect(tableRock.surfaces).toEqual(expect.arrayContaining(["dirt", "rock"]));
    expect(tableRock.activities).toEqual(expect.arrayContaining(["hiking"]));
    expect(tableRock.tags).toMatchObject({ name: "Table Rock Trail", route: "hiking" });
    // Nothing the source does not say.
    expect(tableRock).toMatchObject({ dogPolicy: "unknown", wheelchair: "unknown", feeRequired: null, permitRequired: null, description: null });

    const spur = trailById(r, "relation/16807600");
    expect(spur.operator).toBe("Foothills Trail Conservancy");
    expect(spur.tags).toMatchObject({ from: "Sassafras Mountain", to: "Caeser's Head State Park" });

    for (const t of r.trails) {
      expect(t.activities.length).toBeGreaterThan(0); // every trail here is tagged as a hiking route or footway
      if (t.sacScale !== null) expect(["hiking", "mountain_hiking", "demanding_mountain_hiking"]).toContain(t.sacScale);
    }
  });

  it("emits standalone named trails as way groups, never a route's member ways again", () => {
    expect(groups.length).toBeGreaterThan(0);
    const memberRefs = new Set(raw.elements.flatMap((e) => (e.type === "relation" ? (e.members ?? []).map((m) => m.ref) : [])));
    for (const g of groups) expect(memberRefs.has(Number(g.providerId.split("/")[1]))).toBe(false);

    const lakeside = groups.find((t) => t.name === "Lakeside Trail")!;
    expect(lakeside).toMatchObject({ trailVisibility: "good", surfaces: ["dirt"], wheelchair: "no", activities: ["walking"] });
    expect(lakeside.tags).toMatchObject({ name: "Lakeside Trail", highway: "footway" });
  });

  it("normalizes outdoor POIs (nature features, facilities, elevations)", () => {
    const counts = countBy(r.pois, (p) => p.category);
    for (const c of ["peak", "waterfall", "viewpoint", "parking", "toilets", "campsite", "lake"]) expect(counts[c], c).toBeGreaterThan(0);

    const tableRock = r.pois.find((p) => p.providerId === "node/357090074")!;
    expect(tableRock).toMatchObject({ category: "peak", name: "Table Rock" });
    expect(tableRock.elevationM).toBeGreaterThan(900);
    expect(tableRock.elevationM).toBeLessThan(1000);
    expect(r.pois.find((p) => p.providerId === "relation/8852659")).toMatchObject({ category: "lake", name: "Pinnacle Lake" });
    // Every peak in the sample carries its mapped elevation.
    for (const p of r.pois.filter((x) => x.category === "peak")) expect(p.elevationM).not.toBeNull();
  });

  it("has nothing for the services layer (the outdoor query asks for no service POIs)", () => {
    expect(parseOverpassResponse("services", raw)).toMatchObject({ trails: [], pois: [] });
  });

  it("is deterministic", () => {
    expect(parseOverpassResponse("outdoor", load("table-rock-outdoor.json"))).toEqual(r);
  });
});

describe("osm fixtures: downtown Greenville, SC — Falls Park (urban outdoor)", () => {
  const raw = load("greenville-falls-park-outdoor.json");
  const r = parseOverpassResponse("outdoor", raw);
  const trailWays = raw.elements.filter((e) => e.type === "way" && e.geometry);

  it("is well formed and agrees with the query", () => {
    expectWellFormed("outdoor", raw, r);
    expectQueryParserAgreement("outdoor", raw.elements);
  });

  it("the query returns no sidewalks, crossings or areas, only named trail ways", () => {
    expect(trailWays.length).toBeGreaterThan(0);
    for (const w of trailWays) {
      expect(["path", "footway", "bridleway", "steps", "track"]).toContain(w.tags?.highway);
      expect(w.tags?.name?.trim()).toBeTruthy();
    }
    for (const e of raw.elements) {
      expect(["sidewalk", "crossing", "access_aisle", "traffic_island"]).not.toContain(e.tags?.footway);
      if (e.geometry) expect(e.tags?.area).not.toBe("yes");
    }
    expect(trailWays.map((w) => w.tags?.name)).toContain("Swamp Rabbit Trail");
  });

  it("drops in-tile pieces shorter than 400 m; without the minimum they are way groups", () => {
    for (const t of r.trails) expect(totalLengthM(t.lines)).toBeGreaterThanOrEqual(400);
    const all = parseOverpassResponse("outdoor", raw, { minTrailLengthM: 0 });
    expect(all.trails.length).toBeGreaterThan(r.trails.length);
    expect(all.trails.every((t) => t.providerId.startsWith("waygroup/"))).toBe(true);
    expect(all.trails.map((t) => t.name)).toContain("Swamp Rabbit Trail");
  });

  it("keeps urban POIs: parking dominates, plus named park features", () => {
    const counts = countBy(r.pois, (p) => p.category);
    for (const [c, n] of Object.entries(counts)) if (c !== "parking") expect(counts.parking).toBeGreaterThan(n);
    for (const c of ["toilets", "drinking_water", "viewpoint", "waterfall"]) expect(counts[c], c).toBeGreaterThan(0);
    expect(r.pois.find((p) => p.providerId === "node/446428577")).toMatchObject({ category: "waterfall", name: "Reedy River Falls" });
    // A pedestrian area that is also a viewpoint comes back with a centre.
    expect(r.pois.find((p) => p.providerId === "way/560583247")).toMatchObject({ category: "viewpoint", name: "Paul B. Ellis, III Overlook" });
  });
});

/**
 * Services sample (Travelers Rest, SC). Not fetched yet: overpass-api.de was
 * unreachable when the fixtures were built (see the README). This block runs
 * as soon as the real response is saved under that name; it is skipped, never
 * faked, while the file is missing.
 */
const SERVICES_FIXTURE = "services-travelers-rest.json";
describe.skipIf(!existsSync(fixtureUrl(SERVICES_FIXTURE)))("osm fixtures: Travelers Rest, SC (services)", () => {
  const raw = existsSync(fixtureUrl(SERVICES_FIXTURE)) ? load(SERVICES_FIXTURE) : { elements: [], osm3s: { timestamp_osm_base: "" } };
  const r = parseOverpassResponse("services", raw);

  it("is well formed and agrees with the query", () => {
    expectWellFormed("services", raw, r);
    expectQueryParserAgreement("services", raw.elements);
  });

  it("returns service POIs only: no trail geometry, no outdoor categories", () => {
    expect(r.trails).toEqual([]);
    for (const e of raw.elements) {
      expect(e.geometry, `${e.type}/${e.id}`).toBeUndefined();
      expect(e.members, `${e.type}/${e.id}`).toBeUndefined();
    }
    expect(parseOverpassResponse("outdoor", raw).trails).toEqual([]);
  });

  it("maps a small town's services onto several catalog categories", () => {
    const counts = countBy(r.pois, (p) => p.category);
    expect(Object.keys(counts).length).toBeGreaterThanOrEqual(3);
    expect(counts.restaurant ?? 0).toBeGreaterThan(0);
    // Most services are named; contact fields are only ever copied, never made up.
    expect(r.pois.filter((p) => p.name !== null).length).toBeGreaterThan(r.pois.length / 2);
    for (const p of r.pois) {
      const el = raw.elements.find((e) => `${e.type}/${e.id}` === p.providerId)!;
      if (p.openingHours !== null) expect(el.tags?.opening_hours).toBeDefined();
      if (p.phone !== null) expect(el.tags?.phone ?? el.tags?.["contact:phone"]).toBeDefined();
    }
  });
});
