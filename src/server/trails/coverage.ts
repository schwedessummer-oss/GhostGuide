import "server-only";
import { after } from "next/server";
import { env } from "@/config/env";
import { CATALOG_LAYERS, type Bbox, type CatalogLayer, type CoverageDto, type CoverageState } from "@/domain/catalog";
import { withSystem } from "@/server/db";
import { tilesForBbox, type Tile } from "@/server/geo/tiles";
import { log } from "@/server/log";
import { ingestTilesNow } from "./ingest";
import { enabledProviders, providerById, providerLabelList, providersFor } from "./providers/registry";
import * as repo from "./repository";
import type { TrailDataProvider } from "./types";

/**
 * On-demand loading of provider data per tile (public.catalog_tiles).
 *
 * ensureCoverage(layer, bbox) is called by area searches. For every tile the
 * area needs (tiles.ts grid, nearest to the centre first) and every enabled
 * provider covering it, it
 *   1. creates missing tile rows as 'pending';
 *   2. enqueues ONE 'catalog.ingest_tile' job per tile that needs work —
 *      pending, failed and past its backoff, ready but due for refresh, or
 *      stuck fetching — unless the job of its current request generation is
 *      still queued/running. The dedup key is tile + requested_at; a new
 *      request bumps requested_at with a compare-and-set, so concurrent
 *      searches enqueue exactly one job and a later refresh gets a fresh one;
 *   3. optionally starts loading the N nearest pending tiles right after
 *      the response (next/server `after`; the job runner is the fallback);
 *   4. reports the area's honest loading status (CoverageDto).
 *
 * States
 *   ready      every tile holds data (a background refresh may be queued)
 *   loading    some tiles are pending/fetching (or failed with a retry queued)
 *   partial    some tiles failed (showing what is loaded), or — read-only
 *              status — part of the area was never requested
 *   failed     nothing could be loaded (every tile failed)
 *   too_large  more tiles than maxTiles: nothing is requested; the counts
 *              cover the tiles already known in the area
 * A tile that already holds data counts as ready while it is refreshed or
 * after a failed refresh: its data is still served.
 *
 * Neither function throws: an internal error yields state "failed" with a
 * message saying the loading status is unavailable.
 */

export interface EnsureCoverageOptions {
  /** Most tiles to request (default env CATALOG_MAX_TILES_PER_SEARCH). */
  maxTiles?: number;
  /** Enqueue jobs for missing/stale tiles (default true). */
  request?: boolean;
  /** Also start loading up to this many tiles right after the response (next/server `after`). */
  inlineTiles?: number;
}

/** Hard ceiling on tiles per call, whatever the caller asks. */
export const MAX_TILES_CEILING = 256;
/** Most tiles loaded inline after one response. */
export const MAX_INLINE_TILES = 4;
/**
 * Time budget for loading inline after a search response. Shorter than the
 * job runner's: the search route runs under the platform's default function
 * limit, and a clean timeout (tile failed, retried by the job runner) is
 * better than the platform killing the function mid-fetch (tile stuck in
 * 'fetching' until it goes stale).
 */
export const INLINE_INGEST_BUDGET_MS = 90_000;
export const INLINE_FETCH_BUDGET_MS = 75_000;

export type TileState = "ready" | "loading" | "failed" | "missing";

const NOUN: Record<CatalogLayer, { plural: string; capital: string }> = {
  outdoor: { plural: "trails", capital: "Trails" },
  services: { plural: "nearby places", capital: "Nearby places" },
};

/** Coverage when the coverage service itself fails. Honest, never "ready". */
export function coverageUnavailable(layer: CatalogLayer): CoverageDto {
  const noun = NOUN[layer] ?? NOUN.outdoor;
  return {
    layer,
    state: "failed",
    tilesTotal: 0,
    tilesReady: 0,
    tilesLoading: 0,
    tilesFailed: 0,
    oldestSyncAt: null,
    message: `Loading status is unavailable right now. Showing ${noun.plural} already stored for this area, which may be incomplete.`,
  };
}

/** One provider row's contribution to its tile's state. */
export function rowState(row: Pick<repo.TileRow, "status" | "lastSyncedAt" | "jobStatus"> | undefined): TileState {
  if (!row) return "missing";
  if (row.status === "ready" || row.lastSyncedAt) return "ready";
  if (row.status === "pending" || row.status === "fetching") return "loading";
  return repo.jobOutstanding(row.jobStatus) ? "loading" : "failed";
}

