import { describe, expect, it } from "vitest";
import { haversineM, offsetMeters, type LatLng } from "@/domain/geo";
import {
  boundsOfLines,
  cleanLine,
  cleanLines,
  distancePointToLinesM,
  hasGeometry,
  isClosedLine,
  isValidCoord,
  lengthWeightedCentroid,
  lineEndpoints,
  lineLengthM,
  linesLengthM,
  nearestPointOnLines,
  pointAlongLines,
  resampleLine,
  simplifyLine,
} from "@/server/geo/geodesy";
import type { Line } from "@/server/trails/types";

const origin: LatLng = { lat: 46.5, lng: 8.0 };
const at = (eastM: number, northM: number, from: LatLng = origin): [number, number] => {
  const p = offsetMeters(from, eastM, northM);
  return [p.lng, p.lat];
};
/** Straight line east from `from`, `lengthM` long, one vertex every `stepM`. */
const eastLine = (lengthM: number, stepM = 100, from: LatLng = origin, northM = 0): Line =>
  Array.from({ length: Math.round(lengthM / stepM) + 1 }, (_, i) => at(i * stepM, northM, from));
const ll = (c: [number, number]) => ({ lng: c[0], lat: c[1] });

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
    expect(hasGeometry([[[1, 1]]])).toBe(false);
    expect(hasGeometry([eastLine(100)])).toBe(true);
  });
});

