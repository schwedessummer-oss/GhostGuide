/**
 * RIDB facilities → normalized POIs (pure parsing): the schema-accurate
 * fixture (tests/fixtures/ridb), the facility-type mapping table, HTML
 * stripping and truncation, provenance tags and source URLs, and defensive
 * handling of malformed records and bodies.
 */
import { describe, expect, it } from "vitest";
import type { Bbox } from "@/domain/catalog";
import { OUTDOOR_POI_CATEGORIES } from "@/domain/catalog";
import {
  FACILITY_TYPE_CATEGORIES,
  MAX_FEE_DESCRIPTION_CHARS,
  RIDB_SOURCE_LICENSE,
  RIDB_SOURCE_NAME,
  RidbResponseError,
  categoryForFacilityType,
  facilitiesToPois,
  facilityCoordinates,
  facilityToPoi,
  parseFacilitiesPage,
  stripHtml,
  truncateText,
} from "@/server/trails/providers/ridb/parse";
import page from "../../fixtures/ridb/facilities-union-creek-tile.json";

const TILE: Bbox = [-118.25, 44.5, -118.0, 44.75];
const records = page.RECDATA as unknown[];
const byId = (id: string) => records.find((r) => (r as { FacilityID: string }).FacilityID === id) as Record<string, unknown>;

/** Every property the RIDB OpenAPI spec lists as required for Facility. */
const REQUIRED = [
  "FacilityID", "LegacyFacilityID", "OrgFacilityID", "FacilityName", "FacilityDescription", "FacilityTypeDescription",
  "FacilityUseFeeDescription", "FacilityDirections", "FacilityAccessibilityText", "FacilityPhone", "FacilityEmail",
  "FacilityReservationURL", "FacilityMapURL", "FacilityAdaAccess", "GEOJSON", "FacilityLongitude", "FacilityLatitude",
  "StayLimit", "Keywords", "Reservable", "Enabled", "LastUpdatedDate",
];

