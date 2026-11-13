import { describe, expect, it } from "vitest";
import { TRAIL_FEATURES, type PoiCategory } from "@/domain/catalog";
import { offsetMeters } from "@/domain/geo";
import {
  orientFromTrailhead,
  CAMPING_NEAR_ROUTE_M,
  FEATURE_RADIUS_M,
  PARKING_NEAR_TRAILHEAD_M,
  POI_LOOKUP_RADIUS_M,
  TOILETS_NEAR_TRAILHEAD_M,
  TRAILHEAD_PARKING_RADIUS_M,
  TRAILHEAD_POI_RADIUS_M,
  WATER_NEAR_ROUTE_M,
  attributesFromJson,
  attributesToJson,
  buildTrailRecord,
  combineAttributes,
  deriveAmenities,
  geometryHash,
  selectTrailhead,
  trailCentroid,
  type NearbyPoi,
  type TrailAttributes,
  type TrailRecordInput,
} from "@/server/trails/enrich";
import { estimateDurationMin } from "@/server/trails/estimate";
import type { Line } from "@/server/trails/types";

/** Positions in metres east/north of an origin (lat 46°). */
const ORIGIN = { lat: 46.5, lng: 8.0 };
const at = (east: number, north: number): [number, number] => {
  const p = offsetMeters(ORIGIN, east, north);
  return [p.lng, p.lat];
};
const poi = (category: PoiCategory, east: number, north: number, id = `${category}/${east}/${north}`, provider = "osm"): NearbyPoi => {
  const [lng, lat] = at(east, north);
  return { provider, providerId: id, category, lng, lat };
};

/** A straight 2 km trail from (0,0) to (2000,0). */
const LINE: Line[] = [[at(0, 0), at(500, 0), at(1000, 0), at(1500, 0), at(2000, 0)]];

const ATTRS: TrailAttributes = {
  name: "Ridge Trail",
  nameEn: null,
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
  sourceUpdatedAt: null,
};

const input = (over: Partial<TrailRecordInput> = {}): TrailRecordInput => ({
  provider: "osm",
  providerId: "relation/42",
  attributes: ATTRS,
  lines: LINE,
  routeType: "linear",
  sourceName: "OpenStreetMap contributors",
  sourceUrl: "https://www.openstreetmap.org/relation/42",
  sourceLicense: "ODbL 1.0",
  elevation: null,
  pois: [],
  admin: null,
  timezone: "Europe/Zurich",
  ...over,
});

describe("selectTrailhead", () => {
  it("uses a mapped trailhead within 150 m of an endpoint (nearest wins)", () => {
    const pois = [poi("trailhead", -140, 0, "node/2"), poi("trailhead", -60, 0, "node/1"), poi("parking", 0, -10)];
    const th = selectTrailhead(LINE, pois)!;
    expect(th.source).toBe("osm_trailhead");
    expect(th.poiId).toBe("node/1");
    expect(th.point.lng).toBeCloseTo(at(-60, 0)[0], 9);
  });

  it("counts the END of the route as an endpoint too", () => {
    const th = selectTrailhead(LINE, [poi("trailhead", 2100, 0, "node/end")])!;
    expect(th.source).toBe("osm_trailhead");
    expect(th.poiId).toBe("node/end");
  });

  it("ignores trailheads beyond 150 m and then uses parking within 300 m (point = parking)", () => {
    const pois = [poi("trailhead", -(TRAILHEAD_POI_RADIUS_M + 10), 0), poi("parking", 0, 250, "way/9")];
    const th = selectTrailhead(LINE, pois)!;
    expect(th.source).toBe("parking");
    expect(th.poiId).toBe("way/9");
    expect(th.point.lat).toBeCloseTo(at(0, 250)[1], 9);
  });

  it("does not use a trailhead near the middle of the route (only endpoints count)", () => {
    const th = selectTrailhead(LINE, [poi("trailhead", 1000, 20)])!;
    expect(th.source).toBe("route_start");
  });

  it("falls back to the first vertex when nothing is close enough", () => {
    const th = selectTrailhead(LINE, [poi("parking", 0, TRAILHEAD_PARKING_RADIUS_M + 15), poi("toilets", 0, 5)])!;
    expect(th).toEqual({ point: { lng: LINE[0][0][0], lat: LINE[0][0][1] }, source: "route_start", poiId: null });
  });

  it("returns null without geometry and ignores invalid POIs", () => {
    expect(selectTrailhead([], [])).toBeNull();
    const bad = { provider: "osm", providerId: "bad", category: "trailhead" as const, lng: Number.NaN, lat: 0 };
    expect(selectTrailhead(LINE, [bad])!.source).toBe("route_start");
  });
});

