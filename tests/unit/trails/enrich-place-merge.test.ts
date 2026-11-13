/**
 * Review fixes in enrich.ts:
 *  - merged pieces combine dog / wheelchair / access / fee / permit
 *    conservatively and independently of piece order;
 *  - the country comes from the trail's exact point, and reverse-geocoded
 *    names never contradict it;
 *  - a trailhead from an official dataset (RIDB) is labelled "official".
 */
import { describe, expect, it } from "vitest";
import type { DogPolicy, WheelchairAccess } from "@/domain/catalog";
import { offsetMeters } from "@/domain/geo";
import {
  buildTrailRecord,
  combineAccess,
  combineAttributes,
  combinePolicy,
  combineRequirement,
  resolvePlace,
  selectTrailhead,
  type NearbyPoi,
  type TrailAttributes,
  type TrailRecordInput,
} from "@/server/trails/enrich";
import type { Line } from "@/server/trails/types";

const ATTRS: TrailAttributes = {
  name: "Border Ridge Trail",
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
  tags: {},
  sourceUpdatedAt: null,
};
const piece = (over: Partial<TrailAttributes>): TrailAttributes => ({ ...ATTRS, ...over });
/** combineAttributes in both piece orders: the result must not depend on which tile came last. */
const bothOrders = (a: TrailAttributes, b: TrailAttributes) => [combineAttributes(a, [b]), combineAttributes(b, [a])];

describe("combineAttributes across tile pieces (conservative, order-independent)", () => {
  it("lets a dog ban or leash rule win over a piece that allows dogs", () => {
    for (const c of bothOrders(piece({ dogPolicy: "allowed" }), piece({ dogPolicy: "not_allowed" }))) expect(c.dogPolicy).toBe("not_allowed");
    for (const c of bothOrders(piece({ dogPolicy: "allowed" }), piece({ dogPolicy: "leashed" }))) expect(c.dogPolicy).toBe("leashed");
    for (const c of bothOrders(piece({ dogPolicy: "leashed" }), piece({ dogPolicy: "not_allowed" }))) expect(c.dogPolicy).toBe("not_allowed");
    // "Allowed" only when every piece says so; an untagged piece leaves it unknown.
    for (const c of bothOrders(piece({ dogPolicy: "allowed" }), piece({ dogPolicy: "unknown" }))) expect(c.dogPolicy).toBe("unknown");
    expect(combineAttributes(piece({ dogPolicy: "allowed" }), [piece({ dogPolicy: "allowed" })]).dogPolicy).toBe("allowed");
  });

  it("lets 'no' / 'limited' wheelchair access win; 'yes' only when every piece says yes", () => {
    for (const c of bothOrders(piece({ wheelchair: "yes" }), piece({ wheelchair: "no" }))) expect(c.wheelchair).toBe("no");
    for (const c of bothOrders(piece({ wheelchair: "yes" }), piece({ wheelchair: "limited" }))) expect(c.wheelchair).toBe("limited");
    for (const c of bothOrders(piece({ wheelchair: "yes" }), piece({ wheelchair: "unknown" }))) expect(c.wheelchair).toBe("unknown");
    expect(combineAttributes(piece({ wheelchair: "yes" }), [piece({ wheelchair: "yes" })]).wheelchair).toBe("yes");
  });

  it("lets a restrictive access value win; 'open to the public' only when every piece says so", () => {
    for (const c of bothOrders(piece({ access: "yes" }), piece({ access: "private" }))) expect(c.access).toBe("private");
    for (const c of bothOrders(piece({ access: "permissive" }), piece({ access: "no" }))) expect(c.access).toBe("no");
    for (const c of bothOrders(piece({ access: "yes" }), piece({ access: "permissive" }))) expect(c.access).toBe("permissive");
    for (const c of bothOrders(piece({ access: "yes" }), piece({ access: null }))) expect(c.access).toBeNull();
    for (const c of bothOrders(piece({ access: "yes" }), piece({ access: "agricultural" }))) expect(c.access).toBe("agricultural");
    for (const c of bothOrders(piece({ access: "forestry" }), piece({ access: "agricultural" }))) expect(c.access).toBeNull();
    expect(combineAttributes(piece({ access: "designated" }), [piece({ access: "yes" })]).access).toBe("designated");
    expect(combineAttributes(piece({ access: null }), [piece({ access: null })]).access).toBeNull();
  });

  it("says 'no fee' / 'no permit' only when every piece does; any requirement wins", () => {
    for (const c of bothOrders(piece({ feeRequired: false }), piece({ feeRequired: null }))) expect(c.feeRequired).toBeNull();
    for (const c of bothOrders(piece({ feeRequired: false }), piece({ feeRequired: true }))) expect(c.feeRequired).toBe(true);
    expect(combineAttributes(piece({ feeRequired: false }), [piece({ feeRequired: false })]).feeRequired).toBe(false);
    for (const c of bothOrders(piece({ permitRequired: false }), piece({ permitRequired: null }))) expect(c.permitRequired).toBeNull();
    for (const c of bothOrders(piece({ permitRequired: null }), piece({ permitRequired: true }))) expect(c.permitRequired).toBe(true);
    expect(combineAttributes(piece({ permitRequired: false }), [piece({ permitRequired: false }), piece({ permitRequired: false })]).permitRequired).toBe(false);
  });

  it("exposes the value-level rules", () => {
    expect(combinePolicy<DogPolicy>([], ["not_allowed", "leashed"], "allowed", "unknown")).toBe("unknown");
    expect(combinePolicy<WheelchairAccess>(["yes", "yes", "limited"], ["no", "limited"], "yes", "unknown")).toBe("limited");
    expect(combineRequirement([])).toBeNull();
    expect(combineRequirement([null, true, false])).toBe(true);
    expect(combineAccess([])).toBeNull();
    expect(combineAccess(["  ", null])).toBeNull();
  });
});

