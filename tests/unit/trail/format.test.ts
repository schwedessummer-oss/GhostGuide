import { describe, expect, it } from "vitest";
import {
  accessLabel,
  countryName,
  difficultyExplanation,
  difficultyLabel,
  difficultyQualifier,
  directionsLinks,
  dogPolicyLabel,
  feeLabel,
  formatAltitude,
  formatClimb,
  formatClock,
  formatDayLabel,
  formatDurationEstimate,
  formatHour,
  formatPrecipitation,
  formatRelativeAge,
  formatTemperature,
  formatTrailDistance,
  formatWind,
  hikeFormLabel,
  humanize,
  isPoorVisibility,
  listLabel,
  locationParts,
  osmFeatureFromUrl,
  permitLabel,
  poiCategoryLabel,
  poiDisplayName,
  publicAccessFromTag,
  routeFormNote,
  sacGrade,
  safeWebsiteUrl,
  telHref,
  trailVisibilityLabel,
  unitsForLanguage,
  websiteLabel,
  zoneAbbreviation,
} from "@/components/trail/format";

describe("distances and climbs", () => {
  it("rounds trail distances to 0.1 mi / 0.1 km", () => {
    expect(formatTrailDistance(10_966, "imperial")).toBe("6.8 mi");
    expect(formatTrailDistance(10_966, "metric")).toBe("11.0 km");
    expect(formatTrailDistance(5_483, "imperial")).toBe("3.4 mi");
    expect(formatTrailDistance(250_000, "imperial")).toBe("155 mi");
    expect(formatTrailDistance(250_000, "metric")).toBe("250 km");
  });

  it("uses feet / metres (nearest 10) for short distances", () => {
    expect(formatTrailDistance(150, "imperial")).toBe("490 ft");
    expect(formatTrailDistance(161, "imperial")).toBe("0.1 mi");
    expect(formatTrailDistance(687, "metric")).toBe("690 m");
    expect(formatTrailDistance(0, "imperial")).toBe("0 ft");
    expect(formatTrailDistance(-5, "metric")).toBe("0 m");
  });

  it("rounds climbs to 10 ft / 1 m with thousands separators", () => {
    expect(formatClimb(695, "imperial")).toBe("2,280 ft");
    expect(formatClimb(695, "metric")).toBe("695 m");
    expect(formatClimb(1, "imperial")).toBe("0 ft");
    expect(formatClimb(-3, "metric")).toBe("0 m");
  });

  it("formats altitudes, including below sea level", () => {
    expect(formatAltitude(949, "imperial")).toBe("3,110 ft");
    expect(formatAltitude(-28, "metric")).toBe("-28 m");
  });
});

describe("formatDurationEstimate", () => {
  it("rounds estimates to 5 minutes and pads minutes", () => {
    expect(formatDurationEstimate(186)).toBe("3 h 05 min");
    expect(formatDurationEstimate(104)).toBe("1 h 45 min");
    expect(formatDurationEstimate(120)).toBe("2 h");
    expect(formatDurationEstimate(42)).toBe("40 min");
    expect(formatDurationEstimate(1)).toBe("5 min");
  });

  it("can round to the minute", () => {
    expect(formatDurationEstimate(491, 1)).toBe("8 h 11 min");
    expect(formatDurationEstimate(0, 1)).toBe("0 min");
  });

  it("returns null for unknown or invalid values", () => {
    expect(formatDurationEstimate(null)).toBeNull();
    expect(formatDurationEstimate(undefined)).toBeNull();
    expect(formatDurationEstimate(Number.NaN)).toBeNull();
    expect(formatDurationEstimate(-4)).toBeNull();
  });
});

