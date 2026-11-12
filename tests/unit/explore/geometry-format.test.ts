import { describe, expect, it } from "vitest";
import type { CoverageDto, TrailSummaryDto } from "@/domain/catalog";
import { bboxAroundPoint, bboxForPlace, bboxWithin, clampBbox, coarsenLocation, trailsToFeatureCollection } from "@/components/explore/geometry";
import {
  climbText,
  coverageSummary,
  difficultyText,
  durationText,
  englishName,
  formatAgo,
  hikeDistanceText,
  placeLine,
  resultCountText,
  topFeatures,
} from "@/components/explore/format";

const TRAIL: TrailSummaryDto = {
  id: "0ae15977-bbbe-467f-94f3-74534a4da5db",
  path: "/trail/us/south-carolina/table-rock-trail",
  name: "Table Rock Trail",
  nameEn: null,
  countryCode: "us",
  regionName: "South Carolina",
  nearestPlace: null,
  centroid: { lng: -82.708, lat: 35.043 },
  trailhead: { lng: -82.6996, lat: 35.0317 },
  distanceM: 5483,
  routeType: "linear",
  elevationGainM: 609,
  estimatedDurationMin: 104,
  hikeDistanceM: 10966,
  hikeGainM: 695,
  hikeDurationMin: 186,
  difficulty: "hard",
  difficultySource: "estimated",
  features: ["shelter", "peak", "waterfall", "viewpoint", "cave"],
  dogPolicy: "unknown",
  feeRequired: null,
  permitRequired: null,
  hasParking: true,
  hasToilets: true,
  hasCamping: false,
  familyFriendly: false,
  provider: "osm",
  sourceName: "OpenStreetMap contributors",
  lastSyncedAt: "2026-11-12T13:50:10.171Z",
};

describe("explore geometry", () => {
  it("clamps boxes to valid coordinates and rejects empty ones", () => {
    expect(clampBbox([-200, -95, 200, 95])).toEqual([-180, -85, 180, 85]);
    expect(clampBbox([10, 10, 5, 20])).toBeNull();
    expect(clampBbox([Number.NaN, 0, 1, 1])).toBeNull();
    expect(clampBbox([1, 2, 3])).toBeNull();
  });

  it("builds a box of the right size around a point", () => {
    const [w, s, e, n] = bboxAroundPoint({ lng: -82.7, lat: 35 }, 10);
    expect(n - s).toBeCloseTo(20 / 111.32, 4);
    // wider in longitude away from the equator
    expect(e - w).toBeGreaterThan(n - s);
    expect((w + e) / 2).toBeCloseTo(-82.7, 4);
  });

  it("uses a place's own box when it is big enough, else ~10 km around its point", () => {
    expect(bboxForPlace({ lng: -105, lat: 39.7, bbox: [-105.1, 39.6, -104.6, 39.9] })).toEqual([-105.1, 39.6, -104.6, 39.9]);
    const peak = bboxForPlace({ lng: -82.71, lat: 35.05, bbox: [-82.711, 35.049, -82.709, 35.051] });
    expect(peak[3] - peak[1]).toBeCloseTo(20 / 111.32, 3);
    const noBox = bboxForPlace({ lng: 10, lat: 50, bbox: null });
    expect(bboxWithin([9.99, 49.99, 10.01, 50.01], noBox)).toBe(true);
  });

  it("coarsens device locations to about 1 km", () => {
    expect(coarsenLocation({ lng: -82.712345, lat: 35.048765 })).toEqual({ lng: -82.71, lat: 35.05 });
  });

  it("checks containment", () => {
    expect(bboxWithin([0, 0, 1, 1], [-1, -1, 2, 2])).toBe(true);
    expect(bboxWithin([0, 0, 3, 1], [-1, -1, 2, 2])).toBe(false);
  });

  it("places each trail at its trailhead, else its centroid", () => {
    const fc = trailsToFeatureCollection([TRAIL, { ...TRAIL, id: "b", trailhead: null }]);
    expect(fc.features[0].geometry.coordinates).toEqual([-82.6996, 35.0317]);
    expect(fc.features[1].geometry.coordinates).toEqual([-82.708, 35.043]);
    expect(fc.features[0].properties).toEqual({ id: TRAIL.id, difficulty: "hard" });
  });
});

