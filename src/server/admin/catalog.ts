import "server-only";
import { z } from "zod";
import { env } from "@/config/env";
import { CATALOG_LAYERS, trailPath, type Bbox, type CatalogLayer } from "@/domain/catalog";
import type { SessionUser } from "@/server/auth";
import { recordAudit, type AuditActor } from "@/server/audit";
import type { Tx } from "@/server/db";
import { tileFromKey } from "@/server/geo/tiles";
import { redactString } from "@/server/log";
import { PROVIDER_LABELS, type ProviderKey } from "@/server/providers/http";
import { providerById } from "@/server/trails/providers/registry";
import * as repo from "@/server/trails/repository";
import { assertCan, fail, guarded, ok, requiredText, systemTx, zodFail, type ActionResult } from "./common";
import { PROVIDER_COSTS, estimateMonthlyCostUsd, usageWarnings, type ProviderCostPolicy, type UsageWarning } from "./provider-costs";

/**
 * Admin "Trail data" (/admin/data): provider health and usage with cost
 * estimates, catalog coverage / ingestion status, catalog jobs, and trail
 * moderation.
 *
 * Reads require "integrations.view"; mutations (retry a tile, hide / unhide
 * a trail) require "catalog.manage" and are audited in the same
 * transaction. Every table involved is server-only (catalog_tiles,
 * external_api_usage, jobs) or writable only by trusted code
 * (catalog_trails), so queries run as systemTx after the permission check.
 *
 * Privacy: nothing here is about users. Tiles are 0.25° grid cells (~28 km)
 * of the catalog's coverage, not anyone's location; job payloads are reduced
 * to their tile reference before display.
 */

const VIEW = "integrations.view" as const;
const MANAGE = "catalog.manage" as const;
const LAST_ERROR_CHARS = 200;
const CATALOG_JOB_PATTERN = "catalog.%";

const actorOf = (user: SessionUser): AuditActor => ({ id: user.id, roles: user.roles });
const trimError = (s: string | null | undefined) => (s ? redactString(s).replace(/\s+/g, " ").trim().slice(0, LAST_ERROR_CHARS) : null);

// ---------------------------------------------------------------------------
// Providers: usage, cost, health
// ---------------------------------------------------------------------------

export interface UsageWindow {
  requests: number;
  errors: number;
  cacheHits: number;
  bytes: number;
  /** errors / requests; null when there were no requests. */
  errorRate: number | null;
}

export interface ProviderUsageRow {
  provider: string;
  label: string;
  /** False when the provider needs configuration that is missing (e.g. RIDB_API_KEY). */
  configured: boolean;
  today: UsageWindow;
  last7d: UsageWindow;
  last30d: UsageWindow;
  peakDayRequests7d: number;
  lastRequestAt: Date | null;
  lastSuccessAt: Date | null;
  lastStatus: number | null;
  /** Most recent recorded error (trimmed, redacted) and the UTC day it happened. */
  lastError: string | null;
  lastErrorDay: string | null;
  /** Null for a provider id without an entry in provider-costs.ts. */
  policy: ProviderCostPolicy | null;
  /** Estimate from the last 30 days under the configured pricing; null without a policy. */
  estimatedMonthlyCostUsd: number | null;
  warnings: UsageWarning[];
}

interface UsageAggRow {
  provider: string;
  requestsToday: number;
  errorsToday: number;
  cacheHitsToday: number;
  bytesToday: number;
  requests7d: number;
  errors7d: number;
  cacheHits7d: number;
  bytes7d: number;
  peakDayRequests7d: number;
  peakDayBytes7d: number;
  requests30d: number;
  errors30d: number;
  cacheHits30d: number;
  bytes30d: number;
  lastRequestAt: Date | null;
  lastSuccessAt: Date | null;
  lastStatus: number | null;
  lastError: string | null;
  lastErrorDay: string | null;
}

const usageWindow = (requests: number, errors: number, cacheHits: number, bytes: number): UsageWindow => ({
  requests,
  errors,
  cacheHits,
  bytes,
  errorRate: requests > 0 ? errors / requests : null,
});

