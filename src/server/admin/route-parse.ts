/**
 * Route-file parsing for operator uploads (pure, no I/O).
 *
 * Accepted inputs (untrusted):
 *  - GeoJSON: a LineString geometry, a Feature whose geometry is a
 *    LineString, or a FeatureCollection containing exactly ONE LineString
 *    feature (other non-line features, e.g. Point markers, are ignored).
 *  - GPX: track points or route points (see ./gpx.ts).
 * The result is a candidate LineString; it is validated afterwards with
 * validateLineString (distance tolerance, vertex gaps, ranges).
 */
import type { LineStringGeometry, Position } from "@/domain/geo";
import { MAX_ROUTE_FILE_BYTES, parseGpx } from "./gpx";

export type RouteFormat = "geojson" | "gpx";

export type ExtractResult = { ok: true; geometry: LineStringGeometry; notes: string[] } | { ok: false; errors: string[] };

function asLine(geometry: unknown): LineStringGeometry | null {
  if (!geometry || typeof geometry !== "object") return null;
  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (g.type !== "LineString" || !Array.isArray(g.coordinates)) return null;
  // Copy only the coordinate arrays; validation happens later.
  return { type: "LineString", coordinates: g.coordinates as Position[] };
}

/** Extract the single LineString from a parsed GeoJSON object. */
export function extractLineStringFromGeoJson(input: unknown): ExtractResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["GeoJSON must be an object."] };
  const obj = input as { type?: unknown; geometry?: unknown; features?: unknown };
  switch (obj.type) {
    case "LineString": {
      const line = asLine(obj);
      return line ? { ok: true, geometry: line, notes: [] } : { ok: false, errors: ["LineString has no coordinates array."] };
    }
    case "Feature": {
      const line = asLine(obj.geometry);
      if (!line) {
        const t = (obj.geometry as { type?: unknown } | null)?.type;
        return { ok: false, errors: [`Feature geometry must be a LineString (found ${typeof t === "string" ? t : "none"}).`] };
      }
      return { ok: true, geometry: line, notes: [] };
    }
    case "FeatureCollection": {
      if (!Array.isArray(obj.features)) return { ok: false, errors: ["FeatureCollection has no features array."] };
      const lines: LineStringGeometry[] = [];
      let multi = 0;
      for (const f of obj.features) {
        const geom = (f as { geometry?: unknown } | null)?.geometry as { type?: unknown } | undefined;
        if (geom?.type === "MultiLineString") multi++;
        const line = asLine(geom);
        if (line) lines.push(line);
      }
      if (lines.length === 1) {
        const ignored = obj.features.length - 1;
        return { ok: true, geometry: lines[0], notes: ignored ? [`Ignored ${ignored} non-route feature(s) in the collection.`] : [] };
      }
      if (lines.length === 0) {
        return {
          ok: false,
          errors: [multi ? "Found a MultiLineString; merge it into a single LineString first." : "FeatureCollection contains no LineString feature."],
        };
      }
      return { ok: false, errors: [`FeatureCollection contains ${lines.length} LineString features; upload exactly one route line.`] };
    }
    case "MultiLineString":
      return { ok: false, errors: ["MultiLineString is not supported; merge it into a single LineString first."] };
    default:
      return { ok: false, errors: [`Unsupported GeoJSON type: ${typeof obj.type === "string" ? obj.type : "missing"}.`] };
  }
}

export function detectRouteFormat(filename: string): RouteFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".gpx")) return "gpx";
  if (lower.endsWith(".geojson") || lower.endsWith(".json")) return "geojson";
  return null;
}

/** Decode + parse an uploaded route file into a candidate LineString. */
export function parseRouteFile(bytes: Uint8Array, format: RouteFormat): ExtractResult {
  if (bytes.byteLength === 0) return { ok: false, errors: ["The file is empty."] };
  if (bytes.byteLength > MAX_ROUTE_FILE_BYTES) return { ok: false, errors: ["The file is larger than 2 MB."] };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, errors: ["The file is not valid UTF-8 text."] };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (format === "gpx") {
    const r = parseGpx(text);
    if (!r.ok) return r;
    const notes = [`Read ${r.coordinates.length} ${r.pointKind === "trkpt" ? "track" : "route"} points.`];
    if (!r.hasElevation) notes.push("No elevation in the file (or not on every point).");
    return { ok: true, geometry: { type: "LineString", coordinates: r.coordinates }, notes };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["The file is not valid JSON."] };
  }
  return extractLineStringFromGeoJson(parsed);
}