describe("explore formatting", () => {
  it("describes the hike as usually walked, with its route form", () => {
    expect(hikeDistanceText(TRAIL, "imperial")).toBe("6.8 mi out & back");
    expect(hikeDistanceText({ ...TRAIL, routeType: "loop", hikeDistanceM: 5000 }, "metric")).toBe("5.0 km loop");
    expect(hikeDistanceText({ ...TRAIL, routeType: "network" }, "imperial")).toBe("6.8 mi of paths (network)");
    expect(hikeDistanceText({ ...TRAIL, routeType: "unknown" }, "imperial")).toBe("6.8 mi");
    expect(climbText(TRAIL, "imperial")).toBe("2,280 ft");
    expect(climbText({ ...TRAIL, hikeGainM: null }, "imperial")).toBeNull();
    expect(durationText(TRAIL)).toBe("≈ 3 h 05 min");
    expect(durationText({ ...TRAIL, hikeDurationMin: null })).toBeNull();
  });

  it("marks estimated difficulty", () => {
    expect(difficultyText("hard", "estimated")).toEqual({ label: "Hard", estimated: true });
    expect(difficultyText("moderate", "osm_sac_scale")).toEqual({ label: "Moderate", estimated: false });
    expect(difficultyText("unknown", "estimated")).toEqual({ label: "Difficulty unknown", estimated: false });
  });

  it("orders features by what people choose hikes for", () => {
    expect(topFeatures(TRAIL.features)).toEqual(["waterfall", "viewpoint", "peak"]);
    expect(topFeatures([])).toEqual([]);
  });

  it("builds the place line from known parts only", () => {
    expect(placeLine(TRAIL)).toBe("South Carolina");
    expect(placeLine({ nearestPlace: "Pickens", regionName: "South Carolina" })).toBe("Pickens · South Carolina");
    expect(placeLine({ nearestPlace: "Utah", regionName: "utah" })).toBe("Utah");
    expect(placeLine({ nearestPlace: null, regionName: null })).toBeNull();
  });

  it("shows an English name only when it differs", () => {
    expect(englishName({ name: "Sentier du Lac", nameEn: "Lake Trail" })).toBe("Lake Trail");
    expect(englishName({ name: "Lake Trail", nameEn: "lake trail" })).toBeNull();
    expect(englishName({ name: "X", nameEn: null })).toBeNull();
  });

  it("formats freshness", () => {
    const now = new Date("2026-11-12T12:00:00Z");
    expect(formatAgo("2026-11-12T08:00:00Z", now)).toBe("today");
    expect(formatAgo("2026-11-11T08:00:00Z", now)).toBe("yesterday");
    expect(formatAgo("2026-11-09T12:00:00Z", now)).toBe("3 days ago");
    expect(formatAgo("2026-10-20T12:00:00Z", now)).toBe("3 weeks ago");
    expect(formatAgo("2026-05-01T12:00:00Z", now)).toBe("6 months ago");
    expect(formatAgo(null, now)).toBeNull();
    expect(formatAgo("not a date", now)).toBeNull();
  });

  it("summarizes coverage honestly", () => {
    const base: CoverageDto = { layer: "outdoor", state: "ready", tilesTotal: 2, tilesReady: 2, tilesLoading: 0, tilesFailed: 0, oldestSyncAt: null, message: "" };
    expect(coverageSummary(base)).toBeNull();
    expect(coverageSummary({ ...base, state: "loading", tilesReady: 1, tilesLoading: 1 })).toEqual({
      short: "Loading more trails…",
      tone: "info",
      progress: "1 of 2 areas ready",
    });
    expect(coverageSummary({ ...base, state: "too_large" })?.short).toBe("Zoom in to load trails here");
    expect(coverageSummary({ ...base, state: "failed" })?.tone).toBe("error");
    expect(coverageSummary({ ...base, state: "partial" })?.tone).toBe("warn");
  });

  it("counts results", () => {
    expect(resultCountText(14, 14)).toBe("14 trails");
    expect(resultCountText(1, 1)).toBe("1 trail");
    expect(resultCountText(100, 1312)).toBe("Showing 100 of 1,312 trails");
  });
});
