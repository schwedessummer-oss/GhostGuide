import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_TRAIL_LENGTH_M,
  OverpassResponseError,
  overpassRuntimeError,
  parseOverpassResponse,
} from "@/server/trails/providers/osm/parse";
import { coordKey, totalLengthM } from "@/server/trails/providers/osm/geometry";
import type { NormalizedTrail } from "@/server/trails/types";
import {
  TIMESTAMP,
  at,
  centered,
  lngLat,
  memberNode,
  memberRelation,
  memberWay,
  node,
  relation,
  response,
  straight,
  tagsOnlyWay,
  way,
  type Xy,
} from "../../fixtures/osm/synthetic";

const parse = (elements: unknown[], opts?: { minTrailLengthM?: number }) => parseOverpassResponse("outdoor", response(elements), opts);
const byId = (trails: NormalizedTrail[], id: string) => {
  const t = trails.find((x) => x.providerId === id);
  if (!t) throw new Error(`missing trail ${id}; have ${trails.map((x) => x.providerId).join(", ")}`);
  return t;
};
const rev = <T,>(xs: T[]) => [...xs].reverse();
const k = (xy: Xy) => coordKey(lngLat(xy));
const endKeys = (t: NormalizedTrail) => t.lines.map((l) => [coordKey(l[0]), coordKey(l[l.length - 1])]);

describe("osm parse: response shape", () => {
  it("parses an empty response", () => {
    const r = parse([]);
    expect(r).toEqual({ trails: [], pois: [], dataTimestamp: new Date(TIMESTAMP) });
  });

  it("throws a typed error when there is no elements array (never 'no data')", () => {
    for (const bad of [null, undefined, 42, "x", [], {}, { elements: "nope" }, { elements: {} }]) {
      expect(() => parseOverpassResponse("outdoor", bad)).toThrow(OverpassResponseError);
    }
  });

  it("dataTimestamp is null when missing or invalid", () => {
    expect(parseOverpassResponse("outdoor", { elements: [] }).dataTimestamp).toBeNull();
    expect(parseOverpassResponse("outdoor", { osm3s: { timestamp_osm_base: "yesterday" }, elements: [] }).dataTimestamp).toBeNull();
    expect(parseOverpassResponse("outdoor", { osm3s: { timestamp_osm_base: "2026-13-45T99:99:99Z" }, elements: [] }).dataTimestamp).toBeNull();
    expect(parseOverpassResponse("outdoor", { osm3s: "x", elements: [] }).dataTimestamp).toBeNull();
  });

  it("rejects an invalid minTrailLengthM", () => {
    expect(() => parse([], { minTrailLengthM: -1 })).toThrow(RangeError);
    expect(() => parse([], { minTrailLengthM: Number.NaN })).toThrow(RangeError);
  });

  it("detects Overpass runtime errors reported as remarks", () => {
    expect(overpassRuntimeError({ remark: 'runtime error: Query timed out in "query" at line 3 after 91 seconds.', elements: [] })).toMatch(
      /timed out/,
    );
    expect(overpassRuntimeError({ remark: "runtime error: Query run out of memory using about 2048 MB of RAM.", elements: [] })).toMatch(
      /out of memory/,
    );
    expect(overpassRuntimeError({ remark: "Something informational", elements: [] })).toBeNull();
    expect(overpassRuntimeError({ elements: [] })).toBeNull();
    expect(overpassRuntimeError(null)).toBeNull();
    expect(overpassRuntimeError({ remark: 42 })).toBeNull();
  });
});

