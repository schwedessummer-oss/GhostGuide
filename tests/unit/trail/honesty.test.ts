import { describe, expect, it } from "vitest";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CoverageDto, NearbyResponse, TrailConditionsDto, TrailDetailDto, WeatherAlertDto } from "@/domain/catalog";
import { Conditions, alertWindowText, latestStartView } from "@/components/trail/conditions-panel";
import { NearbyView, emptyServicesText } from "@/components/trail/nearby-panel";
import { SourceFooter } from "@/components/trail/source-footer";
import { TrailStats } from "@/components/trail/trail-stats";
import { cleanSource } from "@/components/trail/elevation-profile";
import { FLAT_PACE_KMH } from "@/components/trail/format";
import { FLAT_SPEED_NO_PROFILE_KMH } from "@/server/trails/estimate";

/*
 * Trail page honesty, rendered: the OSM snapshot time is not an edit time
 * (#8); a failed services load never says "nothing is mapped" (#9); alert
 * times name their day (#12); tomorrow's latest start is labelled (#22);
 * unknown precipitation is not "Dry" and small amounts don't read as zero
 * (#23); a moving time / rating without elevation data never claims the
 * climb was counted (#6/#7).
 */
const render = (el: ReactElement) => renderToStaticMarkup(el);
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const noop = () => {};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRAIL: TrailDetailDto = {
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
  features: [],
  dogPolicy: "unknown",
  feeRequired: null,
  permitRequired: null,
  hasParking: true,
  hasToilets: false,
  hasCamping: false,
  familyFriendly: false,
  provider: "osm",
  sourceName: "OpenStreetMap",
  lastSyncedAt: "2026-11-11T14:20:00.000Z",
  regionSlug: "south-carolina",
  slug: "table-rock-trail",
  timezone: "America/New_York",
  geometry: { type: "MultiLineString", coordinates: [[[-82.6996, 35.0317], [-82.708, 35.043]]] },
  bbox: [-82.72, 35.03, -82.69, 35.05],
  trailheadSource: "osm_trailhead",
  elevationLossM: 86,
  maxElevationM: 949,
  minElevationM: 340,
  elevationProfile: [
    [0, 340],
    [5483, 949],
  ],
  elevationSource: "AWS Terrain Tiles, sampled on a ~27 m grid; source data resolution varies by region (estimate)",
  sacScale: null,
  trailVisibility: null,
  surfaces: [],
  activities: [],
  description: null,
  wheelchair: "unknown",
  access: null,
  seasonality: null,
  operator: null,
  website: null,
  hasDrinkingWater: false,
  sourceUrl: "https://www.openstreetmap.org/relation/123",
  sourceLicense: "ODbL 1.0",
  sourceUpdatedAt: "2026-11-11T14:05:00.000Z",
  pois: [],
  attribution: [
    {
      name: "Elevation: AWS Terrain Tiles, sampled on a ~27 m grid; source data resolution varies by region (estimate)",
      url: "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
      license: null,
    },
  ],
};
/** The same trail when the terrain tiles failed at ingestion: no profile, no climb. */
const NO_ELEVATION: TrailDetailDto = {
  ...TRAIL,
  elevationGainM: null,
  elevationLossM: null,
  hikeGainM: null,
  maxElevationM: null,
  minElevationM: null,
  elevationProfile: null,
  elevationSource: null,
  hikeDurationMin: 145,
  difficulty: "unknown",
  difficultySource: null,
  attribution: [],
};

const NY = "America/New_York";
/** Thu Nov 12 2026, 4:00 PM EST. */
const LATE_AFTERNOON = "2026-11-12T21:00:00.000Z";

