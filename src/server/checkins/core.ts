import "server-only";
import type { JsonValue, Tx } from "@/server/db";
import { cancelQueuedJobs, enqueueJob } from "@/server/jobs/queue";
import {
  checkinJobPrefix,
  computeSchedule,
  type CheckinState,
  type FollowUpKind,
  type TransitionResult,
} from "@/domain/checkin";
import { buildContactFollowUpMessage } from "@/domain/notification-messages";
import type { CheckinStatus, TripStatus } from "@/domain/types";
import { createNotification, NOTIFICATION_TEMPLATES, sendJobDedupKey, VERSIONED_TEMPLATES } from "@/server/notifications/create";
import { addressOn } from "@/server/notifications/addresses";
import { loadContact, loadNoticeContext } from "./context";

/**
 * Check-in persistence and side effects shared by user actions, the hike
 * slice hooks and job handlers. Every function takes the caller's
 * transaction: state change, events, job (re)scheduling and notification
 * outbox rows commit together. Callers must already have authorized the
 * actor and must hold the row lock (lockCheckin*).
 */
export interface CheckinRow extends CheckinState {
  id: string;
  tripId: string;
  userId: string;
  emergencyContactId: string | null;
  tripStatus: TripStatus;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = (tx: Tx) => tx`
  c.id, c.trip_id, c.user_id, c.emergency_contact_id, c.expected_return_at, c.grace_minutes, c.reminder_offsets_min,
  c.status, c.version, c.last_ok_at, c.overdue_at, c.contact_notified_at, c.completed_at, c.created_at, c.updated_at,
  tr.status as trip_status`;

export async function lockCheckinById(tx: Tx, checkinId: string): Promise<CheckinRow | null> {
  const [row] = await tx<CheckinRow[]>`
    select ${COLUMNS(tx)} from public.trip_checkins c join public.trips tr on tr.id = c.trip_id
    where c.id = ${checkinId} for update of c`;
  return row ?? null;
}

export async function lockCheckinByTrip(tx: Tx, tripId: string): Promise<CheckinRow | null> {
  const [row] = await tx<CheckinRow[]>`
    select ${COLUMNS(tx)} from public.trip_checkins c join public.trips tr on tr.id = c.trip_id
    where c.trip_id = ${tripId} for update of c`;
  return row ?? null;
}

export async function persistCheckin(tx: Tx, id: string, s: CheckinState) {
  await tx`
    update public.trip_checkins set
      status = ${s.status}, version = ${s.version}, expected_return_at = ${s.expectedReturnAt}::timestamptz,
      grace_minutes = ${s.graceMinutes}, reminder_offsets_min = ${s.reminderOffsetsMin}::int[],
      last_ok_at = ${s.lastOkAt}::timestamptz, overdue_at = ${s.overdueAt}::timestamptz,
      contact_notified_at = ${s.contactNotifiedAt}::timestamptz, completed_at = ${s.completedAt}::timestamptz
    where id = ${id}`;
}

export type EventActor = { actor: "user" | "system" | "staff"; actorId: string | null };

export async function recordCheckinEvent(tx: Tx, checkinId: string, kind: string, who: EventActor, details: Record<string, unknown> = {}) {
  await tx`
    insert into public.checkin_events (checkin_id, kind, actor, actor_id, details)
    values (${checkinId}, ${kind}, ${who.actor}, ${who.actorId}, ${tx.json(details as JsonValue)})`;
}

/** Enqueue reminder + overdue jobs for the check-in's CURRENT version. */
export async function scheduleCheckinJobs(
  tx: Tx,
  c: { id: string; version: number; expectedReturnAt: Date; graceMinutes: number; reminderOffsetsMin: number[] },
  now: Date,
) {
  for (const step of computeSchedule(c, now)) {
    const payload = step.step === "reminder" ? { checkinId: c.id, version: c.version, offsetMin: step.offsetMin } : { checkinId: c.id, version: c.version };
    await enqueueJob(tx, step.kind, payload, { runAt: step.at, dedupKey: step.dedupKey, maxAttempts: step.step === "overdue" ? 10 : 3 });
  }
}

/** Cancel every queued reminder/overdue job of this check-in (all versions). */
export function cancelCheckinJobs(tx: Tx, checkinId: string) {
  return cancelQueuedJobs(tx, checkinJobPrefix(checkinId));
}

/** Undelivered reminder/overdue notices become suppressed (with a reason the user sees) and their send jobs are cancelled. */
export async function suppressPendingNotices(tx: Tx, checkinId: string, reason: string): Promise<number> {
  const rows = await tx<{ id: string }[]>`
    update public.notifications set status = 'suppressed', error = ${reason}
    where checkin_id = ${checkinId} and status in ('queued', 'failed') and template = any(${VERSIONED_TEMPLATES as string[]}::text[])
    returning id`;
  for (const r of rows) await cancelQueuedJobs(tx, sendJobDedupKey(r.id));
  return rows.length;
}

const FOLLOW_UP_TEMPLATE = {
  ok: NOTIFICATION_TEMPLATES.followUpOk,
  finished: NOTIFICATION_TEMPLATES.followUpFinished,
  extended: NOTIFICATION_TEMPLATES.followUpExtended,
} as const;

/**
 * Follow-up to contacts who already RECEIVED an overdue notice (status
 * sent/simulated/delivered) for this check-in. `episodeVersion` scopes the
 * dedup key so each overdue episode gets at most one follow-up of each kind
 * per recipient. Contacts deleted since, or without consent, are skipped.
 */
export async function queueContactFollowUps(
  tx: Tx,
  checkinId: string,
  kind: FollowUpKind,
  opts: { at: Date; episodeVersion: number; newExpectedReturnAt?: Date | null; only?: { recipientRef: string; channel: string } },
): Promise<number> {
  const recipients = await tx<{ recipientRef: string; channel: "sms" | "email" }[]>`
    select distinct recipient_ref, channel from public.notifications
    where checkin_id = ${checkinId} and template = ${NOTIFICATION_TEMPLATES.overdueContact}
      and status in ('sent', 'simulated', 'delivered') and recipient_ref is not null`;
  const targets = opts.only ? recipients.filter((r) => r.recipientRef === opts.only!.recipientRef && r.channel === opts.only!.channel) : recipients;
  if (!targets.length) return 0;
  const ctx = await loadNoticeContext(tx, checkinId);
  if (!ctx) return 0;
  let created = 0;
  for (const r of targets) {
    const contact = await loadContact(tx, r.recipientRef, ctx.userId);
    if (!contact?.consentConfirmedAt) continue;
    const addr = addressOn(r.channel, contact);
    if (!addr) continue;
    const msg = buildContactFollowUpMessage({
      channel: r.channel,
      kind,
      hikerFirstName: ctx.hikerFirstName,
      trailName: ctx.trailName,
      at: opts.at,
      newExpectedReturnAt: opts.newExpectedReturnAt ?? null,
      timeZone: ctx.timeZone,
    });
    const res = await createNotification(tx, {
      userId: ctx.userId,
      tripId: ctx.tripId,
      checkinId,
      checkinVersion: opts.episodeVersion,
      channel: r.channel,
      recipientKind: "emergency_contact",
      recipientRef: contact.id,
      recipientMasked: addr.masked,
      template: FOLLOW_UP_TEMPLATE[kind],
      subject: msg.subject,
      body: msg.body,
      dedupKey: `notify:${checkinId}:v${opts.episodeVersion}:followup_${kind}:contact:${contact.id}:${r.channel}`,
    });
    if (res.created) created++;
  }
  return created;
}

/**
 * Persist a transition, record its event and run its effects (reschedule,
 * cancel jobs, suppress undelivered notices, contact follow-ups).
 */
export async function applyTransition(
  tx: Tx,
  row: CheckinRow,
  result: TransitionResult,
  ctx: { now: Date; who: EventActor; details?: Record<string, unknown> },
): Promise<CheckinRow> {
  const details: Record<string, unknown> = { ...ctx.details };
  if (result.note) details.note = result.note;
  if (!result.changed) {
    await recordCheckinEvent(tx, row.id, result.event, ctx.who, details);
    return row;
  }
  const next: CheckinRow = { ...row, ...result.state };
  await persistCheckin(tx, row.id, next);
  if (next.version !== row.version) {
    details.fromVersion = row.version;
    details.toVersion = next.version;
  }
  if (next.expectedReturnAt.getTime() !== row.expectedReturnAt.getTime()) details.expectedReturnAt = next.expectedReturnAt.toISOString();
  details.status = next.status satisfies CheckinStatus;
  await recordCheckinEvent(tx, row.id, result.event, ctx.who, details);

  for (const effect of result.effects) {
    switch (effect.type) {
      case "reschedule":
        await cancelCheckinJobs(tx, row.id);
        await scheduleCheckinJobs(tx, next, ctx.now);
        break;
      case "cancel_jobs":
        await cancelCheckinJobs(tx, row.id);
        break;
      case "suppress_pending_notices":
        await suppressPendingNotices(
          tx,
          row.id,
          next.status === "completed"
            ? "Not sent: you finished your trip before it was delivered."
            : next.status === "cancelled"
              ? "Not sent: check-ins were turned off for this trip."
              : "Not sent: you confirmed before it was delivered.",
        );
        break;
      case "follow_up_contact":
        await queueContactFollowUps(tx, row.id, effect.kind, {
          at: effect.kind === "ok" && next.lastOkAt ? next.lastOkAt : ctx.now,
          episodeVersion: effect.kind === "finished" ? next.version : row.version,
          newExpectedReturnAt: effect.kind === "finished" ? null : next.expectedReturnAt,
        });
        break;
    }
  }
  return next;
}
