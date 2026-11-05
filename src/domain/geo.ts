/**
 * Isomorphic geo utilities (no I/O, safe for client and server).
 * Coordinates follow GeoJSON order: [lng, lat] or [lng, lat, ele].
 */
export type Position = [number, number] | [number, number, number];

export interface LineStringGeometry {
  type: "LineString";
  coordinates: Position[];
}

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

export const posToLatLng = (p: Position): LatLng => ({ lat: p[1], lng: p[0] });

/** Cumulative distance (m) at each vertex; result[0] = 0. */
export function cumulativeDistancesM(coords: Position[]): number[] {
  const out = [0];
  for (let i = 1; i < coords.length; i++) {
    out.push(out[i - 1] + haversineM(posToLatLng(coords[i - 1]), posToLatLng(coords[i])));
  }
  return out;
}

export function lineLengthM(coords: Position[]): number {
  const c = cumulativeDistancesM(coords);
  return c[c.length - 1] ?? 0;
}

/** Total positive elevation change (m) when coordinates carry elevation. */
export function elevationGainM(coords: Position[]): number | null {
  if (!coords.every((c) => c.length === 3)) return null;
  let gain = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = (coords[i][2] as number) - (coords[i - 1][2] as number);
    if (d > 0) gain += d;
  }
  return gain;
}

export interface Projection {
  /** distance from the point to the nearest point on the route (m) */
  distanceFromRouteM: number;
  /** distance along the route to the nearest point (m) */
  alongM: number;
  segmentIndex: number;
  nearest: LatLng;
}

/** Two route segments closer than this to the best match count as "the same place". */
export const SAME_PLACE_TOLERANCE_M = 25;

/**
 * Project a point onto a polyline using a local equirectangular
 * approximation per segment (accurate to well under a metre at trail scale).
 *
 * Without a hint, the nearest segment wins. With `hintAlongM` (e.g. current
 * progress), every segment within SAME_PLACE_TOLERANCE_M of the nearest one
 * is a candidate, and the candidate whose along-distance is closest to the
 * hint wins (moving backwards costs double). This keeps progress continuous
 * where route legs overlap (out-and-back, lollipop loops) instead of jumping
 * to the other leg.
 */
export function projectOntoLine(point: LatLng, coords: Position[], cumulative?: number[], hintAlongM?: number): Projection {
  if (coords.length < 2) throw new Error("projectOntoLine requires at least 2 coordinates");
  const cum = cumulative ?? cumulativeDistancesM(coords);
  const cosLat = Math.cos(toRad(point.lat));
  const candidates: Projection[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const a = posToLatLng(coords[i]);
    const b = posToLatLng(coords[i + 1]);
    // local metric frame centered on the point
    const ax = toRad(a.lng - point.lng) * cosLat * EARTH_RADIUS_M;
    const ay = toRad(a.lat - point.lat) * EARTH_RADIUS_M;
    const bx = toRad(b.lng - point.lng) * cosLat * EARTH_RADIUS_M;
    const by = toRad(b.lat - point.lat) * EARTH_RADIUS_M;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const dist = Math.hypot(ax + t * dx, ay + t * dy);
    candidates.push({
      distanceFromRouteM: dist,
      alongM: cum[i] + t * (cum[i + 1] - cum[i]),
      segmentIndex: i,
      nearest: { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) },
    });
  }
  let best = candidates[0];
  for (const c of candidates) if (c.distanceFromRouteM < best.distanceFromRouteM) best = c;
  if (hintAlongM === undefined) return best;
  const cost = (c: Projection) => (c.alongM >= hintAlongM ? c.alongM - hintAlongM : (hintAlongM - c.alongM) * 2);
  let chosen = best;
  for (const c of candidates) {
    if (c.distanceFromRouteM > best.distanceFromRouteM + SAME_PLACE_TOLERANCE_M) continue;
    if (cost(c) < cost(chosen)) chosen = c;
  }
  return chosen;
}

