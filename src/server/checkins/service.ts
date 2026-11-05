import "server-only";
import type { Tx } from "@/server/db";
import { log } from "@/server/log";
import { cancelTransition, confirmOkTransition, finishTransition, hikeStartedTransition } from "@/domain/checkin";
import { applyTransition, lockCheckinByTrip, recordCheckinEvent } from "./core";

/**
 * CROSS-SLICE CONTRACT — implemented by the safety slice.
 * The hike slice calls these when a hike starts / finishes. Signatures are
 * fixed; implementations are idempotent, run entirely inside the caller's
 * (system) transaction, and cancel obsolete jobs.
 *
 * Authorization: the caller has already authenticated `userId`; every
 * function additionally checks that the trip's check-in belongs to that
 * user and silently does nothing otherwise.
 */

const CLIENT_EVENT_ID = /^[A-Za-z0-9:_.-]{1,128}$/;

/** Called (inside the caller's system transaction) when a hike session starts. No-op if the user has not opted in. */
export async function onHikeStarted(tx: Tx, tripId: string, userId: string): Promise<void> {
  const row = await lockCheckinByTrip(tx, tripId);
  if (!row || row.userId !== userId || row.status !== "scheduled") return;
  await applyTransition(tx, row, hikeStartedTransition(row), { now: new Date(), who: { actor: "user", actorId: userId } });
}

/**
 * Called by hike sync when an "I'm okay" tap recorded on the device (possibly
 * offline, so `occurredAt` may be in the past) reaches the server. Must ignore
 * confirmations for completed/cancelled check-ins and be idempotent per
 * `clientEventId`.
 */
export async function onCheckinConfirmedFromDevice(
  tx: Tx,
  tripId: string,
  userId: string,
  occurredAt: Date,
  clientEventId: string,
): Promise<void> {
  if (typeof clientEventId !== "string" || !CLIENT_EVENT_ID.test(clientEventId)) {
    log.warn("checkin.device_ok.invalid_client_event_id", { tripId });
    return;
  }
  const row = await lockCheckinByTrip(tx, tripId);
  if (!row || row.userId !== userId) return;
  // Idempotency: the row lock serializes concurrent syncs; the unique index
  // on (checkin_id, details->>'clientEventId') backs this up.
  const [seen] = await tx`
    select 1 from public.checkin_events where checkin_id = ${row.id} and details ->> 'clientEventId' = ${clientEventId}`;
  if (seen) return;
  const now = new Date();
  const t = occurredAt instanceof Date ? occurredAt.getTime() : NaN;
  // Device clocks can be ahead: a tap "in the future" counts as now.
  const tappedAt = Number.isFinite(t) ? new Date(Math.min(t, now.getTime())) : now;
  const details = { clientEventId, source: "device", tappedAt: tappedAt.toISOString() };
  if (row.status === "completed" || row.status === "cancelled") {
    await recordCheckinEvent(tx, row.id, "ok_ignored", { actor: "user", actorId: userId }, { ...details, note: `check-in is ${row.status}` });
    return;
  }
  await applyTransition(tx, row, confirmOkTransition(row, { tappedAt, now }), { now, who: { actor: "user", actorId: userId }, details });
}

/**
 * Called when the user finishes the trip (from the hike screen or the
 * check-in "Finish trip" action). Marks the check-in completed and cancels
 * every pending reminder / overdue job. Must be safe to call repeatedly.
 */
export async function onTripFinished(tx: Tx, tripId: string, userId: string): Promise<void> {
  const row = await lockCheckinByTrip(tx, tripId);
  if (!row || row.userId !== userId) return;
  if (row.status === "completed" || row.status === "cancelled") return;
  await applyTransition(tx, row, finishTransition(row, new Date()), { now: new Date(), who: { actor: "user", actorId: userId } });
}

/**
 * Trip / booking cancelled: cancel the trip's check-in (status cancelled,
 * version bumped, queued reminder/overdue jobs cancelled, undelivered
 * notices suppressed). Call inside the cancellation transaction, after
 * authorizing the actor. Returns true when a check-in was cancelled.
 * Safe to call repeatedly or for trips without a check-in.
 */
export async function cancelCheckinForTrip(tx: Tx, tripId: string, reason = "trip_cancelled"): Promise<boolean> {
  const row = await lockCheckinByTrip(tx, tripId);
  if (!row || row.status === "completed" || row.status === "cancelled") return false;
  await applyTransition(tx, row, cancelTransition(row), { now: new Date(), who: { actor: "system", actorId: null }, details: { reason } });
  return true;
}
