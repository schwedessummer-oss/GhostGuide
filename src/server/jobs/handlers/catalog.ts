import "server-only";
import { z } from "zod";
import { CATALOG_LAYERS } from "@/domain/catalog";
import { withSystem } from "@/server/db";
import { tileFromKey } from "@/server/geo/tiles";
import { log } from "@/server/log";
import { INGEST_BUDGET_MS, ingestTile, type IngestDeps } from "@/server/trails/ingest";
import { enabledProviders } from "@/server/trails/providers/registry";
import * as repo from "@/server/trails/repository";
import { JobDeferredError, type JobHandlers } from "../queue";

/**
 * Trail-catalog background jobs. They are slow and depend on public
 * providers (Overpass can take minutes), so they never run in the safety
 * job runner (/api/cron/jobs excludes every "catalog." kind); the dedicated
 * /api/cron/catalog runner executes them one at a time.
 *
 *   catalog.ingest_tile    {layer, provider, tileKey, requestedAt} →
 *                          ingestTile. A load nobody has asked about for
 *                          ABANDONED_REQUEST_MS (requestedAt, refreshed
 *                          while people search the area) is dropped, not
 *                          fetched. A job with less than MIN_INGEST_BUDGET_MS
 *                          left before the runner's deadline is deferred: a
 *                          full Overpass attempt must fit. A tile that cannot
 *                          be claimed because the provider's concurrency cap
 *                          is reached, or because another worker is loading
 *                          it, is deferred (no attempt used). Retryable
 *                          failures throw AFTER ingestTile marked the tile
 *                          failed, so the queue's backoff retries the job;
 *                          other failures end it.
 *   catalog.refresh_stale  hourly: enqueues up to REFRESH_BATCH tiles that
 *                          need work and have no outstanding job (due
 *                          refreshes and retries, crashed fetches, pending
 *                          tiles whose job was lost), oldest first, as
 *                          background work (after every live request) and
 *                          only while the queue is under its ceiling.
 *   catalog.purge_caches   daily: deletes expired geocode / weather /
 *                          admin-name cache rows and provider usage rows
 *                          older than API_USAGE_RETENTION_DAYS.
 */

export const CATALOG_JOB_PREFIX = "catalog.";
export const CATALOG_JOB_KINDS = [repo.INGEST_JOB_KIND, "catalog.refresh_stale", "catalog.purge_caches"] as const;
export const REFRESH_BATCH = 25;
/**
 * An ingest job is deferred rather than started with less time than this:
 * one full Overpass attempt (90 s server timeout + 15 s client margin) plus
 * time to store what it returns. Starting a fetch that cannot finish would
 * fail the tile and leave Overpass working on a query nobody waits for.
 */
export const MIN_INGEST_BUDGET_MS = 135_000;
export const API_USAGE_RETENTION_DAYS = 400;

/**
 * Catalog kinds a runner may still claim with `remainingMs` before its
 * deadline: tile loads only while a full provider attempt fits
 * (MIN_INGEST_BUDGET_MS), so a late claim never starts an Overpass query it
 * would have to abandon; the quick maintenance kinds any time.
 */
export function claimableCatalogKinds(remainingMs: number): string[] {
  return remainingMs >= MIN_INGEST_BUDGET_MS ? [...CATALOG_JOB_KINDS] : CATALOG_JOB_KINDS.filter((k) => k !== repo.INGEST_JOB_KIND);
}

const ingestPayload = z.object({
  layer: z.enum(CATALOG_LAYERS),
  provider: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
  tileKey: z.string().max(40),
  /** Epoch ms of the latest request (0: background work). Absent on jobs queued before it existed. */
  requestedAt: z.number().finite().min(0).optional(),
});

/** Enqueue ingest jobs for tiles that need work (see module header). */
export async function refreshStaleTiles(limit = REFRESH_BATCH): Promise<{ considered: number; enqueued: number }> {
  const providers = [...new Set([...enabledProviders("outdoor"), ...enabledProviders("services")].map((p) => p.id))];
  const rows = await withSystem(async (tx) => {
    const outstanding = await repo.countOutstandingIngestJobs(tx, Date.now(), repo.MAX_QUEUED_TILE_LOADS);
    const room = Math.max(0, repo.MAX_QUEUED_TILE_LOADS - outstanding.live - outstanding.background);
    return repo.tilesNeedingWork(tx, providers, Math.min(limit, room));
  });
  let enqueued = 0;
  for (const row of rows) {
    const gen = await withSystem((tx) =>
      repo.requestTileIngest(tx, row.layer, row.provider, row.tileKey, row.requestGen, { requestedAtMs: repo.BACKGROUND_REQUESTED_AT }),
    );
    if (gen) enqueued++;
  }
  return { considered: rows.length, enqueued };
}