function isConfigured(policy: ProviderCostPolicy | null): boolean {
  if (!policy?.keyEnv) return true;
  const v = env()[policy.keyEnv];
  return typeof v === "string" ? v.trim().length > 0 : Boolean(v);
}

/** Raw per-provider aggregates over external_api_usage (UTC days: today, last 7 incl. today, last 30 incl. today). */
async function usageAggregates(tx: Tx): Promise<UsageAggRow[]> {
  return tx<UsageAggRow[]>`
    with d as (select (now() at time zone 'utc')::date as today)
    select u.provider,
           coalesce(sum(u.requests) filter (where u.day = d.today), 0)::bigint as requests_today,
           coalesce(sum(u.errors) filter (where u.day = d.today), 0)::bigint as errors_today,
           coalesce(sum(u.cache_hits) filter (where u.day = d.today), 0)::bigint as cache_hits_today,
           coalesce(sum(u.bytes) filter (where u.day = d.today), 0)::bigint as bytes_today,
           coalesce(sum(u.requests) filter (where u.day >= d.today - 6), 0)::bigint as requests7d,
           coalesce(sum(u.errors) filter (where u.day >= d.today - 6), 0)::bigint as errors7d,
           coalesce(sum(u.cache_hits) filter (where u.day >= d.today - 6), 0)::bigint as cache_hits7d,
           coalesce(sum(u.bytes) filter (where u.day >= d.today - 6), 0)::bigint as bytes7d,
           coalesce(max(u.requests) filter (where u.day >= d.today - 6), 0)::bigint as peak_day_requests7d,
           coalesce(max(u.bytes) filter (where u.day >= d.today - 6), 0)::bigint as peak_day_bytes7d,
           coalesce(sum(u.requests) filter (where u.day >= d.today - 29), 0)::bigint as requests30d,
           coalesce(sum(u.errors) filter (where u.day >= d.today - 29), 0)::bigint as errors30d,
           coalesce(sum(u.cache_hits) filter (where u.day >= d.today - 29), 0)::bigint as cache_hits30d,
           coalesce(sum(u.bytes) filter (where u.day >= d.today - 29), 0)::bigint as bytes30d,
           max(u.last_request_at) as last_request_at,
           max(u.last_success_at) as last_success_at,
           (array_agg(u.last_status order by u.last_request_at desc nulls last, u.day desc)
              filter (where u.last_request_at is not null))[1] as last_status,
           (array_agg(u.last_error order by u.day desc) filter (where u.last_error is not null))[1] as last_error,
           (array_agg(u.day::text order by u.day desc) filter (where u.last_error is not null))[1] as last_error_day
      from public.external_api_usage u, d
     where u.day <= d.today
     group by u.provider`;
}

/** Provider-independent health signal: every request of the last 7 days failed. */
function healthWarnings(requests7d: number, errors7d: number): UsageWarning[] {
  if (requests7d > 0 && errors7d >= requests7d) {
    return [{ level: "critical", message: `All ${requests7d} request(s) of the last 7 days failed; the provider is unreachable or refusing Ghost Guide.` }];
  }
  return [];
}

