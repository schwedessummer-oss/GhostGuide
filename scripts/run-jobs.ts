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
  const watch = process.argv.includes("--watch");
  do {
    await ensurePeriodicJobs();
    const summary = await runDueJobs(allJobHandlers(), { limit: 50, workerId: "local-runner" });
    console.log(new Date().toISOString(), JSON.stringify(summary));
    if (watch) await new Promise((r) => setTimeout(r, 15_000));
  } while (watch);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
