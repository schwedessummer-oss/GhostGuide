import "server-only";
import {
  DIFFICULTIES,
  DOG_POLICIES,
  OUTDOOR_POI_CATEGORIES,
  ROUTE_TYPES,
  SERVICE_POI_CATEGORIES,
  TRAIL_FEATURES,
  trailPath,
  type AttributionDto,
  type Bbox,
  type Difficulty,
  type DifficultySource,
  type DogPolicy,
  type LngLat,
  type PoiCategory,
  type PoiDto,
  type RouteType,
  type TrailDetailDto,
  type TrailFeature,
  type TrailSearchQuery,
  type TrailSummaryDto,
  type WheelchairAccess,
} from "@/domain/catalog";
import type { Fragment } from "postgres";
import { env } from "@/config/env";
import { withAnon, type Tx } from "@/server/db";
import { TILE_DEG, tilesForBbox } from "@/server/geo/tiles";

/**
 * Trail catalog read model: public search and detail reads over
 * public.catalog_trails / public.catalog_pois.
 *
 * Every read runs through withAnon, so the public RLS policy applies
 * (hidden = moderated trails are invisible); queries also say `not t.hidden`
 * explicitly as defence in depth. All user input reaches SQL as bound
 * parameters inside postgres.js fragments — never as SQL text.
 *
 * HIKE SEMANTICS (filters and sorts)
 * catalog_trails.distance_m / elevation_gain_m / estimated_duration_min
 * describe ONE traversal of the mapped geometry. For a linear route the hike
 * people actually do is out-and-back, so search filters and sorts use the
 * HIKE values (consistent with hikeEffortOf in ./estimate.ts):
 *   distance  linear: distance_m × 2                 otherwise: distance_m
 *   climb     linear: gain + loss (loss unknown → 0)  otherwise: gain
 *   duration  linear: estimated_duration_min × 2      otherwise: estimated_duration_min
 * DTOs still report the one-traversal values together with routeType so the
 * UI can say "2.4 km one way (4.8 km out and back)". Trails with an unknown
 * climb / duration never match a maxGainM / maxDurationMin filter: we cannot
 * claim they satisfy it.
 */

/** Detail geometry above this many vertices is simplified for page speed. */
export const DETAIL_SIMPLIFY_VERTEX_THRESHOLD = 20_000;
/**
 * Douglas–Peucker tolerance for oversize detail geometry: 5 m expressed in
 * degrees of latitude. East–west the effective tolerance is smaller (finer)
 * away from the equator, so the line never moves by more than ~5 m.
 */
export const DETAIL_SIMPLIFY_TOLERANCE_DEG = 5 / 111_320;
/** Outdoor POIs shown on a trail page: within 250 m of the route or 600 m of the trailhead. */
export const POI_ROUTE_RADIUS_M = 250;
export const POI_TRAILHEAD_RADIUS_M = 600;
export const POI_LIMIT = 150;
/** Most ids getTrailSummariesByIds looks up at once. */
export const MAX_SUMMARY_IDS = 500;
/**
 * Upper bound for one search query (defence in depth: searchWindow already
 * bounds the area a search scans), so a pathological request cannot hold a
 * connection: it fails (500) instead.
 */
export const SEARCH_STATEMENT_TIMEOUT_MS = 8_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const COUNTRY_RE = /^[a-z]{2}$/;

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

