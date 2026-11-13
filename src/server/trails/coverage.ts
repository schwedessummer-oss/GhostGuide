import "server-only";
import { after } from "next/server";
import { env } from "@/config/env";
import { CATALOG_LAYERS, type Bbox, type CatalogLayer, type CoverageDto, type CoverageState } from "@/domain/catalog";
import { withSystem, type Tx } from "@/server/db";
import { tilesForBbox, type Tile } from "@/server/geo/tiles";
import { log } from "@/server/log";
import { checkRateLimit, consumeRateBudget } from "@/server/rate-limit";
import { ingestTile } from "./ingest";
import { enabledProviders, fetchConcurrencyFor, providerById, providerLabelList, providersFor } from "./providers/registry";
import * as repo from "./repository";
import type { TrailDataProvider } from "./types";

/**
 * On-demand loading of provider data per tile (public.catalog_tiles).
 *
 * ensureCoverage(layer, bbox) is called by area searches. For the tiles the
 * area needs (tiles.ts grid, nearest to the centre first) and every enabled
 * provider covering them, it
 *   1. picks the few tiles nearest the centre that need a load — missing,
 *      failed and past its backoff, ready but due for refresh, or stuck
 *      fetching — and have no outstanding job: at most
 *      MAX_NEW_TILES_PER_REQUEST tiles minus those of the area already
 *      loading, tiles without data before refreshes. The rest of the area
 *      follows as the client polls;
 *   2. bounds the WORK, not just the requests: a global ceiling on queued
 *      live loads (MAX_QUEUED_TILE_LOADS; above it nothing is queued and the
 *      status says so) and, with `client`, a per-client budget of new loads
 *      (CLIENT_LOAD_BUDGET per CLIENT_LOAD_WINDOW_SEC, IPv6 keyed by /64)
 *      shared by every caller that passes the client (search, /explore,
 *      nearby). Over budget, stored data and an honest status are still
 *      returned; nothing is queued or loaded inline;
 *   3. creates the picked tile rows as 'pending' and enqueues ONE
 *      'catalog.ingest_tile' job per tile and provider, unless the job of its
 *      current request generation is still queued/running. The dedup key is
 *      tile + requested_at; a new request bumps requested_at with a
 *      compare-and-set, so concurrent searches enqueue exactly one job and a
 *      later refresh gets a fresh one. Jobs carry `requestedAt`; a search
 *      that asks again for a queued tile refreshes it, so the runner serves
 *      areas people are looking at first and drops loads nobody asked about
 *      for 20 minutes (repository.ABANDONED_REQUEST_MS);
 *   4. optionally starts loading the nearest pending tiles right after the
 *      response (next/server `after`): at most one inline run per client
 *      per INLINE_GATE_WINDOW_SEC, and an inline run never takes a
 *      provider's last fetch slot (that one is the job runner's);
 *   5. reports the area's honest loading status (CoverageDto).
 *
 * States (computed from the providers that supply the layer's main content;
 * a supplementary POI-only provider such as Recreation.gov on the outdoor
 * layer never makes trail coverage loading/partial/failed — its failures
 * are noted in the message instead)
 *   ready      every tile holds data (a background refresh may be queued)
 *   loading    some tiles are being loaded (job queued/running, or fetching)
 *   partial    some tiles failed or could not be queued (showing what is
 *              loaded), or — read-only status — part of the area was never
 *              requested
 *   failed     nothing could be loaded (every tile failed, or nothing is
 *              loaded and the area could not be queued right now)
 *   too_large  more tiles than maxTiles: nothing is requested; the counts
 *              cover the tiles already known in the area (not computed for
 *              areas over COVERAGE_COUNT_MAX_TILES tiles)
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
  /**
   * Rate-limit subject of the requesting client (server/request.ts
   * clientIpFrom). With it, new loads are charged to the client's budget and
   * inline loading is limited per client. Public routes must pass it;
   * trusted callers (scripts, tests) may omit it.
   */
  client?: string;
}

