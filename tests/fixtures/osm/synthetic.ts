/**
 * Builders for SYNTHETIC Overpass responses (edge cases that are hard to find
 * in a small real sample). Shapes mirror real `out geom` / `out center` /
 * `out tags` output (see the real samples in this folder).
 *
 * Positions are given in metres east/north of ORIGIN and rounded to OSM's
 * 1e-7° precision, so the same metre offsets always produce identical
 * coordinates (= a shared node).
 */
import { offsetMeters } from "@/domain/geo";

export const ORIGIN = { lat: 35.05, lng: -82.72 };
export const TIMESTAMP = "2026-11-10T12:34:56Z";

export type Xy = [number, number];

const r7 = (n: number) => Math.round(n * 1e7) / 1e7;

export function at([east, north]: Xy): { lat: number; lon: number } {
  const p = offsetMeters(ORIGIN, east, north);
  return { lat: r7(p.lat), lon: r7(p.lng) };
}

/** [lng, lat] of a metre offset, as the parser outputs it. */
export function lngLat(xy: Xy): [number, number] {
  const p = at(xy);
  return [p.lon, p.lat];
}

let nextNodeId = 9_000_000;

/** A standalone way as output by `out geom` (with node ids, bounds and geometry). */
export function way(id: number, tags: Record<string, string> | undefined, points: Xy[]) {
  const geometry = points.map(at);
  return {
    type: "way",
    id,
    bounds: {
      minlat: Math.min(...geometry.map((g) => g.lat)),
      minlon: Math.min(...geometry.map((g) => g.lon)),
      maxlat: Math.max(...geometry.map((g) => g.lat)),
      maxlon: Math.max(...geometry.map((g) => g.lon)),
    },
    nodes: points.map(() => nextNodeId++),
    geometry,
    ...(tags ? { tags } : {}),
  };
}

/** A way as output by `out tags` (route member ways: tags only). */
export const tagsOnlyWay = (id: number, tags: Record<string, string>) => ({ type: "way", id, tags });

/** A relation way member with geometry, as in `out geom`. */
export const memberWay = (ref: number, points: Xy[], role = "") => ({ type: "way", ref, role, geometry: points.map(at) });
export const memberNode = (ref: number, xy: Xy, role = "") => ({ type: "node", ref, role, ...at(xy) });
export const memberRelation = (ref: number, role = "") => ({ type: "relation", ref, role });

export function relation(id: number, tags: Record<string, string>, members: unknown[]) {
  return { type: "relation", id, members, tags };
}

export const node = (id: number, tags: Record<string, string>, xy: Xy) => ({ type: "node", id, ...at(xy), tags });

/** A way/relation POI as output by `out tags center`. */
export const centered = (type: "way" | "relation", id: number, tags: Record<string, string>, xy: Xy) => ({
  type,
  id,
  center: at(xy),
  tags,
});

export function response(elements: unknown[], extra: Record<string, unknown> = {}) {
  return {
    version: 0.6,
    generator: "Overpass API (synthetic test fixture)",
    osm3s: {
      timestamp_osm_base: TIMESTAMP,
      copyright: "The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.",
    },
    elements,
    ...extra,
  };
}

/** Straight polyline from a to b with `n` intermediate vertices (for realistic lengths). */
export function straight(a: Xy, b: Xy, n = 3): Xy[] {
  const out: Xy[] = [];
  for (let i = 0; i <= n + 1; i++) {
    const t = i / (n + 1);
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}