describe("ridb fixture", () => {
  it("follows the documented response schema", () => {
    expect(Object.keys(page).sort()).toEqual(["METADATA", "RECDATA"]);
    expect(page.METADATA.RESULTS).toEqual({ CURRENT_COUNT: records.length, TOTAL_COUNT: records.length });
    expect(page.METADATA.PARAMETERS).toEqual({ QUERY: "", LIMIT: 50, OFFSET: 0 });
    for (const r of records as Record<string, unknown>[]) {
      for (const key of REQUIRED) expect(r, `${String(r.FacilityID)} lacks ${key}`).toHaveProperty(key);
      expect(typeof r.FacilityID).toBe("string");
      expect(typeof r.FacilityLongitude).toBe("number");
      expect(typeof r.FacilityLatitude).toBe("number");
      expect(typeof r.Reservable).toBe("boolean");
      expect(typeof r.Enabled).toBe("boolean");
      expect(r.LastUpdatedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect((r.GEOJSON as { TYPE: string }).TYPE).toBe("Point");
    }
  });
});

describe("ridb parse: facility types", () => {
  it("maps only types it can map confidently", () => {
    expect(categoryForFacilityType("Campground")).toBe("campsite");
    expect(categoryForFacilityType("Trailhead")).toBe("trailhead");
    expect(categoryForFacilityType("Visitor Center")).toBe("information");
    expect(categoryForFacilityType("Visitor Centre")).toBe("information");
    expect(categoryForFacilityType("Information")).toBe("information");
    expect(categoryForFacilityType("Information Center")).toBe("information");
    expect(categoryForFacilityType("Information Site")).toBe("information");
    expect(categoryForFacilityType("Ranger Station")).toBe("ranger_station");
    // case and whitespace do not matter
    expect(categoryForFacilityType("  ranger   STATION ")).toBe("ranger_station");
    for (const skipped of ["Facility", "Permit", "Ticket Facility", "Tour", "Activity Pass", "Cabin", "Lookout", "Library", "Kiosk", "Campsite", "", "Campgrounds"]) {
      expect(categoryForFacilityType(skipped), skipped).toBeNull();
    }
    expect(categoryForFacilityType(null)).toBeNull();
    expect(categoryForFacilityType(42)).toBeNull();
  });

  it("only produces outdoor-layer categories", () => {
    for (const category of Object.values(FACILITY_TYPE_CATEGORIES)) expect(OUTDOOR_POI_CATEGORIES).toContain(category);
  });
});

describe("ridb parse: fixture page", () => {
  const { pois, skipped } = facilitiesToPois(parseFacilitiesPage(page).records, TILE);
  const poi = (id: string) => pois.find((p) => p.providerId === `facility/${id}`);

  it("keeps the mappable facilities in the tile and counts why the others were skipped", () => {
    expect(pois.map((p) => [p.providerId, p.category])).toEqual([
      ["facility/233115", "campsite"],
      ["facility/990001", "campsite"],
      ["facility/990002", "trailhead"],
      ["facility/990003", "information"],
      ["facility/990004", "ranger_station"],
      ["facility/990005", "information"],
    ]);
    expect(skipped).toEqual({ invalid: 0, disabled: 1, unmapped_type: 2, no_coordinates: 1, outside_area: 1, duplicate: 0 });
  });

  it("maps the spec's example facility field by field", () => {
    expect(poi("233115")).toEqual({
      provider: "ridb",
      providerId: "facility/233115",
      layer: "outdoor",
      category: "campsite",
      name: "UNION CREEK CAMPGROUND",
      nameEn: null,
      lng: -118.0186111,
      lat: 44.6969444,
      elevationM: null,
      tags: { FacilityID: "233115", FacilityTypeDescription: "Campground", Reservable: "false", LastUpdatedDate: "2018-10-01" },
      openingHours: null,
      phone: "541-894-2332",
      website: null,
      sourceName: RIDB_SOURCE_NAME,
      sourceUrl: "https://ridb.recreation.gov/api/v1/facilities/233115",
      sourceLicense: RIDB_SOURCE_LICENSE,
    });
    expect(RIDB_SOURCE_NAME).toBe("Recreation.gov (RIDB)");
    expect(RIDB_SOURCE_LICENSE).toBe("US Government work (public domain)");
  });

  it("links reservable campgrounds to their Recreation.gov page, everything else to the RIDB facility", () => {
    expect(poi("990001")!.sourceUrl).toBe("https://www.recreation.gov/camping/campgrounds/990001");
    expect(poi("990001")!.website).toBe("https://www.recreation.gov/camping/campgrounds/990001");
    expect(poi("990002")!.sourceUrl).toBe("https://ridb.recreation.gov/api/v1/facilities/990002");
    // A reservable non-campground (e.g. a permit) never gets a campground URL — it is skipped anyway.
    const permit = facilityToPoi({ ...byId("990007"), FacilityTypeDescription: "Trailhead" });
    expect("poi" in permit && permit.poi.sourceUrl).toBe("https://ridb.recreation.gov/api/v1/facilities/990007");
  });

  it("strips HTML from names and fee texts and truncates the fee text", () => {
    expect(poi("990005")!.name).toBe("Example & Co Information Site");
    const fee = poi("990001")!.tags.FacilityUseFeeDescription;
    expect(fee).toBeDefined();
    expect(fee).not.toMatch(/[<>]/);
    expect(fee!.startsWith("Fees: $20.00 per night for single sites & $5.00 per extra vehicle. Group sites:")).toBe(true);
    expect(Array.from(fee!).length).toBeLessThanOrEqual(MAX_FEE_DESCRIPTION_CHARS);
    expect(fee!.endsWith("…")).toBe(true);
    // No empty fee tag when RIDB has none.
    expect(poi("233115")!.tags).not.toHaveProperty("FacilityUseFeeDescription");
  });

  it("never stores descriptions, directions, e-mail addresses or accessibility text", () => {
    const json = JSON.stringify(pois);
    expect(json).not.toMatch(/Overview|Baker City|anthonylakes|wheelchair|Synthetic/);
    const allowed = ["FacilityID", "FacilityTypeDescription", "FacilityUseFeeDescription", "LastUpdatedDate", "Reservable"];
    for (const p of pois) {
      for (const key of Object.keys(p.tags)) expect(allowed).toContain(key);
      expect(p.tags.FacilityID).toBe(p.providerId.replace("facility/", ""));
    }
  });

  it("keeps facilities on the tile edge and drops those outside", () => {
    const edge = { ...byId("990002"), FacilityID: "990100", FacilityLongitude: -118.0, FacilityLatitude: 44.75 };
    const outside = { ...byId("990002"), FacilityID: "990101", FacilityLongitude: -117.9999, FacilityLatitude: 44.6 };
    const r = facilitiesToPois([edge, outside], TILE);
    expect(r.pois.map((p) => p.providerId)).toEqual(["facility/990100"]);
    expect(r.skipped.outside_area).toBe(1);
    // Without a bbox nothing is dropped for its location.
    expect(facilitiesToPois([edge, outside]).pois).toHaveLength(2);
  });

  it("keeps the first of duplicate facility ids", () => {
    const dup = { ...byId("990002"), FacilityName: "Second copy" };
    const r = facilitiesToPois([byId("990002"), dup], TILE);
    expect(r.pois.map((p) => p.name)).toEqual(["Example Ridge Trailhead"]);
    expect(r.skipped.duplicate).toBe(1);
  });
});

describe("ridb parse: defensive handling", () => {
  const base = byId("990002");

  it("skips malformed records individually", () => {
    const bad = [null, 7, "x", [], {}, { ...base, FacilityID: "" }, { ...base, FacilityID: "a/b" }, { ...base, FacilityID: "x".repeat(41) }];
    const r = facilitiesToPois(bad, TILE);
    expect(r.pois).toEqual([]);
    expect(r.skipped.invalid).toBe(bad.length);
    // numeric ids are accepted as their decimal string
    const numeric = facilityToPoi({ ...base, FacilityID: 123 });
    expect("poi" in numeric && numeric.poi.providerId).toBe("facility/123");
  });

  it("uses GEOJSON coordinates when the explicit fields are unusable, and rejects 0,0 and out-of-range values", () => {
    expect(facilityCoordinates({ FacilityLongitude: -118.1, FacilityLatitude: 44.6 })).toEqual([-118.1, 44.6]);
    expect(facilityCoordinates({ FacilityLongitude: "-118.1", FacilityLatitude: "44.6" })).toEqual([-118.1, 44.6]);
    expect(facilityCoordinates({ FacilityLongitude: 0, FacilityLatitude: 0, GEOJSON: { TYPE: "Point", COORDINATES: [-118.2, 44.7] } })).toEqual([-118.2, 44.7]);
    expect(facilityCoordinates({ FacilityLongitude: 0, FacilityLatitude: 0, GEOJSON: { TYPE: "Point", COORDINATES: [0, 0] } })).toBeNull();
    expect(facilityCoordinates({ FacilityLongitude: 200, FacilityLatitude: 44 })).toBeNull();
    expect(facilityCoordinates({ FacilityLongitude: -118, FacilityLatitude: 95 })).toBeNull();
    expect(facilityCoordinates({ FacilityLongitude: Number.NaN, FacilityLatitude: 44 })).toBeNull();
    expect(facilityCoordinates({ FacilityLongitude: "", FacilityLatitude: "" })).toBeNull();
    expect(facilityCoordinates({})).toBeNull();
  });

  it("drops a phone without digits or that is too long, and a reservation URL that is not http(s)", () => {
    const r = (o: Record<string, unknown>) => {
      const x = facilityToPoi({ ...base, ...o });
      if (!("poi" in x)) throw new Error("expected a POI");
      return x.poi;
    };
    expect(r({ FacilityPhone: "n/a" }).phone).toBeNull();
    expect(r({ FacilityPhone: "1".repeat(41) }).phone).toBeNull();
    expect(r({ FacilityPhone: " 541-555-0199 " }).phone).toBe("541-555-0199");
    expect(r({ FacilityReservationURL: "javascript:alert(1)" }).website).toBeNull();
    expect(r({ FacilityReservationURL: "not a url" }).website).toBeNull();
    expect(r({ FacilityReservationURL: "http://example.org/r" }).website).toBe("http://example.org/r");
    expect(r({ Reservable: "maybe" }).tags).not.toHaveProperty("Reservable");
    expect(r({ LastUpdatedDate: "yesterday" }).tags).not.toHaveProperty("LastUpdatedDate");
    expect(r({ FacilityName: "<p> </p>" }).name).toBeNull();
    expect(facilityToPoi({ ...base, Enabled: "false" })).toEqual({ skip: "disabled" });
  });

  it("rejects bodies that are not a facilities page instead of treating them as empty", () => {
    for (const body of [null, [], "x", {}, { RECDATA: null }, { RECDATA: {} }, { METADATA: {} }]) {
      expect(() => parseFacilitiesPage(body), JSON.stringify(body)).toThrow(RidbResponseError);
    }
    expect(parseFacilitiesPage({ RECDATA: [] })).toEqual({ records: [], totalCount: null });
    expect(parseFacilitiesPage({ RECDATA: [], METADATA: { RESULTS: { TOTAL_COUNT: -1 } } }).totalCount).toBeNull();
    expect(parseFacilitiesPage({ RECDATA: [], METADATA: { RESULTS: { TOTAL_COUNT: "5" } } }).totalCount).toBeNull();
    expect(parseFacilitiesPage({ RECDATA: [], METADATA: { RESULTS: { TOTAL_COUNT: 120 } } }).totalCount).toBe(120);
  });
});

describe("ridb parse: text helpers", () => {
  it("stripHtml removes tags, script/style content and decodes entities", () => {
    expect(stripHtml("<h2>Overview:</h2>Line<br />two &amp; three&nbsp;&#8211;&#x2014; &quot;q&quot; &unknown;")).toBe(
      "Overview: Line two & three –— \"q\" &unknown;",
    );
    expect(stripHtml("<script>alert(1)</script><style>p{}</style>Safe")).toBe("Safe");
    expect(stripHtml("a < b")).toBe("a b");
    expect(stripHtml("&#0; &#xD800; x")).toBe("x");
    expect(stripHtml(undefined)).toBe("");
    expect(stripHtml(12)).toBe("");
  });

  it("truncateText cuts at a word boundary with an ellipsis", () => {
    expect(truncateText("short", 10)).toBe("short");
    expect(truncateText("alpha beta gamma delta", 15)).toBe("alpha beta…");
    // no usable word boundary: hard cut
    expect(truncateText("one two thrilling", 12)).toBe("one two thr…");
    expect(Array.from(truncateText("x".repeat(50), 10)).length).toBe(10);
  });
});