/** Turn aggregates into page rows: every known provider (in PROVIDER_LABELS order), then unknown ids. Pure. */
export function buildProviderUsageRows(aggs: readonly UsageAggRow[], now: Date = new Date()): ProviderUsageRow[] {
  const byProvider = new Map(aggs.map((a) => [a.provider, a]));
  const known = Object.keys(PROVIDER_LABELS) as ProviderKey[];
  const ids = [...known, ...aggs.map((a) => a.provider).filter((p) => !(known as string[]).includes(p)).sort()];
  return ids.map((id) => {
    const a = byProvider.get(id);
    const policy = (PROVIDER_COSTS as Record<string, ProviderCostPolicy | undefined>)[id] ?? null;
    const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const snapshot = {
      requestsToday: n(a?.requestsToday),
      errorsToday: n(a?.errorsToday),
      bytesToday: n(a?.bytesToday),
      peakDayRequests7d: n(a?.peakDayRequests7d),
      peakDayBytes7d: n(a?.peakDayBytes7d),
      requests30d: n(a?.requests30d),
      lastStatus: a?.lastStatus ?? null,
    };
    return {
      provider: id,
      label: (PROVIDER_LABELS as Record<string, string>)[id] ?? id,
      configured: isConfigured(policy),
      today: usageWindow(snapshot.requestsToday, snapshot.errorsToday, n(a?.cacheHitsToday), snapshot.bytesToday),
      last7d: usageWindow(n(a?.requests7d), n(a?.errors7d), n(a?.cacheHits7d), n(a?.bytes7d)),
      last30d: usageWindow(snapshot.requests30d, n(a?.errors30d), n(a?.cacheHits30d), n(a?.bytes30d)),
      peakDayRequests7d: snapshot.peakDayRequests7d,
      lastRequestAt: a?.lastRequestAt ?? null,
      lastSuccessAt: a?.lastSuccessAt ?? null,
      lastStatus: snapshot.lastStatus,
      lastError: trimError(a?.lastError),
      lastErrorDay: a?.lastErrorDay ?? null,
      policy,
      estimatedMonthlyCostUsd: policy ? estimateMonthlyCostUsd(policy.pricing, snapshot.requests30d) : null,
      warnings: [...(policy ? usageWarnings(policy, snapshot, now) : []), ...healthWarnings(n(a?.requests7d), n(a?.errors7d))],
    };
  });
}

export async function getProviderUsage(user: SessionUser, now: Date = new Date()): Promise<ProviderUsageRow[]> {
  assertCan(user, VIEW);
  const aggs = await systemTx((tx) => usageAggregates(tx));
  return buildProviderUsageRows(aggs, now);
}

// ---------------------------------------------------------------------------
// Coverage / ingestion
// ---------------------------------------------------------------------------

export interface TileCountRow {
  layer: CatalogLayer;
  provider: string;
  pending: number;
  fetching: number;
  ready: number;
  failed: number;
  total: number;
  /** Ready tiles whose latest refresh failed (still serving their last data). */
  readyRefreshFailing: number;
}

export interface TileListRow {
  layer: CatalogLayer;
  provider: string;
  tileKey: string;
  /** Tile bounds (from the grid key), for orientation. */
  bbox: Bbox | null;
  status: repo.TileStatus;
  attempts: number;
  lastError: string | null;
  lastSyncedAt: Date | null;
  nextRefreshAt: Date | null;
  trailCount: number;
  poiCount: number;
  updatedAt: Date;
  /** Status of the load job of the tile's current request (null: none). */
  jobStatus: string | null;
  /** The provider is registered, enabled and serves the layer (a retry can run). */
  retryable: boolean;
}

export interface CoverageOverview {
  counts: TileCountRow[];
  /** Ready/failed tiles whose refresh or retry is due now, and the longest-waiting one. */
  dueNow: number;
  oldestDueAt: Date | null;
  /** Next scheduled refresh among tiles not yet due. */
  nextRefreshAt: Date | null;
  /** Tiles stuck in "fetching" longer than the stale-fetch threshold (a crashed worker). */
  staleFetching: number;
  failures: TileListRow[];
  recentlySynced: TileListRow[];
}

function providerCanLoad(provider: string, layer: CatalogLayer): boolean {
  const p = providerById(provider);
  if (!p || !p.layers.includes(layer)) return false;
  try {
    return p.isEnabled() === true;
  } catch {
    return false;
  }
}