describe("osm parse: route relations", () => {
  const A: Xy = [0, 0];
  const B: Xy = [600, 0];
  const C: Xy = [1200, 0];
  const D: Xy = [1200, 600];

  it("merges members listed in reverse order and reversed ways into one linear chain", () => {
    const r = parse([
      relation(10, { type: "route", route: "hiking", name: "Ridge Route", "name:en": "Ridge Route", ref: "RR" }, [
        memberWay(3, straight(C, D)),
        memberWay(2, rev(straight(B, C))), // reversed way
        memberWay(1, straight(A, B)),
      ]),
    ]);
    expect(r.trails).toHaveLength(1);
    const t = r.trails[0];
    expect(t).toMatchObject({
      provider: "osm",
      providerId: "relation/10",
      name: "Ridge Route",
      nameEn: null,
      routeType: "linear",
      sourceName: "OpenStreetMap contributors",
      sourceUrl: "https://www.openstreetmap.org/relation/10",
      sourceLicense: "ODbL 1.0",
      sourceUpdatedAt: new Date(TIMESTAMP),
      tags: { name: "Ridge Route", "name:en": "Ridge Route", ref: "RR", route: "hiking" },
    });
    expect(t.lines).toHaveLength(1);
    expect(new Set(endKeys(t)[0])).toEqual(new Set([k(A), k(D)]));
    expect(totalLengthM(t.lines)).toBeCloseTo(1800, -1);
  });

  it("detects a loop", () => {
    const r = parse([
      relation(11, { route: "hiking", name: "Lake Loop" }, [
        memberWay(1, straight(A, B)),
        memberWay(2, straight(B, [600, 600])),
        memberWay(3, straight([600, 600], [0, 600])),
        memberWay(4, rev(straight([0, 600], A))),
      ]),
    ]);
    expect(byId(r.trails, "relation/11").routeType).toBe("loop");
  });

  it("a loop whose ends are 30 m apart is still a loop; roundtrip=yes does not override geometry", () => {
    const nearlyClosed = parse([relation(12, { route: "foot", name: "Almost Loop" }, [memberWay(1, [A, B, [600, 600], [0, 600], [0, 30]])])]);
    expect(byId(nearlyClosed.trails, "relation/12").routeType).toBe("loop");
    const open = parse([relation(13, { route: "hiking", name: "Open", roundtrip: "yes" }, [memberWay(1, straight(A, C))])]);
    expect(byId(open.trails, "relation/13").routeType).toBe("linear");
  });

  it("an excursion that cannot be walked in one chain makes a network", () => {
    const r = parse([
      relation(14, { route: "hiking", name: "Main With Spur" }, [
        memberWay(1, straight(A, B)),
        memberWay(2, straight(B, C)),
        memberWay(3, straight(B, [600, 500]), "excursion"),
      ]),
    ]);
    const t = byId(r.trails, "relation/14");
    expect(t.routeType).toBe("network");
    expect(t.lines).toHaveLength(2);
    expect(totalLengthM(t.lines)).toBeCloseTo(1700, -1);
  });

  it("an approach that continues the route still forms one chain", () => {
    const r = parse([
      relation(15, { route: "hiking", name: "With Approach" }, [
        memberWay(1, straight([-400, 0], A), "approach"),
        memberWay(2, straight(A, C)),
      ]),
    ]);
    expect(byId(r.trails, "relation/15").routeType).toBe("linear");
  });

  it("ignores node and relation members and counts a repeated way once", () => {
    const r = parse([
      relation(16, { route: "hiking", name: "Out And Back" }, [
        memberNode(500, A, "start"),
        memberRelation(77, "subroute"),
        memberWay(1, straight(A, C)),
        memberWay(1, rev(straight(A, C)), "backward"),
        { type: "way", ref: 2, role: "" }, // member without geometry
      ]),
    ]);
    const t = byId(r.trails, "relation/16");
    expect(t.routeType).toBe("linear");
    expect(totalLengthM(t.lines)).toBeCloseTo(1200, -1);
  });

  it("keeps mapping gaps in the geometry; a tiny dead-end gap does not make a network", () => {
    const small = parse([relation(17, { route: "hiking", name: "Gappy" }, [memberWay(1, straight(A, B)), memberWay(2, straight([606, 0], C))])]);
    const t = byId(small.trails, "relation/17");
    expect(t.lines).toHaveLength(2);
    expect(t.routeType).toBe("linear");
    const big = parse([relation(18, { route: "hiking", name: "Broken" }, [memberWay(1, straight(A, B)), memberWay(2, straight([700, 0], C))])]);
    expect(byId(big.trails, "relation/18").routeType).toBe("network");
  });

  it("drops unnamed, geometry-less, short and non-hiking relations", () => {
    const r = parse([
      relation(20, { route: "hiking" }, [memberWay(1, straight(A, C))]),
      relation(21, { route: "hiking", name: "   " }, [memberWay(2, straight(A, C))]),
      relation(22, { route: "hiking", name: "No Ways" }, [memberNode(5, A)]),
      relation(23, { route: "hiking", name: "Tiny" }, [memberWay(3, straight(A, [300, 0]))]),
      relation(24, { route: "bicycle", name: "Bike Route" }, [memberWay(4, straight(A, C))]),
      relation(25, { route: "hiking", name: "Kept" }, [memberWay(6, straight(A, C))]),
    ]);
    expect(r.trails.map((t) => t.providerId)).toEqual(["relation/25"]);
    expect(DEFAULT_MIN_TRAIL_LENGTH_M).toBe(400);
    expect(parse([relation(23, { route: "hiking", name: "Tiny" }, [memberWay(3, straight(A, [300, 0]))])], { minTrailLengthM: 0 }).trails).toHaveLength(1);
  });

  it("aggregates attributes from member way tags", () => {
    const r = parse([
      relation(30, { route: "hiking", name: "Summit Route", website: "https://park.example.org/summit", description: "Classic summit hike." }, [
        memberWay(1, straight(A, B)),
        memberWay(2, straight(B, C)),
        memberWay(3, straight(C, D)),
      ]),
      tagsOnlyWay(1, { highway: "path", sac_scale: "hiking", trail_visibility: "excellent", surface: "dirt", dog: "leashed", description: "Lower section" }),
      tagsOnlyWay(2, { highway: "path", sac_scale: "demanding_mountain_hiking", trail_visibility: "bad", surface: "rock", dog: "yes" }),
      tagsOnlyWay(3, { highway: "path", sac_scale: "mountain_hiking", surface: "rock", dog: "yes", wheelchair: "no" }),
    ]);
    const t = byId(r.trails, "relation/30");
    expect(t.sacScale).toBe("demanding_mountain_hiking");
    expect(t.trailVisibility).toBe("bad");
    expect(t.surfaces).toEqual(["rock", "dirt"]); // rock covers 1200 m, dirt 600 m
    expect(t.activities).toEqual(["hiking"]);
    expect(t.dogPolicy).toBe("leashed");
    expect(t.wheelchair).toBe("no");
    expect(t.description).toBe("Classic summit hike.");
    expect(t.website).toBe("https://park.example.org/summit");
    expect(t.feeRequired).toBeNull();
    expect(t.permitRequired).toBeNull();
  });

  it("route-level text comes from the relation only, never from one member", () => {
    const r = parse([
      relation(31, { route: "hiking", name: "Plain Route" }, [memberWay(1, straight(A, B)), memberWay(2, straight(B, C))]),
      tagsOnlyWay(1, { highway: "path", description: "Section text", operator: "County", website: "https://one.example.com", access: "yes" }),
      tagsOnlyWay(2, { highway: "path", operator: "County", access: "yes" }),
    ]);
    const t = byId(r.trails, "relation/31");
    expect(t.description).toBeNull();
    expect(t.website).toBeNull();
    expect(t.operator).toBeNull();
    expect(t.access).toBe("yes"); // every member way states it
  });

  it("route tags: fee, permit, dog, wheelchair, access, seasonality, operator", () => {
    const r = parse([
      relation(
        32,
        {
          route: "hiking",
          name: "Permit Route",
          fee: "yes",
          permit: "required",
          dog: "no",
          wheelchair: "limited",
          access: "permissive",
          seasonal: "summer",
          operator: "  US Forest Service ",
          "contact:website": "fs.usda.gov/x",
        },
        [memberWay(1, straight(A, C))],
      ),
    ]);
    expect(byId(r.trails, "relation/32")).toMatchObject({
      feeRequired: true,
      permitRequired: true,
      dogPolicy: "not_allowed",
      wheelchair: "limited",
      access: "permissive",
      seasonality: "summer",
      operator: "US Forest Service",
      website: "http://fs.usda.gov/x",
    });
  });
});