describe("deriveAmenities", () => {
  const trailhead = { lng: at(0, 0)[0], lat: at(0, 0)[1] };

  it("lists features within 200 m of the route in TRAIL_FEATURES order", () => {
    const pois = [
      poi("viewpoint", 1000, FEATURE_RADIUS_M - 10),
      poi("waterfall", 1500, -(FEATURE_RADIUS_M - 20)),
      poi("lake", 500, FEATURE_RADIUS_M + 15), // too far
      poi("peak", 2150, 0), // 150 m past the end
      poi("toilets", 1000, 0), // not a feature
    ];
    const a = deriveAmenities(LINE, trailhead, pois);
    expect(a.features).toEqual(["waterfall", "viewpoint", "peak"]);
    expect(a.features).toEqual(TRAIL_FEATURES.filter((f) => a.features.includes(f)));
  });

  it("measures parking and toilets from the trailhead, not the route", () => {
    const near = deriveAmenities(LINE, trailhead, [poi("parking", -(PARKING_NEAR_TRAILHEAD_M - 20), 0), poi("toilets", 0, TOILETS_NEAR_TRAILHEAD_M - 20)]);
    expect(near.hasParking).toBe(true);
    expect(near.hasToilets).toBe(true);
    // Right next to the route, but 1 km from the trailhead.
    const far = deriveAmenities(LINE, trailhead, [poi("parking", 1000, 10), poi("toilets", 1000, 10)]);
    expect(far.hasParking).toBe(false);
    expect(far.hasToilets).toBe(false);
    expect(deriveAmenities(LINE, null, [poi("parking", 0, 0)]).hasParking).toBe(false);
  });

  it("measures drinking water (200 m) and camping (500 m) from the route", () => {
    const yes = deriveAmenities(LINE, trailhead, [poi("drinking_water", 1200, WATER_NEAR_ROUTE_M - 10), poi("campsite", 1800, CAMPING_NEAR_ROUTE_M - 30)]);
    expect(yes.hasDrinkingWater).toBe(true);
    expect(yes.hasCamping).toBe(true);
    const no = deriveAmenities(LINE, trailhead, [
      poi("drinking_water", 1200, WATER_NEAR_ROUTE_M + 15),
      poi("campsite", 1800, CAMPING_NEAR_ROUTE_M + 20),
      poi("spring", 1000, 0), // a spring is not drinking water
    ]);
    expect(no.hasDrinkingWater).toBe(false);
    expect(no.hasCamping).toBe(false);
    expect(no.features).toEqual(["spring"]);
  });

  it("is empty without geometry", () => {
    expect(deriveAmenities([], trailhead, [poi("waterfall", 0, 0)])).toEqual({
      features: [],
      hasParking: false,
      hasToilets: false,
      hasDrinkingWater: false,
      hasCamping: false,
    });
  });

  it("the lookup radius covers the farthest rule", () => {
    expect(POI_LOOKUP_RADIUS_M).toBeGreaterThanOrEqual(TRAILHEAD_PARKING_RADIUS_M + TOILETS_NEAR_TRAILHEAD_M);
    expect(POI_LOOKUP_RADIUS_M).toBeGreaterThanOrEqual(CAMPING_NEAR_ROUTE_M);
  });
});

