import "server-only";
import type { JobHandlers } from "../queue";

/** Job handlers for check-in reminders, overdue checks, notifications, location retention (owned by the safety slice). Handlers must be idempotent. */
export const safetyHandlers: JobHandlers = {};
