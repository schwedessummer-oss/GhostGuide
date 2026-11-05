import "server-only";
import { withSystem } from "@/server/db";
import type { JobOutcome } from "@/server/jobs/queue";
import { recordAudit } from "@/server/audit";
import { log } from "@/server/log";
import { OPEN_STATUSES } from "@/domain/checkin";
import { getSafetySettings } from "@/server/checkins/settings";

const BATCH = 5_000;
const MAX_BATCHES = 200;

/**
 * `locations.purge_expired` (daily): delete precise location history older
 * than each user's profiles.location_retention_days (default
 * app_settings.location_retention_default_days for users without a
 * profile). Deletes in batches so a large backlog never holds long locks.
 *
 * The last-known location of a trip whose check-in is still open is kept
 * (it may be needed for an overdue notice on a multi-day trip); it is purged
 * on the first run after the check-in ends.
 *
 * Counts are recorded in audit_logs (actor null, action 'retention.purge').
 */
export async function purgeExpiredLocations(now: Date): Promise<JobOutcome> {
  const { retentionDefaultDays } = await getSafetySettings();
  let pointsDeleted = 0;
  let batches = 0;
  for (; batches < MAX_BATCHES; batches++) {
    const rows = await withSystem(
      (tx) => tx`
        delete from public.location_points
        where id in (
          select lp.id from public.location_points lp
          left join public.profiles p on p.id = lp.user_id
          where lp.recorded_at < ${now}::timestamptz - make_interval(days => coalesce(p.location_retention_days, ${retentionDefaultDays}::int))
          limit ${BATCH}
        )
        returning id`,
    );
    pointsDeleted += rows.length;
    if (rows.length < BATCH) break;
  }
  const lastFixesDeleted = await withSystem(async (tx) => {
    const rows = await tx`
      delete from public.hike_last_locations hll
      using public.hike_sessions s
      where s.id = hll.hike_session_id
        and hll.recorded_at < ${now}::timestamptz - make_interval(days => coalesce(
          (select p.location_retention_days from public.profiles p where p.id = hll.user_id), ${retentionDefaultDays}::int))
        and not exists (
          select 1 from public.trip_checkins c
          where c.trip_id = s.trip_id and c.status = any(${OPEN_STATUSES as string[]}::checkin_status[]))
      returning hll.hike_session_id`;
    await recordAudit(tx, { id: null }, "retention.purge", "location_points", null, {
      pointsDeleted,
      lastFixesDeleted: rows.length,
      defaultRetentionDays: retentionDefaultDays,
      batches: batches + 1,
      ranAt: now.toISOString(),
    });
    return rows.length;
  });
  log.info("retention.purge", { pointsDeleted, lastFixesDeleted });
  return { outcome: pointsDeleted || lastFixesDeleted ? "done" : "noop", note: `${pointsDeleted} points, ${lastFixesDeleted} last fixes` };
}
