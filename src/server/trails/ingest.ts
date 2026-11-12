import "server-only";
import { env } from "@/config/env";
import { CATALOG_LAYERS, type CatalogLayer, type LngLat } from "@/domain/catalog";
import { withSystem } from "@/server/db";
import { elevationProfileFor } from "@/server/geo/elevation";
import { adminCellKey, reverseAdminArea, type AdminArea } from "@/server/geo/geocode";
import { cleanLines, linesLengthM } from "@/server/geo/geodesy";
import { tileForPoint, tileFromKey, type Tile } from "@/server/geo/tiles";
import { timezoneAt } from "@/server/geo/timezone";
import { log, redactString } from "@/server/log";
import { PROVIDER_LABELS, ProviderError } from "@/server/providers/http";
import {
  ENRICHMENT_POI_CATEGORIES,
  POI_LOOKUP_RADIUS_M,
  attributesOf,
  buildTrailRecord,
  orientFromTrailhead,
  selectTrailhead,
  combineAttributes,
  geometryHash,
  trailCentroid,
  type ElevationSnapshot,
} from "./enrich";
import { assembleRoute } from "./providers/osm/geometry";
import { nameKey } from "./providers/osm/tags";
import { fetchConcurrencyFor, providerById } from "./providers/registry";
import * as repo from "./repository";
import type { Line, NormalizedPoi, NormalizedTrail, ProviderId, TrailDataProvider } from "./types";

/**
 * On-demand ingestion of one provider tile (public.catalog_tiles):
 *
 *   claim → provider.fetchArea → upsert POIs → enrich + upsert trails
 *         → retire what the source no longer has → mark ready
 *
 * CLAIM. repository.claimTile atomically moves the tile to 'fetching'
 * (pending, failed, ready-and-due, or a fetch stale for 5 min) and refuses
 * when the provider's global concurrency cap is reached (OSM: 2 tiles
 * fetching within 3 min). The claim's timestamp fences every later write to
 * the tile row, so a worker that lost its claim (reclaimed after a stall)
 * can never overwrite the new owner's status.
 *
 * BUDGET. The provider request gets FETCH_BUDGET_MS (150 s), the whole run
 * INGEST_BUDGET_MS (200 s) or less (budgetMs, e.g. the time a cron run has
 * left). Running out fails the tile (retryable) instead of hanging.
 *
 * TRAILS (outdoor layer). POIs are written first: they inform trailheads
 * and features, together with POIs already stored from neighbouring tiles
 * (PostGIS lookup within POI_LOOKUP_RADIUS_M of the route). Each trail is
 * enriched (enrich.ts) and upserted by (provider, provider_id) in its own
 * transaction, under an advisory lock (per provider id, or per normalized
 * name for mergeable pieces) so concurrent tiles never create duplicates.
 *
 * CROSS-TILE PIECES. OSM "waygroup/<id>" trails only see the ways of one
 * tile, so a named trail crossing a tile edge arrives once per tile, as
 * that tile's part, under the same or a different waygroup id. Each piece
 * is stored in catalog_trail_parts (keyed by piece id + tile); a piece with
 * no row of its own is merged into an existing visible waygroup trail with
 * the same normalized name within MERGE_RADIUS_M (25 m), recording its id
 * as an alias. The row's geometry is the PostGIS union of its parts (the
 * straddling way dissolves), re-assembled into a route, and every derived
 * field is recomputed from it; the existing id and slug are kept.
 *
 * RETIREMENT. Only after a complete, successful sync: trails this tile owns
 * that were not returned are hidden (never deleted) with an honest reason,
 * and POIs located in the tile that were not returned are deleted. Capped or
 * partially failed syncs retire nothing.
 *
 * Nothing is invented: unavailable elevation, admin names or time zone
 * stay null/unknown; a failed fetch marks the tile failed with the reason
 * and a backoff, and existing data is left untouched.
 */

export const INGEST_BUDGET_MS = 200_000;
export const FETCH_BUDGET_MS = 150_000;
export const MAX_TRAILS_PER_TILE = 3_000;
export const MAX_POIS_PER_TILE = 20_000;
/** Pieces of a waygroup trail this close (geography) with the same name are one trail. */
export const MERGE_RADIUS_M = 25;
/**
 * Provider id prefixes of trails that are only partial per tile and may be
 * merged across tiles (OSM way groups). Complete routes (relations) are not.
 */
