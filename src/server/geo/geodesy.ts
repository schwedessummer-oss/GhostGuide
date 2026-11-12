import "server-only";
import type { Bbox, LngLat } from "@/domain/catalog";
import { haversineM } from "@/domain/geo";
import type { Line } from "@/server/trails/types";

/**
 * Geodesy helpers for trail geometry (polylines of [lng, lat] in WGS84).
 *
 * Conventions
 *  - Distances are metres along the sphere (haversine, mean Earth radius),
 *    which agrees with the WGS84 ellipsoid to ~0.5 %; good enough for trail
 *    lengths that are themselves mapped with metre-level noise.
 *  - Point-to-line work uses a local equirectangular projection centred on
 *    the query point (exact north–south, cos(lat)-scaled east–west); the final
 *    distance to the chosen nearest point is re-measured with haversine, so
 *    the error stays well under 1 % for distances below ~50 km.
 *  - Provider geometry is untrusted: vertices that are not finite numbers in
 *    range are ignored rather than throwing (see cleanLine). Functions that
 *    must return a location (boundsOfLines, lengthWeightedCentroid,
 *    pointAlongLines) throw a RangeError only when there is no valid vertex
 *    at all; callers should reject such trails first (hasGeometry()).
 *  - Longitude differences are wrapped to [-180, 180] wherever positions are
 *    combined, so routes crossing the antimeridian measure and project
 *    correctly. Bboxes cannot express such a crossing (w < e) and are the one
 *    exception: see boundsOfLines.
 */

export const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/** Resampled vertex with its distance from the start of the line. */
export interface LinePoint extends LngLat {
  distM: number;
}

export interface NearestOnLines {
  /** Closest point on the geometry. */
  point: LngLat;
  /** Great-circle distance from the query point to `point`, metres. */
  distanceM: number;
  /** Index into the input `lines` array. */
  lineIndex: number;
  /** Distance along that line from its first vertex to `point`, metres. */
  alongM: number;
}

