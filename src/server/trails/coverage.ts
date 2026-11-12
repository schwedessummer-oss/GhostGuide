import "server-only";
import type { Bbox, CatalogLayer, CoverageDto } from "@/domain/catalog";

/**
 * On-demand loading of provider data per tile (public.catalog_tiles).
 * STUB — implemented in Phase 1 (ingestion workstream). Signatures are fixed.
 */

export interface EnsureCoverageOptions {
  /** Most tiles to request (default env CATALOG_MAX_TILES_PER_SEARCH). */
  maxTiles?: number;
  /** Enqueue jobs for missing/stale tiles (default true). */
  request?: boolean;
  /** Also start loading up to this many tiles right after the response (next/server `after`). */
  inlineTiles?: number;
}

/** Current loading status for an area; requests loading of missing tiles. Never throws. */
export async function ensureCoverage(layer: CatalogLayer, bbox: Bbox, opts: EnsureCoverageOptions = {}): Promise<CoverageDto> {
  void layer;
  void bbox;
  void opts;
  throw new Error("ensureCoverage: not implemented");
}

/** Read-only coverage status (no loading requested). */
export async function getCoverage(layer: CatalogLayer, bbox: Bbox): Promise<CoverageDto> {
  void layer;
  void bbox;
  throw new Error("getCoverage: not implemented");
}