export const MERGEABLE_ID_PREFIX: Partial<Record<ProviderId, string>> = { osm: "waygroup/" };

export type ElevationFn = (lines: Line[], opts: { signal?: AbortSignal }) => Promise<ElevationSnapshot | null>;

export interface IngestDeps {
  /** Provider to fetch from (default: the registry entry for providerId). */
  provider?: TrailDataProvider;
  /** DEM elevation for a geometry (default: elevationProfileFor). Null when unavailable. */
  elevation?: ElevationFn;
  /** Administrative names at a point (default: reverseAdminArea). Null when unavailable. */
  reverseAdmin?: (lat: number, lng: number) => Promise<AdminArea | null>;
  /** IANA time zone at a point (default: timezoneAt). */
  timezone?: (lat: number, lng: number) => string | null;
  /** Clock for the human-readable retirement date (default: new Date()). */
  now?: () => Date;
  /** Whole-run budget (default INGEST_BUDGET_MS); the fetch gets min(FETCH_BUDGET_MS, this). */
  budgetMs?: number;
  fetchBudgetMs?: number;
  /** External cancellation. */
  signal?: AbortSignal;
  maxTrails?: number;
  maxPois?: number;
  /** Override the provider's global fetch concurrency cap (tests). */
  concurrencyCap?: number;
  /** Override CATALOG_TILE_TTL_DAYS. */
  ttlDays?: number;
}

export interface IngestCounts {
  trails: number;
  inserted: number;
  updated: number;
  merged: number;
  skipped: number;
  failedTrails: number;
  pois: number;
  retired: number;
  poisRemoved: number;
}

export type IngestResult =
  | ({
      outcome: "done";
      layer: CatalogLayer;
      provider: string;
      tileKey: string;
      capped: { trails: boolean; pois: boolean };
      durationMs: number;
      /** Stored as the tile's last_error when some trails could not be saved. */
      note: string | null;
    } & IngestCounts)
  | {
      outcome: "noop";
      tileKey: string;
      reason: "invalid_tile" | "provider_unavailable" | "busy" | "in_progress" | "not_due";
    }
  | {
      outcome: "failed";
      tileKey: string;
      error: string;
      /** Worth retrying soon (network, timeouts, 5xx, database); false for e.g. a rejected query. */
      retryable: boolean;
      attempts: number | null;
      nextRefreshAt: Date | null;
    };

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

interface Budget {
  /** Aborts when the whole run is out of time or cancelled. */
  total: AbortSignal;
  /** Aborts when the fetch is out of time (or `total` aborts). */
  fetch: AbortSignal;
  why(): "timeout" | "fetch_timeout" | "cancelled" | null;
  /** The fetch finished: its own deadline no longer applies. */
  fetchDone(): void;
  dispose(): void;
}

function startBudget(totalMs: number, fetchMs: number, external?: AbortSignal): Budget {
  const total = new AbortController();
  const fetch = new AbortController();
  let why: "timeout" | "fetch_timeout" | "cancelled" | null = null;
  const abortAll = (reason: typeof why) => {
    if (!why) why = reason;
    total.abort();
    fetch.abort();
  };
  const onExternal = () => abortAll("cancelled");
  if (external?.aborted) onExternal();
  external?.addEventListener("abort", onExternal, { once: true });
  const t1 = setTimeout(() => abortAll("timeout"), Math.max(0, totalMs));
  const t2 = setTimeout(() => {
    if (!why) why = "fetch_timeout";
    fetch.abort();
  }, Math.max(0, Math.min(fetchMs, totalMs)));
  return {
    total: total.signal,
    fetch: fetch.signal,
    why: () => why,
    fetchDone: () => clearTimeout(t2),
    dispose() {
      clearTimeout(t1);
      clearTimeout(t2);
      external?.removeEventListener("abort", onExternal);
    },
  };
}

