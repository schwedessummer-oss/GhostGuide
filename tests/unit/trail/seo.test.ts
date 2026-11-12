import { describe, expect, it } from "vitest";
import { canonicalUrl, serializeJsonLd, snippetUnits, trailJsonLd, trailMetaDescription, trailPageTitle } from "@/components/trail/seo";

const tableRock = {
  name: "Table Rock Trail",
  nearestPlace: null,
  regionName: "South Carolina",
  countryCode: "us",
  routeType: "linear" as const,
  distanceM: 5483,
  hikeDistanceM: 10966,
  hikeGainM: 695,
  difficulty: "hard" as const,
  difficultySource: "estimated" as const,
  provider: "osm",
  sourceName: "OpenStreetMap contributors",
  trailhead: { lng: -82.6995591, lat: 35.03168 },
  feeRequired: null,
  access: null,
};

describe("trailPageTitle", () => {
  it("uses the place (else the region) and the country name", () => {
    expect(trailPageTitle(tableRock)).toBe("Table Rock Trail — South Carolina, United States");
    expect(trailPageTitle({ ...tableRock, nearestPlace: "Pickens" })).toBe("Table Rock Trail — Pickens, United States");
  });

  it("degrades gracefully without place data", () => {
    expect(trailPageTitle({ ...tableRock, regionName: null })).toBe("Table Rock Trail — United States");
    expect(trailPageTitle({ ...tableRock, regionName: null, countryCode: "xx" })).toBe("Table Rock Trail");
    expect(trailPageTitle({ ...tableRock, nearestPlace: "Luxembourg", regionName: null, countryCode: "lu" })).toBe(
      "Table Rock Trail — Luxembourg",
    );
  });
});

describe("trailMetaDescription", () => {
  it("is built only from stored facts", () => {
    expect(trailMetaDescription(tableRock)).toBe(
      "Table Rock Trail is a 6.8 mi (11.0 km) out-and-back hike in South Carolina, United States, with about 2,280 ft of climbing. " +
        "Difficulty: hard (estimated). Map, elevation profile, conditions and trailhead directions. Trail data: OpenStreetMap.",
    );
  });

  it("uses metric outside imperial countries and the right article", () => {
    const d = trailMetaDescription({
      ...tableRock,
      name: "Höhenweg",
      countryCode: "de",
      regionName: "Bayern",
      routeType: "loop",
      hikeDistanceM: 8_200,
      hikeGainM: 410,
      difficulty: "moderate",
      difficultySource: "osm_sac_scale",
    });
    expect(d).toBe(
      "Höhenweg is an 8.2 km loop hike in Bayern, Germany, with about 410 m of climbing. Difficulty: moderate (SAC scale). " +
        "Map, elevation profile, conditions and trailhead directions. Trail data: OpenStreetMap.",
    );
  });

  it("omits unknown climb and difficulty instead of guessing", () => {
    const d = trailMetaDescription({ ...tableRock, hikeGainM: null, difficulty: "unknown", difficultySource: null, routeType: "unknown" });
    expect(d).toBe(
      "Table Rock Trail is a 6.8 mi (11.0 km) trail in South Carolina, United States. Map, elevation profile, conditions and trailhead directions. Trail data: OpenStreetMap.",
    );
    expect(d).not.toMatch(/climbing|Difficulty/);
  });

  it("credits unknown providers by their source name", () => {
    expect(trailMetaDescription({ ...tableRock, provider: "parks_ca", sourceName: "Parks Canada" })).toMatch(/Trail data: Parks Canada\.$/);
  });

  it("chooses snippet units by country", () => {
    expect(snippetUnits("us")).toBe("imperial");
    expect(snippetUnits("CH")).toBe("metric");
  });
});

describe("trailJsonLd", () => {
  const url = "https://ghostguide.app/trail/us/south-carolina/table-rock-trail";

  it("describes a TouristAttraction with only known fields", () => {
    expect(trailJsonLd(tableRock, url)).toEqual({
      "@context": "https://schema.org",
      "@type": "TouristAttraction",
      name: "Table Rock Trail",
      url,
      geo: { "@type": "GeoCoordinates", latitude: 35.03168, longitude: -82.699559 },
      address: { "@type": "PostalAddress", addressRegion: "South Carolina", addressCountry: "US" },
    });
  });

  it("adds isAccessibleForFree only when no fee is mapped, and publicAccess only when clear", () => {
    expect(trailJsonLd({ ...tableRock, feeRequired: false }, url).isAccessibleForFree).toBe(true);
    expect(trailJsonLd({ ...tableRock, feeRequired: true }, url)).not.toHaveProperty("isAccessibleForFree");
    expect(trailJsonLd(tableRock, url)).not.toHaveProperty("isAccessibleForFree");
    expect(trailJsonLd({ ...tableRock, access: "yes" }, url).publicAccess).toBe(true);
    expect(trailJsonLd({ ...tableRock, access: "private" }, url).publicAccess).toBe(false);
    expect(trailJsonLd({ ...tableRock, access: "customers" }, url)).not.toHaveProperty("publicAccess");
  });

  it("omits geo without a trailhead and address without place data", () => {
    const ld = trailJsonLd({ ...tableRock, trailhead: null, regionName: null, countryCode: "xx" }, url);
    expect(ld).not.toHaveProperty("geo");
    expect(ld).not.toHaveProperty("address");
  });

  it("never includes ratings, reviews or descriptions", () => {
    const keys = Object.keys(trailJsonLd({ ...tableRock, feeRequired: false, access: "yes" }, url));
    expect(keys).not.toContain("aggregateRating");
    expect(keys).not.toContain("review");
    expect(keys).not.toContain("description");
  });
});

describe("serializeJsonLd", () => {
  it("cannot be broken out of a script element", () => {
    const out = serializeJsonLd({ name: "</script><script>alert(1)</script> & \u2028" });
    expect(out).not.toMatch(/[<>&\u2028]/);
    expect(out).toContain("\\u003c/script\\u003e");
    expect(JSON.parse(out)).toEqual({ name: "</script><script>alert(1)</script> & \u2028" });
  });
});

describe("canonicalUrl", () => {
  it("joins the base URL and path without double slashes", () => {
    expect(canonicalUrl("https://ghostguide.app/", "/trail/us/x/y")).toBe("https://ghostguide.app/trail/us/x/y");
    expect(canonicalUrl("https://ghostguide.app", "trail/us/x/y")).toBe("https://ghostguide.app/trail/us/x/y");
  });
});
