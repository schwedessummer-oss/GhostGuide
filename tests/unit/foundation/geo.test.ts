import { describe, expect, it } from "vitest";
import { cumulativeDistancesM, haversineM, lineLengthM, offsetMeters, type Position } from "@/domain/geo";

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
    expect(cumulativeDistancesM(line)[5]).toBeCloseTo(500, 0);
  });
});