export interface LineEndpoints {
  lineIndex: number;
  start: LngLat;
  end: LngLat;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** True when `c` is a [lng, lat] pair of finite numbers within WGS84 range. */
export function isValidCoord(c: unknown): c is [number, number] {
  if (!Array.isArray(c) || c.length < 2) return false;
  const [lng, lat] = c as unknown[];
  return (
    typeof lng === "number" &&
    typeof lat === "number" &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}

/**
 * Copy of a line without invalid vertices and without consecutive duplicate
 * vertices. Extra ordinates (e.g. elevation) are dropped. Never throws.
 */
export function cleanLine(line: unknown): Line {
  if (!Array.isArray(line)) return [];
  const out: Line = [];
  for (const c of line) {
    if (!isValidCoord(c)) continue;
    const prev = out[out.length - 1];
    if (prev && prev[0] === c[0] && prev[1] === c[1]) continue;
    out.push([c[0], c[1]]);
  }
  return out;
}

/** Cleaned copies of every line that still has at least two vertices. */
export function cleanLines(lines: unknown): Line[] {
  if (!Array.isArray(lines)) return [];
  return lines.map(cleanLine).filter((l) => l.length >= 2);
}

/** True when at least one line has a measurable (non-zero length) segment. */
export function hasGeometry(lines: unknown): boolean {
  return cleanLines(lines).length > 0;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Wrap a longitude difference into [-180, 180]. */
function wrapDeltaLng(d: number): number {
  if (d > 180) return d - 360 * Math.ceil((d - 180) / 360);
  if (d < -180) return d + 360 * Math.ceil((-180 - d) / 360);
  return d;
}

/** Normalize a longitude into [-180, 180]. */
function normalizeLng(lng: number): number {
  const w = wrapDeltaLng(lng);
  return w === -180 && lng > 0 ? 180 : w;
}

const toLatLng = (c: [number, number]) => ({ lng: c[0], lat: c[1] });

function segmentLengthM(a: [number, number], b: [number, number]): number {
  return haversineM(toLatLng(a), toLatLng(b));
}

/** Cumulative distance at each vertex of a (clean) line; [0] = 0. */
function cumulative(line: Line): number[] {
  const out = new Array<number>(line.length);
  out[0] = 0;
  for (let i = 1; i < line.length; i++) out[i] = out[i - 1] + segmentLengthM(line[i - 1], line[i]);
  return out;
}

/** Interpolate between two vertices (longitude wrapped across ±180). */
function lerp(a: [number, number], b: [number, number], t: number): LngLat {
  return {
    lng: normalizeLng(a[0] + wrapDeltaLng(b[0] - a[0]) * t),
    lat: a[1] + (b[1] - a[1]) * t,
  };
}

// ---------------------------------------------------------------------------
// Length and resampling
// ---------------------------------------------------------------------------

/** Length of one line in metres (invalid vertices ignored). */
export function lineLengthM(line: Line): number {
  const l = cleanLine(line);
  let total = 0;
  for (let i = 1; i < l.length; i++) total += segmentLengthM(l[i - 1], l[i]);
  return total;
}

/** Total length of all lines in metres (one traversal of every line). */
export function linesLengthM(lines: Line[]): number {
  if (!Array.isArray(lines)) return 0;
  let total = 0;
  for (const line of lines) total += lineLengthM(line);
  return total;
}

/**
 * Points every `spacingM` metres along the line, measured from its start.
 * The first and last vertices are always included (the final interval may be
 * shorter than `spacingM`). Positions are interpolated linearly in lng/lat
 * between vertices, which is exact to centimetres at trail vertex spacing.
 *
 * A line with a single valid vertex yields that vertex; no valid vertex
 * yields []. Throws RangeError for a non-positive or non-finite spacing.
 */
export function resampleLine(line: Line, spacingM: number): LinePoint[] {
  if (!Number.isFinite(spacingM) || spacingM <= 0) throw new RangeError("spacingM must be a positive number");
  const l = cleanLine(line);
  if (l.length === 0) return [];
  if (l.length === 1) return [{ lng: l[0][0], lat: l[0][1], distM: 0 }];

  const out: LinePoint[] = [{ lng: l[0][0], lat: l[0][1], distM: 0 }];
  let segStart = 0; // cumulative distance at l[i - 1]
  let next = spacingM; // distance of the next sample
  for (let i = 1; i < l.length; i++) {
    const segLen = segmentLengthM(l[i - 1], l[i]);
    const segEnd = segStart + segLen;
    while (next < segEnd) {
      const p = lerp(l[i - 1], l[i], (next - segStart) / segLen);
      out.push({ ...p, distM: next });
      next += spacingM;
    }
    segStart = segEnd;
  }
  const last = l[l.length - 1];
  // Avoid a near-duplicate final sample when the length is a multiple of spacing.
  const tail = out[out.length - 1];
  if (out.length > 1 && segStart - tail.distM < 1e-6) out.pop();
  out.push({ lng: last[0], lat: last[1], distM: segStart });
  return out;
}

// ---------------------------------------------------------------------------
// Nearest point
// ---------------------------------------------------------------------------

/**
 * Closest point on the geometry to `p`, with which line it lies on and how
 * far along that line it is. Returns null when there is no valid vertex or
 * `p` is not a valid coordinate.
 *
 * Method: every segment is projected into a local equirectangular frame
 * centred on `p` (x = Δlng·cos(lat_p)·R, y = Δlat·R) and the point is
 * clamped onto the segment there; the winner's distance is then re-measured
 * with haversine.
 */
export function nearestPointOnLines(p: LngLat, lines: Line[]): NearestOnLines | null {
  if (!p || !isValidCoord([p.lng, p.lat]) || !Array.isArray(lines)) return null;
  const cosLat = Math.cos(p.lat * DEG);
  const kx = cosLat * DEG * EARTH_RADIUS_M;
  const ky = DEG * EARTH_RADIUS_M;
  const fx = (lng: number) => wrapDeltaLng(lng - p.lng) * kx;
  const fy = (lat: number) => (lat - p.lat) * ky;

  let best: { d2: number; lineIndex: number; seg: number; t: number; line: Line } | null = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = cleanLine(lines[lineIndex]);
    if (line.length === 0) continue;
    if (line.length === 1) {
      const x = fx(line[0][0]);
      const y = fy(line[0][1]);
      const d2 = x * x + y * y;
      if (!best || d2 < best.d2) best = { d2, lineIndex, seg: 0, t: 0, line };
      continue;
    }
    for (let i = 0; i < line.length - 1; i++) {
      const ax = fx(line[i][0]);
      const ay = fy(line[i][1]);
      const dx = fx(line[i + 1][0]) - ax;
      const dy = fy(line[i + 1][1]) - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const x = ax + t * dx;
      const y = ay + t * dy;
      const d2 = x * x + y * y;
      if (!best || d2 < best.d2) best = { d2, lineIndex, seg: i, t, line };
    }
  }
  if (!best) return null;
  const { lineIndex, seg, t, line } = best;
  const point = line.length === 1 ? toLatLng(line[0]) : lerp(line[seg], line[seg + 1], t);
  let alongM = 0;
  for (let i = 1; i <= seg; i++) alongM += segmentLengthM(line[i - 1], line[i]);
  if (line.length > 1) alongM += segmentLengthM(line[seg], line[seg + 1]) * t;
  return { point, distanceM: haversineM(p, point), lineIndex, alongM };
}

/**
 * Shortest distance (m) from `p` to any line. Infinity when there is no valid
 * geometry (so comparisons like `< 200` are simply false).
 */
export function distancePointToLinesM(p: LngLat, lines: Line[]): number {
  return nearestPointOnLines(p, lines)?.distanceM ?? Infinity;
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** First and last valid vertex of every line that has one (input order). */
export function lineEndpoints(lines: Line[]): LineEndpoints[] {
  if (!Array.isArray(lines)) return [];
  const out: LineEndpoints[] = [];
  lines.forEach((raw, lineIndex) => {
    const l = cleanLine(raw);
    if (l.length === 0) return;
    out.push({ lineIndex, start: toLatLng(l[0]), end: toLatLng(l[l.length - 1]) });
  });
  return out;
}

/**
 * Whether a line returns to its start: the endpoints are within `toleranceM`
 * of each other, it has at least three distinct vertices, and it is longer
 * than 4 × toleranceM (so a short stub whose ends happen to be close is not
 * called a loop).
 */
export function isClosedLine(line: Line, toleranceM = 50): boolean {
  const l = cleanLine(line);
  if (l.length < 3) return false;
  const tol = Number.isFinite(toleranceM) && toleranceM >= 0 ? toleranceM : 50;
  if (segmentLengthM(l[0], l[l.length - 1]) > tol) return false;
  return lineLengthM(l) > 4 * tol;
}

/**
 * Douglas–Peucker simplification with a tolerance in metres. Endpoints are
 * always kept; the result never has more vertices than the cleaned input.
 * Distances are measured in a local equirectangular frame centred on the
 * line's bbox, which is accurate for anything a single trail spans.
 * Iterative (no recursion), so very long lines cannot overflow the stack.
 */
export function simplifyLine(line: Line, toleranceM: number): Line {
  const l = cleanLine(line);
  if (l.length <= 2 || !Number.isFinite(toleranceM) || toleranceM <= 0) return l;

  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const c of l) {
    minLat = Math.min(minLat, c[1]);
    maxLat = Math.max(maxLat, c[1]);
  }
  const lat0 = (minLat + maxLat) / 2;
  const lng0 = l[0][0];
  const kx = Math.cos(lat0 * DEG) * DEG * EARTH_RADIUS_M;
  const ky = DEG * EARTH_RADIUS_M;
  // Unwrap longitudes relative to the first vertex so ±180 crossings stay continuous.
  const xs = l.map((c) => wrapDeltaLng(c[0] - lng0) * kx);
  const ys = l.map((c) => (c[1] - lat0) * ky);

  const keep = new Uint8Array(l.length);
  keep[0] = 1;
  keep[l.length - 1] = 1;
  const tol2 = toleranceM * toleranceM;
  const stack: [number, number][] = [[0, l.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    const ax = xs[first];
    const ay = ys[first];
    const dx = xs[last] - ax;
    const dy = ys[last] - ay;
    const len2 = dx * dx + dy * dy;
    let maxD2 = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      // Distance to the segment (not the infinite line), so closed rings work.
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((xs[i] - ax) * dx + (ys[i] - ay) * dy) / len2));
      const ex = xs[i] - (ax + t * dx);
      const ey = ys[i] - (ay + t * dy);
      const d2 = ex * ex + ey * ey;
      if (d2 > maxD2) {
        maxD2 = d2;
        index = i;
      }
    }
    if (index !== -1 && maxD2 > tol2) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return l.filter((_, i) => keep[i] === 1);
}

/**
 * [west, south, east, north] of every valid vertex. Routes that cross the
 * antimeridian get a box spanning the whole longitude range between their
 * extremes (Bbox requires west < east); such hiking routes are extremely rare.
 * Throws RangeError when there is no valid vertex.
 */
export function boundsOfLines(lines: Line[]): Bbox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const raw of Array.isArray(lines) ? lines : []) {
    for (const c of cleanLine(raw)) {
      w = Math.min(w, c[0]);
      e = Math.max(e, c[0]);
      s = Math.min(s, c[1]);
      n = Math.max(n, c[1]);
    }
  }
  if (!Number.isFinite(w)) throw new RangeError("boundsOfLines: no valid coordinates");
  return [w, s, e, n];
}

