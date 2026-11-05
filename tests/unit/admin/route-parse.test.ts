import { describe, expect, it } from "vitest";
import { detectRouteFormat, extractLineStringFromGeoJson, parseRouteFile } from "@/server/admin/route-parse";

const line = { type: "LineString", coordinates: [[-121.7, 47.5, 300], [-121.699, 47.501, 301]] };
const enc = (s: string) => new TextEncoder().encode(s);

describe("GeoJSON route extraction", () => {
  it("accepts a bare LineString, a Feature and a FeatureCollection with one line", () => {
    for (const input of [
      line,
      { type: "Feature", properties: {}, geometry: line },
      { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-121.7, 47.5] } }, { type: "Feature", geometry: line }] },
    ]) {
      const r = extractLineStringFromGeoJson(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.geometry).toEqual({ type: "LineString", coordinates: line.coordinates });
    }
    const fc = extractLineStringFromGeoJson({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] } }, { type: "Feature", geometry: line }] });
    expect(fc.ok && fc.notes.join(" ")).toMatch(/Ignored 1/);
  });

  it("rejects ambiguous or unsupported shapes", () => {
    const cases: [unknown, RegExp][] = [
      [{ type: "FeatureCollection", features: [{ type: "Feature", geometry: line }, { type: "Feature", geometry: line }] }, /exactly one/],
      [{ type: "FeatureCollection", features: [] }, /no LineString/],
      [{ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "MultiLineString", coordinates: [] } }] }, /MultiLineString/],
      [{ type: "MultiLineString", coordinates: [] }, /MultiLineString/],
      [{ type: "Feature", geometry: { type: "Polygon", coordinates: [] } }, /Polygon/],
      [{ type: "Point", coordinates: [0, 0] }, /Unsupported/],
      [[1, 2], /object/],
      [null, /object/],
      [{ type: "LineString" }, /coordinates/],
    ];
    for (const [input, re] of cases) {
      const r = extractLineStringFromGeoJson(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join(" ")).toMatch(re);
    }
  });

  it("parses uploaded bytes by format, rejecting invalid JSON, bad encodings and oversize files", () => {
    expect(parseRouteFile(enc(JSON.stringify(line)), "geojson").ok).toBe(true);
    expect(parseRouteFile(enc("﻿" + JSON.stringify(line)), "geojson").ok).toBe(true);
    const bad = parseRouteFile(enc("{not json"), "geojson");
    expect(!bad.ok && bad.errors[0]).toMatch(/valid JSON/);
    const latin = parseRouteFile(new Uint8Array([0xff, 0xfe, 0x00]), "geojson");
    expect(!latin.ok && latin.errors[0]).toMatch(/UTF-8/);
    const big = parseRouteFile(new Uint8Array(2 * 1024 * 1024 + 1), "gpx");
    expect(!big.ok && big.errors[0]).toMatch(/2 MB/);
    expect(parseRouteFile(new Uint8Array(0), "gpx").ok).toBe(false);
  });

  it("detects the format from the file name", () => {
    expect(detectRouteFormat("Route.GPX")).toBe("gpx");
    expect(detectRouteFormat("a.geojson")).toBe("geojson");
    expect(detectRouteFormat("a.json")).toBe("geojson");
    expect(detectRouteFormat("a.kml")).toBeNull();
  });
});