/** Full rows (with job status) for the given tiles, in input order. */
async function tileRows(tx: Tx, items: { layer: CatalogLayer; provider: string; tileKey: string; updatedAt: Date }[]): Promise<TileListRow[]> {
  const out = new Map<string, repo.TileRow>();
  for (const layer of CATALOG_LAYERS) {
    const pairs = items.filter((i) => i.layer === layer).map((i) => ({ provider: i.provider, tileKey: i.tileKey }));
    for (const row of await repo.readTiles(tx, layer, pairs)) out.set(`${layer}\u0000${row.provider}\u0000${row.tileKey}`, row);
  }
  return items.flatMap((i) => {
    const r = out.get(`${i.layer}\u0000${i.provider}\u0000${i.tileKey}`);
    if (!r) return [];
    return [
      {
        layer: i.layer,
        provider: r.provider,
        tileKey: r.tileKey,
        bbox: tileFromKey(i.layer, r.tileKey)?.bbox ?? null,
        status: r.status,
        attempts: r.attempts,
        lastError: trimError(r.lastError),
        lastSyncedAt: r.lastSyncedAt,
        nextRefreshAt: r.nextRefreshAt,
        trailCount: r.trailCount,
        poiCount: r.poiCount,
        updatedAt: i.updatedAt,
        jobStatus: r.jobStatus,
        retryable: providerCanLoad(r.provider, i.layer),
      },
    ];
  });
}

export async function getCoverageOverview(user: SessionUser, opts: { failures?: number; recent?: number } = {}): Promise<CoverageOverview> {
  assertCan(user, VIEW);
  const failuresLimit = Math.min(100, Math.max(1, opts.failures ?? 20));
  const recentLimit = Math.min(100, Math.max(1, opts.recent ?? 10));
  return systemTx(async (tx) => {
    const countRows = await tx<{ layer: CatalogLayer; provider: string; status: repo.TileStatus; n: number; refreshFailing: number }[]>`
      select layer, provider, status, count(*)::int as n,
             count(*) filter (where status = 'ready' and attempts > 0)::int as refresh_failing
        from public.catalog_tiles
       group by layer, provider, status`;
    const counts = new Map<string, TileCountRow>();
    for (const r of countRows) {
      const key = `${r.layer}\u0000${r.provider}`;
      const row = counts.get(key) ?? { layer: r.layer, provider: r.provider, pending: 0, fetching: 0, ready: 0, failed: 0, total: 0, readyRefreshFailing: 0 };
      if (r.status === "pending" || r.status === "fetching" || r.status === "ready" || r.status === "failed") row[r.status] += r.n;
      row.total += r.n;
      row.readyRefreshFailing += r.refreshFailing;
      counts.set(key, row);
    }

    const [due] = await tx<{ dueNow: number; oldestDueAt: Date | null; nextRefreshAt: Date | null; staleFetching: number }[]>`
      select count(*) filter (where status in ('ready', 'failed') and coalesce(next_refresh_at <= now(), true))::int as due_now,
             min(next_refresh_at) filter (where status in ('ready', 'failed') and next_refresh_at <= now()) as oldest_due_at,
             min(next_refresh_at) filter (where status in ('ready', 'failed') and next_refresh_at > now()) as next_refresh_at,
             count(*) filter (where status = 'fetching' and (fetch_started_at is null
                 or fetch_started_at < now() - make_interval(mins => ${repo.STALE_FETCH_MINUTES})))::int as stale_fetching
        from public.catalog_tiles`;

    // Consecutive failures (attempts > 0): never-loaded tiles that failed, and loaded tiles whose refresh failed.
    const failed = await tx<{ layer: CatalogLayer; provider: string; tileKey: string; updatedAt: Date }[]>`
      select layer, provider, tile_key, updated_at
        from public.catalog_tiles
       where attempts > 0
       order by updated_at desc, tile_key
       limit ${failuresLimit}::int`;
    const recent = await tx<{ layer: CatalogLayer; provider: string; tileKey: string; updatedAt: Date }[]>`
      select layer, provider, tile_key, updated_at
        from public.catalog_tiles
       where last_synced_at is not null
       order by last_synced_at desc, tile_key
       limit ${recentLimit}::int`;

    return {
      counts: [...counts.values()].sort((a, b) => (a.layer < b.layer ? -1 : a.layer > b.layer ? 1 : a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0)),
      dueNow: due?.dueNow ?? 0,
      oldestDueAt: due?.oldestDueAt ?? null,
      nextRefreshAt: due?.nextRefreshAt ?? null,
      staleFetching: due?.staleFetching ?? 0,
      failures: await tileRows(tx, failed),
      recentlySynced: await tileRows(tx, recent),
    };
  });
}

// ---------------------------------------------------------------------------
// Catalog contents
// ---------------------------------------------------------------------------

