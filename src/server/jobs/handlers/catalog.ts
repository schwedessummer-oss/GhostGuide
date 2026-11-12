import "server-only";
import type { JobHandlers } from "../queue";

/**
 * Trail-catalog background jobs (tile ingestion, stale refresh, cache purge).
 * Filled in by the Phase 1 ingestion workstream.
 */
export const catalogHandlers: JobHandlers = {};