describe("length", () => {
  it("measures one and several lines", () => {
    expect(lineLengthM(eastLine(1000))).toBeCloseTo(1000, 0);
    expect(linesLengthM([eastLine(1000), eastLine(2500, 250, origin, 500)])).toBeCloseTo(3500, 0);
    expect(linesLengthM([])).toBe(0);
    expect(linesLengthM([[[8, 46]]])).toBe(0);
    expect(linesLengthM(null as unknown as Line[])).toBe(0);
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

describe("nearest point / distance to lines", () => {
  const line = eastLine(1000);

  it("projects onto the segment and reports distance and progress", () => {
    const n = nearestPointOnLines(ll(at(350, 30)), [line])!;
    expect(n.distanceM).toBeCloseTo(30, 1);
    expect(n.alongM).toBeCloseTo(350, 0);
    expect(n.lineIndex).toBe(0);
    expect(haversineM(n.point, ll(at(350, 0)))).toBeLessThan(0.1);
  });

  it("clamps to the end of the line beyond its ends", () => {
    const n = nearestPointOnLines(ll(at(1300, 400)), [line])!;
    expect(n.distanceM).toBeCloseTo(500, 0);
    expect(n.alongM).toBeCloseTo(1000, 0);
  });

  it("picks the right line among several", () => {
    const second = eastLine(1000, 100, origin, 2000);
    const n = nearestPointOnLines(ll(at(250, 1990)), [line, second])!;
    expect(n.lineIndex).toBe(1);
    expect(n.alongM).toBeCloseTo(250, 0);
    expect(n.distanceM).toBeCloseTo(10, 1);
  });

  it("is accurate to 1% up to 50 km at high latitude (vs dense haversine brute force)", () => {
    const rand = rng(42);
    let checked = 0;
    for (let k = 0; k < 40; k++) {
      const lat = -70 + rand() * 140;
      const base = { lat, lng: -170 + rand() * 340 };
      const bearing = rand() * 2 * Math.PI;
      const route: Line = [at(0, 0, base), at(8000 * Math.cos(bearing), 8000 * Math.sin(bearing), base), at(9000, -6000, base)];
      const p = ll(at((rand() - 0.5) * 70_000, (rand() - 0.5) * 70_000, base));
      const dense = resampleLine(route, 5);
      const truth = Math.min(...dense.map((q) => haversineM(p, q)));
      if (truth > 50_000 || truth < 100) continue;
      const d = distancePointToLinesM(p, [route]);
      expect(Math.abs(d - truth) / truth).toBeLessThan(0.01);
      checked++;
    }
    expect(checked).toBeGreaterThan(25);
  });

  it("works across the antimeridian", () => {
    const route: Line = [
      [179.99, 0],
      [-179.99, 0],
    ];
    const n = nearestPointOnLines({ lng: 180, lat: 0.001 }, [route])!;
    expect(n.distanceM).toBeCloseTo(111.2, 0);
    expect(Math.abs(n.point.lng)).toBeCloseTo(180, 6);
    expect(n.alongM).toBeCloseTo(1112, -1);
  });

  it("supports single-vertex lines and returns null/Infinity without geometry", () => {
    const n = nearestPointOnLines(ll(at(0, 100)), [[[origin.lng, origin.lat]]])!;
    expect(n.distanceM).toBeCloseTo(100, 0);
    expect(n.alongM).toBe(0);
    expect(nearestPointOnLines(origin, [])).toBeNull();
    expect(distancePointToLinesM(origin, [])).toBe(Infinity);
    expect(distancePointToLinesM({ lng: NaN, lat: 0 }, [line])).toBe(Infinity);
    expect(nearestPointOnLines(origin, [[[NaN, NaN]]] as Line[])).toBeNull();
  });
});

describe("endpoints and loops", () => {
  const square: Line = [at(0, 0), at(250, 0), at(250, 250), at(0, 250), at(0, 0)];

  it("lists each line's ends with its index", () => {
    const ends = lineEndpoints([eastLine(1000), [], eastLine(500, 100, origin, 300)]);
    expect(ends.map((e) => e.lineIndex)).toEqual([0, 2]);
    expect(haversineM(ends[0].end, ll(at(1000, 0)))).toBeLessThan(0.01);
    expect(haversineM(ends[1].start, ll(at(0, 300)))).toBeLessThan(0.01);
    expect(lineEndpoints(null as unknown as Line[])).toEqual([]);
  });

  it("detects closed lines with a tolerance", () => {
    expect(isClosedLine(square)).toBe(true);
    expect(isClosedLine([...square.slice(0, 4), at(0, 40)])).toBe(true);
    expect(isClosedLine([...square.slice(0, 4), at(0, 60)])).toBe(false);
    expect(isClosedLine([...square.slice(0, 4), at(0, 60)], 75)).toBe(true);
    expect(isClosedLine(eastLine(1000))).toBe(false);
  });

  it("does not call short stubs or two-point lines loops", () => {
    expect(isClosedLine([at(0, 0), at(30, 30), at(0, 10)])).toBe(false);
    expect(isClosedLine([at(0, 0), at(0, 10)])).toBe(false);
    expect(isClosedLine([])).toBe(false);
  });
});

describe("simplifyLine", () => {
  it("removes collinear vertices and keeps endpoints", () => {
    const line = eastLine(1000, 10);
    const s = simplifyLine(line, 1);
    expect(s).toEqual([line[0], line.at(-1)]);
  });

  it("keeps deviations above the tolerance and drops those below", () => {
    const zigzag: Line = Array.from({ length: 21 }, (_, i) => at(i * 50, i % 2 === 0 ? 0 : 20));
    expect(simplifyLine(zigzag, 5)).toHaveLength(21);
    expect(simplifyLine(zigzag, 25)).toHaveLength(2);
  });

  it("never moves vertices further than the tolerance from the original", () => {
    const rand = rng(7);
    const wiggly: Line = Array.from({ length: 500 }, (_, i) => at(i * 10, Math.sin(i / 15) * 80 + rand() * 6));
    const s = simplifyLine(wiggly, 5);
    expect(s.length).toBeLessThan(wiggly.length / 3);
    expect(s[0]).toEqual(wiggly[0]);
    expect(s.at(-1)).toEqual(wiggly.at(-1));
    for (const v of wiggly) expect(distancePointToLinesM(ll(v), [s])).toBeLessThan(5.2);
  });

  it("keeps the shape of closed rings", () => {
    const ring: Line = [at(0, 0), at(500, 0), at(500, 500), at(0, 500), at(0, 0)];
    const s = simplifyLine(ring, 10);
    expect(s).toHaveLength(5);
  });

  it("handles huge lines iteratively and degenerate tolerances", () => {
    const big: Line = Array.from({ length: 100_000 }, (_, i) => [8 + i * 1e-6, 46 + (i % 2) * 1e-9]);
    expect(simplifyLine(big, 1)).toHaveLength(2);
    const line = eastLine(300, 100);
    expect(simplifyLine(line, 0)).toEqual(line);
    expect(simplifyLine(line, NaN)).toEqual(line);
    expect(simplifyLine([], 5)).toEqual([]);
  });
});

describe("bounds, centroid and points along", () => {
  it("computes bounds and rejects empty geometry", () => {
    const b = boundsOfLines([
      [
        [8, 46],
        [8.2, 46.1],
      ],
      [
        [7.9, 46.3],
        [8.1, 45.9],
      ],
    ]);
    expect(b).toEqual([7.9, 45.9, 8.2, 46.3]);
    expect(() => boundsOfLines([])).toThrow(RangeError);
    expect(() => boundsOfLines([[[NaN, 1]]] as Line[])).toThrow(RangeError);
  });

  it("weights the centroid by segment length, not vertex count", () => {
    // 100 vertices crammed into the first 10 m, then one long segment to 1 km.
    const line: Line = [...Array.from({ length: 100 }, (_, i) => at(i * 0.1, 0)), at(1000, 0)];
    const c = lengthWeightedCentroid([line]);
    expect(haversineM(c, ll(at(500, 0)))).toBeLessThan(1);
  });

  it("puts a loop's centroid in its middle (off the route)", () => {
    const square: Line = [at(0, 0), at(1000, 0), at(1000, 1000), at(0, 1000), at(0, 0)];
    const c = lengthWeightedCentroid([square]);
    expect(haversineM(c, ll(at(500, 500)))).toBeLessThan(1);
    expect(distancePointToLinesM(c, [square])).toBeCloseTo(500, 0);
  });

  it("combines several lines by length", () => {
    const a = eastLine(1000); // centre at 500 E
    const b = eastLine(3000, 100, origin, 1000); // centre at 1500 E, 1000 N
    const c = lengthWeightedCentroid([a, b]);
    expect(haversineM(c, ll(at(1250, 750)))).toBeLessThan(2);
  });

  it("falls back to the vertex mean for zero-length geometry and handles the antimeridian", () => {
    expect(lengthWeightedCentroid([[[8, 46]], [[10, 48]]])).toEqual({ lng: 9, lat: 47 });
    const c = lengthWeightedCentroid([
      [
        [179.9, 10],
        [-179.9, 10],
      ],
    ]);
    expect(Math.abs(c.lng)).toBeCloseTo(180, 6);
    expect(c.lat).toBeCloseTo(10, 6);
    expect(() => lengthWeightedCentroid([])).toThrow(RangeError);
  });

  it("returns on-route points by fraction across lines", () => {
    const a = eastLine(1000);
    const b = eastLine(3000, 100, origin, 1000);
    expect(pointAlongLines([a, b], 0)).toEqual(ll(a[0]));
    expect(pointAlongLines([a, b], 1)).toEqual(ll(b.at(-1)!));
    expect(haversineM(pointAlongLines([a, b], 0.5), ll(at(1000, 1000)))).toBeLessThan(0.5);
    expect(haversineM(pointAlongLines([a], 0.25), ll(at(250, 0)))).toBeLessThan(0.5);
    expect(pointAlongLines([a], -3)).toEqual(ll(a[0]));
    expect(pointAlongLines([a], 7)).toEqual(ll(a.at(-1)!));
    expect(haversineM(pointAlongLines([a], NaN), ll(at(500, 0)))).toBeLessThan(0.5);
    expect(pointAlongLines([[[8, 46]]], 0.5)).toEqual({ lng: 8, lat: 46 });
    expect(() => pointAlongLines([], 0.5)).toThrow(RangeError);
  });

  it("keeps the midpoint of a loop on the route", () => {
    const square: Line = [at(0, 0), at(1000, 0), at(1000, 1000), at(0, 1000), at(0, 0)];
    const mid = pointAlongLines([square], 0.5);
    expect(distancePointToLinesM(mid, [square])).toBeLessThan(0.5);
    expect(haversineM(mid, ll(at(1000, 1000)))).toBeLessThan(0.5);
  });
});
