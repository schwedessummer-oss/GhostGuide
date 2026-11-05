import "server-only";
import type { JobHandlers } from "../queue";

/** Job handlers for hike-session housekeeping (owned by the hike slice). Handlers must be idempotent. */
export const hikeHandlers: JobHandlers = {};