const PROVIDER_ATTRIBUTION: Record<string, AttributionDto> = {
  osm: { name: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright", license: "ODbL 1.0" },
  ridb: {
    name: "Recreation.gov (RIDB)",
    url: "https://ridb.recreation.gov",
    license: "US Government work (public domain)",
  },
};

/**
 * Attribution entries for catalog providers, de-duplicated, in input order.
 * Unknown provider ids are listed by id (no URL/license is invented for them).
 */
export function catalogAttribution(providers: string[]): AttributionDto[] {
  const out: AttributionDto[] = [];
  const seen = new Set<string>();
  for (const raw of providers) {
    const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(PROVIDER_ATTRIBUTION[id] ? { ...PROVIDER_ATTRIBUTION[id] } : { name: id, url: null, license: null });
  }
  return out;
}

/** Attribution for a DEM elevation source label (as written by src/server/geo/elevation.ts). */
export function elevationAttribution(source: string | null): AttributionDto | null {
  if (!source) return null;
  if (/terrain tiles/i.test(source)) {
    // AWS Terrain Tiles combine several DEMs; their attribution document lists them.
    return {
      name: `Elevation: ${source}`,
      url: "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
      license: null,
    };
  }
  return { name: `Elevation: ${source}`, url: null, license: null };
}

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

/** Columns selected by SUMMARY_COLUMNS (camelCased by the db layer). */
export interface TrailSummaryRow {
  id: string;
  name: string;
  nameEn: string | null;
  slug: string;
  countryCode: string;
  regionSlug: string;
  regionName: string | null;
  nearestPlace: string | null;
  centroidLng: number;
  centroidLat: number;
  trailheadLng: number | null;
  trailheadLat: number | null;
  distanceM: number;
  routeType: string;
  elevationGainM: number | null;
  estimatedDurationMin: number | null;
  /** Stored hike total (migration 20261112002000); absent on rows from older queries/tests. */
  hikeDurationMin?: number | null;
  hikeLossM?: number | null;
  difficulty: string;
  difficultySource: string | null;
  features: string[] | null;
  dogPolicy: string;
  feeRequired: boolean | null;
  permitRequired: boolean | null;
  hasParking: boolean;
  hasToilets: boolean;
  hasCamping: boolean;
  familyFriendly: boolean;
  provider: string;
  sourceName: string;
  lastSyncedAt: Date | string;
}

export interface TrailDetailRow extends TrailSummaryRow {
  timezone: string | null;
  /** ST_AsGeoJSON text of the (possibly simplified) geometry. */
  geometryJson: string;
  vertexCount: number;
  bboxWest: number;
  bboxSouth: number;
  bboxEast: number;
  bboxNorth: number;
  trailheadSource: string | null;
  elevationLossM: number | null;
  maxElevationM: number | null;
  minElevationM: number | null;
  elevationProfile: unknown;
  elevationSource: string | null;
  sacScale: string | null;
  trailVisibility: string | null;
  surfaces: string[] | null;
  activities: string[] | null;
  description: string | null;
  wheelchair: string;
  access: string | null;
  seasonality: string | null;
  operator: string | null;
  website: string | null;
  hasDrinkingWater: boolean;
  sourceUrl: string | null;
  sourceLicense: string;
  sourceUpdatedAt: Date | string | null;
}

export interface PoiRow {
  id: string;
  category: string;
  name: string | null;
  lng: number;
  lat: number;
  distanceM: number | null;
  elevationM: number | null;
  openingHours: string | null;
  website: string | null;
  phone: string | null;
  sourceName: string;
  provider: string;
}

const oneOf = <T extends string>(values: readonly T[], v: unknown, fallback: T): T =>
  typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : fallback;
const finiteOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
const iso = (v: Date | string | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const DIFFICULTY_SOURCES: readonly DifficultySource[] = ["osm_sac_scale", "estimated", "official"];
const WHEELCHAIR: readonly WheelchairAccess[] = ["yes", "limited", "no", "unknown"];
const TRAILHEAD_SOURCES = ["osm_trailhead", "parking", "route_start", "official"] as const;
const POI_CATEGORIES: readonly PoiCategory[] = [...OUTDOOR_POI_CATEGORIES, ...SERVICE_POI_CATEGORIES];

function point(lng: unknown, lat: unknown): LngLat | null {
  const x = finiteOrNull(lng);
  const y = finiteOrNull(lat);
  return x === null || y === null ? null : { lng: x, lat: y };
}

/** DB row → public summary DTO (unknown vocabulary values become "unknown"/null). */
/**
 * The hike as usually walked (out-and-back for linear routes), using the same
 * rules as the search filters (module header) and the stored ingestion estimate.
 */
export function hikeTotals(row: TrailSummaryRow): Pick<TrailSummaryDto, "hikeDistanceM" | "hikeGainM" | "hikeDurationMin"> {
  const linear = row.routeType === "linear";
  const gain = finiteOrNull(row.elevationGainM);
  const loss = finiteOrNull(row.hikeLossM ?? null);
  const oneWay = finiteOrNull(row.estimatedDurationMin);
  return {
    hikeDistanceM: linear ? row.distanceM * 2 : row.distanceM,
    hikeGainM: gain === null ? null : linear ? gain + (loss ?? 0) : gain,
    hikeDurationMin: finiteOrNull(row.hikeDurationMin ?? null) ?? (oneWay === null ? null : linear ? oneWay * 2 : oneWay),
  };
}

export function toSummaryDto(row: TrailSummaryRow): TrailSummaryDto {
  return {
    id: row.id,
    path: trailPath({ countryCode: row.countryCode, regionSlug: row.regionSlug, slug: row.slug }),
    name: row.name,
    nameEn: row.nameEn ?? null,
    countryCode: row.countryCode,
    regionName: row.regionName ?? null,
    nearestPlace: row.nearestPlace ?? null,
    // centroid and last_synced_at are NOT NULL columns.
    centroid: { lng: row.centroidLng, lat: row.centroidLat },
    trailhead: point(row.trailheadLng, row.trailheadLat),
    distanceM: row.distanceM,
    routeType: oneOf<RouteType>(ROUTE_TYPES, row.routeType, "unknown"),
    elevationGainM: finiteOrNull(row.elevationGainM),
    estimatedDurationMin: finiteOrNull(row.estimatedDurationMin),
    ...hikeTotals(row),
    difficulty: oneOf<Difficulty>(DIFFICULTIES, row.difficulty, "unknown"),
    difficultySource:
      typeof row.difficultySource === "string" && DIFFICULTY_SOURCES.includes(row.difficultySource as DifficultySource)
        ? (row.difficultySource as DifficultySource)
        : null,
    features: stringList(row.features).filter((f): f is TrailFeature => (TRAIL_FEATURES as readonly string[]).includes(f)),
    dogPolicy: oneOf<DogPolicy>(DOG_POLICIES, row.dogPolicy, "unknown"),
    feeRequired: row.feeRequired ?? null,
    permitRequired: row.permitRequired ?? null,
    hasParking: row.hasParking === true,
    hasToilets: row.hasToilets === true,
    hasCamping: row.hasCamping === true,
    familyFriendly: row.familyFriendly === true,
    provider: row.provider,
    sourceName: row.sourceName,
    lastSyncedAt: iso(row.lastSyncedAt) ?? String(row.lastSyncedAt),
  };
}

/** Parse ST_AsGeoJSON output into a 2D MultiLineString; empty on anything unexpected. */
export function parseGeometry(json: string): TrailDetailDto["geometry"] {
  const empty: TrailDetailDto["geometry"] = { type: "MultiLineString", coordinates: [] };
  let g: unknown;
  try {
    g = JSON.parse(json);
  } catch {
    return empty;
  }
  if (typeof g !== "object" || g === null) return empty;
  const { type, coordinates } = g as { type?: unknown; coordinates?: unknown };
  const lines: unknown[] = type === "MultiLineString" && Array.isArray(coordinates) ? coordinates : type === "LineString" ? [coordinates] : [];
  const out: [number, number][][] = [];
  for (const line of lines) {
    if (!Array.isArray(line)) continue;
    const pts: [number, number][] = [];
    for (const c of line) {
      if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number" && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
        pts.push([c[0], c[1]]);
      }
    }
    if (pts.length >= 2) out.push(pts);
  }
  return { type: "MultiLineString", coordinates: out };
}

/** Validate a stored [[distance_m, elevation_m], ...] profile; null when absent or malformed. */
export function parseElevationProfile(v: unknown): [number, number][] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const out: [number, number][] = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const d = finiteOrNull(p[0]);
    const e = finiteOrNull(p[1]);
    if (d === null || e === null) return null;
    out.push([d, e]);
  }
  return out;
}