describe("osm parse: named way groups", () => {
  it("groups connected ways with the same name (case/whitespace-insensitive) and suppresses route members", () => {
    const r = parse([
      relation(40, { route: "hiking", name: "Route Forty" }, [memberWay(101, straight([0, 0], [1000, 0]))]),
      tagsOnlyWay(101, { highway: "path", name: "Shared Path" }),
      // The same member way also present with geometry (e.g. from another query part): not emitted again.
      way(101, { highway: "path", name: "Shared Path" }, straight([0, 0], [1000, 0])),
      // A named trail made of three ways, out of id order, one reversed, names differ in case/spacing.
      way(205, { highway: "path", name: "Laurel  Fork Trail", sac_scale: "hiking" }, straight([0, 2000], [600, 2000])),
      way(203, { highway: "path", name: "laurel fork trail" }, rev(straight([600, 2000], [1200, 2000]))),
      way(209, { highway: "footway", name: "Laurel Fork Trail" }, straight([1200, 2000], [1200, 2600])),
    ]);
    expect(r.trails.map((t) => t.providerId)).toEqual(["relation/40", "waygroup/203"]);
    const g = byId(r.trails, "waygroup/203");
    expect(g.name).toBe("laurel fork trail"); // the smallest way id names the group
    expect(g.sourceUrl).toBe("https://www.openstreetmap.org/way/203");
    expect(g.lines).toHaveLength(1);
    expect(g.routeType).toBe("linear");
    expect(totalLengthM(g.lines)).toBeCloseTo(1800, -1);
    expect(g.activities).toEqual(["hiking", "walking"]);
    expect(g.sacScale).toBe("hiking");
  });

  it("splits same-named ways that are not connected into separate trails", () => {
    const r = parse([
      way(301, { highway: "path", name: "River Trail" }, straight([0, 0], [800, 0])),
      way(302, { highway: "path", name: "River Trail" }, straight([0, 5000], [800, 5000])),
    ]);
    expect(r.trails.map((t) => t.providerId)).toEqual(["waygroup/301", "waygroup/302"]);
  });

  it("an unjoined node (tiny dead-end gap) does not split a named trail; a real gap does", () => {
    const r = parse([
      // 5 m between the dead ends of two same-named ways: one trail, two lines (the gap is not drawn).
      way(351, { highway: "path", name: "Creek Trail" }, straight([0, 0], [600, 0])),
      way(352, { highway: "path", name: "Creek Trail" }, straight([605, 0], [1200, 0])),
      // 60 m apart: two different pieces, each long enough to be its own trail.
      way(361, { highway: "path", name: "Gorge Trail" }, straight([0, 3000], [600, 3000])),
      way(362, { highway: "path", name: "Gorge Trail" }, straight([660, 3000], [1260, 3000])),
    ]);
    expect(r.trails.map((t) => t.providerId)).toEqual(["waygroup/351", "waygroup/361", "waygroup/362"]);
    const creek = byId(r.trails, "waygroup/351");
    expect(creek.lines).toHaveLength(2);
    expect(creek.routeType).toBe("linear");
    expect(totalLengthM(creek.lines)).toBeCloseTo(1195, -1);
  });

  it("pieces that are each too short survive when an unjoined node is the only thing between them", () => {
    const pieces = [0, 1, 2].map((i) => way(371 + i, { highway: "footway", name: "Boardwalk" }, straight([i * 203, 0], [i * 203 + 200, 0])));
    const r = parse(pieces);
    expect(r.trails.map((t) => t.providerId)).toEqual(["waygroup/371"]);
    expect(totalLengthM(r.trails[0].lines)).toBeCloseTo(600, -1);
  });

  it("does not merge connected ways with different names", () => {
    const r = parse([
      way(401, { highway: "path", name: "Upper Trail" }, straight([0, 0], [800, 0])),
      way(402, { highway: "path", name: "Lower Trail" }, straight([800, 0], [1600, 0])),
    ]);
    expect(r.trails.map((t) => t.name)).toEqual(["Upper Trail", "Lower Trail"]);
  });

  it("connects through T-junctions on interior nodes and detects loops and networks", () => {
    const r = parse([
      // Loop of two ways.
      way(501, { highway: "path", name: "Pond Loop" }, straight([0, 0], [500, 500])),
      way(502, { highway: "path", name: "Pond Loop" }, [[500, 500], [0, 500], [0, 0]]),
      // Network: a spur leaving from an interior vertex of the main way.
      way(601, { highway: "path", name: "Spur Trail" }, [[0, 3000], [500, 3000], [1000, 3000]]),
      way(602, { highway: "path", name: "Spur Trail" }, straight([500, 3000], [500, 3600])),
    ]);
    expect(byId(r.trails, "waygroup/501").routeType).toBe("loop");
    const net = byId(r.trails, "waygroup/601");
    expect(net.routeType).toBe("network");
    expect(net.lines).toHaveLength(2);
  });

  it("aggregates way-group attributes by consensus and keeps only agreeing provenance tags", () => {
    const r = parse([
      way(701, { highway: "path", name: "Falls Trail", operator: "State Park", surface: "dirt", description: "To the falls", dog: "leashed" }, straight([0, 0], [600, 0])),
      way(702, { highway: "path", name: "Falls Trail", surface: "gravel", wheelchair: "yes", dog: "leashed", website: "https://park.example.com" }, straight([600, 0], [700, 0])),
    ]);
    const t = byId(r.trails, "waygroup/701");
    expect(t).toMatchObject({
      operator: "State Park",
      description: "To the falls",
      website: "https://park.example.com",
      dogPolicy: "leashed",
      wheelchair: "unknown", // one way has no wheelchair tag
      surfaces: ["dirt", "gravel"], // dirt is the longer way
    });
    expect(t.tags).toEqual({ name: "Falls Trail", highway: "path", operator: "State Park" });
  });

  it("excludes sidewalks, crossings, private ways and plain tracks", () => {
    const r = parse([
      way(801, { highway: "footway", footway: "sidewalk", name: "Main Street" }, straight([0, 0], [900, 0])),
      way(802, { highway: "footway", footway: "crossing", name: "Main Street" }, straight([900, 0], [900, 20])),
      way(803, { highway: "path", access: "private", name: "Private Trail" }, straight([0, 100], [900, 100])),
      way(804, { highway: "track", name: "Forest Road 700" }, straight([0, 200], [900, 200])),
      way(805, { highway: "track", name: "Rail Trail", foot: "designated", bicycle: "designated" }, straight([0, 300], [900, 300])),
      way(806, { highway: "residential", name: "Elm Street" }, straight([0, 400], [900, 400])),
    ]);
    expect(r.trails.map((t) => t.providerId)).toEqual(["waygroup/805"]);
    expect(r.trails[0].activities).toEqual(["walking", "biking"]);
  });

  it("drops way groups shorter than the minimum", () => {
    const elements = [way(901, { highway: "path", name: "Short Cut" }, straight([0, 0], [150, 0]))];
    expect(parse(elements).trails).toEqual([]);
    expect(parse(elements, { minTrailLengthM: 100 }).trails).toHaveLength(1);
  });

  it("is independent of element order", () => {
    const elements = [
      relation(40, { route: "hiking", name: "Route Forty" }, [memberWay(101, straight([0, 0], [1000, 0]))]),
      way(205, { highway: "path", name: "Laurel Fork Trail" }, straight([0, 2000], [600, 2000])),
      way(203, { highway: "path", name: "Laurel Fork Trail" }, straight([600, 2000], [1200, 2000])),
      way(301, { highway: "path", name: "River Trail" }, straight([0, 4000], [800, 4000])),
      node(1, { highway: "trailhead", name: "TH" }, [0, 0]),
      centered("way", 2, { amenity: "parking" }, [10, 10]),
    ];
    expect(parse([...elements].reverse())).toEqual(parse(elements));
  });
});

