import "server-only";
import type {
  Activity,
  Bbox,
  CatalogLayer,
  DogPolicy,
  PoiCategory,
  RouteType,
  WheelchairAccess,
} from "@/domain/catalog";

/**
 * Trail data provider architecture.
 *
 *   TrailDataProvider          one external source (OSM, Recreation.gov, ...)
 *     fetchArea(layer, bbox)   → NormalizedTrail[] + NormalizedPoi[] for a tile
 *
 * Providers only translate their source into this normalized shape (no DB
 * access, no enrichment). The ingestion pipeline (src/server/trails/ingest.ts)
 * then enriches (elevation, estimates, trailhead, features, admin names,
 * timezone, slug) and upserts into catalog_trails / catalog_pois.
 *
 * Adding a country/official source = one new provider + registry entry
 * (src/server/trails/providers/registry.ts). Data quality differs per source:
 * providers must leave unknown fields null/"unknown" rather than guess.
 */

export type ProviderId = "osm" | "ridb";

/** A polyline as [lng, lat] pairs. */
export type Line = [number, number][];

export interface NormalizedTrail {
  provider: ProviderId;
  /** Stable id within the provider, e.g. "relation/123" or "wayname/<hash>". */
  providerId: string;
  name: string;
  nameEn: string | null;
  /** One or more polylines (route members / merged way chains). */
  lines: Line[];
  routeType: RouteType;
  /** Raw OSM-style sac_scale value when present (e.g. "mountain_hiking"). */
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
  /** Relevant provider tags kept for provenance (no personal data). */
  tags: Record<string, string>;
  sourceName: string;
  sourceUrl: string | null;
  sourceLicense: string;
  sourceUpdatedAt: Date | null;
}

export interface NormalizedPoi {
  provider: ProviderId;
  providerId: string;
  layer: CatalogLayer;
  category: PoiCategory;
  name: string | null;
  nameEn: string | null;
  lng: number;
  lat: number;
  elevationM: number | null;
  tags: Record<string, string>;
  openingHours: string | null;
  phone: string | null;
  website: string | null;
  sourceName: string;
  sourceUrl: string | null;
  sourceLicense: string;
}

export interface ProviderAreaResult {
  trails: NormalizedTrail[];
  pois: NormalizedPoi[];
  /** When the provider's data snapshot was taken (e.g. Overpass timestamp_osm_base). */
  dataTimestamp: Date | null;
}

export interface TrailDataProvider {
  id: ProviderId;
  label: string;
  homepage: string;
  license: string;
  /** Attribution text that must be displayed with this provider's data. */
  attribution: string;
  layers: readonly CatalogLayer[];
  /** False when required configuration (e.g. an API key) is missing. */
  isEnabled(): boolean;
  /** Whether the provider has data for (part of) this area, e.g. RIDB = US only. */
  covers(bbox: Bbox): boolean;
  fetchArea(layer: CatalogLayer, bbox: Bbox, opts?: { signal?: AbortSignal }): Promise<ProviderAreaResult>;
}
