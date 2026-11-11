import "server-only";
import { z } from "zod";
import type { Tx } from "@/server/db";
import { log } from "@/server/log";
import { can } from "@/server/auth/rbac";
import {
  cancelTransition,
  confirmOkTransition,
  deviceExtendTransition,
  finishTransition,
  hikeStartedTransition,
  staffResolveTransition,
} from "@/domain/checkin";
import { applyTransition, lockCheckinById, lockCheckinByTrip, recordCheckinEvent } from "./core";

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

/** Latest time the user changed the schedule (setup/update/extension), by when it was made. */
async function lastScheduleChangeAt(tx: Tx, checkinId: string): Promise<Date | null> {
  const [r] = await tx<{ at: Date | null }[]>`
    select max(coalesce((details ->> 'occurredAt')::timestamptz, created_at)) as at
    from public.checkin_events
    where checkin_id = ${checkinId} and kind in ('opted_in', 'updated', 'extended')`;
  return r?.at ?? null;
}

const validDate = (d: unknown): d is Date => d instanceof Date && Number.isFinite(d.getTime());

/**
 * CROSS-SLICE CONTRACT — called by hike sync for a "checkin_extend" event
 * ("Extend my trip" recorded on the device, possibly offline, so
 * `occurredAt` may be in the past). Idempotent per `clientEventId`; ignores
 * completed/cancelled check-ins; rejects a new time at/before `occurredAt`
 * or more than 24 h after it. Applied as if it had arrived when it was made
 * (deviceExtendTransition): a STALE extension never overrides a newer
 * schedule change or moves the time backwards behind a later "I'm okay".
 * On apply: version++, old-version jobs cancelled, new ones scheduled, and a
 * checkin_events row (actor 'user', details.source 'device'); an
 * already-notified contact gets an "extended" follow-up stating when the
 * hiker extended. Not applied: an `extend_ignored` event with the reason.
 */
export async function onCheckinExtendedFromDevice(
  tx: Tx,
  tripId: string,
  userId: string,
  occurredAt: Date,
  newExpectedReturnAt: Date,
  clientEventId: string,
): Promise<{ applied: boolean; reason?: string }> {
  if (typeof clientEventId !== "string" || !CLIENT_EVENT_ID.test(clientEventId)) {
    log.warn("checkin.device_extend.invalid_client_event_id", { tripId });
    return { applied: false, reason: "invalid client event id" };
  }
  const row = await lockCheckinByTrip(tx, tripId);
  if (!row || row.userId !== userId) return { applied: false, reason: "no check-in for this trip" };
  const [seen] = await tx<{ kind: string }[]>`
    select kind from public.checkin_events where checkin_id = ${row.id} and details ->> 'clientEventId' = ${clientEventId}`;
  if (seen) return { applied: seen.kind === "extended", reason: "duplicate" };

  const now = new Date();
  const who = { actor: "user", actorId: userId } as const;
  const details: Record<string, unknown> = { clientEventId, source: "device" };
  if (validDate(occurredAt)) details.occurredAt = new Date(Math.min(occurredAt.getTime(), now.getTime())).toISOString();
  if (validDate(newExpectedReturnAt)) details.requestedReturnAt = newExpectedReturnAt.toISOString();
  const r =
    validDate(occurredAt) && validDate(newExpectedReturnAt)
      ? deviceExtendTransition(row, { occurredAt, newExpectedReturnAt, now, lastScheduleChangeAt: await lastScheduleChangeAt(tx, row.id) })
      : ({ ok: false, reason: "invalid time" } as const);
  if (!r.ok) {
    await recordCheckinEvent(tx, row.id, "extend_ignored", who, { ...details, reason: r.reason });
    return { applied: false, reason: r.reason };
  }
  await applyTransition(tx, row, r.result, { now, who, details });
  return { applied: true };
}

export const staffResolveSchema = z.object({
  outcome: z.enum(["hiker_confirmed_safe", "note_only"]),
  note: z.string().trim().min(1, "Add a short note about what happened.").max(1000, "Keep the note under 1,000 characters."),
});

/**
 * CROSS-SLICE CONTRACT — called by the admin safety desk (permission
 * trips.monitor; the caller writes the audit log). "note_only" records a
 * staff note (checkin_events, actor 'staff', details { outcome, note })
 * without changing state. "hiker_confirmed_safe" (from overdue,
 * contact_notified, active or confirmed_ok) completes the check-in, cancels
 * queued jobs, suppresses undelivered notices, records the note, and — if
 * the contact was already notified — queues the "finished" follow-up worded
 * as a staff confirmation. Notes are visible to the hiker in their check-in
 * activity (checkin_events RLS), so they must not contain anything the
 * hiker shouldn't read.
 */
export async function staffResolveCheckin(
  tx: Tx,
  checkinId: string,
  staff: { id: string; roles: readonly string[] },
  input: { outcome: "hiker_confirmed_safe" | "note_only"; note: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!staff || typeof staff.id !== "string" || !can(staff.roles, "trips.monitor")) {
    return { ok: false, error: "You don't have permission to resolve check-ins." };
  }
  if (!z.uuid().safeParse(checkinId).success) return { ok: false, error: "Check-in not found." };
  const parsed = staffResolveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
  const row = await lockCheckinById(tx, checkinId);
  if (!row) return { ok: false, error: "Check-in not found." };
  const now = new Date();
  const who = { actor: "staff", actorId: staff.id } as const;
  const details = { outcome: parsed.data.outcome, note: parsed.data.note };
  if (parsed.data.outcome === "note_only") {
    await recordCheckinEvent(tx, row.id, "staff_note", who, details);
    return { ok: true };
  }
  const result = staffResolveTransition(row, now);
  if ("error" in result) return { ok: false, error: result.error };
  await applyTransition(tx, row, result, { now, who, details });
  return { ok: true };
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