describe("buildTrailRecord", () => {
  it("maps a trail without elevation or admin names honestly", () => {
    const r = buildTrailRecord(input())!;
    expect(r.distanceM).toBeGreaterThan(1990);
    expect(r.distanceM).toBeLessThan(2010);
    expect(r.routeType).toBe("linear");
    expect(r.elevationGainM).toBeNull();
    expect(r.elevationLossM).toBeNull();
    expect(r.elevationProfile).toBeNull();
    expect(r.elevationSource).toBeNull();
    expect(r.maxElevationM).toBeNull();
    // No profile: flat-pace estimate for ONE traversal.
    expect(r.estimatedDurationMin).toBe(estimateDurationMin({ distanceM: r.distanceM, profile: null }));
    // Linear 2 km → 4 km out and back, unknown climb and no SAC grade: the
    // rating would rest on the missing climb, so it is unknown (no source),
    // never "estimated from distance and climb"; never family friendly without climb data.
    expect(r.difficulty).toBe("unknown");
    expect(r.difficultySource).toBeNull();
    expect(r.familyFriendly).toBe(false);
    // The country comes from the exact point (offline borders), even without reverse geocoding.
    expect(r.countryCode).toBe("ch");
    expect(r.regionSlug).toBe("unknown");
    expect(r.regionName).toBeNull();
    expect(r.nearestPlace).toBeNull();
    expect(r.timezone).toBe("Europe/Zurich");
    // Nowhere (no country at the point): "xx", never guessed.
    expect(buildTrailRecord(input({ countryAt: () => null }))!.countryCode).toBe("xx");
    expect(r.trailheadSource).toBe("route_start");
    expect(r.trailhead).toEqual({ lng: LINE[0][0][0], lat: LINE[0][0][1] });
    expect(r.baseSlug).toBe("ridge-trail");
    expect(r.centroid.lng).toBeCloseTo(at(1000, 0)[0], 6);
    expect(r.qualityScore).toBeGreaterThan(0);
    expect(r.qualityScore).toBeLessThanOrEqual(100);
    expect(r.tags).toEqual({ route: "hiking" });
    expect(r.lines).toEqual(LINE);
  });

  it("uses elevation, SAC grade, POIs and admin names when available", () => {
    const profile: [number, number][] = [
      [0, 1000],
      [1000, 1150],
      [2000, 1300],
    ];
    const r = buildTrailRecord(
      input({
        attributes: { ...ATTRS, sacScale: "demanding_mountain_hiking", nameEn: "Ridge Path", surfaces: ["rock", "rock", "gravel"] },
        routeType: "loop",
        elevation: { profile, gainM: 300, lossM: 0, maxM: 1300, minM: 1000, source: "AWS Terrain Tiles (z12, estimate)" },
        pois: [poi("trailhead", -50, 0, "node/7"), poi("parking", -80, 0), poi("toilets", -60, 20), poi("waterfall", 900, 50)],
        admin: { countryCode: "CH", regionName: "Graubünden", nearestPlace: "Davos" },
      }),
    )!;
    expect(r.elevationGainM).toBe(300);
    expect(r.elevationLossM).toBe(0);
    expect(r.maxElevationM).toBe(1300);
    expect(r.minElevationM).toBe(1000);
    expect(r.elevationProfile).toEqual(profile);
    expect(r.elevationSource).toMatch(/estimate/);
    expect(r.estimatedDurationMin).toBe(estimateDurationMin({ distanceM: r.distanceM, profile }));
    expect(r.difficulty).toBe("hard");
    expect(r.difficultySource).toBe("osm_sac_scale");
    expect(r.trailheadSource).toBe("osm_trailhead");
    expect(r.hasParking).toBe(true);
    expect(r.hasToilets).toBe(true);
    expect(r.features).toEqual(["waterfall"]);
    expect(r.countryCode).toBe("ch");
    expect(r.regionName).toBe("Graubünden");
    expect(r.regionSlug).toBe("graubunden");
    expect(r.nearestPlace).toBe("Davos");
    expect(r.baseSlug).toBe("ridge-path"); // ASCII English name preferred
    expect(r.surfaces).toEqual(["rock", "gravel"]);
  });

  it("marks an easy, short, gently climbing loop family friendly", () => {
    const loop: Line[] = [[at(0, 0), at(500, 0), at(500, 500), at(0, 500), at(0, 0)]];
    const r = buildTrailRecord(
      input({
        lines: loop,
        routeType: "loop",
        elevation: { profile: [[0, 500], [1000, 540], [2000, 500]], gainM: 40, lossM: 40, maxM: 540, minM: 500, source: "dem" },
      }),
    )!;
    expect(r.difficulty).toBe("easy");
    expect(r.familyFriendly).toBe(true);
  });

  it("drops an unusable elevation profile instead of storing partial numbers", () => {
    const r = buildTrailRecord(input({ elevation: { profile: [[0, Number.NaN]], gainM: 10, lossM: 10, maxM: 1, minM: 0, source: "dem" } }))!;
    expect(r.elevationGainM).toBeNull();
    expect(r.elevationSource).toBeNull();
    expect(r.elevationProfile).toBeNull();
  });

  it("rejects trails without a name or measurable geometry", () => {
    expect(buildTrailRecord(input({ attributes: { ...ATTRS, name: "   " } }))).toBeNull();
    expect(buildTrailRecord(input({ lines: [] }))).toBeNull();
    expect(buildTrailRecord(input({ lines: [[at(0, 0), at(0, 0)]] }))).toBeNull();
    expect(buildTrailRecord(input({ lines: [[[Number.NaN, 1], [2, Number.POSITIVE_INFINITY]]] }))).toBeNull();
  });

  it("uses a hash slug for names without Latin text", () => {
    const r = buildTrailRecord(input({ attributes: { ...ATTRS, name: "高尾山 稲荷山コース" }, providerId: "waygroup/5" }))!;
    expect(r.baseSlug).toMatch(/^trail-[0-9a-f]{10}$/);
  });
});

