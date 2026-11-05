import "server-only";
import type { JobHandlers } from "../queue";
import { processOverdueJob, processReminderJob, scanOverdue } from "@/server/checkins/jobs";
import { processNotificationSend } from "@/server/notifications/send";
import { purgeExpiredLocations } from "@/server/account/retention";

/**
 * Job handlers for check-in reminders, overdue checks, notifications and
 * location retention (owned by the safety slice). Every handler is
 * idempotent and version-guarded: it re-loads current state and returns
 * { outcome: "noop" } when the job is obsolete.
 *
 *  checkins.reminder        {checkinId, version, offsetMin}  reminder to the hiker
 *  checkins.overdue         {checkinId, version}             overdue -> notices to consenting contact + hiker
 *  checkins.scan_overdue    {} (periodic, 1 min)             safety net: (re)queues the same overdue job
 *  notifications.send       {notificationId}                 deliver via provider (demo = simulated)
 *  locations.purge_expired  {} (periodic, daily)             per-user precise-location retention
 */
export const safetyHandlers: JobHandlers = {
  "checkins.reminder": (job, { now }) => processReminderJob(job.payload, now),
  "checkins.overdue": (job, { now }) => processOverdueJob(job.payload, now),
  "checkins.scan_overdue": (_job, { now }) => scanOverdue(now),
  "notifications.send": (job, { now }) => processNotificationSend(job.payload, now),
  "locations.purge_expired": (_job, { now }) => purgeExpiredLocations(now),
};
