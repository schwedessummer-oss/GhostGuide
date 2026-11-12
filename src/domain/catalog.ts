/**
 * Trail catalog contracts shared by server and client (no server imports).
 *
 * Catalog trails are REAL provider data (OpenStreetMap, Recreation.gov, ...),
 * normalized into one shape. Fields a provider does not supply are null /
 * "unknown" and the UI must say so — never fill gaps with invented values.
 * Estimates (duration, DEM elevation, estimated difficulty) are labeled as such.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------
export const CATALOG_LAYERS = ["outdoor", "services"] as const;
export type CatalogLayer = (typeof CATALOG_LAYERS)[number];

export const DIFFICULTIES = ["easy", "moderate", "hard", "expert", "unknown"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export type DifficultySource = "osm_sac_scale" | "estimated" | "official";

/** loop: start ≈ end; linear: one-way line (out-and-back doubles it); network: several branches. */
export const ROUTE_TYPES = ["loop", "linear", "network", "unknown"] as const;
export type RouteType = (typeof ROUTE_TYPES)[number];

export const DOG_POLICIES = ["allowed", "leashed", "not_allowed", "unknown"] as const;
export type DogPolicy = (typeof DOG_POLICIES)[number];
export type WheelchairAccess = "yes" | "limited" | "no" | "unknown";

export const OUTDOOR_POI_CATEGORIES = [
  "trailhead", "parking", "toilets", "drinking_water", "shelter", "campsite", "viewpoint", "peak",
  "waterfall", "lake", "spring", "cave", "picnic_site", "ranger_station", "information",
] as const;
export const SERVICE_POI_CATEGORIES = [
  "fuel", "ev_charging", "restaurant", "fast_food", "cafe", "lodging", "supermarket", "convenience",
  "outdoor_shop", "hospital", "clinic", "pharmacy",
] as const;
export type OutdoorPoiCategory = (typeof OUTDOOR_POI_CATEGORIES)[number];
export type ServicePoiCategory = (typeof SERVICE_POI_CATEGORIES)[number];
export type PoiCategory = OutdoorPoiCategory | ServicePoiCategory;

/** Features derived from mapped POIs within ~200 m of the route. */
export const TRAIL_FEATURES = ["waterfall", "lake", "viewpoint", "peak", "cave", "spring", "shelter", "picnic_site"] as const;
export type TrailFeature = (typeof TRAIL_FEATURES)[number];

export const ACTIVITIES = ["hiking", "walking", "running", "biking", "horse_riding"] as const;
export type Activity = (typeof ACTIVITIES)[number];

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
/** [west, south, east, north] in degrees (WGS84). */
export type Bbox = [number, number, number, number];
export interface LngLat {
  lng: number;
  lat: number;
}

export function parseBbox(value: string | null | undefined): Bbox | null {
  if (!value) return null;
  const parts = value.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [w, s, e, n] = parts;
  if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) return null;
  return [w, s, e, n];
}

export const formatBbox = (b: Bbox) => b.map((n) => Number(n.toFixed(5))).join(",");

// ---------------------------------------------------------------------------
// Attribution / provenance
// ---------------------------------------------------------------------------
export interface AttributionDto {
  name: string;
  url: string | null;
  license: string | null;
}

// ---------------------------------------------------------------------------
// Trails
// ---------------------------------------------------------------------------
export interface TrailSummaryDto {
  id: string;
  /** Canonical page path: /trail/<country>/<region>/<slug> */
  path: string;
  name: string;
  nameEn: string | null;
  countryCode: string;
  regionName: string | null;
  nearestPlace: string | null;
  centroid: LngLat;
  trailhead: LngLat | null;
  distanceM: number;
  routeType: RouteType;
  elevationGainM: number | null;
  estimatedDurationMin: number | null;
  difficulty: Difficulty;
  difficultySource: DifficultySource | null;
  features: TrailFeature[];
  dogPolicy: DogPolicy;
  feeRequired: boolean | null;
  permitRequired: boolean | null;
  hasParking: boolean;
  hasToilets: boolean;
  hasCamping: boolean;
  familyFriendly: boolean;
  provider: string;
  sourceName: string;
  lastSyncedAt: string;
}

export interface PoiDto {
  id: string;
  category: PoiCategory;
  name: string | null;
  lng: number;
  lat: number;
  /** Straight-line distance from the reference point/route, metres (when computed). */
  distanceM: number | null;
  elevationM: number | null;
  openingHours: string | null;
  website: string | null;
  phone: string | null;
  sourceName: string;
}