describe("osm parse: malformed input", () => {
  it("skips malformed elements without crashing", () => {
    const good = way(1001, { highway: "path", name: "Good Trail" }, straight([0, 0], [800, 0]));
    const r = parse([
      null,
      42,
      "way",
      [],
      { type: "way" },
      { type: "way", id: -5, tags: { highway: "path", name: "Neg" }, geometry: straight([0, 0], [800, 0]).map(at) },
      { type: "way", id: "12", tags: { highway: "path", name: "Str" }, geometry: straight([0, 0], [800, 0]).map(at) },
      { type: "way", id: 1.5, tags: { highway: "path", name: "Frac" } },
      { type: "spaceship", id: 7 },
      { type: "way", id: 1002, tags: "highway=path", geometry: straight([0, 0], [800, 0]).map(at) },
      { type: "way", id: 1003, tags: { highway: "path", name: 42 }, geometry: straight([0, 0], [800, 0]).map(at) },
      { type: "way", id: 1004, tags: { highway: "path", name: "No Geometry" }, geometry: "nope" },
      { type: "way", id: 1005, tags: { highway: "path", name: "Garbage Geometry" }, geometry: [{ lat: "x", lon: 1 }, null, { lat: 95, lon: 0 }, {}] },
      { type: "relation", id: 1006, tags: { route: "hiking", name: "Bad Members" }, members: "x" },
      { type: "relation", id: 1007, tags: { route: "hiking", name: "Garbage Members" }, members: [null, { type: "way" }, { type: "way", ref: "1" }, 5] },
      { type: "node", id: 1008, tags: { highway: "trailhead" } }, // no coordinates
      { type: "node", id: 1009, lat: 200, lon: 0, tags: { highway: "trailhead" } },
      { type: "node", id: 1010, lat: 35, lon: -82 }, // untagged
      good,
    ]);
    expect(r.trails.map((t) => t.providerId)).toEqual(["waygroup/1001"]);
    expect(r.pois).toEqual([]);
  });

  it("splits geometry at missing vertices instead of drawing across them", () => {
    const pts = straight([0, 0], [2000, 0], 7).map(at); // a vertex every 250 m
    const geometry = [...pts.slice(0, 4), null, ...pts.slice(5)];
    const r = parse([{ type: "way", id: 1100, tags: { highway: "path", name: "Broken" }, geometry }]);
    const t = byId(r.trails, "waygroup/1100");
    expect(t.lines).toHaveLength(2);
    expect(totalLengthM(t.lines)).toBeCloseTo(1500, -1); // the 500 m hole is not drawn
    expect(t.routeType).toBe("network");
  });

  it("merges an element that appears twice (tags-only, then with geometry)", () => {
    const r = parse([
      tagsOnlyWay(1200, { highway: "path", name: "Twice", sac_scale: "mountain_hiking" }),
      way(1200, { highway: "path", name: "Twice" }, straight([0, 0], [800, 0])),
    ]);
    expect(byId(r.trails, "waygroup/1200").sacScale).toBe("mountain_hiking");
  });
});

