import "server-only";
import { withSystem, type Tx } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { getOwnedTrip } from "@/server/trips/queries";
import { onHikeStarted, onTripFinished } from "@/server/checkins/service";
import { enqueueJob } from "@/server/jobs/queue";
import { log } from "@/server/log";
import { isDemoMode } from "@/config/env";
import type { TripStatus } from "@/domain/types";
import { closureVerdict, type DayClosure } from "@/domain/booking";
import { correctDeviceTime, estimateClockSkewMs } from "@/domain/outbox";
import { localDateInZone, zonedTimeToUtc } from "@/lib/time";
import { formatDate } from "@/lib/format";
import { hikeStartWindow, startAllowed, startWindowMessage } from "@/lib/offline/start-window";
import type { FinishResponse, SessionView, StartResponse } from "@/lib/offline/wire";
import { FUTURE_TOLERANCE_MS, type FinishInput, type StartInput } from "./schemas";
import { conflict, notFound, ok, type HikeResult } from "./result";

/** Sessions still open after this long with no sync are closed as abandoned by a job. */
export const STALE_SESSION_AFTER_MS = 72 * 3600_000;
const MAX_CLIENT_START_AGE_MS = 24 * 3600_000;

export interface SessionRow {
  id: string;
  tripId: string;
  userId: string;
  status: SessionView["status"];
  startedAt: Date;
  pausedAt: Date | null;
  finishedAt: Date | null;
  lastSyncAt: Date | null;
  lastLocationAt: Date | null;
  distanceCompletedM: number;
}

export const SESSION_COLUMNS = (tx: Tx) =>
  tx`id, trip_id, user_id, status, started_at, paused_at, finished_at, last_sync_at, last_location_at, distance_completed_m`;

export function toSessionView(s: SessionRow): SessionView {
  return {
    id: s.id,
    tripId: s.tripId,
    status: s.status,
    startedAt: s.startedAt.toISOString(),
    finishedAt: s.finishedAt?.toISOString() ?? null,
    lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
    distanceCompletedM: s.distanceCompletedM,
  };
}

/**
 * A device timestamp, accepted only within a plausible window around `now`.
 * `skewMs` (device clock − server clock, from the request's `sentAt`) is
 * subtracted first, so a phone whose clock is wrong still records the real time.
 */
export function plausibleClientTime(iso: string | undefined, now: Date, notBefore: Date, skewMs = 0): Date {
  if (!iso) return now;
  const raw = Date.parse(iso);
  if (Number.isNaN(raw)) return now;
  const t = new Date(correctDeviceTime(raw, skewMs));
  if (t.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) return now;
  if (t.getTime() < notBefore.getTime()) return now;
  return t.getTime() > now.getTime() ? now : t;
}

