/**
 * Local job runner. `npm run jobs:run` runs due jobs once;
 * `npm run jobs:run -- --watch` polls every 15 seconds (stand-in for cron).
 */
import { loadEnv } from "./db/lib";

loadEnv();

async function main() {
  const { runDueJobs } = await import("@/server/jobs/queue");
  const { ensurePeriodicJobs } = await import("@/server/jobs/periodic");
  const { allJobHandlers } = await import("@/server/jobs/registry");
  const { closeDb } = await import("@/server/db");
  const { recordRunnerHeartbeat } = await import("@/server/jobs/health");
  const watch = process.argv.includes("--watch");
  do {
    await ensurePeriodicJobs();
    // Same split as production: fast jobs first, then at most one slow
    // trail-catalog job (provider downloads) per pass.
    const summary = await runDueJobs(allJobHandlers(), { limit: 50, workerId: "local-runner", excludeKindPrefixes: ["catalog."] });
    await recordRunnerHeartbeat({ ...summary });
    // Mirrors /api/cron/catalog: drop loads nobody is waiting for, then
    // claim the most recently requested area first.
    const { catalogHandlers, claimableCatalogKinds } = await import("@/server/jobs/handlers/catalog");
    const { dropAbandonedIngestJobs } = await import("@/server/trails/repository");
    await dropAbandonedIngestJobs(Date.now());
    const catalog = await runDueJobs(catalogHandlers, {
      limit: 1,
      kinds: claimableCatalogKinds(240_000),
      workerId: "local-catalog-runner",
      deadline: new Date(Date.now() + 240_000),
      order: "recent_request",
    });
    console.log(new Date().toISOString(), JSON.stringify({ jobs: summary, catalog }));
    if (watch) await new Promise((r) => setTimeout(r, 15_000));
  } while (watch);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