export interface TrailDetailDto extends TrailSummaryDto {
  regionSlug: string;
  slug: string;
  timezone: string | null;
  /** GeoJSON MultiLineString, coordinates [lng, lat]. */
  geometry: { type: "MultiLineString"; coordinates: [number, number][][] };
  bbox: Bbox;
  trailheadSource: "osm_trailhead" | "parking" | "route_start" | "official" | null;
  elevationLossM: number | null;
  maxElevationM: number | null;
  minElevationM: number | null;
  /** [[distance_m, elevation_m], ...] or null when unavailable. */
  elevationProfile: [number, number][] | null;
  elevationSource: string | null;
  sacScale: string | null;
  trailVisibility: string | null;
  surfaces: string[];
  activities: string[];
  description: string | null;
  wheelchair: WheelchairAccess;
  access: string | null;
  seasonality: string | null;
  operator: string | null;
  website: string | null;
  hasDrinkingWater: boolean;
  sourceUrl: string | null;
  sourceLicense: string;
  sourceUpdatedAt: string | null;
  /** Outdoor POIs on/near the route (trailheads, parking, toilets, water, features). */
  pois: PoiDto[];
  attribution: AttributionDto[];
}

export function trailPath(t: { countryCode: string; regionSlug: string; slug: string }): string {
  return `/trail/${t.countryCode}/${t.regionSlug}/${t.slug}`;
}

// ---------------------------------------------------------------------------
// Coverage (on-demand loading status for an area)
// ---------------------------------------------------------------------------
export type CoverageState =
  | "ready" // every tile in the area is loaded
  | "loading" // some tiles are pending/fetching
  | "partial" // some tiles failed; showing what is loaded
  | "failed" // nothing could be loaded
  | "too_large"; // area too big to load; zoom in (already-loaded trails still shown)

export interface CoverageDto {
  layer: CatalogLayer;
  state: CoverageState;
  tilesTotal: number;
  tilesReady: number;
  tilesLoading: number;
  tilesFailed: number;
  /** Oldest successful sync among ready tiles (ISO), when any. */
  oldestSyncAt: string | null;
  /** Human-readable, honest status message for the UI. */
  message: string;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []))
    .pipe(z.array(z.enum(values)).max(values.length));
const flag = z
  .enum(["1", "0", "true", "false"])
  .optional()
  .transform((v) => v === "1" || v === "true");
const num = (min: number, max: number) => z.coerce.number().min(min).max(max).optional();