describe("route form", () => {
  it("labels the hike as usually walked", () => {
    expect(hikeFormLabel("linear")).toBe("Out & back");
    expect(hikeFormLabel("loop")).toBe("Loop");
    expect(hikeFormLabel("network")).toBe("Trail network");
    expect(hikeFormLabel("unknown")).toBe("Mapped length");
  });

  it("explains linear, network and unknown routes; nothing for loops", () => {
    expect(routeFormNote("linear", 5_483, "imperial")).toBe("One way 3.4 mi; most hikers return the same way.");
    expect(routeFormNote("linear", 5_483, "metric")).toBe("One way 5.5 km; most hikers return the same way.");
    expect(routeFormNote("network", 1000, "imperial")).toMatch(/total mapped length/);
    expect(routeFormNote("unknown", 1000, "imperial")).toMatch(/isn't mapped/);
    expect(routeFormNote("loop", 1000, "imperial")).toBeNull();
  });
});

describe("difficulty", () => {
  it("labels difficulty and its source", () => {
    expect(difficultyLabel("hard")).toBe("Hard");
    expect(difficultyLabel("unknown")).toBe("Not rated");
    expect(difficultyQualifier("estimated", "mountain_hiking")).toBe("estimated");
    expect(difficultyQualifier("osm_sac_scale", "mountain_hiking")).toBe("SAC T2");
    expect(difficultyQualifier("osm_sac_scale", null)).toBe("SAC scale");
    expect(difficultyQualifier("official", null)).toBe("official");
    expect(difficultyQualifier(null, null)).toBeNull();
  });

  it("parses SAC grades (names, T-codes, multiple values → hardest)", () => {
    expect(sacGrade("hiking")).toMatchObject({ grade: "T1", rank: 0 });
    expect(sacGrade("T4")).toMatchObject({ grade: "T4", name: "Alpine hiking" });
    expect(sacGrade("hiking;demanding_mountain_hiking")).toMatchObject({ grade: "T3" });
    expect(sacGrade("strange")).toBeNull();
    expect(sacGrade(null)).toBeNull();
  });

  it("explains where the rating comes from", () => {
    expect(difficultyExplanation("hard", "estimated", null)).toMatch(/^Estimated by Ghost Guide.*not an official rating\.$/);
    expect(difficultyExplanation("hard", "estimated", "mountain_hiking")).toMatch(/T2 \(mountain hiking\)/);
    expect(difficultyExplanation("moderate", "osm_sac_scale", "mountain_hiking")).toMatch(/^OpenStreetMap grades the path T2/);
    expect(difficultyExplanation("unknown", null, null)).toMatch(/isn't enough mapped data/);
  });
});

describe("fact labels say when a value is unknown", () => {
  it("fee, permit, dogs", () => {
    expect(feeLabel(true)).toBe("Fee required");
    expect(feeLabel(false)).toBe("No fee");
    expect(feeLabel(null)).toBe("Unknown — check with the land manager");
    expect(permitLabel(null)).toBe("Unknown — check with the land manager");
    expect(permitLabel(false)).toBe("No permit needed");
    expect(dogPolicyLabel("leashed")).toBe("Allowed on a leash");
    expect(dogPolicyLabel("unknown")).toMatch(/^Not mapped/);
  });

  it("visibility and access", () => {
    expect(trailVisibilityLabel(null)).toBe("Not mapped");
    expect(trailVisibilityLabel("bad")).toMatch(/^Poor/);
    expect(trailVisibilityLabel("odd_value")).toBe("Odd value");
    expect(isPoorVisibility("horrible")).toBe(true);
    expect(isPoorVisibility("good")).toBe(false);
    expect(isPoorVisibility(null)).toBe(false);
    expect(accessLabel("permissive")).toMatch(/permission/);
    expect(accessLabel(null)).toBe("Not mapped");
    expect(publicAccessFromTag("yes")).toBe(true);
    expect(publicAccessFromTag("private")).toBe(false);
    expect(publicAccessFromTag("customers")).toBeNull();
    expect(publicAccessFromTag(null)).toBeNull();
  });

  it("humanizes OSM values and lists", () => {
    expect(humanize("fine_gravel")).toBe("Fine gravel");
    expect(listLabel(["dirt", "rock", "dirt"])).toBe("Dirt, rock");
    expect(listLabel(["fine_gravel", "Asphalt"])).toBe("Fine gravel, asphalt");
    expect(listLabel([])).toBeNull();
  });
});

describe("points of interest", () => {
  it("labels categories in singular and plural", () => {
    expect(poiCategoryLabel("toilets")).toBe("Restroom");
    expect(poiCategoryLabel("toilets", true)).toBe("Restrooms");
    expect(poiCategoryLabel("parking", true)).toBe("Parking");
  });

  it("names unnamed POIs by category, never inventing a name", () => {
    expect(poiDisplayName({ name: "Nature Center", category: "toilets" })).toBe("Nature Center");
    expect(poiDisplayName({ name: null, category: "toilets" })).toBe("Unnamed restroom");
    expect(poiDisplayName({ name: "  ", category: "fuel" })).toBe("Unnamed gas station");
    expect(poiDisplayName({ name: null, category: "ev_charging" })).toBe("Unnamed EV charger");
  });
});

describe("places", () => {
  it("names countries from ISO codes", () => {
    expect(countryName("us")).toBe("United States");
    expect(countryName("DE")).toBe("Germany");
    expect(countryName("xx")).toBeNull();
    expect(countryName("usa")).toBeNull();
    expect(countryName(null)).toBeNull();
  });

  it("builds a de-duplicated location line", () => {
    expect(locationParts({ nearestPlace: null, regionName: "South Carolina", countryCode: "us" })).toEqual([
      "South Carolina",
      "United States",
    ]);
    expect(locationParts({ nearestPlace: "Pickens", regionName: "South Carolina", countryCode: "us" })).toEqual([
      "Pickens",
      "South Carolina",
      "United States",
    ]);
    expect(locationParts({ nearestPlace: "Luxembourg", regionName: "luxembourg", countryCode: "lu" })).toEqual(["Luxembourg"]);
    expect(locationParts({ nearestPlace: null, regionName: null, countryCode: "xx" })).toEqual([]);
  });
});

describe("formatRelativeAge", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  it("describes ages in plain words", () => {
    expect(formatRelativeAge("2026-11-12T11:30:00Z", now)).toBe("less than an hour ago");
    expect(formatRelativeAge("2026-11-12T07:00:00Z", now)).toBe("5 hours ago");
    expect(formatRelativeAge("2026-11-11T11:00:00Z", now)).toBe("1 day ago");
    expect(formatRelativeAge("2026-11-10T12:00:00Z", now)).toBe("2 days ago");
    expect(formatRelativeAge("2026-10-22T12:00:00Z", now)).toBe("3 weeks ago");
    expect(formatRelativeAge("2026-07-12T12:00:00Z", now)).toBe("4 months ago");
    expect(formatRelativeAge("2024-11-01T12:00:00Z", now)).toBe("2 years ago");
  });
  it("treats future and invalid dates safely", () => {
    expect(formatRelativeAge("2026-11-13T12:00:00Z", now)).toBe("less than an hour ago");
    expect(formatRelativeAge("not a date", now)).toBe("at an unknown time");
  });
});

describe("links", () => {
  it("recognises OpenStreetMap elements only", () => {
    expect(osmFeatureFromUrl("https://www.openstreetmap.org/relation/6011996")).toEqual({
      type: "relation",
      id: "6011996",
      url: "https://www.openstreetmap.org/relation/6011996",
      editUrl: "https://www.openstreetmap.org/edit?relation=6011996",
    });
    expect(osmFeatureFromUrl("https://openstreetmap.org/way/12/")).toMatchObject({ type: "way", id: "12" });
    expect(osmFeatureFromUrl("https://ridb.recreation.gov/facilities/1")).toBeNull();
    expect(osmFeatureFromUrl("https://www.openstreetmap.org.evil.example/node/1")).toBeNull();
    expect(osmFeatureFromUrl("javascript:alert(1)")).toBeNull();
    expect(osmFeatureFromUrl(null)).toBeNull();
  });

  it("accepts only http(s) websites and fixes bare domains", () => {
    expect(safeWebsiteUrl("https://scparks.com/table-rock")).toBe("https://scparks.com/table-rock");
    expect(safeWebsiteUrl("scparks.com/table-rock")).toBe("https://scparks.com/table-rock");
    expect(safeWebsiteUrl("http://example.org")).toBe("http://example.org/");
    expect(safeWebsiteUrl("https://a.example; https://b.example")).toBe("https://a.example/");
    expect(safeWebsiteUrl("javascript:alert(1)")).toBeNull();
    expect(safeWebsiteUrl("mailto:x@example.org")).toBeNull();
    expect(safeWebsiteUrl("data:text/html,<script>")).toBeNull();
    expect(safeWebsiteUrl("not a url")).toBeNull();
    expect(safeWebsiteUrl("https://localhost/x")).toBeNull();
    expect(safeWebsiteUrl(null)).toBeNull();
    expect(websiteLabel("https://www.example.org/x")).toBe("example.org");
  });

  it("builds tel: links from mapped phone numbers", () => {
    expect(telHref("+1 (864) 878-9813")).toBe("tel:+18648789813");
    expect(telHref("864-878-9813; +1 555 0100")).toBe("tel:8648789813");
    expect(telHref("call us")).toBeNull();
    expect(telHref(null)).toBeNull();
  });

  it("builds directions links to the trailhead", () => {
    expect(directionsLinks({ lat: 35.03168, lng: -82.6995591 })).toEqual({
      google: "https://www.google.com/maps/dir/?api=1&destination=35.03168,-82.699559",
      apple: "https://maps.apple.com/?daddr=35.03168,-82.699559",
    });
  });
});

describe("weather values", () => {
  it("formats temperature, wind and precipitation in both systems", () => {
    expect(formatTemperature(12.2, "imperial")).toBe("54°F");
    expect(formatTemperature(12.2, "metric")).toBe("12°C");
    expect(formatTemperature(-0.4, "metric")).toBe("0°C");
    expect(formatTemperature(null, "metric")).toBeNull();
    expect(formatWind(4.6, "imperial")).toBe("10 mph");
    expect(formatWind(4.6, "metric")).toBe("17 km/h");
    expect(formatWind(-1, "metric")).toBeNull();
    expect(formatPrecipitation(1, "imperial")).toBe("0.04 in");
    expect(formatPrecipitation(1.24, "metric")).toBe("1.2 mm");
    expect(formatPrecipitation(0, "imperial")).toBe("0.00 in");
    expect(formatPrecipitation(null, "imperial")).toBeNull();
  });
});

describe("times in the trail's zone", () => {
  const at = "2026-11-12T22:27:01Z";
  it("formats clock times and hours in the zone", () => {
    expect(formatClock(at, "America/New_York")).toBe("5:27 PM");
    expect(formatHour("2026-11-12T14:00:00Z", "America/New_York")).toBe("9 AM");
    expect(formatClock(at, null)).toBe("10:27 PM");
    expect(formatClock(at, "Not/AZone")).toBe("10:27 PM");
  });

  it("names the zone", () => {
    expect(zoneAbbreviation("America/New_York", new Date(at))).toBe("EST");
    expect(zoneAbbreviation("America/New_York", new Date("2026-07-01T12:00:00Z"))).toBe("EDT");
    expect(zoneAbbreviation(null)).toBe("UTC");
  });

  it("labels days", () => {
    expect(formatDayLabel("2026-11-12", "2026-11-12")).toBe("Today");
    expect(formatDayLabel("2026-11-13", "2026-11-12")).toBe("Fri");
    expect(formatDayLabel("bad", null)).toBe("bad");
  });
});

describe("unitsForLanguage", () => {
  it("defaults to imperial for US English and metric elsewhere", () => {
    expect(unitsForLanguage("en-US")).toBe("imperial");
    expect(unitsForLanguage("en")).toBe("imperial");
    expect(unitsForLanguage("my-MM")).toBe("imperial");
    expect(unitsForLanguage("en-GB")).toBe("metric");
    expect(unitsForLanguage("de-DE")).toBe("metric");
    expect(unitsForLanguage("fr")).toBe("metric");
    expect(unitsForLanguage("")).toBe("imperial");
    expect(unitsForLanguage(undefined)).toBe("imperial");
  });
});
