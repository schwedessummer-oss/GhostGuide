/**
 * Isomorphic geo types and utilities (no I/O, safe for client and server).
 * Coordinates follow GeoJSON order: [lng, lat].
 */

/** [west, south, east, north] in degrees (WGS84). */
export type Bbox = [number, number, number, number];

export interface LngLat {
  lng: number;
  lat: number;
}

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres (mean Earth radius). */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Offset a point by metres east/north (used by synthetic test geometry). */
export function offsetMeters(p: LatLng, eastM: number, northM: number): LatLng {
  const dLat = (northM / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng = (eastM / (EARTH_RADIUS_M * Math.cos(toRad(p.lat)))) * (180 / Math.PI);
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}
