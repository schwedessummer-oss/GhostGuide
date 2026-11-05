import "server-only";
import { withSystem, type Tx } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { getOwnedTrip } from "@/server/trips/queries";
import { onHikeStarted, onTripFinished } from "@/server/checkins/service";
import { enqueueJob } from "@/server/jobs/queue";
import { log } from "@/server/log";
import type { TripStatus } from "@/domain/types";
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

/** A device timestamp, accepted only within a plausible window around `now`. */
export function plausibleClientTime(iso: string | undefined, now: Date, notBefore: Date): Date {
  if (!iso) return now;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return now;
  if (t.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) return now;
  if (t.getTime() < notBefore.getTime()) return now;
  return t.getTime() > now.getTime() ? now : t;
}

/**
 * Start (or resume) the hike for a trip the user owns.
 * Idempotent: if a session is already open it is returned unchanged; a retry
 * with the same client session id returns that session. The trip moves to
 * `active` (lifecycle write via withSystem after the ownership check), the
 * check-in contract is notified, and a housekeeping job is enqueued in the
 * same transaction.
 */
export async function startHike(user: SessionUser, input: StartInput, now = new Date()): Promise<HikeResult<StartResponse>> {
  const trip = await getOwnedTrip(user, input.tripId);
  if (!trip) return notFound("Trip not found");
  if (trip.status !== "booked" && trip.status !== "active") {
    return conflict(trip.status === "completed" ? "This trip is already completed." : "This trip is not booked, so a hike cannot start.");
  }
  const startedAt = plausibleClientTime(input.startedAt, now, new Date(now.getTime() - MAX_CLIENT_START_AGE_MS));

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
      const finishedAt = plausibleClientTime(input.finishedAt, now, open.startedAt);
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
