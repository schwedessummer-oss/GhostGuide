/**
 * Small, safe GPX reader for operator route uploads (untrusted input).
 *
 * Pure (no I/O). Deliberately NOT a general XML parser:
 *  - Documents containing a DOCTYPE or ENTITY declaration are rejected
 *    outright (no entity expansion / XXE surface at all).
 *  - Track points (`trkpt`) are read in document order; when a file has no
 *    track points, route points (`rtept`) are used instead. Only the `lat`
 *    and `lon` attributes and an optional `<ele>` child are read.
 *  - Scanning is linear (indexOf-based), so malformed or hostile input
 *    cannot trigger catastrophic regex backtracking.
 */
import type { Position } from "@/domain/geo";

export const MAX_ROUTE_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_ROUTE_POINTS = 20_000;

export type GpxParseResult =
  | { ok: true; coordinates: Position[]; pointKind: "trkpt" | "rtept"; hasElevation: boolean; name: string | null }
  | { ok: false; errors: string[] };

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function readAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = re.exec(attrs);
  return m ? (m[1] ?? m[2] ?? "").trim() : null;
}

function parseNumber(s: string | null): number | null {
  if (s === null || !NUMBER.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const nestedOpen = (tag: string) => new RegExp(`<${tag}[\\s/>]`);

interface RawPoint {
  lat: number;
  lon: number;
  ele: number | null;
}

function extractPoints(xml: string, tag: "trkpt" | "rtept"): { points: RawPoint[]; errors: string[] } {
  const open = `<${tag}`;
  const close = `</${tag}`;
  const points: RawPoint[] = [];
  const errors: string[] = [];
  let i = 0;
  while (errors.length === 0) {
    const start = xml.indexOf(open, i);
    if (start < 0) break;
    const after = xml[start + open.length] ?? "";
    if (!/[\s/>]/.test(after)) {
      // e.g. <trkptExtension> — not a point element
      i = start + open.length;
      continue;
    }
    const n = points.length + 1;
    const tagEnd = xml.indexOf(">", start);
    if (tagEnd < 0) {
      errors.push(`Point ${n} (<${tag}>) is not closed.`);
      break;
    }
    const attrs = xml.slice(start + open.length, tagEnd);
    if (attrs.includes("<")) {
      errors.push(`Point ${n} (<${tag}>) is malformed.`);
      break;
    }
    let body = "";
    if (attrs.trimEnd().endsWith("/")) {
      i = tagEnd + 1;
    } else {
      const closeIdx = xml.indexOf(close, tagEnd);
      if (closeIdx < 0) {
        errors.push(`Point ${n} (<${tag}>) has no closing tag.`);
        break;
      }
      body = xml.slice(tagEnd + 1, closeIdx);
      if (nestedOpen(tag).test(body)) {
        errors.push(`Point ${n} (<${tag}>) has no closing tag before the next point.`);
        break;
      }
      const closeEnd = xml.indexOf(">", closeIdx);
      if (closeEnd < 0) {
        errors.push(`Point ${n} (<${tag}>) closing tag is malformed.`);
        break;
      }
      i = closeEnd + 1;
    }
    const lat = parseNumber(readAttr(attrs, "lat"));
    const lon = parseNumber(readAttr(attrs, "lon"));
    if (lat === null || lon === null) {
      errors.push(`Point ${n} is missing a numeric lat/lon attribute.`);
      break;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      errors.push(`Point ${n} has coordinates out of range.`);
      break;
    }
    const eleMatch = /<ele>\s*([^<]*?)\s*<\/ele>/.exec(body);
    const ele = eleMatch ? parseNumber(eleMatch[1]) : null;
    if (eleMatch && ele === null) {
      errors.push(`Point ${n} has a non-numeric elevation.`);
      break;
    }
    points.push({ lat, lon, ele });
    if (points.length > MAX_ROUTE_POINTS) {
      errors.push(`Too many points (max ${MAX_ROUTE_POINTS}).`);
      break;
    }
  }
  return { points, errors };
}

export function parseGpx(xml: string): GpxParseResult {
  if (typeof xml !== "string" || xml.trim() === "") return { ok: false, errors: ["The file is empty."] };
  if (xml.length > MAX_ROUTE_FILE_BYTES) return { ok: false, errors: ["The file is larger than 2 MB."] };
  if (/<!DOCTYPE/i.test(xml)) return { ok: false, errors: ["GPX files with a DOCTYPE declaration are not accepted."] };
  if (/<!ENTITY/i.test(xml)) return { ok: false, errors: ["GPX files with ENTITY declarations are not accepted."] };
  if (!/<gpx[\s>]/.test(xml)) return { ok: false, errors: ["Not a GPX document (no <gpx> element)."] };
  if (!/<\/gpx\s*>/.test(xml)) return { ok: false, errors: ["The GPX document is truncated (no closing </gpx>)."] };

  let pointKind: "trkpt" | "rtept" = "trkpt";
  let { points, errors } = extractPoints(xml, "trkpt");
  if (!errors.length && points.length === 0) {
    pointKind = "rtept";
    ({ points, errors } = extractPoints(xml, "rtept"));
  }
  if (errors.length) return { ok: false, errors };
  if (points.length < 2) return { ok: false, errors: ["The GPX file needs at least 2 track or route points."] };

  const hasElevation = points.every((p) => p.ele !== null);
  const coordinates: Position[] = points.map((p) => (hasElevation ? [p.lon, p.lat, p.ele as number] : [p.lon, p.lat]));
  const nameMatch = /<name>\s*([^<]{1,200}?)\s*<\/name>/.exec(xml);
  return { ok: true, coordinates, pointKind, hasElevation, name: nameMatch ? nameMatch[1] : null };
}
