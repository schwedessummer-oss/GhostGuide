import { env } from "@/config/env";
import { safeEqual } from "@/server/auth/tokens";
import { catalogHandlers, claimableCatalogKinds } from "@/server/jobs/handlers/catalog";
import { runDueJobs, type RunSummary } from "@/server/jobs/queue";
import { log } from "@/server/log";
import { dropAbandonedIngestJobs } from "@/server/trails/repository";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Start no new job after this long… */
const RUN_FOR_MS = 240_000;
/**
 * …and give every job a deadline that ends the invocation safely before
 * maxDuration (300 s). The 45 s margin covers work that only stops at its
 * next checkpoint, e.g. a Nominatim admin-name lookup already in flight
 * when the deadline passes (≤ 2 × (10 s throttle wait + 10 s timeout) plus
 * backoff ≈ 41 s), so the platform never kills the function mid-job.
 */
const HARD_DEADLINE_MS = 255_000;

/**
 * Trail-catalog job runner (tile ingestion from OpenStreetMap, stale-tile
 * refresh, cache purge). Called every minute by Supabase pg_cron + pg_net
 * (scripts/setup-cron.ts) with `Authorization: Bearer $CRON_SECRET`.
 *
 * Separate from /api/cron/jobs so slow provider work never delays safety
 * jobs. Runs due "catalog.*" jobs ONE AT A TIME until RUN_FOR_MS has
 * elapsed or nothing is due; each job's deadline (HARD_DEADLINE_MS) bounds
 * ingestion so the function finishes within maxDuration, and tile loads are
 * only claimed while a full provider attempt still fits before it
 * (claimableCatalogKinds). When every job it claims is deferred (the provider's
 * concurrency cap is reached), it stops early: the next invocation, a
 * minute later, tries again.
 *
 * Tile loads are claimed most recent request first (queue ClaimOrder
 * "recent_request"): areas people are looking at now run before an older
 * backlog, and loads nobody asked about for 20 minutes are dropped first
 * (repository.dropAbandonedIngestJobs).
 *
 * Periodic catalog jobs (refresh_stale, purge_caches) are enqueued by the
 * /api/cron/jobs runner's ensurePeriodicJobs() every minute; this runner
 * only executes them, so nothing is scheduled twice.
 */
async function handle(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env().CRON_SECRET}`;
  if (!safeEqual(auth, expected)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const started = Date.now();
  const deadline = new Date(started + HARD_DEADLINE_MS);
  const workerId = `catalog-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const totals: RunSummary = { claimed: 0, succeeded: 0, noop: 0, retried: 0, dead: 0, deferred: 0 };
  let abandoned = 0;
  try {
    abandoned = (await dropAbandonedIngestJobs(Date.now())).jobs;
  } catch (err) {
    log.warn("cron.catalog_drop_abandoned_failed", { error: err instanceof Error ? err.message : String(err) });
  }
  try {
    while (Date.now() - started < RUN_FOR_MS) {
      const kinds = claimableCatalogKinds(deadline.getTime() - Date.now());
      const s = await runDueJobs(catalogHandlers, { limit: 1, kinds, workerId, deadline, order: "recent_request" });
      for (const k of Object.keys(totals) as (keyof RunSummary)[]) totals[k] += s[k];
      if (s.claimed === 0 || s.deferred === s.claimed) break;
    }
  } catch (err) {
    log.error("cron.catalog_failed", { error: err instanceof Error ? err.message : String(err), ...totals });
    return Response.json({ ok: false, error: "catalog runner failed", ...totals, ms: Date.now() - started }, { status: 500 });
  }
  log.info("cron.catalog", { ...totals, abandoned, ms: Date.now() - started });
  return Response.json({ ok: true, ...totals, abandoned, ms: Date.now() - started });
}

export const GET = handle;
export const POST = handle;
