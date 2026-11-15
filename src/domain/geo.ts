/**
 * Isomorphic geo utilities (no I/O, safe for client and server).
 * Coordinates follow GeoJSON order: [lng, lat] or [lng, lat, ele].
 */
export type Position = [number, number] | [number, number, number];

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

/** Offset a point by metres east/north (used by synthetic test geometry). */
export function offsetMeters(p: LatLng, eastM: number, northM: number): LatLng {
  const dLat = (northM / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng = (eastM / (EARTH_RADIUS_M * Math.cos(toRad(p.lat)))) * (180 / Math.PI);
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}