describe("resolvePlace: the country from the exact point, names only when they agree", () => {
  const point = { lng: -70.0, lat: -33.0 };

  it("keeps region and place when the cell is in the same country", () => {
    expect(resolvePlace(point, { countryCode: "cl", regionName: "Santiago Metropolitan Region", nearestPlace: "Lo Barnechea" }, () => "cl")).toEqual({
      countryCode: "cl",
      regionName: "Santiago Metropolitan Region",
      nearestPlace: "Lo Barnechea",
      namesConsistent: true,
    });
  });

  it("drops the neighbour's names when the cell centre lies across the border", () => {
    expect(resolvePlace(point, { countryCode: "ar", regionName: "Mendoza", nearestPlace: "Uspallata" }, () => "cl")).toEqual({
      countryCode: "cl",
      regionName: null,
      nearestPlace: null,
      namesConsistent: false,
    });
  });

  it("compares sovereign countries (a territory and its country agree)", () => {
    const area = { countryCode: "us", regionName: "Puerto Rico", nearestPlace: "Río Grande" };
    expect(resolvePlace(point, area, () => "pr")).toMatchObject({ countryCode: "pr", regionName: "Puerto Rico", namesConsistent: true });
  });

  it("keeps the exact country when names are unavailable, and guesses nothing without one", () => {
    expect(resolvePlace(point, null, () => "cl")).toEqual({ countryCode: "cl", regionName: null, nearestPlace: null, namesConsistent: true });
    expect(resolvePlace(point, { countryCode: "nz", regionName: "Canterbury", nearestPlace: null }, () => null)).toEqual({
      countryCode: null,
      regionName: null,
      nearestPlace: null,
      namesConsistent: false,
    });
    expect(resolvePlace(point, null, () => {
      throw new Error("boom");
    }).countryCode).toBeNull();
    expect(resolvePlace(point, null, () => "not a code").countryCode).toBeNull();
  });

  it("uses the real borders by default (point, not the 0.1° cell centre)", () => {
    // Glacier National Park, 3 km south of the 49th parallel: its cell centre (49.0) lies on the border.
    expect(resolvePlace({ lng: -113.8, lat: 48.973 }, { countryCode: "ca", regionName: "Alberta", nearestPlace: "Waterton Park" })).toMatchObject({
      countryCode: "us",
      regionName: null,
      nearestPlace: null,
    });
  });
});

