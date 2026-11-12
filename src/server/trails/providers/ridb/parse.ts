import "server-only";
import type { Bbox, OutdoorPoiCategory } from "@/domain/catalog";
import type { NormalizedPoi } from "@/server/trails/types";

/**
 * Recreation.gov RIDB facilities → normalized outdoor POIs.
 *
 * Input: the JSON body of GET /api/v1/facilities (OpenAPI spec at
 * https://ridb.recreation.gov/shared/swagger/ridb.yaml, rendered at
 * https://ridb.recreation.gov/docs):
 *
 *   { RECDATA: Facility[], METADATA: { RESULTS: { CURRENT_COUNT, TOTAL_COUNT },
 *                                      PARAMETERS: { QUERY, LIMIT, OFFSET } } }
 *
 * Only facility types that map confidently onto the catalog's outdoor POI
 * vocabulary are kept (FACILITY_TYPE_CATEGORIES); generic "Facility",
 * permits, tickets, tours and anything else are skipped. Disabled facilities
 * (Enabled = false) and facilities without usable coordinates (missing, out
 * of range, or the 0,0 placeholder) are skipped.
 *
 * Kept per POI: name (HTML stripped), coordinates, phone, a reservation URL
 * when it is a valid http(s) URL, and provenance tags (FacilityID,
 * FacilityTypeDescription, Reservable, FacilityUseFeeDescription — stripped
 * and truncated — and LastUpdatedDate). Long descriptions, directions,
 * e-mail addresses and accessibility text are NOT stored: POIs do not need
 * them. Values are never invented: a field RIDB does not supply stays null.
 *
 * A response without a RECDATA array is an error (RidbResponseError), never
 * "no facilities": treating it as empty would delete the tile's stored POIs.
 */

export const RIDB_SOURCE_NAME = "Recreation.gov (RIDB)";
export const RIDB_SOURCE_LICENSE = "US Government work (public domain)";
/** Canonical RIDB facility URL (provenance; independent of RIDB_URL, which may point at a mirror). */
export const RIDB_FACILITY_URL_BASE = "https://ridb.recreation.gov/api/v1/facilities/";
/** Public Recreation.gov page of a reservable campground. */
export const RECREATION_GOV_CAMPGROUND_URL_BASE = "https://www.recreation.gov/camping/campgrounds/";
export const MAX_NAME_CHARS = 300;
export const MAX_FEE_DESCRIPTION_CHARS = 200;
const MAX_PHONE_CHARS = 40;
const MAX_URL_CHARS = 500;

/**
 * FacilityTypeDescription → catalog category. Keys are normalized (lower
 * case, single spaces). The RIDB spec does not enumerate the values; this
 * table lists the ones that map without guessing. Everything else is skipped.
 */
export const FACILITY_TYPE_CATEGORIES: Readonly<Record<string, OutdoorPoiCategory>> = {
  campground: "campsite",
  trailhead: "trailhead",
  "visitor center": "information",
  "visitor centre": "information",
  information: "information",
  "information center": "information",
  "information site": "information",
  "ranger station": "ranger_station",
};

const normalizeType = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Category for a FacilityTypeDescription, or null when it cannot be mapped confidently. */
export function categoryForFacilityType(type: unknown): OutdoorPoiCategory | null {
  if (typeof type !== "string") return null;
  return FACILITY_TYPE_CATEGORIES[normalizeType(type)] ?? null;
}

