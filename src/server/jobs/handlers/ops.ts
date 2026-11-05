import "server-only";
import type { JobHandlers } from "../queue";
import { purgeOldRateLimitWindows } from "@/server/rate-limit";

/** Job handlers for operations: marketing drafts, permit reminders, housekeeping (owned by the admin slice). Handlers must be idempotent. */
export const opsHandlers: JobHandlers = {
  "ops.purge_rate_limits": async () => {
    await purgeOldRateLimitWindows();
    return { outcome: "done" };
  },
};