/** When the load was last asked for (epoch ms; 0 = background work). */
function requestedAtOf(job: { createdAt: Date | string | null }, payload: { requestedAt?: number }): number {
  if (typeof payload.requestedAt === "number") return payload.requestedAt;
  const created = job.createdAt instanceof Date ? job.createdAt.getTime() : Date.parse(String(job.createdAt));
  return Number.isFinite(created) ? created : Date.now();
}

/** Delete expired cache rows and old provider usage rows. */
export async function purgeCatalogCaches(): Promise<{ geocode: number; weather: number; admin: number; usage: number }> {
  return withSystem(async (tx) => {
    const count = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    const geocode = await count(tx<{ n: number }[]>`
      with d as (delete from public.geocode_cache where expires_at < now() returning 1) select count(*)::int as n from d`);
    const weather = await count(tx<{ n: number }[]>`
      with d as (delete from public.weather_cache where expires_at < now() returning 1) select count(*)::int as n from d`);
    const admin = await count(tx<{ n: number }[]>`
      with d as (delete from public.geo_admin_cache where expires_at < now() returning 1) select count(*)::int as n from d`);
    const usage = await count(tx<{ n: number }[]>`
      with d as (delete from public.external_api_usage
                  where day < (now() at time zone 'utc')::date - ${API_USAGE_RETENTION_DAYS}::int returning 1)
      select count(*)::int as n from d`);
    return { geocode, weather, admin, usage };
  });
}

/**
 * Catalog handlers with injectable ingestion dependencies (tests use fake
 * providers; production uses the defaults via `catalogHandlers`).
 */
export function createCatalogHandlers(deps: IngestDeps = {}): JobHandlers {
  return {
    [repo.INGEST_JOB_KIND]: async (job, ctx) => {
      const parsed = ingestPayload.safeParse(job.payload);
      if (!parsed.success || !tileFromKey(parsed.data.layer, parsed.data.tileKey)) {
        log.warn("catalog.ingest_job_invalid", { jobId: job.id });
        return { outcome: "noop", note: "invalid payload (expected layer, provider, tileKey)" };
      }
      const { layer, provider, tileKey } = parsed.data;
      const requestedAt = requestedAtOf(job, parsed.data);
      if (requestedAt > 0 && Date.now() - requestedAt > repo.ABANDONED_REQUEST_MS) {
        const forgotten = await repo.forgetAbandonedTile(layer, provider, tileKey, job.dedupKey);
        return {
          outcome: "noop",
          note: `skipped: nobody asked for this area in the last ${Math.round(repo.ABANDONED_REQUEST_MS / 60_000)} minutes${forgotten ? " (tile forgotten until searched again)" : ""}`,
        };
      }
      const remaining = ctx.deadline ? ctx.deadline.getTime() - Date.now() : Infinity;
      if (remaining < MIN_INGEST_BUDGET_MS) throw new JobDeferredError(5_000, "not enough time left in this runner invocation");
      const budgetMs = Math.max(1, Math.min(deps.budgetMs ?? INGEST_BUDGET_MS, remaining));

      const r = await ingestTile(layer, provider, tileKey, { ...deps, budgetMs });
      switch (r.outcome) {
        case "done":
          return {
            outcome: "done",
            note:
              `${r.trails} trail(s): ${r.inserted} new, ${r.updated} updated, ${r.merged} merged, ${r.retired} retired; ` +
              `${r.pois} POI(s)${r.note ? `. ${r.note}` : ""}`,
          };
        case "noop":
          if (r.reason === "busy") {
            throw new JobDeferredError(20_000 + Math.floor(Math.random() * 20_000), `${provider} concurrency limit reached`);
          }
          if (r.reason === "in_progress") throw new JobDeferredError(60_000, "the tile is being loaded by another worker");
          return { outcome: "noop", note: `skipped: ${r.reason.replace(/_/g, " ")}` };
        case "failed":
          if (r.retryable) throw new Error(r.error);
          return { outcome: "noop", note: `failed, not retried: ${r.error}` };
      }
    },

    "catalog.refresh_stale": async () => {
      const r = await refreshStaleTiles();
      return { outcome: r.enqueued > 0 ? "done" : "noop", note: `${r.enqueued} tile(s) enqueued of ${r.considered} needing work` };
    },

    "catalog.purge_caches": async () => {
      const r = await purgeCatalogCaches();
      const total = r.geocode + r.weather + r.admin + r.usage;
      return {
        outcome: total > 0 ? "done" : "noop",
        note: `deleted ${r.geocode} geocode, ${r.weather} weather, ${r.admin} admin-name cache row(s) and ${r.usage} usage row(s)`,
      };
    },
  };
}

export const catalogHandlers: JobHandlers = createCatalogHandlers();
