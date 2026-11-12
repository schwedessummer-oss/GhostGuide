/**
 * Map-area helpers for Explore (pure, isomorphic).
 */
import type { Bbox, GeocodeResultDto, LngLat, TrailSummaryDto } from "@/domain/catalog";

const KM_PER_DEG_LAT = 111.32;
const MAX_LAT = 85;

/** Below this span (degrees) a place's own box is too small to show trails around it. */
export const MIN_PLACE_SPAN_DEG = 0.06;
/** Radius searched around a point-like place (a peak, a trailhead) or "Near me". */
export const POINT_RADIUS_KM = 10;
export const NEAR_ME_RADIUS_KM = 15;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round5 = (n: number) => Number(n.toFixed(5));

/** Clamp to valid WGS84 (latitudes kept within the web-map range); null when empty. */
export function clampBbox(b: readonly number[]): Bbox | null {
  if (b.length !== 4 || !b.every((n) => Number.isFinite(n))) return null;
  const w = round5(clamp(b[0], -180, 180));
  const s = round5(clamp(b[1], -MAX_LAT, MAX_LAT));
  const e = round5(clamp(b[2], -180, 180));
  const n = round5(clamp(b[3], -MAX_LAT, MAX_LAT));
  return w < e && s < n ? [w, s, e, n] : null;
}

/** A square-ish box of `radiusKm` around a point. */
export function bboxAroundPoint(point: LngLat, radiusKm: number): Bbox {
  const lat = clamp(point.lat, -MAX_LAT, MAX_LAT);
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const dLng = radiusKm / (KM_PER_DEG_LAT * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return clampBbox([point.lng - dLng, lat - dLat, point.lng + dLng, lat + dLat]) ?? [-180, -MAX_LAT, 180, MAX_LAT];
}

/** The area to search for a chosen place: its own box, or ~10 km around a point-like place. */
export function bboxForPlace(place: Pick<GeocodeResultDto, "lng" | "lat" | "bbox">): Bbox {
  const b = place.bbox ? clampBbox(place.bbox) : null;
  if (b && b[2] - b[0] >= MIN_PLACE_SPAN_DEG && b[3] - b[1] >= MIN_PLACE_SPAN_DEG) return b;
  return bboxAroundPoint({ lng: place.lng, lat: place.lat }, POINT_RADIUS_KM);
}

/**
 * Coarsen a device location before it is used anywhere (≈1 km): enough to
 * centre a search, and the URL never carries a precise position.
 */
export function coarsenLocation(p: LngLat): LngLat {
  return { lng: Math.round(p.lng * 100) / 100, lat: Math.round(p.lat * 100) / 100 };
}

/** True when `inner` lies within `outer` (with a small tolerance in degrees). */
export function bboxWithin(inner: Bbox, outer: Bbox, tolerance = 1e-4): boolean {
  return (
    inner[0] >= outer[0] - tolerance && inner[1] >= outer[1] - tolerance && inner[2] <= outer[2] + tolerance && inner[3] <= outer[3] + tolerance
  );
}

/** Where a trail sits on the map: its trailhead, else the route centroid. */
export function trailAnchor(t: Pick<TrailSummaryDto, "trailhead" | "centroid">): LngLat {
  return t.trailhead ?? t.centroid;
}

export interface TrailPointProperties {
  id: string;
  difficulty: TrailSummaryDto["difficulty"];
}

/** GeoJSON points for the map's clustered trail source. */
export function trailsToFeatureCollection(
  trails: Pick<TrailSummaryDto, "id" | "difficulty" | "trailhead" | "centroid">[],
): GeoJSON.FeatureCollection<GeoJSON.Point, TrailPointProperties> {
  return {
    type: "FeatureCollection",
    features: trails.map((t) => {
      const p = trailAnchor(t);
      return {
        type: "Feature",
        properties: { id: t.id, difficulty: t.difficulty },
        geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      };
    }),
  };
}
