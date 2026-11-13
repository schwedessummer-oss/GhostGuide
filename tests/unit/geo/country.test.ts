/**
 * countryCodeAt: offline country at an exact point (bundled borders), used
 * for a trail's country instead of the 0.1° reverse-geocoding cell centre.
 */
import { describe, expect, it } from "vitest";
import { countryCodeAt, sameCountry, sovereignOf } from "@/server/geo/country";

describe("countryCodeAt", () => {
  it("answers for the exact point on either side of a border", () => {
    // US–Canada along the 49th parallel (Glacier / Waterton): the 0.1° cell centre lies ON the border.
    expect(countryCodeAt(48.97, -113.8)).toBe("us");
    expect(countryCodeAt(49.03, -113.8)).toBe("ca");
    // Andes: Aconcagua (Argentina) and the Chilean side of the main ridge.
    expect(countryCodeAt(-32.653, -70.011)).toBe("ar");
    expect(countryCodeAt(-33.35, -70.3)).toBe("cl");
    // Alps: Zermatt (CH) vs Breuil-Cervinia (IT).
    expect(countryCodeAt(46.02, 7.75)).toBe("ch");
    expect(countryCodeAt(45.935, 7.63)).toBe("it");
  });

  it("uses territories with their own code (own emergency numbers / alert services)", () => {
    expect(countryCodeAt(22.3, 114.17)).toBe("hk");
    expect(countryCodeAt(18.4, -66.1)).toBe("pr");
    expect(countryCodeAt(13.45, 144.8)).toBe("gu");
    // An "exceptionally reserved" piece maps to its country (Ceuta → Spain); the Canaries are Spain.
    expect(countryCodeAt(35.89, -5.32)).toBe("es");
    expect(countryCodeAt(28.27, -16.6)).toBe("es");
  });

  it("is null where there is no country, and for invalid input", () => {
    expect(countryCodeAt(-30, -30)).toBeNull(); // South Atlantic
    expect(countryCodeAt(Number.NaN, 0)).toBeNull();
    expect(countryCodeAt(91, 0)).toBeNull();
    expect(countryCodeAt(0, -181)).toBeNull();
    expect(countryCodeAt("46" as unknown as number, 7)).toBeNull();
  });
});

describe("sovereignOf / sameCountry", () => {
  it("compares at the sovereign level and never matches unknown codes", () => {
    expect(sovereignOf("pr")).toBe("us");
    expect(sovereignOf("HK")).toBe("cn");
    expect(sovereignOf("us")).toBe("us");
    expect(sovereignOf("xx")).toBeNull();
    expect(sovereignOf(null)).toBeNull();
    expect(sameCountry("pr", "us")).toBe(true);
    expect(sameCountry("ar", "cl")).toBe(false);
    expect(sameCountry("xx", "xx")).toBe(false);
    expect(sameCountry(null, null)).toBe(false);
  });
});