/**
 * Centre of mass of the route treated as a wire of uniform density: the mean
 * of segment midpoints weighted by segment length. For a loop this is usually
 * NOT on the route (use pointAlongLines for an on-route point). When the
 * geometry has no length (isolated vertices), the mean vertex is returned.
 * Longitudes are unwrapped relative to the first vertex, so routes crossing
 * the antimeridian get a sensible centre. Throws RangeError when there is no
 * valid vertex.
 */
export function lengthWeightedCentroid(lines: Line[]): LngLat {
  const clean = (Array.isArray(lines) ? lines : []).map(cleanLine).filter((l) => l.length > 0);
  if (clean.length === 0) throw new RangeError("lengthWeightedCentroid: no valid coordinates");
  const lng0 = clean[0][0][0];
  const ux = (lng: number) => wrapDeltaLng(lng - lng0);

  let sw = 0;
  let sx = 0;
  let sy = 0;
  let vx = 0;
  let vy = 0;
  let vn = 0;
  for (const l of clean) {
    for (let i = 0; i < l.length; i++) {
      vx += ux(l[i][0]);
      vy += l[i][1];
      vn += 1;
      if (i === 0) continue;
      const len = segmentLengthM(l[i - 1], l[i]);
      sw += len;
      sx += len * ((ux(l[i - 1][0]) + ux(l[i][0])) / 2);
      sy += len * ((l[i - 1][1] + l[i][1]) / 2);
    }
  }
  if (sw > 0) return { lng: normalizeLng(lng0 + sx / sw), lat: sy / sw };
  return { lng: normalizeLng(lng0 + vx / vn), lat: vy / vn };
}