/** Interpolated point at a given distance along the route. */
export function pointAtDistance(coords: Position[], alongM: number, cumulative?: number[]): LatLng {
  const cum = cumulative ?? cumulativeDistancesM(coords);
  const total = cum[cum.length - 1];
  const d = Math.max(0, Math.min(total, alongM));
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < d) i++;
  const segLen = cum[i + 1] - cum[i] || 1;
  const t = (d - cum[i]) / segLen;
  const a = posToLatLng(coords[i]);
  const b = posToLatLng(coords[i + 1]);
  return { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) };
}

/** Offset a point by metres east/north (used by the GPS simulator and tests). */
export function offsetMeters(p: LatLng, eastM: number, northM: number): LatLng {
  const dLat = (northM / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng = (eastM / (EARTH_RADIUS_M * Math.cos(toRad(p.lat)))) * (180 / Math.PI);
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}

export interface GeometryValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  lengthM: number;
  elevationGainM: number | null;
  bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number } | null;
}

/**
 * Validate an imported route geometry (untrusted input). Checks structure,
 * coordinate ranges, vertex spacing and, optionally, agreement with the
 * catalog's declared distance.
 */
export function validateLineString(
  input: unknown,
  opts: { declaredDistanceKm?: number; maxVertexGapM?: number; distanceTolerance?: number } = {},
): GeometryValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (msg: string): GeometryValidation => ({
    valid: false,
    errors: [...errors, msg],
    warnings,
    lengthM: 0,
    elevationGainM: null,
    bounds: null,
  });
  if (!input || typeof input !== "object") return fail("Geometry must be an object");
  const g = input as { type?: unknown; coordinates?: unknown };
  if (g.type !== "LineString") return fail("Geometry type must be LineString");
  if (!Array.isArray(g.coordinates) || g.coordinates.length < 2) return fail("LineString needs at least 2 coordinates");
  if (g.coordinates.length > 20_000) return fail("Too many coordinates (max 20000)");
  const coords: Position[] = [];
  for (const [i, c] of g.coordinates.entries()) {
    if (!Array.isArray(c) || c.length < 2 || c.length > 3 || !c.every((n) => typeof n === "number" && Number.isFinite(n))) {
      return fail(`Coordinate ${i} is not [lng, lat] or [lng, lat, ele]`);
    }
    const [lng, lat] = c as number[];
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return fail(`Coordinate ${i} is out of range`);
    coords.push(c as Position);
  }
  const maxGap = opts.maxVertexGapM ?? 500;
  for (let i = 1; i < coords.length; i++) {
    const gap = haversineM(posToLatLng(coords[i - 1]), posToLatLng(coords[i]));
    if (gap > maxGap) errors.push(`Gap of ${Math.round(gap)} m between vertices ${i - 1} and ${i} exceeds ${maxGap} m`);
  }
  const lengthM = lineLengthM(coords);
  if (opts.declaredDistanceKm !== undefined) {
    const tol = opts.distanceTolerance ?? 0.1;
    const declaredM = opts.declaredDistanceKm * 1000;
    if (Math.abs(lengthM - declaredM) > declaredM * tol) {
      errors.push(
        `Route length ${(lengthM / 1000).toFixed(2)} km differs from declared ${opts.declaredDistanceKm} km by more than ${Math.round(tol * 100)}%`,
      );
    }
  }
  const lats = coords.map((c) => c[1]);
  const lngs = coords.map((c) => c[0]);
  const gain = elevationGainM(coords);
  if (gain === null) warnings.push("No elevation data in geometry");
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    lengthM,
    elevationGainM: gain,
    bounds: { minLat: Math.min(...lats), minLng: Math.min(...lngs), maxLat: Math.max(...lats), maxLng: Math.max(...lngs) },
  };
}

export function formatDistance(meters: number, units: "imperial" | "metric" = "imperial"): string {
  if (units === "metric") return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
  const miles = meters / 1609.344;
  return miles >= 0.1 ? `${miles.toFixed(1)} mi` : `${Math.round(meters * 3.28084)} ft`;
}

export function formatElevation(meters: number, units: "imperial" | "metric" = "imperial"): string {
  return units === "metric" ? `${Math.round(meters)} m` : `${Math.round(meters * 3.28084).toLocaleString("en-US")} ft`;
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}
