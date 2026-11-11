import "server-only";
import { withSystem, withUser, type JsonValue } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { onCheckinConfirmedFromDevice, onCheckinExtendedFromDevice } from "@/server/checkins/service";
import { log } from "@/server/log";
import { correctDeviceTime, estimateClockSkewMs, isSafetyEventKind } from "@/domain/outbox";
import type { CheckinSyncResult, HikeEventData, SyncRejection, SyncResponse } from "@/lib/offline/wire";
import { FUTURE_TOLERANCE_MS, type SyncInput } from "./schemas";
import { notFound, ok, type HikeResult } from "./result";

type InPoint = SyncInput["points"][number];
type InEvent = SyncInput["events"][number];

/**
 * Accept a batch of location points and events recorded on the device
 * (possibly offline, delayed, retried or out of order).
 *
 *  - Ownership: the session must belong to the user (404 otherwise); all
 *    writes to user-owned hike tables run as the user (RLS applies).
 *  - Idempotency: rows are keyed by the client's ids; duplicates are
 *    ignored (ON CONFLICT DO NOTHING) but still acknowledged so the device
 *    can drop them from its outbox.
 *  - Device clocks can be wrong: the batch's `sentAt` (device clock) is
 *    compared with the server clock and every device timestamp is corrected
 *    by that skew (bounded; see estimateClockSkewMs). Event payloads keep the
 *    raw device time (`deviceOccurredAt`) when it was changed.
 *  - Points and ordinary events still more than 2 minutes in the future
 *    after correction are rejected (and reported to the device). Safety
 *    events — "I'm okay", "Extend my trip", finish — are NEVER rejected for
 *    clock reasons: they are accepted with the time clamped to now.
 *  - The last-known location only ever moves FORWARD in time: an older or
 *    delayed batch never overwrites a newer location.
 *  - "I'm okay" and "Extend my trip" are forwarded to the check-in contract
 *    (idempotent per client event id), in the order they happened, after the
 *    batch is stored. What happened to each extension is reported back.
 */
export async function syncHike(user: SessionUser, input: SyncInput, now = new Date()): Promise<HikeResult<SyncResponse>> {
  const nowMs = now.getTime();
  const skewMs = estimateClockSkewMs(input.sentAt, nowMs);
  const limit = nowMs + FUTURE_TOLERANCE_MS;
  const onServerClock = (iso: string) => correctDeviceTime(Date.parse(iso), skewMs);
  const rejected: SyncRejection[] = [];

  const seenPoints = new Set<string>();
  const points: (InPoint & { at: Date })[] = [];
  for (const p of input.points) {
    if (seenPoints.has(p.id)) continue;
    seenPoints.add(p.id);
    const t = onServerClock(p.recordedAt);
    if (!Number.isFinite(t)) rejected.push({ id: p.id, kind: "point", reason: "invalid" });
    else if (t > limit) rejected.push({ id: p.id, kind: "point", reason: "future_timestamp" });
    else points.push({ ...p, at: new Date(t) });
  }

  const seenEvents = new Set<string>();
  const events: (InEvent & { at: Date; stored: HikeEventData & { deviceOccurredAt?: string } })[] = [];
  for (const e of input.events) {
    if (seenEvents.has(e.id)) continue;
    seenEvents.add(e.id);
    let t = onServerClock(e.occurredAt);
    if (!Number.isFinite(t)) {
      if (!isSafetyEventKind(e.kind)) {
        rejected.push({ id: e.id, kind: "event", reason: "invalid" });
        continue;
      }
      t = nowMs;
    }
    if (t > limit) {
      if (!isSafetyEventKind(e.kind)) {
        rejected.push({ id: e.id, kind: "event", reason: "future_timestamp" });
        continue;
      }
      t = nowMs; // never lose an "I'm okay" / extension / finish to a wrong clock
    }
    const stored: HikeEventData & { deviceOccurredAt?: string } = { ...e.payload };
    if (t !== Date.parse(e.occurredAt)) stored.deviceOccurredAt = e.occurredAt;
    if (e.payload.newExpectedReturnAt) {
      const n = onServerClock(e.payload.newExpectedReturnAt);
      if (Number.isFinite(n)) stored.newExpectedReturnAt = new Date(n).toISOString();
    }
    events.push({ ...e, at: new Date(t), stored });
  }
  if (skewMs !== 0) log.info("hike.sync.clock_corrected", { sessionId: input.sessionId, skewMs });

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
        recordedAt: p.at,
      }));
      await tx`
        insert into public.location_points
          ${tx(rows, "hikeSessionId", "userId", "clientPointId", "lat", "lng", "accuracyM", "altitudeM", "recordedAt")}
        on conflict (hike_session_id, client_point_id) do nothing`;

      // Newest point in this batch → last-known location, only if newer than what we have.
      const newest = points.reduce((a, b) => (b.at.getTime() > a.at.getTime() ? b : a));
      await tx`
        insert into public.hike_last_locations (hike_session_id, user_id, lat, lng, accuracy_m, recorded_at, received_at)
        values (${session.id}, ${user.id}, ${newest.lat}, ${newest.lng}, ${newest.accuracyM}, ${newest.at}::timestamptz, now())
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
        payload: tx.json(e.stored as JsonValue),
        occurredAt: e.at,
      }));
      await tx`
        insert into public.hike_events ${tx(rows, "hikeSessionId", "userId", "clientEventId", "kind", "payload", "occurredAt")}
        on conflict (hike_session_id, client_event_id) do nothing`;
    }

    const maxRecordedAt = points.length ? new Date(Math.max(...points.map((p) => p.at.getTime()))) : null;
    const progress = input.progressM !== undefined ? Math.round(input.progressM) : null;
    // Pause state follows the LATEST pause/resume event by (corrected) device time, so
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

  // "I'm okay" taps and extensions, in the order they happened on the device.
  const checkinEvents = events
    .filter((e) => e.kind === "checkin_ok" || e.kind === "checkin_extend")
    .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : 1));
  const checkin: CheckinSyncResult[] = [];
  if (checkinEvents.length) {
    await withSystem(async (tx) => {
      for (const e of checkinEvents) {
        if (e.kind === "checkin_ok") {
          await onCheckinConfirmedFromDevice(tx, result.session.tripId, user.id, e.at, e.id);
          continue;
        }
        const until = e.stored.newExpectedReturnAt ? new Date(e.stored.newExpectedReturnAt) : new Date(Number.NaN);
        const r = await onCheckinExtendedFromDevice(tx, result.session.tripId, user.id, e.at, until, e.id);
        checkin.push({ eventId: e.id, kind: "checkin_extend", applied: r.applied, ...(r.reason ? { reason: r.reason } : {}) });
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
    clockSkewMs: skewMs,
    checkin,
  });
}
