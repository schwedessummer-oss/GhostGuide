import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HILLSHADE_MIN_WIDTH_PX, HILLSHADE_MIN_ZOOM, wantsHillshade } from "@/components/maps/hillshade";

/*
 * Finding #38: terrain hillshade (~1 MB of DEM tiles per map view) only
 * where it helps: wide maps such as a desktop trail page, never Explore or
 * phones, never when the browser asks to save data.
 */
const ctx = (over: Partial<Parameters<typeof wantsHillshade>[1]> = {}) => ({
  width: 1200,
  saveData: false,
  tilesUrl: "https://tiles.example/terrarium/{z}/{x}/{y}.png",
  ...over,
});

describe("wantsHillshade", () => {
  it('"wide" (the default): desktop-width maps only', () => {
    expect(wantsHillshade("wide", ctx())).toBe(true);
    expect(wantsHillshade("wide", ctx({ width: HILLSHADE_MIN_WIDTH_PX }))).toBe(true);
    expect(wantsHillshade("wide", ctx({ width: 390 }))).toBe(false);
    expect(wantsHillshade("wide", ctx({ width: HILLSHADE_MIN_WIDTH_PX - 1 }))).toBe(false);
  });

  it("off when asked, when saving data, or when terrain tiles are off", () => {
    expect(wantsHillshade(false, ctx())).toBe(false);
    expect(wantsHillshade(undefined, ctx())).toBe(false);
    expect(wantsHillshade("wide", ctx({ saveData: true }))).toBe(false);
    expect(wantsHillshade(true, ctx({ saveData: true }))).toBe(false);
    expect(wantsHillshade(true, ctx({ tilesUrl: "off" }))).toBe(false);
    expect(wantsHillshade(true, ctx({ width: 390 }))).toBe(true);
  });

  it("is only drawn from a zoom where relief helps (no DEM tiles below it)", () => {
    expect(HILLSHADE_MIN_ZOOM).toBeGreaterThanOrEqual(9);
    const mapView = readFileSync(path.resolve(import.meta.dirname, "../../../src/components/maps/map-view.tsx"), "utf8");
    expect(mapView).toMatch(/minzoom: HILLSHADE_MIN_ZOOM/);
    expect(mapView).toMatch(/hillshade = "wide"/);
  });

  it("Explore turns it off", () => {
    const exploreMap = readFileSync(path.resolve(import.meta.dirname, "../../../src/components/explore/explore-map.tsx"), "utf8");
    expect(exploreMap).toMatch(/hillshade=\{false\}/);
  });
});