/** DB row → public POI DTO; null for categories outside the catalog vocabulary. */
export function toPoiDto(row: PoiRow): PoiDto | null {
  if (!POI_CATEGORIES.includes(row.category as PoiCategory)) return null;
  const p = point(row.lng, row.lat);
  if (!p) return null;
  return {
    id: row.id,
    category: row.category as PoiCategory,
    name: row.name ?? null,
    lng: p.lng,
    lat: p.lat,
    distanceM: finiteOrNull(row.distanceM),
    elevationM: finiteOrNull(row.elevationM),
    openingHours: row.openingHours ?? null,
    website: row.website ?? null,
    phone: row.phone ?? null,
    sourceName: row.sourceName,
  };
}

/** Attribution for a trail page: trail provider, POI providers, elevation source. */
function detailAttribution(row: TrailDetailRow, poiProviders: string[]): AttributionDto[] {
  const known = [row.provider, ...poiProviders].filter((p) => PROVIDER_ATTRIBUTION[p]);
  const out = catalogAttribution(known);
  if (!PROVIDER_ATTRIBUTION[row.provider]) {
    // Unknown provider: credit it with its own stored source fields.
    out.unshift({ name: row.sourceName, url: row.sourceUrl ?? null, license: row.sourceLicense ?? null });
  }
  const elevation = elevationAttribution(row.elevationSource);
  if (elevation) out.push(elevation);
  return out;
}

