/**
 * Pure parts of the Nominatim geocoder: query parsing and response mapping,
 * against real Nominatim responses (tests/fixtures/nominatim, see README)
 * plus synthetic edge cases. No network, no database.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  adminCellKey,
  geocodeCacheKey,
  mapNominatimResult,
  mapNominatimResults,
  mapNominatimReverse,
  nominatimBbox,
  parsePlaceQuery,
} from "@/server/geo/geocode";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../fixtures/nominatim/${name}`, import.meta.url), "utf8"));

describe("parsePlaceQuery", () => {
  it.each([
    // plain places are kept as typed (whitespace collapsed)
    ["Banff", "Banff", false],
    ["  Mount   Fuji  ", "Mount Fuji", false],
    ["Columbia SC", "Columbia SC", false],
    ["Banff National Park", "Banff National Park", false],
    // leading intent phrases
    ["trails near Denver", "Denver", false],
    ["Trails Near Denver", "Denver", false],
    ["hikes in Yosemite", "Yosemite", false],
    ["hiking near Asheville, NC", "Asheville, NC", false],
    ["best hikes around Banff", "Banff", false],
    ["BEST HIKES AROUND BANFF", "BANFF", false],
    ["the 10 best hikes near Lake Tahoe", "Lake Tahoe", false],
    ["easy trails close to Boulder", "Boulder", false],
    ["dog-friendly hikes near Portland", "Portland", false],
    ["day hikes from Seattle", "Seattle", false],
    ["hiking trails in the Smoky Mountains", "the Smoky Mountains", false],
    ["where to hike near Zion", "Zion", false],
    ["find trails near Moab?", "Moab", false],
    ["trails and hikes near Sedona", "Sedona", false],
    // trailing intent words (plural only)
    ["Banff hikes", "Banff", false],
    ["Denver trails", "Denver", false],
    ["Asheville hiking trails", "Asheville", false],
    ["Chamonix hiking", "Chamonix", false],
    ["Lake District walks", "Lake District", false],
    // names that merely contain trail words stay intact
    ["Appalachian Trail", "Appalachian Trail", false],
    ["Pacific Crest Trail", "Pacific Crest Trail", false],
    ["Trail Ridge Road", "Trail Ridge Road", false],
    ["Hiking Hill", "Hiking Hill", false],
    // bare prepositions
    ["near Denver", "Denver", false],
    ["around Banff", "Banff", false],
    // near me
    ["near me", "", true],
    ["Near Me", "", true],
    ["nearby", "", true],
    ["hikes near me", "", true],
    ["best trails near me", "", true],
    ["trails nearby", "", true],
    ["nearby hikes", "", true],
    ["hiking around me", "", true],
    ["easy hikes close to me", "", true],
    // nothing to look up
    ["", "", false],
    ["   ", "", false],
    ["hikes", "", false],
    ["hiking trails", "", false],
    ["best hikes", "", false],
  ])("%j → %j (nearMe %s)", (q, placeQuery, nearMe) => {
    expect(parsePlaceQuery(q)).toEqual({ placeQuery, nearMe });
  });

  it("tolerates non-string input and very long queries", () => {
    expect(parsePlaceQuery(undefined as unknown as string)).toEqual({ placeQuery: "", nearMe: false });
    const long = `trails near ${"a".repeat(500)}`;
    const r = parsePlaceQuery(long);
    expect(r.nearMe).toBe(false);
    expect(r.placeQuery.length).toBeLessThanOrEqual(200);
  });

  it("strips control characters and wrapping quotes", () => {
    expect(parsePlaceQuery('"Banff"')).toEqual({ placeQuery: "Banff", nearMe: false });
    expect(parsePlaceQuery("Ban\u0000ff\nhikes")).toEqual({ placeQuery: "Ban ff", nearMe: false });
  });
});

describe("geocodeCacheKey", () => {
  it("trims, collapses whitespace and lower-cases", () => {
    expect(geocodeCacheKey("  Mount   FUJI ")).toBe("mount fuji");
    expect(geocodeCacheKey("Columbia\tSC")).toBe("columbia sc");
  });
});

describe("nominatimBbox", () => {
  it("reorders [south, north, west, east] strings into [w, s, e, n]", () => {
    expect(nominatimBbox(["51.1612529", "51.1934089", "-115.5910001", "-115.5452022"])).toEqual([
      -115.5910001, 51.1612529, -115.5452022, 51.1934089,
    ]);
  });

  it.each([
    [null],
    [["1", "2", "3"]],
    [["a", "2", "3", "4"]],
    [["10", "5", "0", "1"]], // south > north
    [["0", "1", "5", "4"]], // west > east
    [["-91", "1", "0", "1"]],
    [["0", "1", "-181", "1"]],
  ])("rejects %j", (v) => {
    expect(nominatimBbox(v)).toBeNull();
  });
});

describe("mapNominatimResults with real responses", () => {
  it("Banff: two towns in two countries, labelled name/region/country", () => {
    const r = mapNominatimResults(fixture("search-banff.json"));
    expect(r).toEqual([
      {
        id: "osm:relation/8452792",
        label: "Banff, Alberta, Canada",
        kind: "town",
        lng: -115.5720773,
        lat: 51.175076,
        bbox: [-115.5910001, 51.1612529, -115.5452022, 51.1934089],
        countryCode: "ca",
        source: "OpenStreetMap Nominatim",
      },
      {
        id: "osm:node/31816622",
        label: "Banff, Scotland, United Kingdom",
        kind: "town",
        lng: -2.5217539,
        lat: 57.6645459,
        bbox: [-2.5617539, 57.6245459, -2.4817539, 57.7045459],
        countryCode: "gb",
        source: "OpenStreetMap Nominatim",
      },
    ]);
  });

  it("Mount Fuji: a volcano and peaks; province used as the region", () => {
    const r = mapNominatimResults(fixture("search-mount-fuji.json"));
    expect(r.map((x) => [x.kind, x.label, x.countryCode])).toEqual([
      ["volcano", "Mount Fuji, Shizuoka Prefecture, Japan", "jp"],
      ["peak", "Mount Fuji, Nagasaki Prefecture, Japan", "jp"],
      ["peak", "Mount Fuji, Wisconsin, United States", "us"],
    ]);
    expect(r[0]).toMatchObject({ lng: 138.7307677, lat: 35.3628384, bbox: [138.7307177, 35.3627884, 138.7308177, 35.3628884] });
  });

  it("Columbia SC: a city (boundary relation with addresstype city)", () => {
    const [c, ...rest] = mapNominatimResults(fixture("search-columbia-sc.json"));
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({ kind: "city", label: "Columbia, South Carolina, United States", countryCode: "us" });
    expect(c.bbox).toEqual([-81.170978, 33.943248, -80.7038161, 34.131597]);
  });

  it("Banff National Park: leisure=nature_reserve", () => {
    const [p] = mapNominatimResults(fixture("search-banff-national-park.json"));
    expect(p).toMatchObject({ kind: "nature_reserve", label: "Banff National Park, Alberta, Canada", countryCode: "ca" });
  });

  it("unclassified objects (a chalet, an events venue) fall back to kind 'place'", () => {
    const r = mapNominatimResults(fixture("search-great-smoky-mountains.json"));
    expect(r.map((x) => x.kind)).toEqual(["place", "place"]);
    expect(r[0].label).toBe("Smokey Mountains View, Tennessee, United States");
  });

  it("an empty answer maps to no results", () => {
    expect(mapNominatimResults(fixture("search-no-results.json"))).toEqual([]);
  });
});

describe("mapNominatimResult / mapNominatimResults edge cases", () => {
  const base = {
    place_id: 1,
    osm_type: "node",
    osm_id: 42,
    lat: "10.5",
    lon: "20.25",
    category: "place",
    type: "village",
    addresstype: "village",
    name: "Testville",
    display_name: "Testville, Some State, Somewhere",
    address: { village: "Testville", state: "Some State", country: "Somewhere", country_code: "SW" },
    boundingbox: ["10", "11", "20", "21"],
  };

  it("maps kinds from addresstype, then type, then category", () => {
    const kind = (o: Record<string, unknown>) => mapNominatimResult({ ...base, ...o })?.kind;
    expect(kind({ addresstype: "hamlet" })).toBe("hamlet");
    expect(kind({ addresstype: "state", type: "administrative", category: "boundary" })).toBe("region");
    expect(kind({ addresstype: "province" })).toBe("region");
    expect(kind({ addresstype: "county" })).toBe("county");
    expect(kind({ addresstype: "country" })).toBe("country");
    expect(kind({ addresstype: "x", type: "national_park", category: "boundary" })).toBe("national_park");
    expect(kind({ addresstype: "x", type: "protected_area", category: "boundary" })).toBe("protected_area");
    expect(kind({ addresstype: "x", type: "mountain_range", category: "natural" })).toBe("mountain_range");
    expect(kind({ addresstype: "x", type: "administrative", category: "boundary" })).toBe("region");
    expect(kind({ addresstype: "x", type: "y", category: "z" })).toBe("place");
    expect(kind({ addresstype: undefined, type: undefined, category: undefined, class: "highway" })).toBe("place");
    expect(kind({ addresstype: undefined, type: "path", category: "highway" })).toBe("trail");
  });

  it("lower-cases valid country codes and drops invalid ones", () => {
    expect(mapNominatimResult(base)?.countryCode).toBe("sw");
    expect(mapNominatimResult({ ...base, address: { ...base.address, country_code: "usa" } })?.countryCode).toBeNull();
    expect(mapNominatimResult({ ...base, address: undefined })?.countryCode).toBeNull();
  });

  it("labels countries by name only and drops repeated parts", () => {
    expect(mapNominatimResult({ ...base, addresstype: "country", name: "Somewhere" })?.label).toBe("Somewhere");
    expect(mapNominatimResult({ ...base, addresstype: "state", name: "Some State" })?.label).toBe("Some State, Somewhere");
  });

  it("falls back to display_name for the name, and to place_id for the id", () => {
    const r = mapNominatimResult({ ...base, name: "", osm_type: undefined, osm_id: undefined });
    expect(r?.label).toBe("Testville, Some State, Somewhere");
    expect(r?.id).toBe("nominatim:1");
  });

  it("skips results without a usable name or position", () => {
    expect(mapNominatimResult({ ...base, name: "", display_name: "" })).toBeNull();
    expect(mapNominatimResult({ ...base, lat: "x" })).toBeNull();
    expect(mapNominatimResult({ ...base, lat: "91" })).toBeNull();
    expect(mapNominatimResult({ ...base, lon: "-181" })).toBeNull();
    expect(mapNominatimResult(null)).toBeNull();
    expect(mapNominatimResult("Banff")).toBeNull();
    expect(mapNominatimResult([base])).toBeNull();
  });

  it("keeps the result but drops an invalid bbox", () => {
    expect(mapNominatimResult({ ...base, boundingbox: ["11", "10", "20", "21"] })?.bbox).toBeNull();
  });

  it("de-duplicates the same object and the same label close together", () => {
    const relation = { ...base, osm_type: "relation", osm_id: 7 };
    const nodeNearby = { ...base, osm_type: "node", osm_id: 8, lat: "10.55", lon: "20.3" };
    const sameNameFarAway = { ...base, osm_type: "node", osm_id: 9, lat: "40", lon: "20.25" };
    const r = mapNominatimResults([relation, nodeNearby, relation, sameNameFarAway]);
    expect(r.map((x) => x.id)).toEqual(["osm:relation/7", "osm:node/9"]);
  });

  it("returns at most 6 results and ignores non-arrays", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...base, osm_id: i + 1, name: `Place ${i}` }));
    expect(mapNominatimResults(many)).toHaveLength(6);
    expect(mapNominatimResults({ error: "x" })).toEqual([]);
    expect(mapNominatimResults(null)).toEqual([]);
  });
});

describe("mapNominatimReverse", () => {
  it("maps a real zoom-10 answer (county level: no town in the answer)", () => {
    expect(mapNominatimReverse(fixture("reverse-table-rock.json"))).toEqual({
      countryCode: "us",
      regionName: "South Carolina",
      nearestPlace: null,
    });
  });

  it("picks region and nearest place by precedence", () => {
    expect(
      mapNominatimReverse({ address: { province: "Shizuoka Prefecture", county: "Sunto", town: "Oyama", suburb: "X", country_code: "JP" } }),
    ).toEqual({ countryCode: "jp", regionName: "Shizuoka Prefecture", nearestPlace: "Oyama" });
    expect(mapNominatimReverse({ address: { county: "Pickens County", hamlet: "Sunset", country_code: "us" } })).toEqual({
      countryCode: "us",
      regionName: "Pickens County",
      nearestPlace: "Sunset",
    });
    expect(mapNominatimReverse({ address: { state: "Alberta", city: "Calgary", village: "Nope" } })).toEqual({
      countryCode: null,
      regionName: "Alberta",
      nearestPlace: "Calgary",
    });
  });

  it("answers all-null for 'Unable to geocode' (open sea) and null for anything else", () => {
    expect(mapNominatimReverse({ error: "Unable to geocode" })).toEqual({ countryCode: null, regionName: null, nearestPlace: null });
    expect(mapNominatimReverse({})).toBeNull();
    expect(mapNominatimReverse([])).toBeNull();
    expect(mapNominatimReverse("x")).toBeNull();
    expect(mapNominatimReverse(null)).toBeNull();
  });
});

describe("adminCellKey", () => {
  it.each([
    [35.04, -82.71, "350/-827"],
    [35.05, -82.75, "351/-827"],
    [51.175, -115.572, "512/-1156"],
    [-0.04, 0.04, "0/0"],
    [0.04, -0.04, "0/0"],
    [90, 180, "900/1800"],
    [-90, -180, "-900/-1800"],
  ])("(%s, %s) → %s", (lat, lng, key) => {
    expect(adminCellKey(lat, lng)).toBe(key);
  });
});