describe("buildTrailRecord: place from the trailhead's exact point", () => {
  const ORIGIN = { lat: 48.973, lng: -113.8 };
  const at = (east: number, north: number): [number, number] => {
    const p = offsetMeters(ORIGIN, east, north);
    return [p.lng, p.lat];
  };
  const LINE: Line[] = [[at(0, 0), at(800, 0), at(1600, 0)]];
  const input = (over: Partial<TrailRecordInput> = {}): TrailRecordInput => ({
    provider: "osm",
    providerId: "relation/7",
    attributes: ATTRS,
    lines: LINE,
    routeType: "linear",
    sourceName: "OpenStreetMap contributors",
    sourceUrl: null,
    sourceLicense: "ODbL 1.0",
    elevation: null,
    pois: [],
    admin: null,
    timezone: null,
    ...over,
  });

  it("stores the real country and no foreign region when the cell answer is the neighbour's", () => {
    const r = buildTrailRecord(input({ admin: { countryCode: "ca", regionName: "Alberta", nearestPlace: "Waterton Park" } }))!;
    expect(r.countryCode).toBe("us");
    expect(r.regionSlug).toBe("unknown");
    expect(r.regionName).toBeNull();
    expect(r.nearestPlace).toBeNull();
  });

  it("keeps consistent names", () => {
    const r = buildTrailRecord(input({ admin: { countryCode: "us", regionName: "Montana", nearestPlace: "Babb" } }))!;
    expect(r).toMatchObject({ countryCode: "us", regionName: "Montana", regionSlug: "montana", nearestPlace: "Babb" });
  });

  it("asks for the country at the trailhead", () => {
    const seen: [number, number][] = [];
    buildTrailRecord(
      input({
        countryAt: (lat, lng) => {
          seen.push([lat, lng]);
          return "us";
        },
      }),
    );
    expect(seen).toEqual([[LINE[0][0][1], LINE[0][0][0]]]);
  });
});

describe("selectTrailhead: attribution by provider", () => {
  const ORIGIN = { lat: 37.75, lng: -119.6 };
  const at = (east: number, north: number): [number, number] => {
    const p = offsetMeters(ORIGIN, east, north);
    return [p.lng, p.lat];
  };
  const LINE: Line[] = [[at(0, 0), at(1000, 0)]];
  const th = (provider: string, providerId: string, east: number): NearbyPoi => {
    const [lng, lat] = at(east, 0);
    return { provider, providerId, category: "trailhead", lng, lat };
  };

  it("labels a Recreation.gov (RIDB) trailhead 'official', an OSM one 'osm_trailhead'", () => {
    expect(selectTrailhead(LINE, [th("ridb", "facility/123", -30)])).toMatchObject({ source: "official", poiId: "facility/123" });
    expect(selectTrailhead(LINE, [th("osm", "node/9", -30)])).toMatchObject({ source: "osm_trailhead", poiId: "node/9" });
    // Nearest wins whichever the source; the label follows the winner.
    expect(selectTrailhead(LINE, [th("osm", "node/9", -90), th("ridb", "facility/123", -20)])).toMatchObject({ source: "official", poiId: "facility/123" });
    expect(selectTrailhead(LINE, [th("osm", "node/9", -20), th("ridb", "facility/123", -90)])).toMatchObject({ source: "osm_trailhead", poiId: "node/9" });
  });

  it("stores the official label on the record", () => {
    const r = buildTrailRecord({
      provider: "osm",
      providerId: "relation/8",
      attributes: ATTRS,
      lines: LINE,
      routeType: "linear",
      sourceName: "OpenStreetMap contributors",
      sourceUrl: null,
      sourceLicense: "ODbL 1.0",
      elevation: null,
      pois: [th("ridb", "facility/123", -30)],
      admin: null,
      timezone: null,
    })!;
    expect(r.trailheadSource).toBe("official");
  });

  it("ignores POIs without a provider", () => {
    const anonymous = { ...th("osm", "node/1", -10), provider: "" };
    expect(selectTrailhead(LINE, [anonymous])!.source).toBe("route_start");
  });
});