function conditions(over: Partial<TrailConditionsDto> = {}): TrailConditionsDto {
  return {
    trailId: TRAIL.id,
    generatedAt: LATE_AFTERNOON,
    timezone: NY,
    point: { lng: -82.6996, lat: 35.0317 },
    forecastStatus: "ok",
    current: null,
    hourly: [],
    daily: [],
    highlights: [],
    alertsStatus: "ok",
    alerts: [],
    sun: [
      { date: "2026-11-12", sunrise: "2026-11-12T11:50:00.000Z", sunset: "2026-11-12T22:20:00.000Z", civilDusk: null, polar: null },
      { date: "2026-11-13", sunrise: "2026-11-13T11:51:00.000Z", sunset: "2026-11-13T22:19:00.000Z", civilDusk: null, polar: null },
    ],
    planning: {
      estimatedDurationMin: 90,
      outAndBackDurationMin: 180,
      latestRecommendedStart: null,
      finishIfStartNow: null,
      daylightRemainingMin: 80,
      durationBasis: "elevation_profile",
      notes: [],
    },
    forecastUpdatedAt: null,
    attribution: [],
    ...over,
  };
}
const renderConditions = (data: TrailConditionsDto) => text(render(h(Conditions, { data, onRetry: noop })));

// ---------------------------------------------------------------------------
// #8 Source footer
// ---------------------------------------------------------------------------