/** Hard ceiling on tiles per call, whatever the caller asks. */
export const MAX_TILES_CEILING = 256;
/** Most tiles loaded inline after one response. */
export const MAX_INLINE_TILES = 4;
/**
 * Time budget for loading inline after a search response. The search and
 * nearby routes allow 300 s (maxDuration) for this, so the fetch budget
 * covers one full Overpass attempt (90 s server timeout + 15 s client
 * margin): an inline run never abandons a query Overpass is still working
 * on (which would hold an Overpass slot our concurrency cap counts as free).
 */
export const INLINE_INGEST_BUDGET_MS = 150_000;
export const INLINE_FETCH_BUDGET_MS = 110_000;
/** Most tiles one request starts loading; the rest of the area follows as the client polls. */
export const MAX_NEW_TILES_PER_REQUEST = 4;
/** Global ceiling on queued/running live tile loads; above it nothing new is queued ("busy"). */
export const MAX_QUEUED_TILE_LOADS = repo.MAX_QUEUED_TILE_LOADS;
/** New tile loads (tile × provider) one client may queue per window. */
export const CLIENT_LOAD_BUDGET = 32;
export const CLIENT_LOAD_WINDOW_SEC = 600;
/** At most one inline loading run per client per window (inline runs take up to INLINE_INGEST_BUDGET_MS). */
export const INLINE_GATE_WINDOW_SEC = 150;
/** Upper bound for the coverage queries of one call. */
export const COVERAGE_STATEMENT_TIMEOUT_MS = 3_000;
/** Too-large areas with more tiles than this are not counted (their counts read 0). */
export const COVERAGE_COUNT_MAX_TILES = 4096;

/**
 * Providers that only add points of interest to a layer (no trails): their
 * tiles are loaded like any other, but they never decide the layer's
 * coverage state. Recreation.gov (RIDB) supplies campgrounds, trailheads
 * and facilities on the outdoor layer, never trail geometry.
 */
export const SUPPLEMENTARY_PROVIDERS: Readonly<Partial<Record<CatalogLayer, readonly string[]>>> = { outdoor: ["ridb"] };

export function isSupplementaryProvider(layer: CatalogLayer, providerId: string): boolean {
  return SUPPLEMENTARY_PROVIDERS[layer]?.includes(providerId) ?? false;
}

/** The providers that decide a tile's state: the main-content providers, or all when there are none. */
function primaryOf(layer: CatalogLayer, providerIds: readonly string[]): string[] {
  const main = providerIds.filter((id) => !isSupplementaryProvider(layer, id));
  return main.length > 0 ? main : [...providerIds];
}

/** Why part of an area was not queued for loading. */
export type DeferredReason = "busy" | "client_budget";

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

/**
 * One provider row's contribution to its tile's state. A pending row is
 * loading only while its job is queued/running (a pending row whose load
 * was dropped or cancelled is "missing": nothing is loading it).
 */
export function rowState(row: Pick<repo.TileRow, "status" | "lastSyncedAt" | "jobStatus"> | undefined): TileState {
  if (!row) return "missing";
  if (row.status === "ready" || row.lastSyncedAt) return "ready";
  if (row.status === "fetching") return "loading";
  if (repo.jobOutstanding(row.jobStatus)) return "loading";
  return row.status === "pending" ? "missing" : "failed";
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
  /** Tiles never requested (read-only status, not queued yet, or unknown parts of a too-large area). */
  missing: number;
  oldestSyncAt: Date | null;
  tooLarge: boolean;
  /** Main-content providers: "OpenStreetMap", "OpenStreetMap and Recreation.gov", ... ("" when none). */
  sources: string;
  /** Some missing tiles could not be queued now: the queue is full ("busy") or the client's budget is spent. */
  deferred?: DeferredReason | null;
  /** Labels of supplementary providers that failed somewhere in the area ("" when none). */
  supplementaryFailed?: string;
}

