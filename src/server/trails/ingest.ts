import "server-only";
import { revalidatePath } from "next/cache";
import { env } from "@/config/env";
import { CATALOG_LAYERS, trailPath, type CatalogLayer, type LngLat } from "@/domain/catalog";
import { withSystem } from "@/server/db";
import { countryCodeAt } from "@/server/geo/country";
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
import { UNKNOWN_REGION_SLUG } from "./slug";
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
 * short transaction, under an advisory lock (per provider id, or per
 * normalized name for mergeable pieces) so concurrent tiles never create
 * duplicates. No network request runs while a transaction is open: admin
 * names are looked up before it; when the geometry to store needs a DEM
 * profile, the transaction rolls back, terrain tiles are fetched with no
 * lock or connection held, and the write runs again, using that profile
 * only if the geometry is still the same (geometry hash). Lock waits are
 * bounded (TRAIL_LOCK_TIMEOUT_MS).
 *
 * PLACE NAMES. The country comes from the trail's exact point (offline
 * borders, enrich.ts resolvePlace); region and nearest place from Nominatim
 * reverse geocoding per 0.1° cell, memoized per run for definite answers
 * only: a failed lookup is retried for the next trail of the cell (at most
 * ADMIN_ATTEMPTS_PER_CELL times per cell; after ADMIN_FAILURES_BEFORE_PAUSE
 * consecutive failures the run stops asking). A trail stored with an unknown
 * region because names were unavailable makes the tile refresh within
 * NAMES_RETRY_TTL_HOURS instead of the normal TTL, so its region is filled
 * in soon; when that moves its path, the old path redirects (redirects.ts).
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
/** Reverse-geocoding attempts per 0.1° cell per run (a failure is retried for a later trail of the cell). */
export const ADMIN_ATTEMPTS_PER_CELL = 2;
/** After this many consecutive failed reverse lookups the run stops asking (the service is down or saturated). */
export const ADMIN_FAILURES_BEFORE_PAUSE = 3;
/** A tile that stored trails without place names (lookup unavailable) refreshes within this many hours. */
export const NAMES_RETRY_TTL_HOURS = 6;
/** Longest wait for a trail's advisory lock or row locks; a longer wait fails the trail (retried next refresh). */
export const TRAIL_LOCK_TIMEOUT_MS = 15_000;
/** Transaction attempts per trail when its geometry changes between the elevation fetch and the write. */
export const MAX_STORE_ROUNDS = 3;

export type ElevationFn = (lines: Line[], opts: { signal?: AbortSignal }) => Promise<ElevationSnapshot | null>;

export interface IngestDeps {
  /** Provider to fetch from (default: the registry entry for providerId). */
  provider?: TrailDataProvider;
  /** DEM elevation for a geometry (default: elevationProfileFor). Null when unavailable. */
  elevation?: ElevationFn;
  /** Administrative names at a point (default: reverseAdminArea). Null when unavailable. */
  reverseAdmin?: (lat: number, lng: number, opts?: { signal?: AbortSignal }) => Promise<AdminArea | null>;
  /** Country at an exact point (default: countryCodeAt, offline borders). Null when unknown. */
  countryAt?: (lat: number, lng: number) => string | null;
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
  /** Trails stored with an unknown region because reverse geocoding was unavailable (the tile refreshes soon). */
  namesMissing: number;
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
  /** Admin names for a point's cell: an AdminArea (all-null for "no address"), or null when unavailable. */
  admin: (p: LngLat) => Promise<AdminArea | null>;
  timezone: (lat: number, lng: number) => string | null;
  countryAt: (lat: number, lng: number) => string | null;
}

type TrailOutcome = "inserted" | "updated" | "merged" | "skipped";

interface TrailResult {
  outcome: TrailOutcome;
  /** Stored with an unknown region because the admin lookup was unavailable. */
  namesMissing: boolean;
  /** The trail's page path changed (old path now redirects); set after the write committed. */
  moved?: TrailMove;
}

