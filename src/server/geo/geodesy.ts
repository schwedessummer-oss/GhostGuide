import "server-only";
import { haversineM, type LngLat } from "@/domain/geo";

/**
 * Geodesy helpers for route geometry (polylines of [lng, lat] in WGS84),
 * used by the elevation sampler (elevation.ts).
 *
 * Conventions
 *  - Distances are metres along the sphere (haversine, mean Earth radius),
 *    which agrees with the WGS84 ellipsoid to ~0.5 %; good enough for route
 *    lengths that are themselves mapped with metre-level noise.
 *  - Provider geometry is untrusted: vertices that are not finite numbers in
 *    range are ignored rather than throwing (see cleanLine).
 *  - Longitude differences are wrapped to [-180, 180] wherever positions are
 *    combined, so routes crossing the antimeridian measure correctly.
 */

/** A polyline as [lng, lat] pairs. */
export type Line = [number, number][];

/** Resampled vertex with its distance from the start of the line. */
export interface LinePoint extends LngLat {
  distM: number;
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

/**
 * Points every `spacingM` metres along the line, measured from its start.
 * The first and last vertices are always included (the final interval may be
 * shorter than `spacingM`). Positions are interpolated linearly in lng/lat
 * between vertices, which is exact to centimetres at route vertex spacing.
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
