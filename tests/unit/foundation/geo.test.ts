import { describe, expect, it } from "vitest";
import {
  cumulativeDistancesM,
  haversineM,
  lineLengthM,
  offsetMeters,
  pointAtDistance,
  projectOntoLine,
  validateLineString,
  type Position,
} from "@/domain/geo";

const origin = { lat: 47.5, lng: -121.7 };
// straight line ~1 km east in 10 vertices
const line: Position[] = Array.from({ length: 11 }, (_, i) => {
  const p = offsetMeters(origin, i * 100, 0);
  return [p.lng, p.lat];
});

describe("geo", () => {
  it("haversine matches known offsets", () => {
    const p = offsetMeters(origin, 0, 1000);
    expect(haversineM(origin, p)).toBeCloseTo(1000, 0);
  });

  it("computes polyline length", () => {
    expect(lineLengthM(line)).toBeCloseTo(1000, 0);
  });

  it("projects a point onto the route with distance and progress", () => {
    const p = offsetMeters(origin, 350, 30);
    const proj = projectOntoLine(p, line);
    expect(proj.distanceFromRouteM).toBeCloseTo(30, 0);
    expect(proj.alongM).toBeCloseTo(350, 0);
  });

  it("uses the progress hint to disambiguate overlapping out-and-back legs", () => {
    const outAndBack: Position[] = [...line, ...line.slice(0, -1).reverse()];
    const cum = cumulativeDistancesM(outAndBack);
    const p = offsetMeters(origin, 300, 2);
    expect(projectOntoLine(p, outAndBack, cum, 300).alongM).toBeCloseTo(300, -1);
    expect(projectOntoLine(p, outAndBack, cum, 1700).alongM).toBeCloseTo(1700, -1);
  });

  it("interpolates points along the route", () => {
    const p = pointAtDistance(line, 550);
    expect(haversineM(origin, p)).toBeCloseTo(550, 0);
  });

  it("validates route geometry and rejects untrusted input", () => {
    expect(validateLineString({ type: "LineString", coordinates: line }).valid).toBe(true);
    expect(validateLineString({ type: "Point", coordinates: [0, 0] }).valid).toBe(false);
    expect(validateLineString({ type: "LineString", coordinates: [[0, 0]] }).valid).toBe(false);
    expect(validateLineString({ type: "LineString", coordinates: [[0, 0], [200, 0]] }).valid).toBe(false);
    expect(validateLineString({ type: "LineString", coordinates: [[0, 0], ["x", 1]] }).valid).toBe(false);
    const gap = validateLineString({ type: "LineString", coordinates: [line[0], line[10]] });
    expect(gap.valid).toBe(false);
    expect(gap.errors[0]).toMatch(/Gap/);
    const mismatch = validateLineString({ type: "LineString", coordinates: line }, { declaredDistanceKm: 2 });
    expect(mismatch.valid).toBe(false);
  });
});
