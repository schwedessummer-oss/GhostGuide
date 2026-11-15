import { describe, expect, it } from "vitest";
import { haversineM, offsetMeters, type LatLng } from "@/domain/geo";
import { cleanLine, cleanLines, isValidCoord, lineLengthM, resampleLine, type Line } from "@/server/geo/geodesy";

const origin: LatLng = { lat: 46.5, lng: 8.0 };
const at = (eastM: number, northM: number, from: LatLng = origin): [number, number] => {
  const p = offsetMeters(from, eastM, northM);
  return [p.lng, p.lat];
};
/** Straight line east from `from`, `lengthM` long, one vertex every `stepM`. */
const eastLine = (lengthM: number, stepM = 100, from: LatLng = origin, northM = 0): Line =>
  Array.from({ length: Math.round(lengthM / stepM) + 1 }, (_, i) => at(i * stepM, northM, from));
const ll = (c: [number, number]) => ({ lng: c[0], lat: c[1] });

describe("validation", () => {
  it("accepts finite in-range pairs only", () => {
    expect(isValidCoord([8, 46])).toBe(true);
    expect(isValidCoord([8, 46, 1200])).toBe(true);
    expect(isValidCoord([181, 0])).toBe(false);
    expect(isValidCoord([0, -91])).toBe(false);
    expect(isValidCoord([NaN, 0])).toBe(false);
    expect(isValidCoord(["8", "46"])).toBe(false);
    expect(isValidCoord([8])).toBe(false);
    expect(isValidCoord(null)).toBe(false);
  });

  it("cleanLine drops invalid vertices, duplicates and extra ordinates without throwing", () => {
    const dirty = [[8, 46, 1000], [8, 46], null, [NaN, 1], [8.001, 46], "x", [8.001, 46], [8.002, 95]] as unknown as Line;
    expect(cleanLine(dirty)).toEqual([
      [8, 46],
      [8.001, 46],
    ]);
    expect(cleanLine("not a line")).toEqual([]);
    expect(cleanLines([dirty, [[1, 1]], [], "x"])).toEqual([
      [
        [8, 46],
        [8.001, 46],
      ],
    ]);
    expect(cleanLines(undefined)).toEqual([]);
  });
});

describe("length", () => {
  it("measures a line", () => {
    expect(lineLengthM(eastLine(1000))).toBeCloseTo(1000, 0);
    expect(lineLengthM(eastLine(2500, 250, origin, 500))).toBeCloseTo(2500, 0);
    expect(lineLengthM([])).toBe(0);
    expect(lineLengthM([[8, 46]])).toBe(0);
  });

  it("measures across the antimeridian the short way", () => {
    const line: Line = [
      [179.999, 0],
      [-179.999, 0],
    ];
    expect(lineLengthM(line)).toBeCloseTo(222.4, 0);
  });
});

describe("resampleLine", () => {
  it("emits points every spacing metres and keeps both ends", () => {
    const line = eastLine(1000, 200);
    const pts = resampleLine(line, 300);
    expect(pts.map((p) => Math.round(p.distM))).toEqual([0, 300, 600, 900, 1000]);
    expect(pts[0]).toMatchObject({ lng: line[0][0], lat: line[0][1], distM: 0 });
    expect(pts.at(-1)).toMatchObject({ lng: line.at(-1)![0], lat: line.at(-1)![1] });
    for (const p of pts) expect(haversineM(origin, p)).toBeCloseTo(p.distM, 0);
  });

  it("does not duplicate the end when the length is a multiple of the spacing", () => {
    const pts = resampleLine(eastLine(1000, 100), 250);
    expect(pts.map((p) => Math.round(p.distM))).toEqual([0, 250, 500, 750, 1000]);
  });

  it("follows corners: distance is measured along the line", () => {
    const corner = at(500, 0);
    const line: Line = [at(0, 0), corner, at(500, 500)];
    const pts = resampleLine(line, 600);
    expect(pts).toHaveLength(3);
    expect(haversineM(ll(corner), pts[1])).toBeCloseTo(100, 0);
    expect(pts[2].distM).toBeCloseTo(1000, 0);
  });

  it("handles degenerate input", () => {
    expect(resampleLine([], 30)).toEqual([]);
    expect(resampleLine([[8, 46]], 30)).toEqual([{ lng: 8, lat: 46, distM: 0 }]);
    const short = resampleLine(eastLine(10, 10), 30);
    expect(short.map((p) => Math.round(p.distM))).toEqual([0, 10]);
    expect(() => resampleLine(eastLine(100), 0)).toThrow(RangeError);
    expect(() => resampleLine(eastLine(100), NaN)).toThrow(RangeError);
  });
});
