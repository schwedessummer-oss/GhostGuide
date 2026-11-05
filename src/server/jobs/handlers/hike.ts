import "server-only";
import { withSystem } from "@/server/db";
import { enqueueJob, type JobHandlers } from "../queue";
import { log } from "@/server/log";

/** An open session with no sync for this long (and started over 72 h ago) is closed as abandoned. */
const QUIET_FOR_MS = 48 * 3600_000;
const RECHECK_AFTER_MS = 24 * 3600_000;
const MAX_RECHECKS = 14;

/**
 * Job handlers for hike-session housekeeping (owned by the hike slice).
 * Handlers must be idempotent: they re-load current state and no-op when
 * the session is no longer open.
 *
 * hike.close_stale_session — enqueued when a session starts (runs 72 h
 * later). Marks the SESSION `abandoned` if the device has not synced for
 * 48 h, so it stops showing as an open hike. It deliberately does NOT
 * complete the trip or touch check-ins: an unfinished hike is never treated
 * as "safely finished".
 */
export const hikeHandlers: JobHandlers = {
  "hike.close_stale_session": async (job, { now }) => {
    const sessionId = String(job.payload.sessionId ?? "");
    const recheck = Number(job.payload.recheck ?? 0);
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return { outcome: "noop", note: "invalid payload" };
    return withSystem(async (tx) => {
      const [s] = await tx<{ status: string; startedAt: Date; lastSyncAt: Date | null }[]>`
        select status, started_at, last_sync_at from public.hike_sessions where id = ${sessionId} for update`;
      if (!s || (s.status !== "active" && s.status !== "paused")) return { outcome: "noop" as const, note: "session not open" };
      const lastSeen = (s.lastSyncAt ?? s.startedAt).getTime();
      if (now.getTime() - lastSeen >= QUIET_FOR_MS) {
        await tx`update public.hike_sessions set status = 'abandoned', paused_at = null where id = ${sessionId} and status in ('active', 'paused')`;
        log.info("hike.session_abandoned", { sessionId });
        return { outcome: "done" as const, note: "abandoned" };
      }
      if (recheck < MAX_RECHECKS) {
        await enqueueJob(
          tx,
          "hike.close_stale_session",
          { sessionId, recheck: recheck + 1 },
          { runAt: new Date(now.getTime() + RECHECK_AFTER_MS), dedupKey: `hike:${sessionId}:close_stale:${recheck + 1}` },
        );
      }
      return { outcome: "noop" as const, note: "recently synced; rescheduled" };
    });
  },
};