/**
 * The point `fraction` (0..1, clamped; NaN → 0.5) of the way along the
 * concatenated lines, in input order. pointAlongLines(lines, 0.5) is a
 * representative on-route point (e.g. for weather or a map label).
 * Throws RangeError when there is no valid vertex.
 */
export function pointAlongLines(lines: Line[], fraction: number): LngLat {
  const clean = (Array.isArray(lines) ? lines : []).map(cleanLine).filter((l) => l.length > 0);
  if (clean.length === 0) throw new RangeError("pointAlongLines: no valid coordinates");
  const f = Number.isNaN(fraction) ? 0.5 : Math.max(0, Math.min(1, fraction));
  const cums = clean.map(cumulative);
  const total = cums.reduce((sum, c) => sum + c[c.length - 1], 0);
  if (total === 0) return toLatLng(clean[0][0]);

  let remaining = f * total;
  for (let li = 0; li < clean.length; li++) {
    const l = clean[li];
    const cum = cums[li];
    const len = cum[cum.length - 1];
    if (remaining > len && li < clean.length - 1) {
      remaining -= len;
      continue;
    }
    if (l.length === 1) return toLatLng(l[0]);
    const d = Math.min(remaining, len);
    let i = 1;
    while (i < l.length - 1 && cum[i] < d) i++;
    const segLen = cum[i] - cum[i - 1];
    return lerp(l[i - 1], l[i], segLen === 0 ? 0 : (d - cum[i - 1]) / segLen);
  }
  // Unreachable: the last line always returns above.
  const last = clean[clean.length - 1];
  return toLatLng(last[last.length - 1]);
}