const DEFERRED_TEXT: Record<DeferredReason, string> = {
  busy: "Many areas are waiting to be loaded right now, so this one was not queued.",
  client_budget: "Many new areas were requested from your network in the last few minutes, so this one was not queued.",
};

/** State and plain-language message for counted tiles. Pure. */
export function summarizeCoverage(i: CoverageSummaryInput): CoverageDto {
  const noun = NOUN[i.layer] ?? NOUN.outdoor;
  const from = i.sources ? ` from ${i.sources}` : "";
  let state: CoverageState;
  let message: string;
  if (i.tooLarge) {
    state = "too_large";
    message = `Zoom in to load ${noun.plural} for this area. Showing ${noun.plural} already loaded near the middle of this area.`;
  } else if (i.loading > 0) {
    state = "loading";
    message =
      i.ready > 0
        ? `Loading more ${noun.plural} for this area${from}… this can take a minute. Showing what is loaded so far.`
        : `Loading ${noun.plural} for this area${from}… this can take a minute.`;
  } else if (i.deferred && i.missing > 0) {
    // Nothing is loading and part of the area could not be queued: say why, honestly.
    state = i.ready > 0 ? "partial" : "failed";
    message =
      state === "partial"
        ? `${DEFERRED_TEXT[i.deferred]} Showing what is already loaded; please try again in a few minutes.`
        : `${DEFERRED_TEXT[i.deferred]} Please try again in a few minutes.`;
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
  if (i.supplementaryFailed && !i.tooLarge) message += ` ${i.supplementaryFailed} data could not be loaded for part of this area right now.`;
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
const pairKey = (provider: string, tileKey: string) => `${provider}\u0000${tileKey}`;

const clampTiles = (n: unknown, fallback: number) =>
  Math.min(MAX_TILES_CEILING, Math.max(1, Math.floor(typeof n === "number" && Number.isFinite(n) ? n : fallback)));

/** Fetch-slot cap for an inline run: one below the provider's, so the job runner always keeps a slot. */
export function inlineConcurrencyCap(providerId: string): number {
  return Math.max(1, fetchConcurrencyFor(providerId) - 1);
}

/** Schedule inline loading after the response; outside a request scope this is a no-op. */
function scheduleInline(layer: CatalogLayer, items: { provider: string; tileKey: string }[]): boolean {
  if (items.length === 0) return false;
  try {
    after(async () => {
      try {
        const settled = await Promise.allSettled(
          items.map((i) =>
            ingestTile(layer, i.provider, i.tileKey, {
              budgetMs: INLINE_INGEST_BUDGET_MS,
              fetchBudgetMs: INLINE_FETCH_BUDGET_MS,
              concurrencyCap: inlineConcurrencyCap(i.provider),
            }),
          ),
        );
        log.info("catalog.inline_ingest", { layer, tiles: items.length, outcomes: settled.map((r) => (r.status === "fulfilled" ? r.value.outcome : "failed")) });
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

/** One inline run per client per INLINE_GATE_WINDOW_SEC (any client when none is given). */
async function inlineAllowed(client: string | undefined): Promise<boolean> {
  if (!client) return true;
  try {
    return (await checkRateLimit(`catalog:inline:${client}`, 1, INLINE_GATE_WINDOW_SEC)).allowed;
  } catch (err) {
    log.warn("catalog.inline_gate_failed", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

const limitStatement = (tx: Tx) => tx`select set_config('statement_timeout', ${String(COVERAGE_STATEMENT_TIMEOUT_MS)}, true)`;

async function tooLargeCoverage(layer: CatalogLayer, bbox: Bbox, tilesTotal: number): Promise<CoverageDto> {
  const providers = enabledProviders(layer);
  const primary = primaryOf(layer, providers.map((p) => p.id));
  let counts = { ready: 0, loading: 0, failed: 0, oldestSyncAt: null as Date | null };
  if (tilesTotal <= COVERAGE_COUNT_MAX_TILES) {
    try {
      counts = await withSystem(async (tx) => {
        await limitStatement(tx);
        return repo.coverageCountsInBbox(tx, layer, primary, bbox);
      });
    } catch (err) {
      // Counts are informational for a too-large area: report it without them.
      log.warn("catalog.coverage_count_failed", { layer, tiles: tilesTotal, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return summarizeCoverage({
    layer,
    tilesTotal,
    ready: counts.ready,
    loading: counts.loading,
    failed: counts.failed,
    missing: Math.max(0, tilesTotal - counts.ready - counts.loading - counts.failed),
    oldestSyncAt: counts.oldestSyncAt,
    tooLarge: true,
    sources: providerLabelList(providers.filter((p) => primary.includes(p.id))),
  });
}

interface WantedLoad {
  provider: string;
  tile: Tile;
}

async function compute(layer: CatalogLayer, bbox: Bbox, opts: EnsureCoverageOptions): Promise<CoverageDto> {
  if (!(CATALOG_LAYERS as readonly string[]).includes(layer)) throw new RangeError(`Unknown catalog layer: ${String(layer)}`);
  if (!validBbox(bbox)) throw new RangeError("Invalid bbox");
  const e = env();
  const maxTiles = clampTiles(opts.maxTiles, e.CATALOG_MAX_TILES_PER_SEARCH);
  const request = opts.request !== false;
  const client = typeof opts.client === "string" && opts.client.trim() ? opts.client.trim().slice(0, 100) : undefined;
  const grid = tilesForBbox(layer, bbox, maxTiles);
  if (grid.truncated) return tooLargeCoverage(layer, bbox, grid.count);

  const plans: { tile: Tile; providers: string[] }[] = grid.tiles.map((tile) => ({
    tile,
    providers: providersFor(layer, tile.bbox).map((p) => p.id),
  }));
  const pairs = plans.flatMap((p) => p.providers.map((provider) => ({ provider, tile: p.tile, tileKey: p.tile.key })));
  const nowMs = Date.now();

  const { rows, deferred } = await withSystem(async (tx) => {
    await limitStatement(tx);
    let current = await repo.readTiles(tx, layer, pairs);
    if (!request) return { rows: current, deferred: null };
    let byKey = new Map(current.map((r) => [pairKey(r.provider, r.tileKey), r]));

    // 1. What needs a load (nearest first; tiles without data before refreshes), and how much is already in flight.
    const firstLoads: WantedLoad[][] = [];
    const refreshes: WantedLoad[][] = [];
    let inFlight = 0;
    for (const plan of plans) {
      const needs: WantedLoad[] = [];
      let loading = false;
      let hasData = plan.providers.length > 0;
      for (const provider of plan.providers) {
        const row = byKey.get(pairKey(provider, plan.tile.key));
        if (rowState(row) === "loading") loading = true;
        if (!row?.lastSyncedAt && row?.status !== "ready") hasData = false;
        if (!row || (repo.tileNeedsWork(row) && !repo.jobOutstanding(row.jobStatus))) needs.push({ provider, tile: plan.tile });
      }
      if (loading) inFlight++;
      if (needs.length > 0) (hasData ? refreshes : firstLoads).push(needs);
    }
    const wanted = [...firstLoads, ...refreshes];
    let loads = wanted.slice(0, Math.max(0, MAX_NEW_TILES_PER_REQUEST - inFlight)).flat();
    let deferred: DeferredReason | null = null;

    // 2. Bound the work: global ceiling, then the client's budget.
    if (loads.length > 0) {
      const outstanding = await repo.countOutstandingIngestJobs(tx, nowMs, MAX_QUEUED_TILE_LOADS);
      const room = Math.max(0, MAX_QUEUED_TILE_LOADS - outstanding.live);
      if (room < loads.length) {
        deferred = "busy";
        loads = loads.slice(0, room);
      }
    }
    if (loads.length > 0 && client) {
      const budget = await consumeRateBudget(tx, `catalog:loads:${client}`, loads.length, CLIENT_LOAD_BUDGET, CLIENT_LOAD_WINDOW_SEC);
      if (budget.granted < loads.length) {
        deferred = "client_budget";
        loads = loads.slice(0, budget.granted);
      }
    }

    // 3. Create missing rows, then one job per (tile, provider) in a fixed lock order (no deadlocks).
    if (loads.length > 0) {
      const missing = loads.filter((l) => !byKey.has(pairKey(l.provider, l.tile.key)));
      if (missing.length > 0) {
        await repo.insertPendingTiles(tx, layer, missing);
        current = await repo.readTiles(tx, layer, pairs);
        byKey = new Map(current.map((r) => [pairKey(r.provider, r.tileKey), r]));
      }
      const ordered = [...loads].sort((a, b) => cmp(a.provider, b.provider) || cmp(a.tile.key, b.tile.key));
      for (const load of ordered) {
        const row = byKey.get(pairKey(load.provider, load.tile.key));
        if (!row || !repo.tileNeedsWork(row) || repo.jobOutstanding(row.jobStatus)) continue;
        const gen = await repo.requestTileIngest(tx, layer, row.provider, row.tileKey, row.requestGen, { requestedAtMs: nowMs });
        // gen null: a concurrent request bumped the generation first and its job covers this tile.
        row.jobStatus = "queued";
        if (gen) row.requestGen = gen;
        else row.requestGen = (await repo.readTiles(tx, layer, [row]))[0]?.requestGen ?? row.requestGen;
      }
    }

    // 4. Someone is still looking at this area: keep its queued loads ahead of abandoned ones.
    const queued = current.filter((r) => r.jobStatus === "queued");
    if (queued.length > 0) await repo.touchIngestRequests(tx, layer, queued, nowMs);
    return { rows: current, deferred };
  });

  // 5. Status, from the providers that supply the layer's main content.
  const byKey = new Map(rows.map((r) => [pairKey(r.provider, r.tileKey), r]));
  const counts = { ready: 0, loading: 0, failed: 0, missing: 0 };
  let oldestSyncAt: Date | null = null;
  const pendingNearestFirst: { provider: string; tileKey: string }[] = [];
  const supplementaryFailed = new Set<string>();
  for (const plan of plans) {
    const primary = primaryOf(layer, plan.providers);
    const states: TileState[] = [];
    for (const provider of plan.providers) {
      const row = byKey.get(pairKey(provider, plan.tile.key));
      const state = rowState(row);
      if (row?.status === "pending" && repo.jobOutstanding(row.jobStatus)) pendingNearestFirst.push({ provider, tileKey: plan.tile.key });
      if (!primary.includes(provider)) {
        if (state === "failed") supplementaryFailed.add(provider);
        continue;
      }
      states.push(state);
      if (row && state === "ready" && row.lastSyncedAt && (!oldestSyncAt || row.lastSyncedAt < oldestSyncAt)) oldestSyncAt = row.lastSyncedAt;
    }
    counts[combineTileStates(states)]++;
  }

  const inline = Math.min(MAX_INLINE_TILES, Math.max(0, Math.floor(opts.inlineTiles ?? 0)));
  if (request && inline > 0 && e.CATALOG_INLINE_INGEST && pendingNearestFirst.length > 0 && (await inlineAllowed(client))) {
    scheduleInline(layer, pendingNearestFirst.slice(0, inline));
  }

  const label = (ids: Iterable<string>) =>
    providerLabelList([...ids].map((id) => providerById(id)).filter((p): p is TrailDataProvider => p !== null));
  return summarizeCoverage({
    layer,
    tilesTotal: plans.length,
    ...counts,
    oldestSyncAt,
    tooLarge: false,
    sources: label(new Set(plans.flatMap((p) => primaryOf(layer, p.providers)))),
    deferred,
    supplementaryFailed: label(supplementaryFailed),
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