class BudgetExceeded extends Error {
  constructor() {
    super("ingestion time budget exceeded");
    this.name = "BudgetExceeded";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const positiveInt = (v: number | undefined, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback);

function isEnabledSafely(p: TrailDataProvider): boolean {
  try {
    return p.isEnabled() === true;
  } catch {
    return false;
  }
}

const defaultElevation: ElevationFn = (lines, opts) => elevationProfileFor(lines, { signal: opts.signal });

interface RunContext {
  layer: CatalogLayer;
  provider: TrailDataProvider;
  tile: Tile;
  syncStart: string;
  signal: AbortSignal;
  mergePrefix: string | null;
  elevation: (lines: Line[]) => Promise<ElevationSnapshot | null>;
  admin: (p: LngLat) => Promise<AdminArea | null>;
  timezone: (lat: number, lng: number) => string | null;
}

type TrailOutcome = "inserted" | "updated" | "merged" | "skipped";

/** Thrown inside a trail's transaction to roll it back and count the trail as skipped. */
class SkipTrail extends Error {
  constructor() {
    super("trail skipped");
    this.name = "SkipTrail";
  }
}

function validTrail(t: NormalizedTrail, providerId: string): boolean {
  return (
    t !== null &&
    typeof t === "object" &&
    t.provider === providerId &&
    typeof t.providerId === "string" &&
    t.providerId.length >= 1 &&
    t.providerId.length <= 200 &&
    typeof t.name === "string" &&
    t.name.trim().length > 0 &&
    Array.isArray(t.lines)
  );
}

/**
 * Enrich and store one trail (see the module header). Network-bound admin
 * lookups (Nominatim, globally throttled) happen before the transaction;
 * terrain tiles (cached in-process) are sampled inside it, because merged
 * geometry is only known once the parts are locked.
 */
async function processTrail(ctx: RunContext, t: NormalizedTrail): Promise<TrailOutcome> {
  const piece = cleanLines(t.lines);
  if (piece.length === 0 || !(linesLengthM(piece) >= 1)) return "skipped";
  const pieceCentroid = trailCentroid(piece)!;
  const admin = await ctx.admin(pieceCentroid);
  const mergeable = ctx.mergePrefix !== null && t.providerId.startsWith(ctx.mergePrefix);
  const lockKey = mergeable ? `catalog_trail:${t.provider}:name:${nameKey(t.name)}` : `catalog_trail:${t.provider}:id:${t.providerId}`;

  try {
    return await storeTrail(ctx, t, piece, pieceCentroid, admin, mergeable, lockKey);
  } catch (err) {
    if (err instanceof SkipTrail) return "skipped";
    throw err;
  }
}

async function storeTrail(
  ctx: RunContext,
  t: NormalizedTrail,
  piece: Line[],
  pieceCentroid: LngLat,
  admin: AdminArea | null,
  mergeable: boolean,
  lockKey: string,
): Promise<TrailOutcome> {
  const pieceAttributes = attributesOf(t);
  return withSystem(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${lockKey}))`;
    let stored = await repo.findTrailForUpdate(tx, t.provider, t.providerId);
    let alias: string | null = null;
    if (!stored && mergeable) {
      const key = nameKey(t.name);
      const candidates = await repo.mergeCandidates(tx, t.provider, ctx.mergePrefix!, piece, MERGE_RADIUS_M, ctx.tile.key, ctx.syncStart);
      const match = candidates.find((c) => nameKey(c.name) === key);
      if (match) {
        stored = await repo.readTrailForUpdate(tx, match.id);
        if (stored) alias = t.providerId;
      }
    }

    let lines: Line[] = piece;
    let routeType = t.routeType;
    let attributes = pieceAttributes;
    if (stored && mergeable) {
      if (stored.partCount === 0) {
        // A row stored before parts existed: keep its geometry as a part of the tile it lies in.
        await repo.seedPartFromTrail(tx, stored.id, tileForPoint(ctx.layer, stored.firstVertex.lng, stored.firstVertex.lat).key);
      }
      await repo.upsertPart(tx, stored.id, t.provider, t.providerId, ctx.tile.key, piece, pieceAttributes);
      const merged = await repo.mergedPartsGeometry(tx, stored.id, ctx.tile.key, ctx.syncStart, {
        partId: t.providerId,
        tileKey: ctx.tile.key,
      });
      if (merged.partCount > 1 && merged.lines.length > 0) {
        const assembled = assembleRoute(merged.lines);
        if (assembled.lines.length > 0) {
          lines = assembled.lines;
          routeType = assembled.routeType;
        }
        attributes = combineAttributes(pieceAttributes, merged.otherAttributes);
      }
    }

    const pois = await repo.nearbyOutdoorPois(tx, lines, POI_LOOKUP_RADIUS_M, ENRICHMENT_POI_CATEGORIES);
    // Measure linear routes from their trailhead (gain, one-way duration).
    if (routeType === "linear") lines = orientFromTrailhead(lines, selectTrailhead(lines, pois)?.point ?? null);
    const sameGeometry = stored !== null && stored.geomHash === geometryHash(lines);
    const elevation = sameGeometry && stored!.elevation ? stored!.elevation : await ctx.elevation(lines);
    const centroid = trailCentroid(lines) ?? pieceCentroid;
    const keepIdentity = stored !== null && stored.providerId !== t.providerId;
    const record = buildTrailRecord({
      provider: t.provider,
      // A merged row keeps its own id (slug fallback hash) and source link.
      providerId: keepIdentity ? stored!.providerId : t.providerId,
      attributes,
      lines,
      routeType,
      sourceName: t.sourceName,
      sourceUrl: keepIdentity ? stored!.sourceUrl : t.sourceUrl,
      sourceLicense: t.sourceLicense,
      elevation,
      pois,
      admin,
      timezone: ctx.timezone(centroid.lat, centroid.lng),
    });
    // Unusable after all (e.g. no storable name): roll back any part written above.
    if (!record) throw new SkipTrail();

    if (stored) {
      await repo.updateTrail(tx, stored, record, { alias });
      return alias ? "merged" : "updated";
    }
    const inserted = await repo.insertTrail(tx, record);
    if (inserted) {
      if (mergeable) await repo.upsertPart(tx, inserted.id, t.provider, t.providerId, ctx.tile.key, piece, pieceAttributes);
      return "inserted";
    }
    // Inserted concurrently by a writer that did not take our lock: update that row.
    const again = await repo.findTrailForUpdate(tx, t.provider, t.providerId);
    if (!again) throw new Error("trail row vanished after a concurrent insert");
    await repo.updateTrail(tx, again, record, { alias: null });
    if (mergeable) await repo.upsertPart(tx, again.id, t.provider, t.providerId, ctx.tile.key, piece, pieceAttributes);
    return "updated";
  });
}

/** Complete routes first, then longer trails: what survives a cap matters most. */
function orderForIngest(trails: NormalizedTrail[], mergePrefix: string | null): NormalizedTrail[] {
  const isPiece = (t: NormalizedTrail) => mergePrefix !== null && t.providerId.startsWith(mergePrefix);
  const length = new Map(trails.map((t) => [t, linesLengthM(cleanLines(t.lines))]));
  return [...trails].sort(
    (a, b) =>
      Number(isPiece(a)) - Number(isPiece(b)) ||
      (length.get(b) ?? 0) - (length.get(a) ?? 0) ||
      (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load one tile of one provider (see the module header). Never throws:
 * outcomes are "done", "noop" (not claimable now: busy, in progress, not
 * due, invalid) or "failed" (the tile is marked failed with backoff;
 * `retryable` says whether a quick retry is worthwhile).
 */
export async function ingestTile(layer: CatalogLayer, providerId: string, tileKey: string, deps: IngestDeps = {}): Promise<IngestResult> {
  const startedMs = Date.now();
  const key = typeof tileKey === "string" ? tileKey : String(tileKey);
  const tile = (CATALOG_LAYERS as readonly string[]).includes(layer) && typeof tileKey === "string" ? tileFromKey(layer, tileKey) : null;
  if (!tile) return { outcome: "noop", tileKey: key, reason: "invalid_tile" };

  const provider = deps.provider ?? providerById(providerId);
  if (!provider || provider.id !== providerId || !provider.layers.includes(layer) || !isEnabledSafely(provider)) {
    return { outcome: "noop", tileKey: key, reason: "provider_unavailable" };
  }

  let claim: repo.ClaimResult;
  try {
    claim = await repo.claimTile(layer, provider.id, tile, positiveInt(deps.concurrencyCap, fetchConcurrencyFor(provider.id)));
  } catch (err) {
    log.warn("catalog.tile_claim_failed", { layer, provider: provider.id, tileKey: key, error: errorText(err) });
    return { outcome: "failed", tileKey: key, error: `Could not claim the tile: ${redactString(errorText(err)).slice(0, 200)}`, retryable: true, attempts: null, nextRefreshAt: null };
  }
  if (claim.status !== "claimed") return { outcome: "noop", tileKey: key, reason: claim.status };

  const totalMs = positiveInt(deps.budgetMs, INGEST_BUDGET_MS);
  const budget = startBudget(totalMs, positiveInt(deps.fetchBudgetMs, FETCH_BUDGET_MS), deps.signal);
  const reverse = deps.reverseAdmin ?? reverseAdminArea;
  const adminMemo = new Map<string, Promise<AdminArea | null>>();
  const elevationFn = deps.elevation ?? defaultElevation;
  const timezoneFn = deps.timezone ?? timezoneAt;
  const ctx: RunContext = {
    layer,
    provider,
    tile,
    syncStart: claim.syncStart,
    signal: budget.total,
    mergePrefix: MERGEABLE_ID_PREFIX[provider.id] ?? null,
    async elevation(lines) {
      try {
        return await elevationFn(lines, { signal: budget.total });
      } catch (err) {
        if (budget.total.aborted) throw new BudgetExceeded();
        log.warn("catalog.elevation_failed", { tileKey: key, error: errorText(err) });
        return null;
      }
    },
    admin(p) {
      const cell = adminCellKey(p.lat, p.lng);
      let pending = adminMemo.get(cell);
      if (!pending) {
        pending = Promise.resolve()
          .then(() => reverse(p.lat, p.lng))
          .catch((err: unknown) => {
            log.warn("catalog.admin_lookup_failed", { tileKey: key, error: errorText(err) });
            return null;
          });
        adminMemo.set(cell, pending);
      }
      return pending;
    },
    timezone(lat, lng) {
      try {
        return timezoneFn(lat, lng);
      } catch {
        return null;
      }
    },
  };

  const counts: IngestCounts = { trails: 0, inserted: 0, updated: 0, merged: 0, skipped: 0, failedTrails: 0, pois: 0, retired: 0, poisRemoved: 0 };
  let stage: "fetch" | "store" = "fetch";
  try {
    const result = await provider.fetchArea(layer, tile.bbox, { signal: budget.fetch });
    budget.fetchDone();
    if (budget.total.aborted) throw new BudgetExceeded();
    if (!result || typeof result !== "object" || !Array.isArray(result.pois) || !Array.isArray(result.trails)) {
      throw new Error(`${provider.label} returned an invalid result`);
    }
    stage = "store";

    // POIs first: they inform trailheads and features.
    const maxPois = positiveInt(deps.maxPois, MAX_POIS_PER_TILE);
    const pois = result.pois.filter((p: NormalizedPoi) => p && p.layer === layer && p.provider === provider.id);
    const poisCapped = pois.length > maxPois;
    if (poisCapped) log.warn("catalog.tile_pois_capped", { tileKey: key, provider: provider.id, returned: pois.length, kept: maxPois });
    counts.pois = await withSystem((tx) => repo.upsertPois(tx, pois.slice(0, maxPois)));

    // Trails (outdoor layer only).
    const maxTrails = positiveInt(deps.maxTrails, MAX_TRAILS_PER_TILE);
    const trails = layer === "outdoor" ? orderForIngest(result.trails.filter((t) => validTrail(t, provider.id)), ctx.mergePrefix) : [];
    const trailsCapped = trails.length > maxTrails;
    if (trailsCapped) log.warn("catalog.tile_trails_capped", { tileKey: key, provider: provider.id, returned: trails.length, kept: maxTrails });
    let firstError: string | null = null;
    for (const t of trails.slice(0, maxTrails)) {
      if (budget.total.aborted) throw new BudgetExceeded();
      try {
        const outcome = await processTrail(ctx, t);
        counts[outcome]++;
        if (outcome !== "skipped") counts.trails++;
      } catch (err) {
        if (budget.total.aborted || err instanceof BudgetExceeded) throw new BudgetExceeded();
        counts.failedTrails++;
        firstError ??= errorText(err);
        log.warn("catalog.trail_store_failed", { tileKey: key, providerId: t.providerId, error: errorText(err) });
      }
    }
    if (counts.failedTrails > 0 && counts.trails === 0) {
      throw new Error(`None of the ${counts.failedTrails} trail(s) could be saved: ${firstError}`);
    }
    const note = counts.failedTrails > 0 ? `${counts.failedTrails} of ${counts.failedTrails + counts.trails} trail(s) could not be saved; they will be retried on the next refresh.` : null;

    // Retire + mark ready, fenced by the claim.
    const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
    const reason = `Not found in ${provider.label} on ${today}`;
    const ttlDays = positiveInt(deps.ttlDays, env().CATALOG_TILE_TTL_DAYS);
    // ±10 % jitter so tiles loaded together do not all refresh at once.
    const ttlSeconds = ttlDays * 86_400 * (0.9 + Math.random() * 0.2);
    const held = await withSystem(async (tx) => {
      if (!(await repo.lockHeldTile(tx, layer, provider.id, tile.key, claim.token))) return false;
      if (layer === "outdoor" && !trailsCapped && counts.failedTrails === 0) {
        const r = await repo.retireMissing(tx, layer, provider.id, tile, claim.syncStart, reason);
        counts.retired = r.retired;
      }
      if (!poisCapped) counts.poisRemoved = await repo.deleteStalePois(tx, provider.id, layer, tile, claim.syncStart);
      return repo.markTileReady(tx, layer, provider.id, tile.key, claim.token, { trailCount: counts.trails, poiCount: counts.pois, ttlSeconds, note });
    });
    if (!held) {
      log.warn("catalog.tile_claim_lost", { layer, provider: provider.id, tileKey: key });
      return { outcome: "failed", tileKey: key, error: "Another worker took over this tile before the sync finished.", retryable: false, attempts: null, nextRefreshAt: null };
    }

    const durationMs = Date.now() - startedMs;
    log.info("catalog.tile_ingested", { layer, provider: provider.id, tileKey: key, ...counts, durationMs });
    return { outcome: "done", layer, provider: provider.id, tileKey: key, ...counts, capped: { trails: trailsCapped, pois: poisCapped }, durationMs, note };
  } catch (err) {
    const why = budget.why();
    let message: string;
    let retryable: boolean;
    if (why === "cancelled") {
      message = "Loading was cancelled before it finished.";
      retryable = true;
    } else if (why === "fetch_timeout" && stage === "fetch") {
      message = `${provider.label} did not answer within ${Math.round(Math.min(positiveInt(deps.fetchBudgetMs, FETCH_BUDGET_MS), totalMs) / 1000)} s.`;
      retryable = true;
    } else if (why === "timeout" || err instanceof BudgetExceeded) {
      message = `Loading took longer than the ${Math.round(totalMs / 1000)} s time budget.`;
      retryable = true;
    } else if (err instanceof ProviderError) {
      message = `${PROVIDER_LABELS[err.provider] ?? provider.label}: ${err.message}`;
      retryable = err.retryable;
    } else if (err instanceof RangeError) {
      message = err.message;
      retryable = false;
    } else {
      message = errorText(err);
      retryable = true;
    }
    message = redactString(message).slice(0, 300);
    let marked: Awaited<ReturnType<typeof repo.markTileFailed>> = null;
    try {
      marked = await repo.markTileFailed(layer, provider.id, tile.key, claim.token, message);
    } catch (markErr) {
      log.error("catalog.tile_mark_failed_failed", { tileKey: key, error: errorText(markErr) });
    }
    log.warn("catalog.tile_failed", { layer, provider: provider.id, tileKey: key, stage, retryable, error: message, attempts: marked?.attempts ?? null, ...counts });
    return { outcome: "failed", tileKey: key, error: message, retryable, attempts: marked?.attempts ?? null, nextRefreshAt: marked?.nextRefreshAt ?? null };
  } finally {
    budget.dispose();
  }
}

/**
 * Load a few tiles right now (after a search response), in parallel, never
 * throwing. Tiles that cannot be claimed (cap reached, in progress, loaded)
 * are left to the job runner.
 */
export async function ingestTilesNow(layer: CatalogLayer, items: readonly { provider: string; tileKey: string }[], deps: IngestDeps = {}): Promise<IngestResult[]> {
  const settled = await Promise.allSettled(items.map((i) => ingestTile(layer, i.provider, i.tileKey, deps)));
  return settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { outcome: "failed" as const, tileKey: items[i].tileKey, error: errorText(s.reason), retryable: true, attempts: null, nextRefreshAt: null },
  );
}