export interface TrailCountRow {
  key: string;
  visible: number;
  /** Hidden by moderation (stays hidden across refreshes). */
  hidden: number;
  /** Hidden automatically because the source no longer has the trail. */
  retired: number;
  total: number;
}

export interface CatalogTrailRow {
  id: string;
  name: string;
  provider: string;
  providerId: string;
  path: string;
  countryCode: string;
  regionName: string | null;
  distanceM: number;
  state: "visible" | "hidden" | "retired";
  hiddenReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  sourceUrl: string | null;
}

export interface CatalogOverview {
  byProvider: TrailCountRow[];
  byCountry: TrailCountRow[];
  countryCount: number;
  pois: { provider: string; layer: CatalogLayer; n: number }[];
  newest: CatalogTrailRow[];
  /** Most recently hidden by moderation. */
  hidden: CatalogTrailRow[];
}

const trailColumns = (tx: Tx) => tx`
  t.id, t.name, t.provider, t.provider_id, t.country_code, t.region_slug, t.slug, t.region_name, t.distance_m,
  t.hidden, t.retired_at, t.hidden_reason, t.created_at, t.updated_at, t.source_url`;

interface TrailDbRow {
  id: string;
  name: string;
  provider: string;
  providerId: string;
  countryCode: string;
  regionSlug: string;
  slug: string;
  regionName: string | null;
  distanceM: number;
  hidden: boolean;
  retiredAt: Date | null;
  hiddenReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  sourceUrl: string | null;
}

const trailState = (r: Pick<TrailDbRow, "hidden" | "retiredAt">): CatalogTrailRow["state"] => (r.retiredAt ? "retired" : r.hidden ? "hidden" : "visible");

const toTrailRow = (r: TrailDbRow): CatalogTrailRow => ({
  id: r.id,
  name: r.name,
  provider: r.provider,
  providerId: r.providerId,
  path: trailPath(r),
  countryCode: r.countryCode,
  regionName: r.regionName,
  distanceM: r.distanceM,
  state: trailState(r),
  hiddenReason: r.hiddenReason,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  sourceUrl: r.sourceUrl,
});

export async function getCatalogOverview(user: SessionUser): Promise<CatalogOverview> {
  assertCan(user, VIEW);
  return systemTx(async (tx) => {
    const counted = (group: "provider" | "country_code", limit: number) => tx<TrailCountRow[]>`
      select ${tx(group)} as key,
             count(*) filter (where not hidden)::int as visible,
             count(*) filter (where hidden and retired_at is null)::int as hidden,
             count(*) filter (where retired_at is not null)::int as retired,
             count(*)::int as total
        from public.catalog_trails
       group by ${tx(group)}
       order by total desc, key
       limit ${limit}::int`;
    const byProvider = await counted("provider", 50);
    const byCountry = await counted("country_code", 20);
    const [countries] = await tx<{ n: number }[]>`select count(distinct country_code)::int as n from public.catalog_trails`;
    const pois = await tx<{ provider: string; layer: CatalogLayer; n: number }[]>`
      select provider, layer, count(*)::int as n from public.catalog_pois group by provider, layer order by provider, layer`;
    const newest = await tx<TrailDbRow[]>`select ${trailColumns(tx)} from public.catalog_trails t order by t.created_at desc, t.id limit 10`;
    const hidden = await tx<TrailDbRow[]>`
      select ${trailColumns(tx)} from public.catalog_trails t
       where t.hidden and t.retired_at is null
       order by t.updated_at desc, t.id limit 20`;
    return {
      byProvider,
      byCountry,
      countryCount: countries?.n ?? 0,
      pois,
      newest: newest.map(toTrailRow),
      hidden: hidden.map(toTrailRow),
    };
  });
}

// ---------------------------------------------------------------------------
// Catalog jobs
// ---------------------------------------------------------------------------

export interface CatalogJobRow {
  id: number;
  kind: string;
  status: string;
  /** Failed attempt waiting for its automatic retry (status queued with an error). */
  retrying: boolean;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  /** "outdoor · osm · 0.25/123/456" for tile jobs; null otherwise. Nothing else from the payload is shown. */
  target: string | null;
  runAt: Date;
  updatedAt: Date;
}