describe("combineAttributes", () => {
  it("keeps the most demanding grade, worst visibility, unions lists and the latest timestamp", () => {
    const a: TrailAttributes = { ...ATTRS, sacScale: "hiking", trailVisibility: "good", surfaces: ["dirt"], feeRequired: false, sourceUpdatedAt: new Date("2026-01-01T00:00:00Z"), tags: { a: "1", b: "primary" } };
    const b: TrailAttributes = {
      ...ATTRS,
      sacScale: "alpine_hiking",
      trailVisibility: "bad",
      surfaces: ["rock", "dirt"],
      activities: ["hiking", "running"],
      feeRequired: true,
      description: "From the other tile",
      dogPolicy: "leashed",
      sourceUpdatedAt: new Date("2026-06-01T00:00:00Z"),
      tags: { b: "other", c: "3" },
    };
    const c = combineAttributes(a, [b]);
    expect(c.name).toBe(a.name);
    expect(c.sacScale).toBe("alpine_hiking");
    expect(c.trailVisibility).toBe("bad");
    expect(c.surfaces).toEqual(["dirt", "rock"]);
    expect(c.activities).toEqual(["hiking", "running"]);
    expect(c.feeRequired).toBe(true);
    expect(c.description).toBe("From the other tile");
    expect(c.dogPolicy).toBe("leashed");
    expect(c.sourceUpdatedAt?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(c.tags).toEqual({ a: "1", b: "primary", c: "3" });
  });

  it("keeps unknowns unknown", () => {
    const c = combineAttributes(ATTRS, [ATTRS]);
    expect(c.sacScale).toBeNull();
    expect(c.feeRequired).toBeNull();
    expect(c.permitRequired).toBeNull();
    expect(c.dogPolicy).toBe("unknown");
  });
});

describe("part attribute JSON", () => {
  it("round-trips and rejects unusable input", () => {
    const a: TrailAttributes = { ...ATTRS, sacScale: "hiking", sourceUpdatedAt: new Date("2026-11-10T12:34:56Z") };
    expect(attributesFromJson(JSON.parse(JSON.stringify(attributesToJson(a))))).toEqual(a);
    expect(attributesFromJson(null)).toBeNull();
    expect(attributesFromJson({ name: "" })).toBeNull();
    expect(attributesFromJson({ name: "X", dogPolicy: "maybe", activities: ["hiking", "flying"], tags: { k: 1 } })).toMatchObject({
      name: "X",
      dogPolicy: "unknown",
      activities: ["hiking"],
      tags: {},
    });
  });
});

describe("geometryHash / trailCentroid", () => {
  it("is stable for the same geometry and changes when it changes", () => {
    expect(geometryHash(LINE)).toBe(geometryHash(JSON.parse(JSON.stringify(LINE))));
    expect(geometryHash(LINE)).not.toBe(geometryHash([[...LINE[0], at(2100, 0)]]));
    expect(geometryHash(LINE)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("centroid is null without geometry", () => {
    expect(trailCentroid([])).toBeNull();
    expect(trailCentroid(LINE)!.lat).toBeCloseTo(ORIGIN.lat, 6);
  });
});

describe("orientFromTrailhead", () => {
  // A one-way line drawn summit → base (OSM often maps it this way).
  const summitToBase: [number, number][] = [
    [-82.7, 35.1],
    [-82.71, 35.09],
    [-82.72, 35.08],
  ];
  const base = { lng: -82.7201, lat: 35.0801 };
  const summit = { lng: -82.7001, lat: 35.1001 };

  it("reverses a linear route whose trailhead is at its far end", () => {
    const out = orientFromTrailhead([summitToBase], base);
    expect(out).toEqual([[...summitToBase].reverse()]);
  });

  it("keeps a route that already starts at the trailhead", () => {
    expect(orientFromTrailhead([summitToBase], summit)).toEqual([summitToBase]);
  });

  it("reverses line order and each line for multi-line routes", () => {
    const a: [number, number][] = [
      [0, 0],
      [0, 0.01],
    ];
    const b: [number, number][] = [
      [0, 0.01],
      [0, 0.02],
    ];
    const out = orientFromTrailhead([a, b], { lng: 0, lat: 0.0201 });
    expect(out).toEqual([
      [...b].reverse(),
      [...a].reverse(),
    ]);
  });

  it("returns cleaned lines unchanged without a trailhead", () => {
    expect(orientFromTrailhead([summitToBase], null)).toEqual([summitToBase]);
  });
});