/** A tile's state across its providers: loading > failed > missing > ready. */
export function combineTileStates(states: readonly TileState[]): TileState {
  if (states.includes("loading")) return "loading";
  if (states.includes("failed")) return "failed";
  if (states.includes("missing")) return "missing";
  return "ready";
}

export interface CoverageSummaryInput {
  layer: CatalogLayer;
  tilesTotal: number;
  ready: number;
  loading: number;
  failed: number;
  /** Tiles never requested (read-only status, or unknown parts of a too-large area). */
  missing: number;
  oldestSyncAt: Date | null;
  tooLarge: boolean;
  /** "OpenStreetMap", "OpenStreetMap and Recreation.gov", ... ("" when none). */
  sources: string;
}

/** State and plain-language message for counted tiles. Pure. */
export function summarizeCoverage(i: CoverageSummaryInput): CoverageDto {
  const noun = NOUN[i.layer] ?? NOUN.outdoor;
  const from = i.sources ? ` from ${i.sources}` : "";
  let state: CoverageState;
  let message: string;
  if (i.tooLarge) {
    state = "too_large";
    message = `Zoom in to load ${noun.plural} for this area. Showing ${noun.plural} already loaded.`;
  } else if (i.loading > 0) {
    state = "loading";
    message =
      i.ready > 0
        ? `Loading more ${noun.plural} for this area${from}… this can take a minute. Showing what is loaded so far.`
        : `Loading ${noun.plural} for this area${from}… this can take a minute.`;
  } else if (i.failed > 0) {
    state = i.ready > 0 || i.missing > 0 ? "partial" : "failed";
    message =
      state === "partial"
        ? "Some of this area could not be loaded right now; showing what is available."
        : `${noun.capital} for this area could not be loaded${from} right now. Please try again later.`;
  } else if (i.missing > 0) {
    state = "partial";
    message =
      i.ready > 0
        ? "Part of this area has not been loaded yet; showing what is available."
        : `${noun.capital} for this area have not been loaded yet.`;
  } else {
    state = "ready";
    message = `${noun.capital} for this area are loaded${from}.`;
  }
  return {
    layer: i.layer,
    state,
    tilesTotal: i.tilesTotal,
    tilesReady: i.ready,
    tilesLoading: i.loading,
    tilesFailed: i.failed,
    oldestSyncAt: i.oldestSyncAt ? i.oldestSyncAt.toISOString() : null,
    message,
  };
}

