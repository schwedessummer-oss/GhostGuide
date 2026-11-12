import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ROUTE_MEMBERS,
  DEFAULT_OVERPASS_MAXSIZE_BYTES,
  DEFAULT_OVERPASS_TIMEOUT_SEC,
  buildOverpassQuery,
  overpassBbox,
  renderCondition,
} from "@/server/trails/providers/osm/query";
import type { Bbox } from "@/domain/catalog";

const BBOX: Bbox = [-82.76, 35.02, -82.68, 35.08];
const B = "(35.02,-82.76,35.08,-82.68)";

/** Statements (lines) of a query. */
const lines = (q: string) => q.split("\n").map((l) => l.trim());

describe("osm query: settings and bbox", () => {
  it("uses JSON output with default timeout and maxsize", () => {
    const q = buildOverpassQuery("outdoor", BBOX);
    expect(DEFAULT_OVERPASS_TIMEOUT_SEC).toBe(90);
    expect(DEFAULT_OVERPASS_MAXSIZE_BYTES).toBe(268_435_456);
    expect(lines(q)[0]).toBe("[out:json][timeout:90][maxsize:268435456];");
  });

  it("honours timeout and maxsize options", () => {
    const q = buildOverpassQuery("services", BBOX, { timeoutSec: 25, maxSizeBytes: 64 * 1024 * 1024 });
    expect(lines(q)[0]).toBe("[out:json][timeout:25][maxsize:67108864];");
  });

  it("rejects invalid options", () => {
    expect(() => buildOverpassQuery("outdoor", BBOX, { timeoutSec: 0 })).toThrow(RangeError);
    expect(() => buildOverpassQuery("outdoor", BBOX, { timeoutSec: 1.5 })).toThrow(RangeError);
    expect(() => buildOverpassQuery("outdoor", BBOX, { maxSizeBytes: -1 })).toThrow(RangeError);
    expect(() => buildOverpassQuery("outdoor", BBOX, { maxRouteMembers: Number.NaN })).toThrow(RangeError);
    expect(() => buildOverpassQuery("nope" as never, BBOX)).toThrow(RangeError);
  });

  it("converts [west,south,east,north] to Overpass (south,west,north,east)", () => {
    expect(overpassBbox(BBOX)).toBe(B);
    expect(overpassBbox([-180, -90, 180, 90])).toBe("(-90,-180,90,180)");
    // No exponent notation or float noise.
    expect(overpassBbox([0.0000001, 1e-8, 0.1 + 0.2, 1])).toBe("(0,0.0000001,1,0.3)");
  });

  it("rejects invalid or empty bboxes", () => {
    expect(() => overpassBbox([0, 0, 0, 1])).toThrow(RangeError);
    expect(() => overpassBbox([10, 0, 5, 1])).toThrow(RangeError); // antimeridian / inverted
    expect(() => overpassBbox([0, 50, 1, 40])).toThrow(RangeError);
    expect(() => overpassBbox([-181, 0, 0, 1])).toThrow(RangeError);
    expect(() => overpassBbox([0, 0, Number.NaN, 1])).toThrow(RangeError);
    expect(() => overpassBbox([0, 0, 1] as unknown as Bbox)).toThrow(RangeError);
  });

  it("applies the bbox to every query statement", () => {
    for (const layer of ["outdoor", "services"] as const) {
      const statements = lines(buildOverpassQuery(layer, BBOX)).filter((l) => /^(nwr|node|way|rel)\[/.test(l));
      expect(statements.length).toBeGreaterThan(5);
      for (const s of statements) expect(s.endsWith(`${B};`)).toBe(true);
    }
  });

  it("never uses regular expressions on keys and keeps brackets/quotes balanced", () => {
    for (const layer of ["outdoor", "services"] as const) {
      const q = buildOverpassQuery(layer, BBOX);
      expect(q).not.toMatch(/\[~/); // key-regex syntax: [~"key"~"value"]
      expect((q.match(/\(/g) ?? []).length).toBe((q.match(/\)/g) ?? []).length);
      expect((q.match(/\[/g) ?? []).length).toBe((q.match(/\]/g) ?? []).length);
      expect((q.match(/(?<!\\)"/g) ?? []).length % 2).toBe(0);
    }
  });
});

describe("osm query: outdoor layer", () => {
  const q = buildOverpassQuery("outdoor", BBOX);
  const l = lines(q);

  it("fetches named hiking and foot route relations with member geometry", () => {
    expect(l).toContain(`rel["route"="hiking"]["name"]${B};`);
    expect(l).toContain(`rel["route"="foot"]["name"]${B};`);
    expect(l).toContain(`rel.routes_all(if:count_members() <= ${DEFAULT_MAX_ROUTE_MEMBERS})->.routes;`);
    expect(l).toContain(".routes out geom qt;");
  });

  it("fetches the tags of route member ways without geometry", () => {
    expect(l).toContain("way(r.routes)->.route_ways;");
    expect(l).toContain(".route_ways out tags qt;");
  });

  it("caps route size via maxRouteMembers", () => {
    expect(buildOverpassQuery("outdoor", BBOX, { maxRouteMembers: 50 })).toContain("(if:count_members() <= 50)");
  });

  it("fetches named trail ways, tracks only with pedestrian evidence", () => {
    expect(l).toContain(`way["highway"~"^(path|footway|bridleway|steps)$"]["name"]${B};`);
    expect(l).toContain(`way["highway"="track"]["name"]["foot"~"^(yes|designated)$"]${B};`);
    expect(l).toContain(`way["highway"="track"]["name"]["sac_scale"]${B};`);
    expect(l).toContain(`way["highway"="track"]["name"]["trail_visibility"]${B};`);
    expect(q).not.toMatch(/way\["highway"="track"\]\["name"\]\(/); // never all named tracks
  });

  it("excludes sidewalks, crossings, areas, indoor, closed and private ways, and route members", () => {
    expect(l).toContain('way.candidates["footway"~"^(sidewalk|crossing|access_aisle|traffic_island)$"];');
    expect(l).toContain('way.candidates["area"="yes"];');
    expect(l).toContain('way.candidates["indoor"="yes"];');
    expect(l).toContain('way.candidates["foot"~"^(no|private)$"];');
    expect(l).toContain('way.candidates["access"~"^(private|no)$"]["foot"!~"^(yes|designated|permissive)$"];');
    expect(l).toContain(".route_ways;");
    expect(l).toContain("(way.candidates; - .excluded;)->.trails;");
    expect(l).toContain(".trails out geom qt;");
  });

  it("fetches every outdoor POI category", () => {
    const expected = [
      `nwr["highway"="trailhead"]${B};`,
      `nwr["amenity"="parking"]["parking"!~"^(underground|multi-storey)$"]["access"!~"^(private|no|customers)$"]${B};`,
      `nwr["amenity"="toilets"]["access"!~"^(private|no)$"]${B};`,
      `nwr["amenity"="drinking_water"]["drinking_water"!="no"]["access"!~"^(private|no)$"]${B};`,
      `nwr["man_made"="water_tap"]["drinking_water"="yes"]["access"!~"^(private|no)$"]${B};`,
      `nwr["amenity"="shelter"]["shelter_type"!~"^(public_transport|field_shelter)$"]["access"!~"^(private|no)$"]${B};`,
      `nwr["tourism"~"^(wilderness_hut|alpine_hut)$"]["access"!~"^(private|no)$"]${B};`,
      `nwr["tourism"="camp_site"]["access"!~"^(private|no)$"]${B};`,
      `nwr["tourism"="viewpoint"]["access"!~"^(private|no)$"]${B};`,
      `node["natural"~"^(peak|volcano)$"]${B};`,
      `nwr["waterway"="waterfall"]${B};`,
      `nwr["natural"="waterfall"]${B};`,
      `way["natural"="water"]["water"~"^(lake|reservoir|pond)$"]["name"]${B};`,
      `rel["natural"="water"]["water"~"^(lake|reservoir|pond)$"]["name"]${B};`,
      `node["natural"="spring"]${B};`,
      `node["natural"="cave_entrance"]${B};`,
      `nwr["tourism"="picnic_site"]["access"!~"^(private|no)$"]${B};`,
      `nwr["amenity"="ranger_station"]["access"!~"^(private|no)$"]${B};`,
      `nwr["tourism"="information"]["information"~"^(office|visitor_centre|visitor_center)$"]["access"!~"^(private|no)$"]${B};`,
    ];
    for (const s of expected) expect(l).toContain(s);
  });

  it("outputs POI nodes with coordinates and POI areas with a centre (tags only)", () => {
    expect(l).toContain("node.pois->.poi_nodes;");
    expect(l).toContain(".poi_nodes out qt;");
    expect(l).toContain("(way.pois; rel.pois;)->.poi_areas;");
    expect(l).toContain(".poi_areas out tags center qt;");
  });

  it("does not ask for service POIs", () => {
    expect(q).not.toContain('"fuel"');
    expect(q).not.toContain('"restaurant"');
    expect(q).not.toContain('"hospital"');
  });
});

describe("osm query: services layer", () => {
  const q = buildOverpassQuery("services", BBOX);
  const l = lines(q);

  it("only asks for service POIs (no trails, no parking/toilets)", () => {
    expect(q).not.toContain('"route"');
    expect(q).not.toContain('"highway"');
    expect(q).not.toContain('"parking"');
    expect(q).not.toContain('"toilets"');
    expect(q).not.toContain("out geom");
  });

  it("fetches every service category", () => {
    const expected = [
      `nwr["amenity"="fuel"]["access"!~"^(private|no)$"]${B};`,
      `nwr["amenity"="charging_station"]["motorcar"!="no"]["access"!~"^(private|no)$"]${B};`,
      `nwr["amenity"="restaurant"]["access"!~"^(private|no)$"]${B};`,
      `nwr["amenity"="fast_food"]["access"!~"^(private|no)$"]${B};`,
      `nwr["amenity"="cafe"]["access"!~"^(private|no)$"]${B};`,
      `nwr["tourism"~"^(hotel|motel|guest_house|hostel|chalet)$"]["access"!~"^(private|no)$"]${B};`,
      `nwr["shop"="supermarket"]["access"!~"^(private|no)$"]${B};`,
      `nwr["shop"="convenience"]["access"!~"^(private|no)$"]${B};`,
      `nwr["shop"="outdoor"]["access"!~"^(private|no)$"]${B};`,
      `nwr["shop"="sports"]["sport"~"(^|;) *(hiking|climbing|camping) *(;|$)"]["access"!~"^(private|no)$"]${B};`,
      `nwr["amenity"="hospital"]["access"!~"^(private|no)$"]${B};`,
      `nwr["amenity"~"^(clinic|doctors)$"]["access"!~"^(private|no)$"]${B};`,
      `nwr["amenity"="pharmacy"]["access"!~"^(private|no)$"]${B};`,
    ];
    for (const s of expected) expect(l).toContain(s);
    expect(l).toContain(".poi_areas out tags center qt;");
  });
});

describe("osm query: condition rendering", () => {
  it("renders each operator", () => {
    expect(renderCondition({ key: "name", op: "exists" })).toBe('["name"]');
    expect(renderCondition({ key: "a", op: "in", values: ["x"] })).toBe('["a"="x"]');
    expect(renderCondition({ key: "a", op: "in", values: ["x", "y"] })).toBe('["a"~"^(x|y)$"]');
    expect(renderCondition({ key: "a", op: "not_in", values: ["x"] })).toBe('["a"!="x"]');
    expect(renderCondition({ key: "a", op: "not_in", values: ["x", "y"] })).toBe('["a"!~"^(x|y)$"]');
  });

  it("escapes quotes, backslashes and regex metacharacters", () => {
    expect(renderCondition({ key: 'we"ird', op: "in", values: ['a"b'] })).toBe('["we\\"ird"="a\\"b"]');
    expect(renderCondition({ key: "k", op: "in", values: ["a.b", "c+d"] })).toBe('["k"~"^(a\\\\.b|c\\\\+d)$"]');
  });
});