describe("osm parse: POIs", () => {
  it("normalizes outdoor POIs from nodes, way centres and relation centres", () => {
    const r = parse([
      node(1, { highway: "trailhead", name: "Table Rock Trailhead", "name:en": "Table Rock Trailhead", ele: "1100 ft" }, [0, 0]),
      centered("way", 2, { amenity: "parking", fee: "yes", capacity: "40", operator: "SC State Parks", "addr:street": "x" }, [50, 50]),
      centered("relation", 3, { natural: "water", water: "lake", name: "Pinnacle Lake" }, [400, 400]),
      node(4, { natural: "peak", name: "Pinnacle Mountain", ele: "1052" }, [900, 900]),
      node(5, { tourism: "information", information: "visitor_centre", opening_hours: "Mo-Su 09:00-17:00", phone: "+1 864 878 9813", website: "https://southcarolinaparks.com" }, [5, 5]),
      node(6, { amenity: "bench" }, [1, 1]),
      node(7, { amenity: "parking", access: "private" }, [2, 2]),
      // A POI way without a centre but with geometry → bbox centre.
      way(8, { tourism: "picnic_site" }, [[0, 0], [100, 0], [100, 100]]),
    ]);
    expect(r.pois.map((p) => [p.providerId, p.category])).toEqual([
      ["node/1", "trailhead"],
      ["node/4", "peak"],
      ["node/5", "information"],
      ["way/2", "parking"],
      ["way/8", "picnic_site"],
      ["relation/3", "lake"],
    ]);
    const th = r.pois[0];
    expect(th).toMatchObject({
      provider: "osm",
      layer: "outdoor",
      name: "Table Rock Trailhead",
      nameEn: null,
      elevationM: 335,
      lng: at([0, 0]).lon,
      lat: at([0, 0]).lat,
      sourceName: "OpenStreetMap contributors",
      sourceUrl: "https://www.openstreetmap.org/node/1",
      sourceLicense: "ODbL 1.0",
      openingHours: null,
      phone: null,
      website: null,
    });
    const parking = r.pois.find((p) => p.providerId === "way/2")!;
    expect(parking.tags).toEqual({ amenity: "parking", fee: "yes", capacity: "40", operator: "SC State Parks" });
    expect(parking.name).toBeNull();
    expect(r.pois.find((p) => p.providerId === "node/4")!.elevationM).toBe(1052);
    expect(r.pois.find((p) => p.providerId === "node/5")).toMatchObject({
      openingHours: "Mo-Su 09:00-17:00",
      phone: "+1 864 878 9813",
      website: "https://southcarolinaparks.com",
    });
    const picnic = r.pois.find((p) => p.providerId === "way/8")!;
    expect(picnic.lng).toBeCloseTo((at([0, 0]).lon + at([100, 0]).lon) / 2, 7);
    expect(picnic.lat).toBeCloseTo((at([0, 0]).lat + at([0, 100]).lat) / 2, 7);
  });

  it("services layer: service categories only, never trails", () => {
    const elements = [
      node(1, { amenity: "fuel", name: "Gas" }, [0, 0]),
      node(2, { amenity: "parking" }, [0, 0]),
      centered("way", 3, { tourism: "motel", name: "Motel" }, [10, 10]),
      relation(4, { route: "hiking", name: "Should Not Appear" }, [memberWay(5, straight([0, 0], [2000, 0]))]),
      way(6, { highway: "path", name: "Nor This" }, straight([0, 0], [2000, 0])),
    ];
    const r = parseOverpassResponse("services", response(elements));
    expect(r.trails).toEqual([]);
    expect(r.pois.map((p) => [p.providerId, p.category, p.layer])).toEqual([
      ["node/1", "fuel", "services"],
      ["way/3", "lodging", "services"],
    ]);
  });
});
