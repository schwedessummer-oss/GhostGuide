import "server-only";
import type { JobHandlers } from "../queue";
import { enqueueJob } from "../queue";
import { withSystem } from "@/server/db";
import { purgeOldRateLimitWindows } from "@/server/rate-limit";
import { PERMIT_REMIND_JOB, permitRemindRunKey, runPermitReminders } from "@/server/admin/permits";

/** Next daily permit-reminder run: 16:00 UTC (morning in the U.S. Pacific launch region) after `now`. */
export function nextPermitRemindRun(now: Date): Date {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 16, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Job handlers for operations: marketing drafts, permit reminders, housekeeping (owned by the admin slice). Handlers must be idempotent. */
export const opsHandlers: JobHandlers = {
  "ops.purge_rate_limits": async () => {
    await purgeOldRateLimitWindows();
    return { outcome: "done" };
  },

  /**
   * In-app reminders for booked trips whose required permit is not obtained
   * within the reminder window. Idempotent: notifications are deduplicated per
   * trip/permit/day, so re-runs on the same day create nothing new. The run
   * re-schedules itself for the next day (dedup key per day), so overlapping
   * schedulers never double-queue it.
   */
  [PERMIT_REMIND_JOB]: async (_job, { now }) => {
    const summary = await withSystem((tx) => runPermitReminders(tx, now));
    const next = nextPermitRemindRun(now);
    await enqueueJob(null, PERMIT_REMIND_JOB, {}, { runAt: next, dedupKey: permitRemindRunKey(next.toISOString().slice(0, 10)), maxAttempts: 3 });
    return {
      outcome: summary.created > 0 ? "done" : "noop",
      note: `${summary.created} permit reminder(s) created; ${summary.candidates} trip permit(s) in a reminder window.`,
    };
  },
};
