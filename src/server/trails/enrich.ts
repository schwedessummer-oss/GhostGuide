import "server-only";
import { createHash } from "node:crypto";
import {
  ACTIVITIES,
  TRAIL_FEATURES,
  type Activity,
  type Difficulty,
  type DifficultySource,
  type DogPolicy,
  type LngLat,
  type PoiCategory,
  type RouteType,
  type TrailFeature,
  type WheelchairAccess,
} from "@/domain/catalog";
import { haversineM } from "@/domain/geo";
import type { ElevationResult } from "@/server/geo/elevation";
import type { AdminArea } from "@/server/geo/geocode";
import { boundsOfLines, cleanLines, distancePointToLinesM, lengthWeightedCentroid, lineEndpoints, linesLengthM } from "@/server/geo/geodesy";
import { highestSacScale, worstTrailVisibility } from "@/server/trails/providers/osm/tags";
import { classifyDifficulty, estimateDurationMin, estimateOutAndBackMin, isFamilyFriendly, qualityScore } from "./estimate";
import { countryCodeOrUnknown, regionSlugFor, slugify } from "./slug";
import type { Line, NormalizedTrail, ProviderId } from "./types";

/**
 * Trail enrichment: everything derived at ingestion from a provider trail,
 * the outdoor POIs around it, a DEM elevation profile, administrative names
 * and the time zone. Pure and deterministic (the async inputs are fetched by
 * ingest.ts and passed in), so every rule here is unit-tested directly.
 *
 * Nothing is invented: a missing input yields null / false / "unknown",
 * never a guess. Distances are great-circle metres (src/server/geo/geodesy).
 *
 * TRAILHEAD (first rule that matches)
 *   1. "osm_trailhead": a mapped trailhead POI (highway=trailhead) within
 *      150 m of a route endpoint (the start or end of any line) — nearest wins;
 *   2. "parking": a public parking POI within 300 m of an endpoint; the
 *      trailhead point is the parking location;
 *   3. "route_start": the first vertex of the route.
 *
 * AMENITIES (POIs within ...)
 *   features            200 m of the route, one per TRAIL_FEATURES category
 *   has_parking         400 m of the trailhead
 *   has_toilets         500 m of the trailhead
 *   has_drinking_water  200 m of the route (mapped drinking water only; springs are not)
 *   has_camping         500 m of the route (campsites)
 */

export const TRAILHEAD_POI_RADIUS_M = 150;
export const TRAILHEAD_PARKING_RADIUS_M = 300;
export const FEATURE_RADIUS_M = 200;
export const PARKING_NEAR_TRAILHEAD_M = 400;
export const TOILETS_NEAR_TRAILHEAD_M = 500;
export const WATER_NEAR_ROUTE_M = 200;
export const CAMPING_NEAR_ROUTE_M = 500;
/**
 * POIs farther than this from the route cannot change any rule above: the
 * farthest reach is toilets 500 m from a parking trailhead that is itself
 * up to 300 m from an endpoint.
 */
export const POI_LOOKUP_RADIUS_M = TRAILHEAD_PARKING_RADIUS_M + TOILETS_NEAR_TRAILHEAD_M;
/** Outdoor POI categories that can influence enrichment (the POI lookup filter). */
export const ENRICHMENT_POI_CATEGORIES: readonly PoiCategory[] = [
  "trailhead",
  "parking",
  "toilets",
  "drinking_water",
  "campsite",
  ...TRAIL_FEATURES,
];

/** An outdoor POI near a trail (from this tile's response or already stored). */
export interface NearbyPoi {
  providerId: string;
  category: PoiCategory;
  lng: number;
  lat: number;
}

export type DerivedTrailheadSource = "osm_trailhead" | "parking" | "route_start";

export interface TrailheadChoice {
  point: LngLat;
  source: DerivedTrailheadSource;
  /** Provider id of the POI that defined the trailhead (null for route_start). */
  poiId: string | null;
}