export class RidbResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RidbResponseError";
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  deg: "°",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return " ";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** Plain text from an HTML fragment: tags (and script/style content) removed, entities decoded, whitespace collapsed. */
export function stripHtml(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  const noBlocks = value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const noTags = noBlocks.replace(/<\/?[a-z!][^>]*>/gi, " ").replace(/</g, " ");
  return decodeEntities(noTags)
    // Control characters (except whitespace, collapsed below) never belong in a label.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** At most `max` characters, cut at a word boundary when possible, with "…" when cut. */
export function truncateText(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const cut = chars.slice(0, Math.max(1, max - 1)).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

const FACILITY_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function facilityId(v: unknown): string | null {
  const s = typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : typeof v === "string" ? v.trim() : "";
  return FACILITY_ID_RE.test(s) ? s : null;
}

function finiteNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

/** [lng, lat] from FacilityLongitude/FacilityLatitude, else GEOJSON.COORDINATES; null when unusable. */
export function facilityCoordinates(rec: Record<string, unknown>): [number, number] | null {
  const valid = (lng: number | null, lat: number | null): lng is number =>
    lng !== null && lat !== null && Math.abs(lng) <= 180 && Math.abs(lat) <= 90 && !(lng === 0 && lat === 0);
  const lng = finiteNumber(rec.FacilityLongitude);
  const lat = finiteNumber(rec.FacilityLatitude);
  if (valid(lng, lat)) return [lng, lat as number];
  const geo = rec.GEOJSON;
  if (geo && typeof geo === "object") {
    const coords = (geo as { COORDINATES?: unknown }).COORDINATES;
    if (Array.isArray(coords) && coords.length >= 2) {
      const gLng = finiteNumber(coords[0]);
      const gLat = finiteNumber(coords[1]);
      if (valid(gLng, gLat)) return [gLng, gLat as number];
    }
  }
  return null;
}

function reservable(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

function phone(v: unknown): string | null {
  const s = stripHtml(v);
  return s && /\d/.test(s) && s.length <= MAX_PHONE_CHARS ? s : null;
}

function httpUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > MAX_URL_CHARS) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function lastUpdated(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) && s.length <= 40 ? s : null;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type SkipReason = "invalid" | "disabled" | "unmapped_type" | "no_coordinates" | "outside_area" | "duplicate";

/** Why a raw record would be skipped, or the POI it maps to. */
export function facilityToPoi(raw: unknown): { poi: NormalizedPoi } | { skip: Exclude<SkipReason, "outside_area" | "duplicate"> } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { skip: "invalid" };
  const rec = raw as Record<string, unknown>;
  const id = facilityId(rec.FacilityID);
  if (!id) return { skip: "invalid" };
  if (rec.Enabled === false || rec.Enabled === "false") return { skip: "disabled" };
  const category = categoryForFacilityType(rec.FacilityTypeDescription);
  if (!category) return { skip: "unmapped_type" };
  const coords = facilityCoordinates(rec);
  if (!coords) return { skip: "no_coordinates" };

  const isReservable = reservable(rec.Reservable);
  const name = truncateText(stripHtml(rec.FacilityName), MAX_NAME_CHARS) || null;
  const fee = truncateText(stripHtml(rec.FacilityUseFeeDescription), MAX_FEE_DESCRIPTION_CHARS);
  const updated = lastUpdated(rec.LastUpdatedDate);

  const tags: Record<string, string> = {
    FacilityID: id,
    FacilityTypeDescription: stripHtml(rec.FacilityTypeDescription),
  };
  if (isReservable !== null) tags.Reservable = String(isReservable);
  if (fee) tags.FacilityUseFeeDescription = fee;
  if (updated) tags.LastUpdatedDate = updated;

  const sourceUrl =
    category === "campsite" && isReservable === true
      ? `${RECREATION_GOV_CAMPGROUND_URL_BASE}${encodeURIComponent(id)}`
      : `${RIDB_FACILITY_URL_BASE}${encodeURIComponent(id)}`;

  return {
    poi: {
      provider: "ridb",
      providerId: `facility/${id}`,
      layer: "outdoor",
      category,
      name,
      nameEn: null,
      lng: coords[0],
      lat: coords[1],
      elevationM: null,
      tags,
      openingHours: null,
      phone: phone(rec.FacilityPhone),
      website: httpUrl(rec.FacilityReservationURL),
      sourceName: RIDB_SOURCE_NAME,
      sourceUrl,
      sourceLicense: RIDB_SOURCE_LICENSE,
    },
  };
}

const inBbox = (lng: number, lat: number, b: Bbox) => lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];

export interface FacilitiesResult {
  pois: NormalizedPoi[];
  skipped: Record<SkipReason, number>;
}

/**
 * Map raw facility records to POIs. With `bbox`, facilities outside it
 * (edges inclusive) are dropped: a radius search returns a circle around the
 * tile. Duplicate FacilityIDs keep their first occurrence.
 */
export function facilitiesToPois(records: readonly unknown[], bbox?: Bbox): FacilitiesResult {
  const skipped: Record<SkipReason, number> = { invalid: 0, disabled: 0, unmapped_type: 0, no_coordinates: 0, outside_area: 0, duplicate: 0 };
  const seen = new Set<string>();
  const pois: NormalizedPoi[] = [];
  for (const raw of records) {
    const r = facilityToPoi(raw);
    if ("skip" in r) {
      skipped[r.skip]++;
      continue;
    }
    if (bbox && !inBbox(r.poi.lng, r.poi.lat, bbox)) {
      skipped.outside_area++;
      continue;
    }
    if (seen.has(r.poi.providerId)) {
      skipped.duplicate++;
      continue;
    }
    seen.add(r.poi.providerId);
    pois.push(r.poi);
  }
  return { pois, skipped };
}

export interface FacilitiesPage {
  records: unknown[];
  /** METADATA.RESULTS.TOTAL_COUNT when present (matches for the whole query). */
  totalCount: number | null;
}

/** Validate one /facilities response body. Throws RidbResponseError when it is not a facilities page. */
export function parseFacilitiesPage(json: unknown): FacilitiesPage {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new RidbResponseError("RIDB returned a response that is not an object");
  const body = json as { RECDATA?: unknown; METADATA?: unknown };
  if (!Array.isArray(body.RECDATA)) throw new RidbResponseError("RIDB response has no RECDATA array");
  let totalCount: number | null = null;
  const results = body.METADATA && typeof body.METADATA === "object" ? (body.METADATA as { RESULTS?: unknown }).RESULTS : undefined;
  if (results && typeof results === "object") {
    const total = (results as { TOTAL_COUNT?: unknown }).TOTAL_COUNT;
    if (typeof total === "number" && Number.isSafeInteger(total) && total >= 0) totalCount = total;
  }
  return { records: body.RECDATA, totalCount };
}