/** DB row (+ POI rows) → public detail DTO. */
export function toDetailDto(row: TrailDetailRow, pois: PoiRow[] = []): TrailDetailDto {
  const trailheadSource = (TRAILHEAD_SOURCES as readonly (string | null)[]).includes(row.trailheadSource)
    ? (row.trailheadSource as (typeof TRAILHEAD_SOURCES)[number])
    : null;
  const bbox: Bbox = [row.bboxWest, row.bboxSouth, row.bboxEast, row.bboxNorth];
  return {
    ...toSummaryDto(row),
    regionSlug: row.regionSlug,
    slug: row.slug,
    timezone: row.timezone ?? null,
    geometry: parseGeometry(row.geometryJson),
    bbox,
    trailheadSource,
    elevationLossM: finiteOrNull(row.elevationLossM),
    maxElevationM: finiteOrNull(row.maxElevationM),
    minElevationM: finiteOrNull(row.minElevationM),
    elevationProfile: parseElevationProfile(row.elevationProfile),
    elevationSource: row.elevationSource ?? null,
    sacScale: row.sacScale ?? null,
    trailVisibility: row.trailVisibility ?? null,
    surfaces: stringList(row.surfaces),
    activities: stringList(row.activities),
    description: row.description ?? null,
    wheelchair: oneOf<WheelchairAccess>(WHEELCHAIR, row.wheelchair, "unknown"),
    access: row.access ?? null,
    seasonality: row.seasonality ?? null,
    operator: row.operator ?? null,
    website: row.website ?? null,
    hasDrinkingWater: row.hasDrinkingWater === true,
    sourceUrl: row.sourceUrl ?? null,
    sourceLicense: row.sourceLicense,
    sourceUpdatedAt: iso(row.sourceUpdatedAt),
    pois: pois.map(toPoiDto).filter((p): p is PoiDto => p !== null),
    attribution: detailAttribution(row, pois.map((p) => p.provider)),
  };
}

// ---------------------------------------------------------------------------
// SQL fragments (constant SQL text; values are bound parameters)
// ---------------------------------------------------------------------------

const summaryColumns = (tx: Tx) => tx`
  t.id, t.name, t.name_en, t.slug, t.country_code, t.region_slug, t.region_name, t.nearest_place,
  st_x(t.centroid::geometry) as centroid_lng, st_y(t.centroid::geometry) as centroid_lat,
  st_x(t.trailhead::geometry) as trailhead_lng, st_y(t.trailhead::geometry) as trailhead_lat,
  t.distance_m, t.route_type, t.elevation_gain_m, t.estimated_duration_min, t.difficulty, t.difficulty_source,
  t.features, t.dog_policy, t.fee_required, t.permit_required, t.has_parking, t.has_toilets, t.has_camping,
  t.family_friendly, t.provider, t.source_name, t.last_synced_at,
  t.hike_duration_min, t.elevation_loss_m as hike_loss_m`;