interface TrailMove {
  from: string;
  to: string;
}

/** Above this many moved trails in one tile, every cached trail page is expired at once. */
const MAX_MOVES_PURGED_ONE_BY_ONE = 25;

/**
 * Trail pages are cached (ISR, src/app/trail/[country]/[region]/[slug]).
 * After a tile commits, expire the pages it changed the meaning of: for each
 * moved trail its old path (a cached page that must now redirect) and its new
 * path (which may hold a cached redirect or 404 from before). Retired trails
 * are not tracked by path, so retirement expires every trail page; so do many
 * moves. Content changes of trails that keep their path wait for the page's
 * normal hourly revalidation.
 *
 * Outside a Next.js request (local scripts, tests) revalidatePath throws:
 * there is no page cache to purge there, so that is ignored.
 */
function purgeTrailPages(moves: TrailMove[], retired: number): void {
  if (moves.length === 0 && retired === 0) return;
  try {
    if (retired > 0 || moves.length > MAX_MOVES_PURGED_ONE_BY_ONE) {
      revalidatePath("/trail/[country]/[region]/[slug]", "page");
      return;
    }
    for (const m of moves) {
      revalidatePath(m.from);
      revalidatePath(m.to);
    }
  } catch {
    /* not inside a Next.js request: no page cache */
  }
}

/** Thrown inside a trail's transaction (rolling it back) when the geometry to store needs a DEM profile. */
class ElevationNeeded extends Error {
  constructor(
    readonly lines: Line[],
    readonly hash: string,
  ) {
    super("elevation needed");
    this.name = "ElevationNeeded";
  }
}

/** A DEM profile fetched outside any transaction for the geometry with this hash. */
interface PlannedElevation {
  hash: string;
  elevation: ElevationSnapshot | null;
}

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
 * Enrich and store one trail (see the module header). The network-bound
 * admin lookup (Nominatim, globally throttled) happens before any
 * transaction; terrain tiles are fetched between transactions (storeTrail).
 */
async function processTrail(ctx: RunContext, t: NormalizedTrail): Promise<TrailResult> {
  const piece = cleanLines(t.lines);
  if (piece.length === 0 || !(linesLengthM(piece) >= 1)) return { outcome: "skipped", namesMissing: false };
  const pieceCentroid = trailCentroid(piece)!;
  const admin = await ctx.admin(pieceCentroid);
  const mergeable = ctx.mergePrefix !== null && t.providerId.startsWith(ctx.mergePrefix);
  const lockKey = mergeable ? `catalog_trail:${t.provider}:name:${nameKey(t.name)}` : `catalog_trail:${t.provider}:id:${t.providerId}`;

  try {
    return await storeTrail(ctx, t, piece, pieceCentroid, admin, mergeable, lockKey);
  } catch (err) {
    if (err instanceof SkipTrail) return { outcome: "skipped", namesMissing: false };
    throw err;
  }
}

/**
 * Write one trail, fetching its DEM profile with no transaction open: the
 * first write attempt rolls back with ElevationNeeded when the geometry it
 * would store has no usable profile yet (new or changed geometry); the
 * profile is fetched, and the write runs again and uses it only if the
 * geometry it computes then is the same (a concurrent tile can change a
 * merged trail in between; then the profile is fetched again, at most
 * MAX_STORE_ROUNDS attempts in all).
 */
async function storeTrail(
  ctx: RunContext,
  t: NormalizedTrail,
  piece: Line[],
  pieceCentroid: LngLat,
  admin: AdminArea | null,
  mergeable: boolean,
  lockKey: string,
): Promise<TrailResult> {
  let planned: PlannedElevation | null = null;
  for (let round = 1; ; round++) {
    try {
      return await writeTrail(ctx, t, piece, pieceCentroid, admin, mergeable, lockKey, planned);
    } catch (err) {
      if (!(err instanceof ElevationNeeded)) throw err;
      if (round >= MAX_STORE_ROUNDS) {
        throw new Error("The trail changed while its elevation was being computed; it will be retried on the next refresh.");
      }
      // No transaction, lock or pooled connection is held while terrain tiles are fetched.
      planned = { hash: err.hash, elevation: await ctx.elevation(err.lines) };
    }
  }
}