function validBbox(b: unknown): b is Bbox {
  if (!Array.isArray(b) || b.length !== 4 || !b.every((n) => typeof n === "number" && Number.isFinite(n))) return false;
  const [w, s, e, n] = b as number[];
  return w >= -180 && e <= 180 && s >= -90 && n <= 90 && w < e && s < n;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const clampTiles = (n: unknown, fallback: number) =>
  Math.min(MAX_TILES_CEILING, Math.max(1, Math.floor(typeof n === "number" && Number.isFinite(n) ? n : fallback)));

/** Schedule inline loading after the response; outside a request scope this is a no-op. */
function scheduleInline(layer: CatalogLayer, items: { provider: string; tileKey: string }[]): boolean {
  if (items.length === 0) return false;
  try {
    after(async () => {
      try {
        const results = await ingestTilesNow(layer, items, { budgetMs: INLINE_INGEST_BUDGET_MS, fetchBudgetMs: INLINE_FETCH_BUDGET_MS });
        log.info("catalog.inline_ingest", { layer, tiles: items.length, outcomes: results.map((r) => r.outcome) });
      } catch (err) {
        log.warn("catalog.inline_ingest_failed", { layer, error: err instanceof Error ? err.message : String(err) });
      }
    });
    return true;
  } catch {
    // `after` throws outside a request scope (scripts, tests): the job runner loads the tiles.
    return false;
  }
}

async function compute(layer: CatalogLayer, bbox: Bbox, opts: EnsureCoverageOptions): Promise<CoverageDto> {
  if (!(CATALOG_LAYERS as readonly string[]).includes(layer)) throw new RangeError(`Unknown catalog layer: ${String(layer)}`);
  if (!validBbox(bbox)) throw new RangeError("Invalid bbox");
  const e = env();
  const maxTiles = clampTiles(opts.maxTiles, e.CATALOG_MAX_TILES_PER_SEARCH);
  const request = opts.request !== false;
  const grid = tilesForBbox(layer, bbox, maxTiles);

  if (grid.truncated) {
    const providers = enabledProviders(layer);
    const counts = await withSystem((tx) =>
      repo.coverageCountsInBbox(
        tx,
        layer,
        providers.map((p) => p.id),
        bbox,
      ),
    );
    return summarizeCoverage({
      layer,
      tilesTotal: grid.count,
      ready: counts.ready,
      loading: counts.loading,
      failed: counts.failed,
      missing: Math.max(0, grid.count - counts.ready - counts.loading - counts.failed),
      oldestSyncAt: counts.oldestSyncAt,
      tooLarge: true,
      sources: providerLabelList(providers),
    });
  }

  const plans: { tile: Tile; providers: string[] }[] = grid.tiles.map((tile) => ({
    tile,
    providers: providersFor(layer, tile.bbox).map((p) => p.id),
  }));
  const pairs = plans.flatMap((p) => p.providers.map((provider) => ({ provider, tile: p.tile, tileKey: p.tile.key })));

  const rows = await withSystem(async (tx) => {
    if (request) await repo.insertPendingTiles(tx, layer, pairs);
    const current = await repo.readTiles(tx, layer, pairs);
    if (!request) return current;
    // Fixed lock order (provider, tile key) so concurrent searches never deadlock.
    const ordered = [...current].sort((a, b) => cmp(a.provider, b.provider) || cmp(a.tileKey, b.tileKey));
    for (const row of ordered) {
      if (!repo.tileNeedsWork(row) || repo.jobOutstanding(row.jobStatus)) continue;
      const gen = await repo.requestTileIngest(tx, layer, row.provider, row.tileKey, row.requestGen);
      // gen null: a concurrent request bumped the generation first and its job covers this tile.
      row.jobStatus = "queued";
      if (gen) row.requestGen = gen;
    }
    return current;
  });

  const byKey = new Map(rows.map((r) => [`${r.provider}\u0000${r.tileKey}`, r]));
  const counts = { ready: 0, loading: 0, failed: 0, missing: 0 };
  let oldestSyncAt: Date | null = null;
  const pendingNearestFirst: { provider: string; tileKey: string }[] = [];
  for (const plan of plans) {
    const states: TileState[] = [];
    for (const provider of plan.providers) {
      const row = byKey.get(`${provider}\u0000${plan.tile.key}`);
      const state = rowState(row);
      states.push(state);
      if (row && state === "ready" && row.lastSyncedAt && (!oldestSyncAt || row.lastSyncedAt < oldestSyncAt)) oldestSyncAt = row.lastSyncedAt;
      if (row?.status === "pending") pendingNearestFirst.push({ provider, tileKey: plan.tile.key });
    }
    counts[combineTileStates(states)]++;
  }

  const inline = Math.min(MAX_INLINE_TILES, Math.max(0, Math.floor(opts.inlineTiles ?? 0)));
  if (request && inline > 0 && e.CATALOG_INLINE_INGEST) scheduleInline(layer, pendingNearestFirst.slice(0, inline));

  const sources = [...new Set(plans.flatMap((p) => p.providers))]
    .map((id) => providerById(id))
    .filter((p): p is TrailDataProvider => p !== null);
  return summarizeCoverage({
    layer,
    tilesTotal: plans.length,
    ...counts,
    oldestSyncAt,
    tooLarge: false,
    sources: providerLabelList(sources),
  });
}

/** Current loading status for an area; requests loading of missing tiles. Never throws. */
export async function ensureCoverage(layer: CatalogLayer, bbox: Bbox, opts: EnsureCoverageOptions = {}): Promise<CoverageDto> {
  try {
    return await compute(layer, bbox, opts ?? {});
  } catch (err) {
    log.error("catalog.coverage_failed", { layer, request: opts?.request !== false, error: err instanceof Error ? err.message : String(err) });
    return coverageUnavailable((CATALOG_LAYERS as readonly string[]).includes(layer) ? layer : "outdoor");
  }
}

/** Read-only coverage status (no loading requested). Never throws. */
export async function getCoverage(layer: CatalogLayer, bbox: Bbox): Promise<CoverageDto> {
  return ensureCoverage(layer, bbox, { request: false, inlineTiles: 0 });
}
