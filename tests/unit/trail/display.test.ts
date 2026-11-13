import { describe, expect, it } from "vitest";
import type { PoiDto } from "@/domain/catalog";
import { groupPoisByCategory, mapViewBounds, poiGroupOf } from "@/components/trail/poi";
import { knownHazards } from "@/components/trail/safety-section";
import { MET_SYMBOL_CODES, weatherSymbol } from "@/components/trail/weather";
import { symbolSeverity } from "@/server/weather/forecast";

const poi = (category: PoiDto["category"], name: string | null = null): PoiDto => ({
  id: `${category}-${name ?? "x"}-${Math.random()}`,
  category,
  name,
  lng: 0,
  lat: 0,
  distanceM: null,
  elevationM: null,
  openingHours: null,
  website: null,
  phone: null,
  sourceName: "OpenStreetMap contributors",
});

describe("weatherSymbol", () => {
  it("maps MET Norway symbol codes to labels and kinds", () => {
    expect(weatherSymbol("clearsky_day")).toEqual({ kind: "clear", label: "Clear", night: false });
    expect(weatherSymbol("fair_night")).toEqual({ kind: "fair", label: "Mostly clear", night: true });
    expect(weatherSymbol("partlycloudy_polartwilight")).toMatchObject({ kind: "partlycloudy", night: true });
    expect(weatherSymbol("cloudy")).toMatchObject({ kind: "cloudy", label: "Cloudy" });
    expect(weatherSymbol("lightrain")).toMatchObject({ kind: "drizzle", label: "Light rain" });
    expect(weatherSymbol("heavyrainshowers_day")).toMatchObject({ kind: "rain", label: "Heavy rain showers" });
    expect(weatherSymbol("lightrainshowers_day")).toMatchObject({ kind: "rain", label: "Light rain showers" });
    expect(weatherSymbol("sleetshowersandthunder_night")).toMatchObject({
      kind: "thunder",
      label: "Sleet showers and thunder",
      night: true,
    });
    expect(weatherSymbol("heavysnow")).toMatchObject({ kind: "snow", label: "Heavy snow" });
    expect(weatherSymbol("sleet")).toMatchObject({ kind: "sleet", label: "Sleet" });
    expect(weatherSymbol("fog")).toMatchObject({ kind: "fog" });
  });

  it("returns null for unknown codes instead of guessing", () => {
    expect(weatherSymbol("sandstorm_day")).toBeNull();
    expect(weatherSymbol("")).toBeNull();
    expect(weatherSymbol(null)).toBeNull();
    expect(weatherSymbol("clearsky_noon")).toBeNull();
    expect(weatherSymbol("ssnow")).toBeNull();
  });

  it("recognises MET's 'lights…' spellings of light sleet / snow showers and thunder (#24)", () => {
    expect(weatherSymbol("lightssleetshowersandthunder_day")).toEqual({
      kind: "thunder",
      label: "Light sleet showers and thunder",
      night: false,
    });
    expect(weatherSymbol("lightssnowshowersandthunder_night")).toEqual({
      kind: "thunder",
      label: "Light snow showers and thunder",
      night: true,
    });
    expect(weatherSymbol("lightssnowshowersandthunder_polartwilight")).toMatchObject({ kind: "thunder", night: true });
  });

  it("gives an icon kind and a label for every code in MET's official symbol legend (#24)", () => {
    expect(MET_SYMBOL_CODES).toHaveLength(41);
    expect(new Set(MET_SYMBOL_CODES.map((c) => c.code)).size).toBe(41);
    for (const { code, variants } of MET_SYMBOL_CODES) {
      const codes = variants ? [`${code}_day`, `${code}_night`, `${code}_polartwilight`] : [code];
      for (const c of codes) {
        const s = weatherSymbol(c);
        expect(s, c).not.toBeNull();
        expect(s?.label, c).toMatch(/^[A-Z][a-z ]+$/);
        expect(s?.night, c).toBe(c.endsWith("_night") || c.endsWith("_polartwilight"));
        // Thunder codes always show the thunder icon and say so; the label never drops the precipitation type.
        if (code.includes("thunder")) {
          expect(s?.kind, c).toBe("thunder");
          expect(s?.label, c).toMatch(/and thunder$/);
        } else {
          expect(s?.kind, c).not.toBe("thunder");
        }
        for (const p of ["rain", "sleet", "snow"]) if (code.includes(p)) expect(s?.label.toLowerCase(), c).toContain(p);
        // The server ranks the same code (so a day's symbol picked there always has an icon here).
        expect(symbolSeverity(c), c).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("POI groups", () => {
  it("groups outdoor POIs by category in display order with plural labels", () => {
    const groups = groupPoisByCategory([
      poi("waterfall", "Carrick Creek Falls"),
      poi("parking"),
      poi("waterfall"),
      poi("fuel", "Gas"),
      poi("toilets", "Nature Center"),
    ]);
    expect(groups.map((g) => [g.category, g.label, g.items.length])).toEqual([
      ["parking", "Parking", 1],
      ["toilets", "Restroom", 1],
      ["waterfall", "Waterfalls", 2],
    ]);
    expect(groups.every((g) => /^#[0-9a-f]{6}$/i.test(g.color))).toBe(true);
  });

  it("has a style for every outdoor category and none for services", () => {
    expect(poiGroupOf("viewpoint")?.key).toBe("sights");
    expect(poiGroupOf("drinking_water")?.key).toBe("water");
    expect(poiGroupOf("restaurant")).toBeNull();
  });
});

describe("mapViewBounds", () => {
  it("extends the route bbox to the trailhead and POIs, with padding", () => {
    const [w, s, e, n] = mapViewBounds([-82.72, 35.03, -82.7, 35.05], [{ lng: -82.69, lat: 35.02 }]);
    expect(w).toBeLessThan(-82.72);
    expect(e).toBeGreaterThan(-82.69);
    expect(s).toBeLessThan(35.02);
    expect(n).toBeGreaterThan(35.05);
    // Extra room at the bottom for the attribution bar.
    expect(35.02 - s).toBeGreaterThan(n - 35.05);
  });

  it("pads tiny routes to at least ~150 m and ignores invalid points", () => {
    const [w, s, e, n] = mapViewBounds([10, 46, 10.0001, 46.0001], [{ lng: Number.NaN, lat: 0 }]);
    expect(e - w).toBeGreaterThanOrEqual(0.003);
    expect(n - s).toBeGreaterThanOrEqual(0.0045);
  });
});

describe("knownHazards", () => {
  it("reports only what the map data says", () => {
    expect(knownHazards({ sacScale: null, trailVisibility: null })).toEqual([]);
    expect(knownHazards({ sacScale: "mountain_hiking", trailVisibility: "good" })).toEqual([]);
    const h = knownHazards({ sacScale: "demanding_mountain_hiking", trailVisibility: "bad" });
    expect(h).toHaveLength(2);
    expect(h[0]).toMatch(/SAC T3/);
    expect(h[1]).toMatch(/hard to follow.*poor/);
  });
});