const detailColumns = (tx: Tx) => tx`
  ${summaryColumns(tx)},
  t.timezone, t.trailhead_source, t.elevation_loss_m, t.max_elevation_m, t.min_elevation_m,
  t.elevation_profile, t.elevation_source, t.sac_scale, t.trail_visibility, t.surfaces, t.activities,
  t.description, t.wheelchair, t.access, t.seasonality, t.operator, t.website, t.has_drinking_water,
  t.source_url, t.source_license, t.source_updated_at,
  st_npoints(t.geom) as vertex_count,
  st_asgeojson(
    case when st_npoints(t.geom) > ${DETAIL_SIMPLIFY_VERTEX_THRESHOLD}::int
         then st_simplifypreservetopology(t.geom, ${DETAIL_SIMPLIFY_TOLERANCE_DEG}::float8)
         else t.geom end,
    6) as geometry_json,
  st_xmin(t.geom) as bbox_west, st_ymin(t.geom) as bbox_south,
  st_xmax(t.geom) as bbox_east, st_ymax(t.geom) as bbox_north`;

/** Out-and-back distance for linear routes (see module header). */
const hikeDistance = (tx: Tx) => tx`(case when t.route_type = 'linear' then t.distance_m * 2 else t.distance_m end)`;
/** Round-trip climb for linear routes: gain + loss (unknown loss counts as 0). */
const hikeGain = (tx: Tx) =>
  tx`(case when t.route_type = 'linear' then t.elevation_gain_m + coalesce(t.elevation_loss_m, 0) else t.elevation_gain_m end)`;
const hikeDuration = (tx: Tx) =>
  tx`coalesce(t.hike_duration_min, case when t.route_type = 'linear' then t.estimated_duration_min * 2 else t.estimated_duration_min end)`;

/** Escape LIKE metacharacters so user text matches literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function searchConditions(tx: Tx, q: TrailSearchQuery) {
  const [w, s, e, n] = q.bbox;
  const text = q.q?.trim() ? q.q.trim() : null;
  return tx`and`.join([
    tx`not t.hidden`,
    // geom && envelope (GiST index), refined to a true intersection.
    tx`st_intersects(t.geom, st_makeenvelope(${w}::float8, ${s}::float8, ${e}::float8, ${n}::float8, 4326))`,
    q.difficulty.length > 0 && tx`t.difficulty = any(${q.difficulty}::text[])`,
    q.routeType.length > 0 && tx`t.route_type = any(${q.routeType}::text[])`,
    q.features.length > 0 && tx`t.features @> ${q.features}::text[]`,
    q.activity !== undefined && tx`t.activities @> ${[q.activity]}::text[]`,
    q.minDistanceKm !== undefined && tx`${hikeDistance(tx)} >= ${q.minDistanceKm * 1000}::float8`,
    q.maxDistanceKm !== undefined && tx`${hikeDistance(tx)} <= ${q.maxDistanceKm * 1000}::float8`,
    q.maxGainM !== undefined && tx`${hikeGain(tx)} <= ${q.maxGainM}::float8`,
    q.maxDurationMin !== undefined && tx`${hikeDuration(tx)} <= ${q.maxDurationMin}::float8`,
    q.dogFriendly && tx`t.dog_policy in ('allowed', 'leashed')`,
    q.familyFriendly && tx`t.family_friendly`,
    q.parking && tx`t.has_parking`,
    q.toilets && tx`t.has_toilets`,
    q.camping && tx`t.has_camping`,
    q.fee === "free" && tx`t.fee_required = false`,
    q.fee === "paid" && tx`t.fee_required = true`,
    q.permit === "required" && tx`t.permit_required = true`,
    q.permit === "not_required" && tx`t.permit_required = false`,
    text !== null &&
      tx`(t.name ilike ${`%${escapeLike(text)}%`} or t.name_en ilike ${`%${escapeLike(text)}%`}
          or t.search_text @@ websearch_to_tsquery('simple', ${text}))`,
  ]);
}

function searchOrder(tx: Tx, q: TrailSearchQuery) {
  switch (q.sort) {
    case "length":
      return tx`order by ${hikeDistance(tx)} asc, lower(t.name) asc, t.id asc`;
    case "gain":
      return tx`order by ${hikeGain(tx)} asc nulls last, ${hikeDistance(tx)} asc, t.id asc`;
    case "name":
      return tx`order by lower(t.name) asc, t.id asc`;
    case "relevance":
    default: {
      const [w, s, e, n] = q.bbox;
      const cx = (w + e) / 2;
      const cy = (s + n) / 2;
      const text = q.q?.trim() ? q.q.trim() : null;
      // With a name query, exact then prefix name matches come first.
      const nameRank = text
        ? tx`(case when lower(t.name) = lower(${text}) or lower(t.name_en) = lower(${text}) then 0
                   when t.name ilike ${`${escapeLike(text)}%`} or t.name_en ilike ${`${escapeLike(text)}%`} then 1
                   else 2 end) asc,`
        : tx``;
      return tx`order by ${nameRank} t.quality_score desc,
        st_distance(t.centroid, st_setsrid(st_makepoint(${cx}::float8, ${cy}::float8), 4326)::geography, false) asc,
        t.id asc`;
    }
  }
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

/**
 * The area a search actually scans. Within the coverage limit (no more than
 * `maxTiles` tiles of the outdoor grid, env CATALOG_MAX_TILES_PER_SEARCH —
 * the size coverage loads; larger areas are "too_large") it is the bbox
 * itself. A larger bbox is cut to a window of the same AREA as `maxTiles`
 * tiles around its centre (keeping the bbox's shape where it is narrow), so
 * a world-sized box costs no more than an ordinary search: the coverage
 * status tells the user to zoom in and that only trails near the middle are
 * shown.
 */
