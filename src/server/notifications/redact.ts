import "server-only";
import type { Tx } from "@/server/db";
import { COORDS_PATTERN, LOCATION_REMOVED, MAP_LINK_PATTERN, MAP_LINK_REMOVED } from "@/domain/notification-messages";
import { OPEN_STATUSES } from "@/domain/checkin";

/**
 * Stored notice bodies are the exact text that was sent (the user's audit
 * trail), so an overdue notice keeps the precise coordinates and map link it
 * contained. Deleting location history and the retention purge must remove
 * those too: coordinates become "[location removed]" and map links
 * "[map link removed]"; the rest of the text (times, accuracy, wording) is
 * kept so the history still shows what happened.
 */
const redactedBody = (tx: Tx) =>
  tx`regexp_replace(regexp_replace(n.body, ${MAP_LINK_PATTERN}, ${MAP_LINK_REMOVED}, 'g'), ${COORDS_PATTERN}, ${LOCATION_REMOVED}, 'g')`;
const hasLocation = (tx: Tx) => tx`(n.body ~ ${COORDS_PATTERN} or n.body ~ ${MAP_LINK_PATTERN})`;

/** Every notice about this user (any status, any trip). Returns the number of notices changed. */
export async function redactNoticeLocationsForUser(tx: Tx, userId: string): Promise<number> {
  const rows = await tx`
    update public.notifications n set body = ${redactedBody(tx)}
    where n.user_id = ${userId} and ${hasLocation(tx)}
    returning n.id`;
  return rows.length;
}

/**
 * Retention: notices older than each user's location_retention_days
 * (default `defaultDays`). Notices of a check-in that is still open are kept
 * intact, like its last-known location (a pending notice may still be sent).
 */
export async function redactExpiredNoticeLocations(tx: Tx, now: Date, defaultDays: number): Promise<number> {
  const rows = await tx`
    update public.notifications n set body = ${redactedBody(tx)}
    where n.user_id is not null and ${hasLocation(tx)}
      and n.created_at < ${now}::timestamptz - make_interval(days => coalesce(
        (select p.location_retention_days from public.profiles p where p.id = n.user_id), ${defaultDays}::int))
      and not exists (
        select 1 from public.trip_checkins c
        where c.id = n.checkin_id and c.status = any(${OPEN_STATUSES as string[]}::checkin_status[]))
    returning n.id`;
  return rows.length;
}
