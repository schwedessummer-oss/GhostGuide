import type { Bbox, CatalogLayer, LngLat } from "@/domain/catalog";

/**
 * Fixed degree grid used to load provider data on demand and to track what
 * has been loaded (public.catalog_tiles). Keys look like "0.25/1234/567":
 * ix = floor((lng + 180) / deg), iy = floor((lat + 90) / deg).
 *
 * 0.25° ≈ 28 km north-south: small enough for one Overpass request in dense
 * areas, large enough that a typical town search touches 1–4 tiles.
 */
export const TILE_DEG: Record<CatalogLayer, number> = { outdoor: 0.25, services: 0.25 };

export interface Tile {
  layer: CatalogLayer;
  deg: number;
  ix: number;
  iy: number;
  key: string;
  bbox: Bbox;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

function tileAt(layer: CatalogLayer, ix: number, iy: number): Tile {
  const deg = TILE_DEG[layer];
  const w = round(ix * deg - 180);
  const s = round(iy * deg - 90);
  return { layer, deg, ix, iy, key: `${deg}/${ix}/${iy}`, bbox: [w, s, round(w + deg), round(s + deg)] };
}

const maxIx = (deg: number) => Math.round(360 / deg) - 1;
const maxIy = (deg: number) => Math.round(180 / deg) - 1;

export function tileForPoint(layer: CatalogLayer, lng: number, lat: number): Tile {
  const deg = TILE_DEG[layer];
  const ix = Math.min(maxIx(deg), Math.max(0, Math.floor((lng + 180) / deg)));
  const iy = Math.min(maxIy(deg), Math.max(0, Math.floor((lat + 90) / deg)));
  return tileAt(layer, ix, iy);
}

export function tileFromKey(layer: CatalogLayer, key: string): Tile | null {
  const m = key.match(/^([0-9.]+)\/(\d+)\/(\d+)$/);
  if (!m) return null;
  const deg = Number(m[1]);
  if (deg !== TILE_DEG[layer]) return null;
  const ix = Number(m[2]);
  const iy = Number(m[3]);
  if (ix > maxIx(deg) || iy > maxIy(deg)) return null;
  return tileAt(layer, ix, iy);
}

export function bboxCenter(b: Bbox): LngLat {
  return { lng: (b[0] + b[2]) / 2, lat: (b[1] + b[3]) / 2 };
}

/**
 * Tiles intersecting a bbox, nearest to the bbox centre first. When more
 * than `max` tiles intersect, returns the `max` nearest and truncated=true.
 */
export function tilesForBbox(layer: CatalogLayer, bbox: Bbox, max = Infinity): { tiles: Tile[]; count: number; truncated: boolean } {
  const deg = TILE_DEG[layer];
  const eps = 1e-9;
  const x0 = Math.max(0, Math.floor((bbox[0] + 180) / deg));
  const x1 = Math.min(maxIx(deg), Math.floor((bbox[2] + 180 - eps) / deg));
  const y0 = Math.max(0, Math.floor((bbox[1] + 90) / deg));
  const y1 = Math.min(maxIy(deg), Math.floor((bbox[3] + 90 - eps) / deg));
  const count = Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1);
  const c = bboxCenter(bbox);
  const cx = (c.lng + 180) / deg;
  const cy = (c.lat + 90) / deg;
  // Enumerate only up to a bounded window around the centre when huge.
  const cap = Number.isFinite(max) ? max : count;
  const tiles: Tile[] = [];
  if (count <= 4096) {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push(tileAt(layer, x, y));
  } else {
    const r = Math.ceil(Math.sqrt(cap)) + 1;
    for (let x = Math.max(x0, Math.floor(cx) - r); x <= Math.min(x1, Math.floor(cx) + r); x++)
      for (let y = Math.max(y0, Math.floor(cy) - r); y <= Math.min(y1, Math.floor(cy) + r); y++) tiles.push(tileAt(layer, x, y));
  }
  tiles.sort((a, b) => (a.ix + 0.5 - cx) ** 2 + (a.iy + 0.5 - cy) ** 2 - ((b.ix + 0.5 - cx) ** 2 + (b.iy + 0.5 - cy) ** 2));
  const truncated = count > cap;
  return { tiles: tiles.slice(0, cap), count, truncated };
}

/** Bbox around a point with a radius in metres (approximate, fine for < 100 km). */
export function bboxAround(p: LngLat, radiusM: number): Bbox {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.max(0.01, Math.cos((p.lat * Math.PI) / 180)));
  return [
    Math.max(-180, p.lng - dLng),
    Math.max(-90, p.lat - dLat),
    Math.min(180, p.lng + dLng),
    Math.min(90, p.lat + dLat),
  ];
}

/** WKT polygon for a bbox (for ST_GeomFromText(..., 4326)). */
export function bboxToWkt(b: Bbox): string {
  const [w, s, e, n] = b;
  return `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
}

/** Approximate bbox area in km² (for "too large" checks). */
export function bboxAreaKm2(b: Bbox): number {
  const midLat = ((b[1] + b[3]) / 2) * (Math.PI / 180);
  return (b[2] - b[0]) * 111.32 * Math.cos(midLat) * (b[3] - b[1]) * 111.32;
}