export function searchWindow(bbox: Bbox, maxTiles?: number): { bbox: Bbox; limited: boolean } {
  const max = Math.max(1, Math.floor(maxTiles ?? env().CATALOG_MAX_TILES_PER_SEARCH));
  if (!tilesForBbox("outdoor", bbox, max).truncated) return { bbox, limited: false };
  const [w, s, e, n] = bbox;
  const deg = TILE_DEG.outdoor;
  const maxArea = max * deg * deg;
  const width = Math.min(e - w, Math.max(Math.sqrt(maxArea), maxArea / (n - s)));
  const height = Math.min(n - s, maxArea / width);
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    bbox: [clamp(cx - width / 2, w, e), clamp(cy - height / 2, s, n), clamp(cx + width / 2, w, e), clamp(cy + height / 2, s, n)],
    limited: true,
  };
}

/**
 * Trails intersecting the search area with every filter of
 * trailSearchQuerySchema applied in SQL (see the module header for
 * out-and-back semantics). The search area is q.bbox, or for an area larger
 * than the coverage limit its middle (searchWindow), so the work per search
 * is bounded whatever bbox is asked for.
 *
 * Sorts: relevance (name matches first when q is set, then quality_score
 * desc, then great-circle distance of the centroid from the bbox centre),
 * length (hike distance asc),
 * gain (hike climb asc, unknown last), name (case-insensitive).
 * `total` counts every match in the search area before `limit`.
 */
export async function searchTrails(q: TrailSearchQuery, opts: { maxTiles?: number } = {}): Promise<{ trails: TrailSummaryDto[]; total: number }> {
  if (!Array.isArray(q.bbox) || q.bbox.length !== 4 || !q.bbox.every((v) => Number.isFinite(v))) {
    return { trails: [], total: 0 };
  }
  const limit = Math.min(200, Math.max(1, Math.floor(Number.isFinite(q.limit) ? q.limit : 100)));
  const area: TrailSearchQuery = { ...q, bbox: searchWindow(q.bbox, opts.maxTiles).bbox };
  const rows = await withAnon(async (tx) => {
    await tx`select set_config('statement_timeout', ${String(SEARCH_STATEMENT_TIMEOUT_MS)}, true)`;
    return tx<(TrailSummaryRow & { total: number })[]>`
      select ${summaryColumns(tx)}, count(*) over()::int as total
        from public.catalog_trails t
       where ${searchConditions(tx, area)}
       ${searchOrder(tx, area)}
       limit ${limit}::int`;
  });
  return { trails: rows.map(toSummaryDto), total: rows[0]?.total ?? 0 };
}