/** Query-string schema for GET /api/trails/search (also used by /explore). */
export const trailSearchQuerySchema = z.object({
  bbox: z.string().transform((v, ctx) => {
    const b = parseBbox(v);
    if (!b) {
      ctx.addIssue({ code: "custom", message: "bbox must be west,south,east,north in degrees" });
      return z.NEVER;
    }
    return b;
  }),
  /** Optional name filter applied to trails in the area. */
  q: z.string().trim().max(120).optional(),
  difficulty: csv(DIFFICULTIES),
  routeType: csv(ROUTE_TYPES),
  features: csv(TRAIL_FEATURES),
  activity: z.enum(ACTIVITIES).optional(),
  minDistanceKm: num(0, 500),
  maxDistanceKm: num(0, 500),
  maxGainM: num(0, 10000),
  maxDurationMin: num(0, 10000),
  dogFriendly: flag,
  familyFriendly: flag,
  parking: flag,
  toilets: flag,
  camping: flag,
  fee: z.enum(["free", "paid"]).optional(),
  permit: z.enum(["required", "not_required"]).optional(),
  sort: z.enum(["relevance", "length", "gain", "name"]).default("relevance"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  /** Request loading of not-yet-loaded tiles (default on). */
  load: z
    .enum(["1", "0"])
    .optional()
    .transform((v) => v !== "0"),
}).superRefine((q, ctx) => {
  if (q.minDistanceKm !== undefined && q.maxDistanceKm !== undefined && q.minDistanceKm > q.maxDistanceKm) {
    for (const path of ["minDistanceKm", "maxDistanceKm"]) {
      ctx.addIssue({ code: "custom", message: "minDistanceKm must not exceed maxDistanceKm", path: [path] });
    }
  }
});
export type TrailSearchQuery = z.infer<typeof trailSearchQuerySchema>;

export interface TrailSearchResponse {
  trails: TrailSummaryDto[];
  /** Matches in the area before `limit` was applied. */
  total: number;
  bbox: Bbox;
  coverage: CoverageDto;
  attribution: AttributionDto[];
}

// ---------------------------------------------------------------------------
// Geocoding
// ---------------------------------------------------------------------------
export interface GeocodeResultDto {
  id: string;
  label: string;
  /** e.g. city, town, village, park, protected_area, peak, mountain_range, region, country */
  kind: string;
  lng: number;
  lat: number;
  bbox: Bbox | null;
  countryCode: string | null;
  source: string;
}

export interface GeocodeResponse {
  query: string;
  /** The place part of a query like "trails near Denver" → "Denver". */
  placeQuery: string;
  results: GeocodeResultDto[];
  status: "ok" | "no_results" | "unavailable";
  /** True for "near me" / "nearby" queries: the client should use the device location. */
  nearMe?: boolean;
  attribution: AttributionDto[];
}

// ---------------------------------------------------------------------------
// Conditions (weather, daylight, alerts) — never invented; null when unavailable
// ---------------------------------------------------------------------------
export interface HourlyForecastDto {
  time: string; // ISO
  temperatureC: number | null;
  precipitationMm: number | null;
  precipitationProbability: number | null; // %
  windSpeedMs: number | null;
  windGustMs: number | null;
  symbol: string | null; // provider symbol code, e.g. "partlycloudy_day"
}

export interface DailyForecastDto {
  date: string; // YYYY-MM-DD in trail timezone
  minC: number | null;
  maxC: number | null;
  precipitationMm: number | null;
  maxWindMs: number | null;
  symbol: string | null;
}

export interface WeatherAlertDto {
  id: string;
  event: string;
  severity: string; // as given by the source (e.g. Minor/Moderate/Severe/Extreme)
  headline: string | null;
  description: string | null;
  instruction: string | null;
  onset: string | null;
  ends: string | null;
  source: string; // e.g. "National Weather Service"
  url: string | null;
}

export interface SunTimesDto {
  date: string; // YYYY-MM-DD (trail timezone)
  sunrise: string | null; // ISO
  sunset: string | null; // ISO
  civilDusk: string | null; // ISO
  /** Set at high latitudes when the sun does not rise/set that day. */
  polar: "day" | "night" | null;
}

export interface PlanningDto {
  /** One traversal (loop or one way), minutes; null when unknown. */
  estimatedDurationMin: number | null;
  /** Out-and-back estimate for linear routes. */
  outAndBackDurationMin: number | null;
  /** Latest start that still finishes ~1 h before sunset (ISO), when computable. */
  latestRecommendedStart: string | null;
  /** If starting now: estimated finish (ISO). */
  finishIfStartNow: string | null;
  /** Daylight left from now until sunset, minutes (0 after sunset); null when unknown. */
  daylightRemainingMin: number | null;
  notes: string[];
}

export interface TrailConditionsDto {
  trailId: string;
  generatedAt: string;
  timezone: string | null;
  point: LngLat;
  forecastStatus: "ok" | "unavailable";
  current: HourlyForecastDto | null;
  hourly: HourlyForecastDto[]; // next ~24 h
  daily: DailyForecastDto[]; // next ~7 days
  /** Plain-language, derived only from the forecast numbers (e.g. "Rain likely around 4 PM"). */
  highlights: string[];
  alertsStatus: "ok" | "unavailable" | "not_supported";
  alerts: WeatherAlertDto[];
  sun: SunTimesDto[]; // today + next days
  planning: PlanningDto;
  forecastUpdatedAt: string | null;
  attribution: AttributionDto[];
}

// ---------------------------------------------------------------------------
// Nearby services
// ---------------------------------------------------------------------------
export interface NearbyGroupDto {
  category: ServicePoiCategory | "parking" | "toilets";
  label: string;
  items: PoiDto[]; // nearest few, with distanceM from the trailhead
}

export interface NearbyResponse {
  trailId: string;
  origin: LngLat;
  radiusM: number;
  coverage: CoverageDto;
  groups: NearbyGroupDto[];
  /** Explains limits honestly, e.g. ratings unavailable, straight-line distances. */
  notes: string[];
  attribution: AttributionDto[];
}

// ---------------------------------------------------------------------------
// Emergency information
// ---------------------------------------------------------------------------
export interface EmergencyNumbersDto {
  countryCode: string | null;
  /** The number to call first; null when Ghost Guide has no verified number for the country. */
  primary: string | null;
  police: string | null;
  ambulance: string | null;
  fire: string | null;
  notes: string[];
  source: string;
}