export interface AmenityFlags {
  features: TrailFeature[];
  hasParking: boolean;
  hasToilets: boolean;
  hasDrinkingWater: boolean;
  hasCamping: boolean;
}

/** DEM elevation summary as stored on a trail (an estimate). */
export type ElevationSnapshot = Pick<ElevationResult, "profile" | "gainM" | "lossM" | "maxM" | "minM" | "source">;

/**
 * Trail attributes that can differ between the pieces of a merged trail
 * (everything a NormalizedTrail carries except identity and geometry).
 * Stored per piece in catalog_trail_parts.attrs (sourceUpdatedAt as ISO).
 */
export interface TrailAttributes {
  name: string;
  nameEn: string | null;
  sacScale: string | null;
  trailVisibility: string | null;
  surfaces: string[];
  activities: Activity[];
  description: string | null;
  dogPolicy: DogPolicy;
  wheelchair: WheelchairAccess;
  feeRequired: boolean | null;
  permitRequired: boolean | null;
  access: string | null;
  seasonality: string | null;
  operator: string | null;
  website: string | null;
  tags: Record<string, string>;
  sourceUpdatedAt: Date | null;
}

/** Everything written to public.catalog_trails for one trail (except id/slug allocation). */
export interface TrailRecord extends TrailAttributes {
  provider: ProviderId;
  providerId: string;
  /** Slug before any uniqueness suffix. */
  baseSlug: string;
  /** "xx" when unknown. */
  countryCode: string;
  regionName: string | null;
  /** "unknown" when unknown. */
  regionSlug: string;
  nearestPlace: string | null;
  timezone: string | null;
  centroid: LngLat;
  trailhead: LngLat;
  trailheadSource: DerivedTrailheadSource;
  /** Cleaned route geometry ([lng, lat] polylines). */
  lines: Line[];
  geomHash: string;
  distanceM: number;
  routeType: RouteType;
  elevationGainM: number | null;
  elevationLossM: number | null;
  maxElevationM: number | null;
  minElevationM: number | null;
  elevationProfile: [number, number][] | null;
  elevationSource: string | null;
  estimatedDurationMin: number;
  /** Out-and-back for linear routes, else one traversal (see migration 20261112002000). */
  hikeDurationMin: number;
  difficulty: Difficulty;
  difficultySource: DifficultySource | null;
  features: TrailFeature[];
  hasParking: boolean;
  hasToilets: boolean;
  hasDrinkingWater: boolean;
  hasCamping: boolean;
  familyFriendly: boolean;
  sourceName: string;
  sourceUrl: string | null;
  sourceLicense: string;
  qualityScore: number;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Length-weighted centroid of the valid geometry, or null when there is none. */
export function trailCentroid(lines: Line[]): LngLat | null {
  const clean = cleanLines(lines);
  return clean.length ? lengthWeightedCentroid(clean) : null;
}

/**
 * Fingerprint of a geometry (coordinates rounded to 1e-7°, OSM precision),
 * used to reuse a stored elevation profile when the geometry is unchanged.
 */
export function geometryHash(lines: Line[]): string {
  const canonical = cleanLines(lines).map((l) => l.map(([lng, lat]) => [Math.round(lng * 1e7), Math.round(lat * 1e7)]));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

const isValidPoi = (p: NearbyPoi) =>
  p !== null &&
  typeof p === "object" &&
  Number.isFinite(p.lng) &&
  Number.isFinite(p.lat) &&
  Math.abs(p.lat) <= 90 &&
  Math.abs(p.lng) <= 180;

/** Nearest POI of a category within `radiusM` of any of `targets` (ties: smaller provider id). */
function nearestTo(targets: readonly LngLat[], pois: readonly NearbyPoi[], category: PoiCategory, radiusM: number): { poi: NearbyPoi; d: number } | null {
  let best: { poi: NearbyPoi; d: number } | null = null;
  for (const poi of pois) {
    if (poi.category !== category || !isValidPoi(poi)) continue;
    let d = Infinity;
    for (const t of targets) d = Math.min(d, haversineM(t, poi));
    if (d > radiusM) continue;
    if (!best || d < best.d || (d === best.d && poi.providerId < best.poi.providerId)) best = { poi, d };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Trailhead and amenities
// ---------------------------------------------------------------------------

/** Trailhead per the rules in the module header; null when the geometry is empty. */
export function selectTrailhead(lines: Line[], pois: readonly NearbyPoi[]): TrailheadChoice | null {
  const clean = cleanLines(lines);
  if (clean.length === 0) return null;
  const ends = lineEndpoints(clean).flatMap((e) => [e.start, e.end]);
  const list = Array.isArray(pois) ? pois : [];

  const trailhead = nearestTo(ends, list, "trailhead", TRAILHEAD_POI_RADIUS_M);
  if (trailhead) return { point: { lng: trailhead.poi.lng, lat: trailhead.poi.lat }, source: "osm_trailhead", poiId: trailhead.poi.providerId };

  const parking = nearestTo(ends, list, "parking", TRAILHEAD_PARKING_RADIUS_M);
  if (parking) return { point: { lng: parking.poi.lng, lat: parking.poi.lat }, source: "parking", poiId: parking.poi.providerId };

  return { point: { lng: clean[0][0][0], lat: clean[0][0][1] }, source: "route_start", poiId: null };
}

/**
 * Orient a linear route so it starts at its trailhead. Providers draw lines in
 * any direction (OSM often maps a summit trail top-down); hikers start at the
 * trailhead, so "gain" and the one-way duration must be measured from there.
 * Reverses line order and vertex order when the trailhead is closer to the
 * route's last vertex than to its first; otherwise returns the lines as is.
 */
export function orientFromTrailhead(lines: Line[], trailhead: LngLat | null): Line[] {
  const clean = cleanLines(lines);
  if (!trailhead || clean.length === 0) return clean;
  const first = clean[0][0];
  const lastLine = clean[clean.length - 1];
  const last = lastLine[lastLine.length - 1];
  const dFirst = haversineM(trailhead, { lng: first[0], lat: first[1] });
  const dLast = haversineM(trailhead, { lng: last[0], lat: last[1] });
  if (!(dLast < dFirst)) return clean;
  return clean
    .slice()
    .reverse()
    .map((line) => line.slice().reverse());
}

/**
 * Route-relative amenity checks. A cheap bounding-box test (expanded by the
 * radius) rejects far POIs before the exact point-to-line distance.
 */
export function deriveAmenities(lines: Line[], trailhead: LngLat | null, pois: readonly NearbyPoi[]): AmenityFlags {
  const clean = cleanLines(lines);
  const none: AmenityFlags = { features: [], hasParking: false, hasToilets: false, hasDrinkingWater: false, hasCamping: false };
  if (clean.length === 0) return none;
  const list = (Array.isArray(pois) ? pois : []).filter(isValidPoi);

  const [w, s, e, n] = boundsOfLines(clean);
  const maxLat = Math.max(Math.abs(s), Math.abs(n));
  const degLat = (m: number) => m / 111_320;
  const degLng = (m: number) => m / (111_320 * Math.max(0.01, Math.cos((Math.min(89.9, maxLat) * Math.PI) / 180)));
  const nearRoute = (p: NearbyPoi, radiusM: number) => {
    if (p.lat < s - degLat(radiusM) || p.lat > n + degLat(radiusM) || p.lng < w - degLng(radiusM) || p.lng > e + degLng(radiusM)) return false;
    return distancePointToLinesM(p, clean) <= radiusM;
  };
  const nearTrailhead = (p: NearbyPoi, radiusM: number) => trailhead !== null && haversineM(trailhead, p) <= radiusM;

  const found = new Set<TrailFeature>();
  for (const p of list) {
    if ((TRAIL_FEATURES as readonly string[]).includes(p.category) && !found.has(p.category as TrailFeature) && nearRoute(p, FEATURE_RADIUS_M)) {
      found.add(p.category as TrailFeature);
    }
  }
  return {
    features: TRAIL_FEATURES.filter((f) => found.has(f)),
    hasParking: list.some((p) => p.category === "parking" && nearTrailhead(p, PARKING_NEAR_TRAILHEAD_M)),
    hasToilets: list.some((p) => p.category === "toilets" && nearTrailhead(p, TOILETS_NEAR_TRAILHEAD_M)),
    hasDrinkingWater: list.some((p) => p.category === "drinking_water" && nearRoute(p, WATER_NEAR_ROUTE_M)),
    hasCamping: list.some((p) => p.category === "campsite" && nearRoute(p, CAMPING_NEAR_ROUTE_M)),
  };
}

// ---------------------------------------------------------------------------
// Attributes of merged pieces
// ---------------------------------------------------------------------------

/** The attributes of a normalized trail (identity and geometry stripped). */
export function attributesOf(t: NormalizedTrail): TrailAttributes {
  return {
    name: t.name,
    nameEn: t.nameEn,
    sacScale: t.sacScale,
    trailVisibility: t.trailVisibility,
    surfaces: [...t.surfaces],
    activities: [...t.activities],
    description: t.description,
    dogPolicy: t.dogPolicy,
    wheelchair: t.wheelchair,
    feeRequired: t.feeRequired,
    permitRequired: t.permitRequired,
    access: t.access,
    seasonality: t.seasonality,
    operator: t.operator,
    website: t.website,
    tags: { ...t.tags },
    sourceUpdatedAt: t.sourceUpdatedAt,
  };
}

/** JSON form stored in catalog_trail_parts.attrs. */
export function attributesToJson(a: TrailAttributes): Record<string, unknown> {
  return { ...a, sourceUpdatedAt: a.sourceUpdatedAt ? a.sourceUpdatedAt.toISOString() : null };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const oneOf = <T extends string>(values: readonly T[], v: unknown, fallback: T): T =>
  typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : fallback;

/** Parse stored part attributes defensively; null when unusable (no name). */
export function attributesFromJson(raw: unknown): TrailAttributes | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const name = str(o.name);
  if (!name) return null;
  const updated = typeof o.sourceUpdatedAt === "string" ? new Date(o.sourceUpdatedAt) : null;
  const tags: Record<string, string> = {};
  if (o.tags && typeof o.tags === "object" && !Array.isArray(o.tags)) {
    for (const [k, v] of Object.entries(o.tags as Record<string, unknown>)) if (typeof v === "string") tags[k] = v;
  }
  return {
    name,
    nameEn: str(o.nameEn),
    sacScale: str(o.sacScale),
    trailVisibility: str(o.trailVisibility),
    surfaces: strList(o.surfaces),
    activities: strList(o.activities).filter((a): a is Activity => (ACTIVITIES as readonly string[]).includes(a)),
    description: str(o.description),
    dogPolicy: oneOf<DogPolicy>(["allowed", "leashed", "not_allowed", "unknown"], o.dogPolicy, "unknown"),
    wheelchair: oneOf<WheelchairAccess>(["yes", "limited", "no", "unknown"], o.wheelchair, "unknown"),
    feeRequired: boolOrNull(o.feeRequired),
    permitRequired: boolOrNull(o.permitRequired),
    access: str(o.access),
    seasonality: str(o.seasonality),
    operator: str(o.operator),
    website: str(o.website),
    tags,
    sourceUpdatedAt: updated && !Number.isNaN(updated.getTime()) ? updated : null,
  };
}

const firstKnown = <T>(values: readonly T[], unknown: T): T => values.find((v) => v !== unknown) ?? unknown;
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/**
 * Attributes of a trail merged from several pieces. `primary` (the piece
 * just fetched) wins wherever a single value is needed; otherwise:
 * the hardest sac_scale and the worst trail_visibility of any piece (the
 * whole trail is at least that demanding), the union of surfaces and
 * activities, a fee/permit requirement if any piece states one (an explicit
 * "no fee" only when no piece says yes), the most recent source timestamp,
 * and for text fields the first value any piece has. Provenance tags of the
 * primary piece win per key.
 */
export function combineAttributes(primary: TrailAttributes, others: readonly TrailAttributes[]): TrailAttributes {
  const all = [primary, ...others];
  const fee = all.some((a) => a.feeRequired === true) ? true : all.some((a) => a.feeRequired === false) ? false : null;
  const permit = all.some((a) => a.permitRequired === true) ? true : all.some((a) => a.permitRequired === false) ? false : null;
  const timestamps = all.map((a) => a.sourceUpdatedAt?.getTime()).filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  const tags: Record<string, string> = {};
  for (const a of [...others].reverse()) Object.assign(tags, a.tags);
  Object.assign(tags, primary.tags);
  return {
    name: primary.name,
    nameEn: primary.nameEn ?? firstKnown(others.map((a) => a.nameEn), null),
    sacScale: highestSacScale(all.map((a): Record<string, string> => (a.sacScale ? { sac_scale: a.sacScale } : {}))),
    trailVisibility: worstTrailVisibility(all.map((a): Record<string, string> => (a.trailVisibility ? { trail_visibility: a.trailVisibility } : {}))),
    surfaces: unique(all.flatMap((a) => a.surfaces)),
    activities: unique(all.flatMap((a) => a.activities)),
    description: firstKnown(all.map((a) => a.description), null),
    dogPolicy: firstKnown<DogPolicy>(all.map((a) => a.dogPolicy), "unknown"),
    wheelchair: firstKnown<WheelchairAccess>(all.map((a) => a.wheelchair), "unknown"),
    feeRequired: fee,
    permitRequired: permit,
    access: firstKnown(all.map((a) => a.access), null),
    seasonality: firstKnown(all.map((a) => a.seasonality), null),
    operator: firstKnown(all.map((a) => a.operator), null),
    website: firstKnown(all.map((a) => a.website), null),
    tags,
    sourceUpdatedAt: timestamps.length ? new Date(Math.max(...timestamps)) : null,
  };
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

export interface TrailRecordInput {
  provider: ProviderId;
  providerId: string;
  attributes: TrailAttributes;
  lines: Line[];
  routeType: RouteType;
  sourceName: string;
  sourceUrl: string | null;
  sourceLicense: string;
  /** DEM elevation for exactly these lines, or null when unavailable. */
  elevation: ElevationSnapshot | null;
  /** Outdoor POIs near the route (see POI_LOOKUP_RADIUS_M). */
  pois: readonly NearbyPoi[];
  /** Reverse-geocoded names at the centroid, or null when unavailable. */
  admin: AdminArea | null;
  timezone: string | null;
}

const finiteOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
const nonNegativeOrNull = (v: unknown): number | null => {
  const n = finiteOrNull(v);
  return n !== null && n >= 0 ? n : null;
};

function validProfile(profile: unknown): [number, number][] | null {
  if (!Array.isArray(profile) || profile.length < 2) return null;
  const out: [number, number][] = [];
  for (const p of profile) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    out.push([p[0], p[1]]);
  }
  return out;
}

const cleanText = (v: string | null | undefined, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? Array.from(s).slice(0, max).join("") : null;
};

/**
 * Map a provider trail plus its context to the stored record. Returns null
 * when the trail cannot be stored honestly: no usable geometry (length
 * under 1 m) or no name.
 */
export function buildTrailRecord(input: TrailRecordInput): TrailRecord | null {
  const a = input.attributes;
  const name = cleanText(a?.name, 300);
  if (!name) return null;
  const lines = cleanLines(input.lines);
  if (lines.length === 0) return null;
  const distanceM = Math.round(linesLengthM(lines));
  if (!(distanceM >= 1)) return null;

  const centroid = lengthWeightedCentroid(lines);
  const pois = Array.isArray(input.pois) ? input.pois : [];
  const trailhead = selectTrailhead(lines, pois)!;
  const amenities = deriveAmenities(lines, trailhead.point, pois);

  const elevation = input.elevation;
  const profile = elevation ? validProfile(elevation.profile) : null;
  const hasElevation = elevation !== null && profile !== null;
  const gainM = hasElevation ? nonNegativeOrNull(elevation.gainM) : null;
  const lossM = hasElevation ? nonNegativeOrNull(elevation.lossM) : null;

  const routeType = input.routeType;
  const sacScale = a.sacScale ?? null;
  const classified = classifyDifficulty({ distanceM, gainM, lossM, routeType, sacScale });
  const difficultySource = classified.difficulty === "unknown" ? null : classified.source;
  const familyFriendly = isFamilyFriendly({ difficulty: classified.difficulty, sacScale, distanceM, gainM, lossM, routeType });

  const regionName = cleanText(input.admin?.regionName ?? null, 200);
  const nameEn = cleanText(a.nameEn, 300);
  const description = a.description ?? null;
  const website = a.website ?? null;
  const operator = a.operator ?? null;

  return {
    provider: input.provider,
    providerId: input.providerId,
    name,
    nameEn,
    baseSlug: slugify(name, nameEn, input.providerId),
    countryCode: countryCodeOrUnknown(input.admin?.countryCode),
    regionName,
    regionSlug: regionSlugFor(regionName),
    nearestPlace: cleanText(input.admin?.nearestPlace ?? null, 200),
    timezone: cleanText(input.timezone, 64),
    centroid,
    trailhead: trailhead.point,
    trailheadSource: trailhead.source,
    lines,
    geomHash: geometryHash(lines),
    distanceM,
    routeType,
    elevationGainM: gainM,
    elevationLossM: lossM,
    maxElevationM: hasElevation ? finiteOrNull(elevation.maxM) : null,
    minElevationM: hasElevation ? finiteOrNull(elevation.minM) : null,
    elevationProfile: profile,
    elevationSource: hasElevation ? cleanText(elevation.source, 300) : null,
    // One traversal of the mapped geometry (an estimate; labelled in the UI).
    estimatedDurationMin: estimateDurationMin({ distanceM, profile }),
    hikeDurationMin: routeType === "linear" ? estimateOutAndBackMin(distanceM, profile) : estimateDurationMin({ distanceM, profile }),
    difficulty: classified.difficulty,
    difficultySource,
    features: amenities.features,
    hasParking: amenities.hasParking,
    hasToilets: amenities.hasToilets,
    hasDrinkingWater: amenities.hasDrinkingWater,
    hasCamping: amenities.hasCamping,
    familyFriendly,
    sacScale,
    trailVisibility: a.trailVisibility ?? null,
    surfaces: unique(strList(a.surfaces)),
    activities: unique(a.activities ?? []),
    description,
    dogPolicy: a.dogPolicy ?? "unknown",
    wheelchair: a.wheelchair ?? "unknown",
    feeRequired: a.feeRequired ?? null,
    permitRequired: a.permitRequired ?? null,
    access: a.access ?? null,
    seasonality: a.seasonality ?? null,
    operator,
    website,
    tags: { ...(a.tags ?? {}) },
    sourceName: input.sourceName,
    sourceUrl: input.sourceUrl,
    sourceLicense: input.sourceLicense,
    sourceUpdatedAt: a.sourceUpdatedAt ?? null,
    qualityScore: qualityScore({
      name,
      distanceM,
      elevationGainM: gainM,
      sacScale,
      surfaces: a.surfaces,
      trailheadSource: trailhead.source,
      description,
      website,
      operator,
      trailVisibility: a.trailVisibility,
      routeType,
      dogPolicy: a.dogPolicy,
      feeRequired: a.feeRequired,
    }),
  };
}