async function readDetail(tx: Tx, where: Fragment): Promise<TrailDetailDto | null> {
  const [row] = await tx<TrailDetailRow[]>`
    select ${detailColumns(tx)}
      from public.catalog_trails t
     where ${where} and not t.hidden`;
  if (!row) return null;
  const pois = await tx<PoiRow[]>`
    select p.id, p.category, p.name,
           st_x(p.location::geometry) as lng, st_y(p.location::geometry) as lat,
           round(st_distance(p.location, r.route))::int as distance_m,
           p.elevation_m, p.opening_hours, p.website, p.phone, p.source_name, p.provider
      from (select t.geom::geography as route, t.trailhead
              from public.catalog_trails t where t.id = ${row.id}::uuid) r
      join public.catalog_pois p
        on p.layer = 'outdoor'
       and (st_dwithin(p.location, r.route, ${POI_ROUTE_RADIUS_M}::float8)
            or (r.trailhead is not null and st_dwithin(p.location, r.trailhead, ${POI_TRAILHEAD_RADIUS_M}::float8)))
     order by st_distance(p.location, r.route) asc, p.id asc
     limit ${POI_LIMIT}::int`;
  return toDetailDto(row, pois);
}

/**
 * Trail page data by canonical path parts (/trail/<country>/<region>/<slug>).
 * Null for malformed parts, unknown or hidden trails.
 *
 * Geometry over DETAIL_SIMPLIFY_VERTEX_THRESHOLD (20 000) vertices is returned
 * simplified (ST_SimplifyPreserveTopology, ~5 m) so pages stay fast; distances,
 * profile and POI proximity are always computed from the full stored geometry.
 */
export async function getTrailDetailByPath(countryCode: string, regionSlug: string, slug: string): Promise<TrailDetailDto | null> {
  if (typeof countryCode !== "string" || typeof regionSlug !== "string" || typeof slug !== "string") return null;
  if (!COUNTRY_RE.test(countryCode) || !SLUG_RE.test(regionSlug) || regionSlug.length > 80 || !SLUG_RE.test(slug) || slug.length > 120) {
    return null;
  }
  return withAnon((tx) =>
    readDetail(tx, tx`t.country_code = ${countryCode} and t.region_slug = ${regionSlug} and t.slug = ${slug}`),
  );
}

/** Trail page data by id. Null for non-UUIDs, unknown or hidden trails. See getTrailDetailByPath. */
export async function getTrailDetailById(id: string): Promise<TrailDetailDto | null> {
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  return withAnon((tx) => readDetail(tx, tx`t.id = ${id.toLowerCase()}::uuid`));
}

/**
 * Summaries for a list of ids (e.g. saved trails), in input order. Invalid,
 * unknown and hidden ids are skipped; duplicates are returned once (first
 * position). At most MAX_SUMMARY_IDS ids are looked up.
 */
export async function getTrailSummariesByIds(ids: string[]): Promise<TrailSummaryDto[]> {
  if (!Array.isArray(ids)) return [];
  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    if (typeof raw !== "string" || !UUID_RE.test(raw)) continue;
    const id = raw.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    wanted.push(id);
    if (wanted.length >= MAX_SUMMARY_IDS) break;
  }
  if (!wanted.length) return [];
  const rows = await withAnon(
    (tx) => tx<TrailSummaryRow[]>`
      select ${summaryColumns(tx)}
        from public.catalog_trails t
       where t.id = any(${wanted}::uuid[]) and not t.hidden`,
  );
  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
  return wanted.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toSummaryDto(row)] : [];
  });
}
