import "server-only";
import type { SessionUser } from "@/server/auth";
import { isDemoMode } from "@/config/env";
import { runDueJobs, type JobHandlers } from "@/server/jobs/queue";
import { allJobHandlers } from "@/server/jobs/registry";
import { ensurePeriodicJobs } from "@/server/jobs/periodic";
import { recordAudit } from "@/server/audit";
import { withSystem } from "@/server/db";
import { assertCan, fail, guarded, ok, type ActionResult } from "./common";

/**
 * DEMO MODE ONLY: run due jobs immediately so the demo is self-contained
 * without a cron scheduler. In live mode jobs run only via /api/cron/jobs.
 */
export async function runDueJobsNow(user: SessionUser, handlers: JobHandlers = allJobHandlers()): Promise<ActionResult> {
  assertCan(user, "jobs.manage");
  if (!isDemoMode()) return fail("Running jobs from the admin is only available in demo mode. In live mode jobs run on the cron schedule.");
  return guarded(async () => {
    await ensurePeriodicJobs();
    // Trail-catalog jobs (slow provider downloads) have their own runner (/api/cron/catalog).
    const s = await runDueJobs(handlers, { limit: 50, workerId: `admin-${user.id.slice(0, 8)}`, excludeKindPrefixes: ["catalog."] });
    await withSystem((tx) => recordAudit(tx, { id: user.id, roles: user.roles }, "jobs.run_now", "job", null, { ...s }));
    return ok(`Ran ${s.claimed} due job(s): ${s.succeeded} done, ${s.noop} no-op, ${s.retried} will retry, ${s.dead} dead.`);
  }, "admin.run_jobs");
}