describe("source footer (#8)", () => {
  it("labels the OpenStreetMap snapshot time as 'data as of', never as an edit time", () => {
    const out = text(render(h(SourceFooter, { trail: TRAIL })));
    // Absolute, never "… ago": the page is cached, so a relative age would go stale.
    expect(out).toContain("last updated in Ghost Guide Nov 11, 2026, 14:20 UTC");
    expect(out).not.toMatch(/\bago\b/);
    expect(out).toContain("OpenStreetMap data as of Nov 11, 2026, 14:05 UTC");
    expect(out).not.toMatch(/last edited/i);
    // The machine-readable time is the stored instant.
    expect(render(h(SourceFooter, { trail: TRAIL }))).toContain('dateTime="2026-11-11T14:05:00.000Z"');
  });

  it("says nothing about the source's time when it is unknown", () => {
    const out = text(render(h(SourceFooter, { trail: { ...TRAIL, sourceUpdatedAt: null } })));
    expect(out).not.toMatch(/as of|last edited/i);
  });

  it("rewrites elevation labels stored with the old '~27 m DEM' wording (#27)", () => {
    const legacy = "Elevation: AWS Terrain Tiles, ~27 m DEM (estimate)";
    const out = text(render(h(SourceFooter, { trail: { ...TRAIL, attribution: [{ name: legacy, url: null, license: null }] } })));
    expect(out).toContain("Elevation: AWS Terrain Tiles, sampled on a ~27 m grid; source data resolution varies by region (estimate)");
    expect(out).not.toMatch(/m DEM/);
    expect(cleanSource("AWS Terrain Tiles, ~27 m DEM (estimate)")).toBe(
      "AWS Terrain Tiles, sampled on a ~27 m grid; source data resolution varies by region",
    );
    expect(cleanSource("Terrarium terrain tiles, ~31 m DEM (estimate)")).toBe("Terrarium terrain tiles, sampled on a ~31 m grid");
    expect(cleanSource(TRAIL.elevationSource)).toBe("AWS Terrain Tiles, sampled on a ~27 m grid; source data resolution varies by region");
    expect(cleanSource(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #9 Nearby services
// ---------------------------------------------------------------------------

function nearby(state: CoverageDto["state"], groups: NearbyResponse["groups"] = []): NearbyResponse {
  return {
    trailId: TRAIL.id,
    origin: { lng: -82.6996, lat: 35.0317 },
    radiusM: 15_000,
    coverage: {
      layer: "services",
      state,
      tilesTotal: 4,
      tilesReady: state === "ready" ? 4 : state === "partial" ? 1 : 0,
      tilesLoading: state === "loading" ? 3 : 0,
      tilesFailed: state === "failed" ? 4 : state === "partial" ? 3 : 0,
      oldestSyncAt: null,
      message:
        state === "failed"
          ? "Services for this area could not be loaded right now. Please try again later."
          : state === "partial"
            ? "Some of this area could not be loaded right now; showing what is available."
            : state === "too_large"
              ? "Zoom in to load services for this area. Showing services already loaded near the middle of this area."
              : state === "loading"
                ? "Loading services for this area… this can take a minute."
                : "Services for this area are loaded.",
    },
    groups,
    notes: [],
    attribution: [],
  };
}
const renderNearby = (data: NearbyResponse, gaveUp = false) => text(render(h(NearbyView, { data, polling: false, gaveUp, onRetry: noop })));

describe("nearby services after a failed load (#9)", () => {
  it("says nothing is mapped only when the whole area was checked", () => {
    const out = renderNearby(nearby("ready"));
    expect(out).toContain("No gas, food, lodging or medical care is mapped within 15 km.");
    expect(out).not.toContain("Check again");
  });

  for (const state of ["failed", "partial", "too_large"] as const) {
    it(`${state}: says the services couldn't (all) be checked, never "none mapped within 15 km"`, () => {
      const out = renderNearby(nearby(state));
      expect(out).not.toContain("No gas, food, lodging or medical care is mapped within");
      expect(out).toMatch(/couldn't (all )?be checked/);
      expect(out).toMatch(/there may be (gas, food, lodging or medical care|places) nearby/);
      // An amber banner explains the state (on a trail page, never "zoom in").
      expect(out).not.toMatch(/Zoom in/);
    });
  }

  it("offers to check again after a failed or partial load", () => {
    expect(renderNearby(nearby("failed"))).toContain("Check again");
    expect(renderNearby(nearby("partial"))).toContain("Check again");
    expect(renderNearby(nearby("failed"))).toContain("Services for this area could not be loaded right now.");
  });

  it("still lists what was loaded when part of the area failed", () => {
    const out = renderNearby(
      nearby("partial", [
        {
          category: "hospital",
          label: "Medical",
          items: [
            {
              id: "p1",
              category: "clinic",
              name: "Pickens Clinic",
              lng: -82.7,
              lat: 34.9,
              distanceM: 9000,
              elevationM: null,
              openingHours: null,
              website: null,
              phone: null,
              sourceName: "OpenStreetMap contributors",
            },
          ],
        },
      ]),
    );
    expect(out).toContain("Pickens Clinic");
    expect(out).toContain("Some of this area could not be loaded right now");
  });

  it("keeps the loading wording while the area loads", () => {
    expect(emptyServicesText("loading", 15_000)).toMatch(/will appear here once the area has loaded/);
    expect(renderNearby(nearby("loading"))).not.toMatch(/medical care is mapped within|couldn't/);
  });
});

// ---------------------------------------------------------------------------
// #12 Alert times
// ---------------------------------------------------------------------------

const alert = (onset: string | null, ends: string | null): WeatherAlertDto => ({
  id: `a-${onset}-${ends}`,
  event: "Winter Storm Warning",
  severity: "Severe",
  headline: null,
  description: null,
  instruction: null,
  onset,
  ends,
  source: "National Weather Service",
  url: null,
});

describe("alert times name their day (#12)", () => {
  const now = new Date(LATE_AFTERNOON); // Thu Nov 12, 4 PM EST

  it("gives weekday and date for a start or end that is not today", () => {
    expect(alertWindowText(alert("2026-11-13T15:00:00Z", "2026-11-15T01:00:00Z"), NY, now)).toBe(
      "From Fri, Nov 13, 10:00 AM EST until Sat, Nov 14, 8:00 PM EST",
    );
  });

  it("says 'today' for a time today", () => {
    expect(alertWindowText(alert(null, "2026-11-13T01:00:00Z"), NY, now)).toBe("Until 8:00 PM EST today");
    expect(alertWindowText(alert("2026-11-12T14:00:00Z", null), NY, now)).toBe("From 9:00 AM EST today");
    expect(alertWindowText(alert(null, null), NY, now)).toBeNull();
  });

  it("names the zone in force at each moment across a DST change", () => {
    // Sat Oct 31 2026, noon EDT; DST ends Sun Nov 1 at 2 AM.
    expect(alertWindowText(alert("2026-10-31T20:00:00Z", "2026-11-02T01:00:00Z"), NY, new Date("2026-10-31T16:00:00Z"))).toBe(
      "From 4:00 PM EDT today until Sun, Nov 1, 8:00 PM EST",
    );
  });

  it("shows the dated window on the alert card", () => {
    const out = renderConditions(conditions({ alerts: [alert("2026-11-13T15:00:00Z", "2026-11-15T01:00:00Z")] }));
    expect(out).toContain("Winter Storm Warning");
    expect(out).toContain("From Fri, Nov 13, 10:00 AM EST until Sat, Nov 14, 8:00 PM EST");
  });
});

// ---------------------------------------------------------------------------
// #22 Latest recommended start
// ---------------------------------------------------------------------------

describe("latest recommended start (#22)", () => {
  it("labels tomorrow's start as tomorrow and says it is too late today", () => {
    // 4 PM, sunset 5:20 PM, a 3 h hike: the server gives tomorrow's sunset − 4 h.
    const data = conditions({ planning: { ...conditions().planning, latestRecommendedStart: "2026-11-13T18:19:00.000Z" } });
    expect(latestStartView(data)).toEqual({ text: "Tomorrow, 1:19 PM", tooLateToday: true, beforeSunrise: false });
    const out = renderConditions(data);
    expect(out).toMatch(/Latest recommended start Tomorrow, 1:19 PM Too late to start today/);
    expect(out).not.toMatch(/Already passed/);
  });

  it("shows today's start as a plain time", () => {
    const data = conditions({
      generatedAt: "2026-11-12T14:00:00.000Z",
      planning: { ...conditions().planning, latestRecommendedStart: "2026-11-12T18:20:00.000Z" },
    });
    expect(latestStartView(data)).toEqual({ text: "1:20 PM", tooLateToday: false, beforeSunrise: false });
    const out = renderConditions(data);
    expect(out).toMatch(/Latest recommended start 1:20 PM Finish if you start now/);
    expect(out).not.toMatch(/Too late to start today|Before sunrise/);
  });

  it("flags a start before sunrise next to the value", () => {
    // 3 AM; a 12 h hike: sunset 5:20 PM − 13 h = 4:20 AM, before the 6:50 AM sunrise.
    const data = conditions({
      generatedAt: "2026-11-12T08:00:00.000Z",
      planning: { ...conditions().planning, latestRecommendedStart: "2026-11-12T09:20:00.000Z" },
    });
    expect(latestStartView(data)).toEqual({ text: "4:20 AM", tooLateToday: false, beforeSunrise: true });
    expect(renderConditions(data)).toMatch(/4:20 AM Before sunrise: part of the hike would be in the dark/);
  });

  it("uses the server's UTC fallback when the zone is unknown", () => {
    const data = conditions({
      timezone: null,
      sun: [
        { date: "2026-11-12", sunrise: "2026-11-12T11:50:00.000Z", sunset: "2026-11-12T22:20:00.000Z", civilDusk: null, polar: null },
        { date: "2026-11-13", sunrise: "2026-11-13T11:51:00.000Z", sunset: "2026-11-13T22:19:00.000Z", civilDusk: null, polar: null },
      ],
      planning: { ...conditions().planning, latestRecommendedStart: "2026-11-13T18:19:00.000Z" },
    });
    expect(latestStartView(data)).toMatchObject({ text: "Tomorrow, 6:19 PM", tooLateToday: true });
  });

  it("names the day of a finish time that is not today", () => {
    const data = conditions({ planning: { ...conditions().planning, finishIfStartNow: "2026-11-13T07:00:00.000Z" } });
    expect(renderConditions(data)).toMatch(/Finish if you start now ≈ Tomorrow, 2:00 AM After sunset/);
  });
});

// ---------------------------------------------------------------------------
// #23 Precipitation
// ---------------------------------------------------------------------------

describe("precipitation values (#23)", () => {
  const hour = (time: string, precipitationMm: number | null) => ({
    time,
    temperatureC: 10,
    precipitationMm,
    precipitationProbability: null,
    windSpeedMs: null,
    windGustMs: null,
    symbol: null,
  });
  const day = (date: string, precipitationMm: number | null) => ({ date, minC: 2, maxC: 12, precipitationMm, maxWindMs: null, symbol: null });

  it("shows unknown as unknown, zero as dry, and small amounts as more than zero", () => {
    const html = render(
      h(Conditions, {
        data: conditions({
          hourly: [hour("2026-11-12T21:00:00Z", null), hour("2026-11-12T22:00:00Z", 0), hour("2026-11-12T23:00:00Z", 0.1)],
          daily: [day("2026-11-12", null), day("2026-11-13", 0), day("2026-11-14", 0.1), day("2026-11-15", 3.2)],
        }),
        onRetry: noop,
      }),
    );
    const out = text(html);
    const hourly = text(html.slice(html.indexOf('aria-label="Hourly forecast"'), html.indexOf("Next 7 days")));
    const daily = text(html.slice(html.indexOf("Next 7 days"), html.indexOf("Official alerts")));
    // Hourly: unknown, none, 0.1 mm (both unit renderings are in the HTML).
    expect(hourly).toMatch(/Now 50°F 10°C Unknown precipitation/);
    expect(hourly).toMatch(/— no precipitation/);
    expect(hourly).toContain("<0.01 in 0.1 mm");
    // Daily: unknown is never "Dry"; zero is.
    expect(daily).toMatch(/Today 54°F 12°C \/ 36°F 2°C Unknown precipitation/);
    expect(daily).toMatch(/Fri 54°F 12°C \/ 36°F 2°C Dry \(no precipitation forecast\)/);
    expect(daily).toContain("<0.01 in 0.1 mm");
    expect(daily).toContain("0.13 in 3.2 mm");
    expect(out).not.toContain("0.00 in");
    expect((daily.match(/Dry/g) ?? []).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #6 / #7 No elevation data
// ---------------------------------------------------------------------------

describe("moving time and difficulty without elevation data (#6/#7)", () => {
  it("with a profile: moving time allows for climbing", () => {
    const out = text(render(h(TrailStats, { trail: TRAIL })));
    expect(out).toContain("moving time, estimated");
    expect(out).toContain("extra time for climbing");
    expect(out).toContain("Estimated by Ghost Guide from the hike's distance and climb.");
  });

  it("without one: says the time is from distance only and never that climbing is included", () => {
    const out = text(render(h(TrailStats, { trail: NO_ELEVATION })));
    expect(out).toContain("≈ 2 h 25 min moving time from distance only (climb not counted)");
    expect(out).not.toContain("moving time, estimated");
    expect(out).not.toMatch(/extra time for climbing,|includes climbing|allows for climbing/);
    expect(out).toMatch(/moving time is based on distance only, at a flat-ground pace \( ?2\.8 mph 4\.5 km\/h ?\), with no extra time for climbing/);
    expect(out).toContain("On a hilly trail it takes longer.");
    expect(out).toContain("Not rated");
    expect(out).toContain("There is no elevation data for this trail, so Ghost Guide can't rate its effort.");
    expect(out).not.toMatch(/distance and climb/);
  });

  it("an Expert rating by distance alone says so", () => {
    const out = text(render(h(TrailStats, { trail: { ...NO_ELEVATION, difficulty: "expert", difficultySource: "estimated" } })));
    expect(out).toContain("Expert estimated from distance");
    expect(out).toContain("Estimated by Ghost Guide from the hike's distance alone: there is no elevation data, but the distance already makes it Expert.");
    expect(out).not.toMatch(/distance and climb/);
  });

  it("the planning explanation says the time is from distance only (from the live response, not the cached page)", () => {
    const planning = { ...conditions().planning, latestRecommendedStart: "2026-11-13T18:19:00.000Z" };
    const distanceOnly = conditions({ planning: { ...planning, durationBasis: "distance_only" } });
    expect(renderConditions(distanceOnly)).toContain("Based on ≈ 3 h moving time from distance only (climb not counted).");
    const profiled = conditions({ planning: { ...planning, durationBasis: "elevation_profile" } });
    expect(renderConditions(profiled)).toContain("Based on ≈ 3 h moving time.");
  });

  it("uses the same flat pace as the server's estimate", () => {
    expect(FLAT_PACE_KMH).toBe(FLAT_SPEED_NO_PROFILE_KMH);
  });
});