export interface CatalogJobsOverview {
  counts: { kind: string; status: string; n: number }[];
  failed: CatalogJobRow[];
  /** run_at of the longest-waiting due job (queued, run_at passed): a stale value means the catalog runner is not running. */
  oldestDueQueuedAt: Date | null;
  /** That job has waited longer than RUNNER_STALE_MINUTES. */
  runnerLooksStopped: boolean;
}

/** A due catalog job waiting longer than this suggests the catalog runner is not scheduled. */
export const RUNNER_STALE_MINUTES = 10;

const payloadTarget = (payload: unknown): string | null => {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const layer = typeof p.layer === "string" && (CATALOG_LAYERS as readonly string[]).includes(p.layer) ? p.layer : null;
  const provider = typeof p.provider === "string" && /^[a-z][a-z0-9_]{1,30}$/.test(p.provider) ? p.provider : null;
  const tileKey = typeof p.tileKey === "string" && /^[0-9.]+\/[0-9]+\/[0-9]+$/.test(p.tileKey) ? p.tileKey : null;
  return layer && provider && tileKey ? `${layer} · ${provider} · ${tileKey}` : null;
};

export async function getCatalogJobs(user: SessionUser): Promise<CatalogJobsOverview> {
  assertCan(user, VIEW);
  return systemTx(async (tx) => {
    const counts = await tx<{ kind: string; status: string; n: number }[]>`
      select kind, status::text as status, count(*)::int as n
        from public.jobs where kind like ${CATALOG_JOB_PATTERN}
       group by kind, status order by kind, status`;
    const rows = await tx<{ id: number; kind: string; status: string; attempts: number; maxAttempts: number; lastError: string | null; payload: unknown; runAt: Date; updatedAt: Date }[]>`
      select id, kind, status::text as status, attempts, max_attempts, last_error, payload, run_at, updated_at
        from public.jobs
       where kind like ${CATALOG_JOB_PATTERN}
         and (status in ('failed', 'dead')
              or (status = 'queued' and attempts > 0 and last_error is not null and last_error not like 'deferred:%'))
       order by updated_at desc, id desc
       limit 10`;
    const [due] = await tx<{ oldest: Date | null; stale: boolean | null }[]>`
      select min(run_at) as oldest, min(run_at) < now() - make_interval(mins => ${RUNNER_STALE_MINUTES}) as stale
        from public.jobs
       where kind like ${CATALOG_JOB_PATTERN} and status = 'queued' and run_at <= now()`;
    return {
      counts,
      oldestDueQueuedAt: due?.oldest ?? null,
      runnerLooksStopped: due?.stale === true,
      failed: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        retrying: r.status === "queued",
        attempts: r.attempts,
        maxAttempts: r.maxAttempts,
        lastError: trimError(r.lastError),
        target: payloadTarget(r.payload),
        runAt: r.runAt,
        updatedAt: r.updatedAt,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const retrySchema = z.object({
  layer: z.enum(CATALOG_LAYERS, "Unknown layer."),
  provider: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/, "Unknown provider."),
  tileKey: z.string().max(40).regex(/^[0-9.]+\/[0-9]+\/[0-9]+$/, "Not a tile key."),
  reason: z.string().trim().max(300, "Reason is too long.").optional(),
});

/**
 * "Retry now" for one tile: requests a new load through the coverage
 * machinery (repository.requestTileIngest: new request generation + a
 * deduplicated catalog.ingest_tile job due now). A loaded tile is first made
 * due (markTilesDue) so the job may claim it; a load already queued for
 * later (backoff after a failure) is brought forward to now instead of
 * queueing a second one. The catalog runner (/api/cron/catalog) executes it.
 */
export async function requestTileRetry(user: SessionUser, input: unknown): Promise<ActionResult<{ jobId: number | null }>> {
  assertCan(user, MANAGE);
  const parsed = retrySchema.safeParse(input);
  if (!parsed.success) return zodFail(parsed.error);
  const { layer, provider: providerId, tileKey } = parsed.data;
  const reason = parsed.data.reason || "Manual retry from the Trail data page";
  if (!tileFromKey(layer, tileKey)) return fail("Not a tile of this layer's grid.");
  const provider = providerById(providerId);
  if (!provider || !provider.layers.includes(layer)) return fail(`Unknown provider “${providerId}” for the ${layer} layer.`);
  if (!providerCanLoad(providerId, layer)) return fail(`${provider.label} is not enabled (its configuration is missing), so this tile cannot be loaded.`);

  return guarded(() =>
    systemTx(async (tx) => {
      const [row] = await repo.readTiles(tx, layer, [{ provider: providerId, tileKey }]);
      if (!row) return fail("Tile not found.");
      if (row.jobStatus === "running") return fail("This tile is being loaded right now.");
      if (row.status === "fetching" && !row.fetchStale) return fail("This tile is being loaded right now.");
      const target = `${layer}:${providerId}:${tileKey}`;
      const base = { layer, provider: providerId, tileKey, fromStatus: row.status, attempts: row.attempts, lastError: trimError(row.lastError), reason };

      if (row.jobStatus === "queued") {
        const key = repo.ingestJobKey(layer, providerId, tileKey, row.requestGen);
        const [job] = await tx<{ id: number }[]>`
          update public.jobs set run_at = now()
           where dedup_key = ${key} and status = 'queued'
          returning id`;
        if (!job) return fail("This tile's load is no longer queued; reload the page and try again.");
        await recordAudit(tx, actorOf(user), "catalog.tile_retry_requested", "catalog_tile", target, { ...base, mode: "expedited", jobId: job.id });
        return ok(`The queued load of tile ${tileKey} (job #${job.id}) now runs at the next catalog runner pass, within about a minute.`, { data: { jobId: job.id } });
      }

      if (row.status === "ready") await repo.markTilesDue(tx, layer, [{ provider: providerId, tileKey }]);
      const gen = await repo.requestTileIngest(tx, layer, providerId, tileKey, row.requestGen);
      if (!gen) return fail("Another request for this tile arrived at the same moment; its load is already queued.");
      const [job] = await tx<{ id: number }[]>`select id from public.jobs where dedup_key = ${repo.ingestJobKey(layer, providerId, tileKey, gen)}`;
      await recordAudit(tx, actorOf(user), "catalog.tile_retry_requested", "catalog_tile", target, { ...base, mode: "requested", jobId: job?.id ?? null });
      return ok(
        `Load of tile ${tileKey} (${provider.label}, ${layer}) queued${job ? ` as job #${job.id}` : ""}. The catalog runner picks it up within about a minute.`,
        { data: { jobId: job?.id ?? null } },
      );
    }),
  );
}

const COUNTRY_RE = /^[a-z]{2}$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TrailRef = { id: string } | { countryCode: string; regionSlug: string; slug: string };

/**
 * A catalog trail reference typed by staff: its id (UUID), its page path
 * "/trail/<country>/<region>/<slug>", or a full URL of that page. Null when
 * it is neither.
 */
export function parseTrailRef(raw: unknown): TrailRef | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 500) return null;
  if (UUID_RE.test(value)) return { id: value.toLowerCase() };
  let path = value;
  if (/^https?:\/\//i.test(value)) {
    try {
      path = new URL(value).pathname;
    } catch {
      return null;
    }
  }
  path = path.split(/[?#]/)[0].replace(/\/+$/, "");
  const m = /^\/trail\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
  if (!m) return null;
  let parts: string[];
  try {
    parts = m.slice(1).map((p) => decodeURIComponent(p).toLowerCase());
  } catch {
    return null;
  }
  const [countryCode, regionSlug, slug] = parts;
  if (!COUNTRY_RE.test(countryCode) || !SLUG_RE.test(regionSlug) || regionSlug.length > 80 || !SLUG_RE.test(slug) || slug.length > 120) return null;
  return { countryCode, regionSlug, slug };
}

const moderationSchema = z.object({
  trail: z.string().trim().min(1, "Enter the trail's id or its /trail/… page path.").max(500, "That trail reference is too long."),
  reason: requiredText(5, 500, "Reason"),
});

async function lockTrail(tx: Tx, ref: TrailRef): Promise<TrailDbRow | null> {
  const where = "id" in ref ? tx`t.id = ${ref.id}::uuid` : tx`t.country_code = ${ref.countryCode} and t.region_slug = ${ref.regionSlug} and t.slug = ${ref.slug}`;
  const [row] = await tx<TrailDbRow[]>`select ${trailColumns(tx)} from public.catalog_trails t where ${where} for update of t`;
  return row ?? null;
}

/**
 * Hide a catalog trail (moderation). Public reads exclude hidden trails via
 * RLS (catalog_trails_public_read: not hidden), so it disappears from
 * search, trail pages and saved lists; nothing is deleted. A moderation hide
 * clears retired_at, so ingestion never un-hides it when the source has it.
 */
export async function hideCatalogTrail(user: SessionUser, input: unknown): Promise<ActionResult<{ id: string }>> {
  assertCan(user, MANAGE);
  const parsed = moderationSchema.safeParse(input);
  if (!parsed.success) return zodFail(parsed.error);
  const ref = parseTrailRef(parsed.data.trail);
  if (!ref) return fail("Enter the trail's id or its /trail/<country>/<region>/<slug> page path.", { trail: ["Not a trail id or trail page path."] });
  const { reason } = parsed.data;
  return guarded(() =>
    systemTx(async (tx) => {
      const t = await lockTrail(tx, ref);
      if (!t) return fail("No catalog trail has that id or path.");
      if (t.hidden && !t.retiredAt) return fail(`“${t.name}” is already hidden (reason: ${t.hiddenReason ?? "none recorded"}).`);
      await tx`
        update public.catalog_trails
           set hidden = true, hidden_reason = ${reason}, retired_at = null
         where id = ${t.id}::uuid`;
      await recordAudit(tx, actorOf(user), "catalog.trail_hidden", "catalog_trail", t.id, {
        reason,
        name: t.name,
        path: trailPath(t),
        provider: t.provider,
        providerId: t.providerId,
        previousState: trailState(t),
        previousReason: t.hiddenReason,
      });
      return ok(`“${t.name}” is hidden. It no longer appears in search, on its trail page or in saved lists, and refreshes keep it hidden.`, {
        data: { id: t.id },
      });
    }),
  );
}

/**
 * Unhide a trail hidden by moderation. A trail retired by ingestion (the
 * source no longer has it) cannot be unhidden by hand: it comes back by
 * itself if the source has it again.
 */
export async function unhideCatalogTrail(user: SessionUser, input: unknown): Promise<ActionResult<{ id: string }>> {
  assertCan(user, MANAGE);
  const parsed = moderationSchema.safeParse(input);
  if (!parsed.success) return zodFail(parsed.error);
  const ref = parseTrailRef(parsed.data.trail);
  if (!ref) return fail("Enter the trail's id or its /trail/<country>/<region>/<slug> page path.", { trail: ["Not a trail id or trail page path."] });
  const { reason } = parsed.data;
  return guarded(() =>
    systemTx(async (tx) => {
      const t = await lockTrail(tx, ref);
      if (!t) return fail("No catalog trail has that id or path.");
      if (!t.hidden) return fail(`“${t.name}” is not hidden.`);
      if (t.retiredAt) {
        return fail(
          `“${t.name}” was retired automatically (${t.hiddenReason ?? "no longer in its source"}). It reappears by itself if the source has it again; it cannot be unhidden by hand.`,
        );
      }
      await tx`update public.catalog_trails set hidden = false, hidden_reason = null where id = ${t.id}::uuid`;
      await recordAudit(tx, actorOf(user), "catalog.trail_unhidden", "catalog_trail", t.id, {
        reason,
        name: t.name,
        path: trailPath(t),
        provider: t.provider,
        providerId: t.providerId,
        previousReason: t.hiddenReason,
      });
      return ok(`“${t.name}” is visible again.`, { data: { id: t.id } });
    }),
  );
}
