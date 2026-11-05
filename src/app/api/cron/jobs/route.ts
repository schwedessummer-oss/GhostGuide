import { env } from "@/config/env";
import { safeEqual } from "@/server/auth/tokens";
import { runDueJobs } from "@/server/jobs/queue";
import { ensurePeriodicJobs } from "@/server/jobs/periodic";
import { allJobHandlers } from "@/server/jobs/registry";
import { log } from "@/server/log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Job runner endpoint. Called every minute by Vercel Cron (GET with
 * `Authorization: Bearer $CRON_SECRET`) or by Supabase pg_cron + pg_net.
 */
async function handle(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env().CRON_SECRET}`;
  if (!safeEqual(auth, expected)) return Response.json({ error: "unauthorized" }, { status: 401 });

  await ensurePeriodicJobs();
  const started = Date.now();
  const handlers = allJobHandlers();
  const totals = { claimed: 0, succeeded: 0, noop: 0, retried: 0, dead: 0 };
  // Drain in batches until empty or ~45s elapsed (stay under maxDuration).
  while (Date.now() - started < 45_000) {
    const s = await runDueJobs(handlers, { limit: 25 });
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += s[k];
    if (s.claimed === 0) break;
  }
  log.info("cron.jobs", totals);
  return Response.json({ ok: true, ...totals, ms: Date.now() - started });
}

export const GET = handle;
export const POST = handle;