/** The calendar day after a YYYY-MM-DD date. */
export function nextDate(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Closures that still matter for starting a hike on a region-local calendar
 * day: active now, or scheduled to begin later that day. Closures that have
 * already ENDED (e.g. a morning storm closure lifted at 11:00) do not block an
 * afternoon start. A full ("closed") closure means a hike cannot be STARTED —
 * there is no demo override for it. Conservative: a full closure scheduled for
 * later the same day still blocks the start.
 */
export async function closuresForDay(tx: Tx, trailId: string, day: string, timeZone: string, now: Date = new Date()) {
  const dayStart = zonedTimeToUtc(day, "00:00", timeZone);
  const dayEnd = zonedTimeToUtc(nextDate(day), "00:00", timeZone);
  const notEndedBy = now.getTime() > dayStart.getTime() ? now : dayStart;
  const rows = await tx<DayClosure[]>`
    select severity, reason, starts_at, ends_at from public.trail_closures
    where trail_id = ${trailId} and starts_at < ${dayEnd}::timestamptz and (ends_at is null or ends_at > ${notEndedBy}::timestamptz)
    order by starts_at`;
  return closureVerdict(rows, day, timeZone);
}

/**
 * Closures a hiker needs to see for a trip: not ended, and starting before
 * the end of the booked day (active now, or scheduled for the hike date).
 * Full closures first.
 */
export async function tripClosures(
  tx: Tx,
  trailId: string,
  when: { bookedDate: string | null; timezone: string } | null,
): Promise<{ severity: string; reason: string; startsAt: Date; endsAt: Date | null }[]> {
  const bookedDayEnd = when?.bookedDate ? zonedTimeToUtc(nextDate(when.bookedDate), "00:00", when.timezone) : null;
  return tx<{ severity: string; reason: string; startsAt: Date; endsAt: Date | null }[]>`
    select severity, reason, starts_at, ends_at from public.trail_closures
    where trail_id = ${trailId} and (ends_at is null or ends_at > now())
      and starts_at <= greatest(now(), coalesce(${bookedDayEnd}::timestamptz, now()))
    order by (severity = 'closed') desc, starts_at`;
}

export function closedTrailStartMessage(day: string, reason: string): string {
  return `The trail is closed on ${formatDate(day, { weekday: "long", month: "long", day: "numeric" })}: ${reason.replace(/[.\s]+$/, "")}. This hike can't be started on a closed trail. Contact us from your trip page about changing or cancelling your booking.`;
}

/** The date a trip's hike is booked for (live booking's hike date, else the trip's planned date) and its region time zone. */
export async function bookedDateFor(tx: Tx, tripId: string): Promise<{ bookedDate: string | null; timezone: string } | null> {
  const [row] = await tx<{ bookedDate: string | null; timezone: string }[]>`
    select coalesce(
             (select to_char(b.hike_date, 'YYYY-MM-DD') from public.bookings b
              where b.trip_id = t.id and b.status in ('confirmed', 'cancellation_requested', 'refund_pending', 'needs_attention')
              order by b.created_at desc limit 1),
             to_char(t.planned_date, 'YYYY-MM-DD')) as booked_date,
           r.timezone
    from public.trips t join public.regions r on r.id = t.region_id
    where t.id = ${tripId}`;
  return row ?? null;
}

export interface StartOptions {
  /** whether "Start anyway (demo)" may be honoured; defaults to APP_MODE=demo */
  demoMode?: boolean;
}

/**
 * Start (or resume) the hike for a trip the user owns.
 * Idempotent: if a session is already open it is returned unchanged; a retry
 * with the same client session id returns that session. The trip moves to
 * `active` (lifecycle write via withSystem after the ownership check), the
 * check-in contract is notified, and a housekeeping job is enqueued in the
 * same transaction.
 *
 * A NEW session can only start on the booked date (region time zone), judged
 * at the device's start time so an offline start synced after midnight still
 * counts; an open session keeps going past midnight. In demo mode only, the
 * hiker can explicitly start on another day (`demoStartAnyway`).
 */
export async function startHike(user: SessionUser, input: StartInput, now = new Date(), opts: StartOptions = {}): Promise<HikeResult<StartResponse>> {
  const trip = await getOwnedTrip(user, input.tripId);
  if (!trip) return notFound("Trip not found");
  if (trip.status !== "booked" && trip.status !== "active") {
    return conflict(trip.status === "completed" ? "This trip is already completed." : "This trip is not booked, so a hike cannot start.");
  }
  const skewMs = estimateClockSkewMs(input.sentAt, now.getTime());
  const startedAt = plausibleClientTime(input.startedAt, now, new Date(now.getTime() - MAX_CLIENT_START_AGE_MS), skewMs);

  return withSystem(async (tx): Promise<HikeResult<StartResponse>> => {
    const [locked] = await tx<{ status: TripStatus }[]>`
      select status from public.trips where id = ${trip.id} and user_id = ${user.id} for update`;
    if (!locked) return notFound("Trip not found");
    if (locked.status !== "booked" && locked.status !== "active") return conflict("This trip can no longer be started.");

    const [open] = await tx<SessionRow[]>`
      select ${SESSION_COLUMNS(tx)} from public.hike_sessions
      where trip_id = ${trip.id} and status in ('active', 'paused') order by started_at desc limit 1`;
    if (open) {
      if (locked.status === "booked") await tx`update public.trips set status = 'active' where id = ${trip.id}`;
      return ok({ session: toSessionView(open), created: false, tripStatus: "active" });
    }

    let proposedId = input.clientSessionId ?? null;
    if (proposedId) {
      const [existing] = await tx<SessionRow[]>`select ${SESSION_COLUMNS(tx)} from public.hike_sessions where id = ${proposedId}`;
      if (existing) {
        // A retried start whose first response was lost → same session.
        if (existing.tripId === trip.id && existing.userId === user.id) {
          return ok({ session: toSessionView(existing), created: false, tripStatus: locked.status });
        }
        proposedId = null; // id collision with someone else's session: never reveal or reuse it
      }
    }

    const when = await bookedDateFor(tx, trip.id);
    if (when) {
      const w = hikeStartWindow(when.bookedDate, when.timezone, startedAt);
      const demoOverride = input.demoStartAnyway === true && (opts.demoMode ?? isDemoMode());
      if (!startAllowed(w) && !demoOverride) return conflict(startWindowMessage(w) ?? "This hike can only start on its booked date.");
      // A trail fully closed on the day the hike would start: never (not even in a demo).
      const day = localDateInZone(startedAt, when.timezone);
      const closures = await closuresForDay(tx, trip.trailId, day, when.timezone, startedAt);
      if (closures.closed) return conflict(closedTrailStartMessage(day, closures.closed.reason));
    }

    const [session] = await tx<SessionRow[]>`
      insert into public.hike_sessions (id, trip_id, user_id, status, started_at)
      values (coalesce(${proposedId}::uuid, gen_random_uuid()), ${trip.id}, ${user.id}, 'active', ${startedAt}::timestamptz)
      returning ${SESSION_COLUMNS(tx)}`;
    await tx`update public.trips set status = 'active' where id = ${trip.id} and status = 'booked'`;
    await onHikeStarted(tx, trip.id, user.id);
    await enqueueJob(
      tx,
      "hike.close_stale_session",
      { sessionId: session.id },
      { runAt: new Date(startedAt.getTime() + STALE_SESSION_AFTER_MS), dedupKey: `hike:${session.id}:close_stale:0` },
    );
    log.info("hike.started", { tripId: trip.id, sessionId: session.id });
    return ok({ session: toSessionView(session), created: true, tripStatus: "active" });
  });
}

/**
 * Finish the hike: the open session becomes `finished`, the trip
 * `completed`, and the check-in contract is told (reminders/overdue jobs are
 * cancelled there). Idempotent: finishing a completed trip returns the
 * finished session (and re-notifies the contract, which is safe).
 */
export async function finishHike(user: SessionUser, input: FinishInput, now = new Date()): Promise<HikeResult<FinishResponse>> {
  const trip = await getOwnedTrip(user, input.tripId);
  if (!trip) return notFound("Trip not found");

  return withSystem(async (tx): Promise<HikeResult<FinishResponse>> => {
    const [locked] = await tx<{ status: TripStatus }[]>`
      select status from public.trips where id = ${trip.id} and user_id = ${user.id} for update`;
    if (!locked) return notFound("Trip not found");
    const latest = async () =>
      (
        await tx<SessionRow[]>`
          select ${SESSION_COLUMNS(tx)} from public.hike_sessions where trip_id = ${trip.id}
          order by (status in ('active', 'paused')) desc, started_at desc limit 1`
      )[0] ?? null;

    if (locked.status === "completed") {
      const s = await latest();
      await onTripFinished(tx, trip.id, user.id);
      if (!s) return conflict("This trip has no recorded hike.");
      return ok({ session: toSessionView(s), alreadyFinished: true, tripStatus: "completed" });
    }
    if (locked.status !== "active") return conflict("Start the hike before finishing it.");

    const [open] = await tx<SessionRow[]>`
      select ${SESSION_COLUMNS(tx)} from public.hike_sessions
      where trip_id = ${trip.id} and status in ('active', 'paused') order by started_at desc limit 1 for update`;
    let session: SessionRow | null = open ?? null;
    if (open) {
      const finishedAt = plausibleClientTime(input.finishedAt, now, open.startedAt, estimateClockSkewMs(input.sentAt, now.getTime()));
      const distance = Math.round(input.distanceCompletedM ?? 0);
      [session] = await tx<SessionRow[]>`
        update public.hike_sessions
        set status = 'finished', finished_at = ${finishedAt}::timestamptz, paused_at = null,
            distance_completed_m = greatest(distance_completed_m, ${distance}::int)
        where id = ${open.id}
        returning ${SESSION_COLUMNS(tx)}`;
    } else {
      session = await latest();
    }
    await tx`update public.trips set status = 'completed' where id = ${trip.id}`;
    await onTripFinished(tx, trip.id, user.id);
    log.info("hike.finished", { tripId: trip.id, sessionId: session?.id ?? null });
    if (!session) return conflict("This trip has no recorded hike.");
    return ok({ session: toSessionView(session), alreadyFinished: false, tripStatus: "completed" });
  });
}
