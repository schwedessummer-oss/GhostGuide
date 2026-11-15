import "server-only";
import { enqueueJob } from "./queue";

/**
 * Periodic maintenance jobs. Each cron tick calls ensurePeriodicJobs(),
 * which enqueues one job per kind per time bucket using a dedup key, so
 * overlapping or repeated cron invocations never double-schedule.
 *
 * Handlers for these kinds live in src/server/jobs/handlers/*.ts.
 */
export const PERIODIC_JOBS: { kind: string; everyMinutes: number }[] = [
  { kind: "bookings.expire_holds", everyMinutes: 5 },
  { kind: "payments.reconcile", everyMinutes: 60 },
  { kind: "ops.purge_rate_limits", everyMinutes: 60 * 24 },
  // Safety net for the self-rescheduling daily permit reminder run (ops
  // handler). A second run on the same day is a no-op: reminders are
  // deduplicated per trip/permit/day.
  { kind: "permits.remind", everyMinutes: 60 * 24 },
  // Trail catalog (run by /api/cron/catalog, never by the general job runner):
  // enqueue due tile refreshes/retries, and purge expired provider caches.
  { kind: "catalog.refresh_stale", everyMinutes: 60 },
  { kind: "catalog.purge_caches", everyMinutes: 60 * 24 },
];

export function bucketKey(kind: string, everyMinutes: number, now: Date): string {
  const bucketMs = everyMinutes * 60_000;
  const bucket = new Date(Math.floor(now.getTime() / bucketMs) * bucketMs).toISOString();
  return `periodic:${kind}:${bucket}`;
}

export async function ensurePeriodicJobs(now = new Date()) {
  for (const p of PERIODIC_JOBS) {
    await enqueueJob(null, p.kind, {}, { dedupKey: bucketKey(p.kind, p.everyMinutes, now), maxAttempts: 3 });
  }
}