async function writeTrail(
  ctx: RunContext,
  t: NormalizedTrail,
  piece: Line[],
  pieceCentroid: LngLat,
  admin: AdminArea | null,
  mergeable: boolean,
  lockKey: string,
  planned: PlannedElevation | null,
): Promise<TrailResult> {
  const pieceAttributes = attributesOf(t);
  return withSystem(async (tx) => {
    // Bounded waits: a stuck holder fails this trail (retried next refresh) instead of the whole run.
    await tx`select set_config('lock_timeout', ${`${TRAIL_LOCK_TIMEOUT_MS}ms`}, true)`;
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
    const hash = geometryHash(lines);
    let elevation: ElevationSnapshot | null;
    if (stored !== null && stored.geomHash === hash && stored.elevation) elevation = stored.elevation;
    else if (planned !== null && planned.hash === hash) elevation = planned.elevation;
    // Rolls back everything written above; storeTrail fetches the profile and calls again.
    else throw new ElevationNeeded(lines, hash);
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
      countryAt: ctx.countryAt,
    });
    // Unusable after all (e.g. no storable name): roll back any part written above.
    if (!record) throw new SkipTrail();
    /** Region of the stored row after the write: unknown because names were unavailable? */
    const namesMissing = (row: repo.StoredTrail | null) =>
      admin === null && (row === null || repo.identityMoves(row, record) ? record.regionSlug : row.regionSlug) === UNKNOWN_REGION_SLUG;

    const moveOf = (u: { slug: string; movedFrom: string | null }): TrailMove | undefined =>
      u.movedFrom ? { from: u.movedFrom, to: trailPath({ countryCode: record.countryCode, regionSlug: record.regionSlug, slug: u.slug }) } : undefined;
    if (stored) {
      const u = await repo.updateTrail(tx, stored, record, { alias });
      return { outcome: alias ? "merged" : "updated", namesMissing: namesMissing(stored), moved: moveOf(u) };
    }
    const inserted = await repo.insertTrail(tx, record);
    if (inserted) {
      if (mergeable) await repo.upsertPart(tx, inserted.id, t.provider, t.providerId, ctx.tile.key, piece, pieceAttributes);
      return { outcome: "inserted", namesMissing: namesMissing(null) };
    }
    // Inserted concurrently by a writer that did not take our lock: update that row.
    const again = await repo.findTrailForUpdate(tx, t.provider, t.providerId);
    if (!again) throw new Error("trail row vanished after a concurrent insert");
    const u = await repo.updateTrail(tx, again, record, { alias: null });
    if (mergeable) await repo.upsertPart(tx, again.id, t.provider, t.providerId, ctx.tile.key, piece, pieceAttributes);
    return { outcome: "updated", namesMissing: namesMissing(again), moved: moveOf(u) };
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
  /** Definite answers (and lookups in flight) per 0.1° cell; failures are not kept. */
  const adminMemo = new Map<string, Promise<AdminArea | null>>();
  const adminFailures = new Map<string, number>();
  let adminFailuresInARow = 0;
  const elevationFn = deps.elevation ?? defaultElevation;
  const timezoneFn = deps.timezone ?? timezoneAt;
  const countryFn = deps.countryAt ?? countryCodeAt;
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
      const known = adminMemo.get(cell);
      if (known) return known;
      // Unavailable for this run: this cell failed too often, or the service keeps failing.
      if ((adminFailures.get(cell) ?? 0) >= ADMIN_ATTEMPTS_PER_CELL || adminFailuresInARow >= ADMIN_FAILURES_BEFORE_PAUSE) {
        return Promise.resolve(null);
      }
      const pending = Promise.resolve()
        .then(() => reverse(p.lat, p.lng, { signal: budget.total }))
        .catch((err: unknown) => {
          log.warn("catalog.admin_lookup_failed", { tileKey: key, error: errorText(err) });
          return null;
        })
        .then((area) => {
          if (area) {
            adminFailuresInARow = 0;
            return area;
          }
          // A failure is not an answer: forget it, so the next trail of this cell asks again.
          adminMemo.delete(cell);
          adminFailures.set(cell, (adminFailures.get(cell) ?? 0) + 1);
          adminFailuresInARow++;
          if (adminFailuresInARow === ADMIN_FAILURES_BEFORE_PAUSE) {
            log.warn("catalog.admin_lookups_paused", { tileKey: key, failuresInARow: adminFailuresInARow });
          }
          return null;
        });
      adminMemo.set(cell, pending);
      return pending;
    },
    timezone(lat, lng) {
      try {
        return timezoneFn(lat, lng);
      } catch {
        return null;
      }
    },
    countryAt(lat, lng) {
      try {
        return countryFn(lat, lng);
      } catch {
        return null;
      }
    },
  };

  const counts: IngestCounts = { trails: 0, inserted: 0, updated: 0, merged: 0, skipped: 0, failedTrails: 0, namesMissing: 0, pois: 0, retired: 0, poisRemoved: 0 };
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
    const moves: TrailMove[] = [];
    for (const t of trails.slice(0, maxTrails)) {
      if (budget.total.aborted) throw new BudgetExceeded();
      try {
        const { outcome, namesMissing, moved } = await processTrail(ctx, t);
        counts[outcome]++;
        if (outcome !== "skipped") counts.trails++;
        if (namesMissing) counts.namesMissing++;
        if (moved) moves.push(moved);
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
    const notes: string[] = [];
    if (counts.failedTrails > 0) {
      notes.push(`${counts.failedTrails} of ${counts.failedTrails + counts.trails} trail(s) could not be saved; they will be retried on the next refresh.`);
    }
    if (counts.namesMissing > 0) {
      notes.push(`Place names were unavailable for ${counts.namesMissing} trail(s); the tile refreshes within ${NAMES_RETRY_TTL_HOURS} h to fill them in.`);
    }
    const note = notes.length > 0 ? notes.join(" ") : null;

    // Retire + mark ready, fenced by the claim.
    const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
    const reason = `Not found in ${provider.label} on ${today}`;
    const ttlDays = positiveInt(deps.ttlDays, env().CATALOG_TILE_TTL_DAYS);
    // ±10 % jitter so tiles loaded together do not all refresh at once.
    const jitter = 0.9 + Math.random() * 0.2;
    // Trails stored without place names: refresh soon (names fill in, the path moves with a redirect).
    const ttlSeconds = Math.min(ttlDays * 86_400, counts.namesMissing > 0 ? NAMES_RETRY_TTL_HOURS * 3_600 : Infinity) * jitter;
    const held = await withSystem(async (tx) => {
      if (!(await repo.lockHeldTile(tx, layer, provider.id, tile.key, claim.token))) return false;
      if (layer === "outdoor" && !trailsCapped && counts.failedTrails === 0) {
        const r = await repo.retireMissing(tx, layer, provider.id, tile, claim.syncStart, reason);
        counts.retired = r.retired;
      }
      if (!poisCapped) counts.poisRemoved = await repo.deleteStalePois(tx, provider.id, layer, tile, claim.syncStart);
      return repo.markTileReady(tx, layer, provider.id, tile.key, claim.token, { trailCount: counts.trails, poiCount: counts.pois, ttlSeconds, note });
    });
    // Trail writes and retirements are committed: expire the cached pages they changed.
    purgeTrailPages(moves, counts.retired);
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
