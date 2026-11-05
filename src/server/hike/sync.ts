import "server-only";
import { withSystem, withUser, type JsonValue } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { onCheckinConfirmedFromDevice } from "@/server/checkins/service";
import type { SyncRejection, SyncResponse } from "@/lib/offline/wire";
import { FUTURE_TOLERANCE_MS, type SyncInput } from "./schemas";
import { notFound, ok, type HikeResult } from "./result";

/**
 * Accept a batch of location points and events recorded on the device
 * (possibly offline, delayed, retried or out of order).
 *
 *  - Ownership: the session must belong to the user (404 otherwise); all
 *    writes to user-owned hike tables run as the user (RLS applies).
 *  - Idempotency: rows are keyed by the client's ids; duplicates are
 *    ignored (ON CONFLICT DO NOTHING) but still acknowledged so the device
 *    can drop them from its outbox.
 *  - Points/events stamped more than 2 minutes in the future are rejected.
 *  - The last-known location only ever moves FORWARD in time: an older or
 *    delayed batch never overwrites a newer location.
 *  - "I'm okay" taps are forwarded to the check-in contract (idempotent per
 *    client event id) after the batch is stored.
 */
export async function syncHike(user: SessionUser, input: SyncInput, now = new Date()): Promise<HikeResult<SyncResponse>> {
  const limit = now.getTime() + FUTURE_TOLERANCE_MS;
  const rejected: SyncRejection[] = [];
  const seenPoints = new Set<string>();
  const points = input.points.filter((p) => {
    if (seenPoints.has(p.id)) return false;
    seenPoints.add(p.id);
    if (Date.parse(p.recordedAt) > limit) {
      rejected.push({ id: p.id, kind: "point", reason: "future_timestamp" });
      return false;
    }
    return true;
  });
  const seenEvents = new Set<string>();
  const events = input.events.filter((e) => {
    if (seenEvents.has(e.id)) return false;
    seenEvents.add(e.id);
    if (Date.parse(e.occurredAt) > limit) {
      rejected.push({ id: e.id, kind: "event", reason: "future_timestamp" });
      return false;
    }
    return true;
  });

  const result = await withUser(user, async (tx) => {
    const [session] = await tx<{ id: string; tripId: string; status: string }[]>`
      select id, trip_id, status from public.hike_sessions where id = ${input.sessionId} and user_id = ${user.id}`;
    if (!session) return null;

    if (points.length) {
      const rows = points.map((p) => ({
        hikeSessionId: session.id,
        userId: user.id,
        clientPointId: p.id,
        lat: p.lat,
        lng: p.lng,
        accuracyM: p.accuracyM,
        altitudeM: p.altitudeM,
        recordedAt: new Date(p.recordedAt),
      }));
      await tx`
        insert into public.location_points
          ${tx(rows, "hikeSessionId", "userId", "clientPointId", "lat", "lng", "accuracyM", "altitudeM", "recordedAt")}
        on conflict (hike_session_id, client_point_id) do nothing`;

      // Newest point in this batch → last-known location, only if newer than what we have.
      const newest = points.reduce((a, b) => (Date.parse(b.recordedAt) > Date.parse(a.recordedAt) ? b : a));
      await tx`
        insert into public.hike_last_locations (hike_session_id, user_id, lat, lng, accuracy_m, recorded_at, received_at)
        values (${session.id}, ${user.id}, ${newest.lat}, ${newest.lng}, ${newest.accuracyM}, ${newest.recordedAt}::timestamptz, now())
        on conflict (hike_session_id) do update
          set lat = excluded.lat, lng = excluded.lng, accuracy_m = excluded.accuracy_m,
              recorded_at = excluded.recorded_at, received_at = excluded.received_at
          where public.hike_last_locations.recorded_at < excluded.recorded_at`;
    }

    if (events.length) {
      const rows = events.map((e) => ({
        hikeSessionId: session.id,
        userId: user.id,
        clientEventId: e.id,
        kind: e.kind,
        payload: tx.json(e.payload as JsonValue),
        occurredAt: new Date(e.occurredAt),
      }));
      await tx`
        insert into public.hike_events ${tx(rows, "hikeSessionId", "userId", "clientEventId", "kind", "payload", "occurredAt")}
        on conflict (hike_session_id, client_event_id) do nothing`;
    }

    const maxRecordedAt = points.length ? new Date(Math.max(...points.map((p) => Date.parse(p.recordedAt)))) : null;
    const progress = input.progressM !== undefined ? Math.round(input.progressM) : null;
    // Pause state follows the LATEST pause/resume event by device time, so
    // delayed or reordered batches converge on the same answer.
    const [updated] = await tx<{ id: string; status: string; lastSyncAt: Date | null }[]>`
      with last_toggle as (
        select kind, occurred_at from public.hike_events
        where hike_session_id = ${session.id} and kind in ('pause', 'resume')
        order by occurred_at desc, id desc limit 1
      )
      update public.hike_sessions s set
        last_sync_at = now(),
        last_location_at = greatest(s.last_location_at, ${maxRecordedAt}::timestamptz),
        distance_completed_m = greatest(s.distance_completed_m, coalesce(${progress}::int, 0)),
        status = case
          when s.status in ('active', 'paused') then
            case when (select kind from last_toggle) = 'pause' then 'paused'::public.hike_status else 'active'::public.hike_status end
          else s.status end,
        paused_at = case
          when s.status in ('active', 'paused') and (select kind from last_toggle) = 'pause' then (select occurred_at from last_toggle)
          when s.status in ('active', 'paused') then null
          else s.paused_at end
      where s.id = ${session.id}
      returning s.id, s.status, s.last_sync_at`;
    return { session, updated };
  });
  if (!result) return notFound("Hike session not found");

  const confirmations = events.filter((e) => e.kind === "checkin_ok");
  if (confirmations.length) {
    await withSystem(async (tx) => {
      for (const e of confirmations) {
        await onCheckinConfirmedFromDevice(tx, result.session.tripId, user.id, new Date(e.occurredAt), e.id);
      }
    });
  }

  return ok({
    serverTime: new Date().toISOString(),
    acceptedPointIds: points.map((p) => p.id),
    acceptedEventIds: events.map((e) => e.id),
    rejected,
    session: {
      id: result.updated.id,
      status: result.updated.status,
      lastSyncAt: result.updated.lastSyncAt?.toISOString() ?? null,
    },
  });
}
