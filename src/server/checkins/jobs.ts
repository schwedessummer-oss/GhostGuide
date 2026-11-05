import "server-only";
import { z } from "zod";
import { withSystem, type Tx } from "@/server/db";
import type { JobOutcome } from "@/server/jobs/queue";
import { enqueueJob } from "@/server/jobs/queue";
import { log } from "@/server/log";
import {
  AWAITING_STATUSES,
  cancelTransition,
  isAwaiting,
  isOverdueState,
  isTerminal,
  overdueDedupKey,
  overdueDueAt,
  overdueTransition,
} from "@/domain/checkin";
import { buildOverdueContactMessage, buildOverdueUserMessage, buildReminderMessage } from "@/domain/notification-messages";
import { createNotification, NOTIFICATION_TEMPLATES } from "@/server/notifications/create";
import { contactAddresses, userAddress } from "@/server/notifications/addresses";
import { applyTransition, lockCheckinById, recordCheckinEvent, type CheckinRow } from "./core";
import { loadContact, loadLastLocationForTrip, loadNoticeContext } from "./context";
import { getSafetySettings } from "./settings";

/**
 * Check-in job handlers. All are idempotent and version-guarded: they
 * re-load the check-in under a row lock and do nothing when the job's
 * version is obsolete, the check-in has ended, or the work was already done.
 */
const noop = (note: string): JobOutcome => ({ outcome: "noop", note });
const SYSTEM = { actor: "system", actorId: null } as const;

const reminderPayload = z.object({ checkinId: z.uuid(), version: z.number().int().min(0), offsetMin: z.number().int() });
const overduePayload = z.object({ checkinId: z.uuid(), version: z.number().int().min(0) });

/** A cancelled trip cancels its check-in even if the cancelling code did not (self-healing). */
async function cancelIfTripCancelled(tx: Tx, row: CheckinRow, now: Date): Promise<boolean> {
  if (row.tripStatus !== "cancelled" || isTerminal(row.status)) return false;
  await applyTransition(tx, row, cancelTransition(row), { now, who: SYSTEM, details: { reason: "trip_cancelled" } });
  return true;
}

// ---------------------------------------------------------------------------
// checkins.reminder — reminder to the hiker before the expected return
// ---------------------------------------------------------------------------
export async function processReminderJob(payload: unknown, now: Date): Promise<JobOutcome> {
  const p = reminderPayload.safeParse(payload);
  if (!p.success) return noop("invalid payload");
  return withSystem(async (tx) => {
    const row = await lockCheckinById(tx, p.data.checkinId);
    if (!row) return noop("check-in not found");
    if (await cancelIfTripCancelled(tx, row, now)) return noop("trip cancelled");
    if (row.version !== p.data.version) return noop(`obsolete version ${p.data.version} (current ${row.version})`);
    if (!isAwaiting(row.status)) return noop(`status ${row.status}`);
    if (now.getTime() >= overdueDueAt(row).getTime()) return noop("past the overdue time; the overdue check handles it");
    const ctx = await loadNoticeContext(tx, row.id);
    if (!ctx) return noop("context missing");
    const addr = userAddress(ctx);
    const channel = addr?.channel ?? "email";
    const msg = buildReminderMessage({
      channel,
      trailName: ctx.trailName,
      expectedReturnAt: row.expectedReturnAt,
      graceMinutes: row.graceMinutes,
      timeZone: ctx.timeZone,
    });
    const res = await createNotification(tx, {
      userId: row.userId,
      tripId: row.tripId,
      checkinId: row.id,
      checkinVersion: row.version,
      channel,
      recipientKind: "user",
      recipientRef: row.userId,
      recipientMasked: addr?.masked ?? "no phone or email on file",
      template: NOTIFICATION_TEMPLATES.reminder,
      subject: msg.subject,
      body: msg.body,
      dedupKey: `notify:${row.id}:v${row.version}:reminder:${p.data.offsetMin}:user:${row.userId}:${channel}`,
      ...(addr ? {} : { status: "suppressed" as const, error: "No phone number or email address on file." }),
    });
    if (!res.created) return noop("reminder already created");
    await recordCheckinEvent(tx, row.id, "reminder_queued", SYSTEM, { version: row.version, offsetMin: p.data.offsetMin });
    return { outcome: "done" };
  });
}

// ---------------------------------------------------------------------------
// checkins.overdue — no confirmation by expected return + grace
// ---------------------------------------------------------------------------
export async function processOverdueJob(payload: unknown, now: Date): Promise<JobOutcome> {
  const p = overduePayload.safeParse(payload);
  if (!p.success) return noop("invalid payload");
  return withSystem(async (tx) => {
    const row = await lockCheckinById(tx, p.data.checkinId);
    if (!row) return noop("check-in not found");
    if (await cancelIfTripCancelled(tx, row, now)) return noop("trip cancelled");
    if (row.version !== p.data.version) return noop(`obsolete version ${p.data.version} (current ${row.version})`);
    if (isTerminal(row.status)) return noop(`status ${row.status}`);
    if (isOverdueState(row.status)) return noop("already processed for this version");
    const result = overdueTransition(row, now);
    if (!result.changed) return noop(result.note ?? "not due");

    const settings = await getSafetySettings(tx);
    const ctx = await loadNoticeContext(tx, row.id);
    if (!ctx) throw new Error("check-in context missing");
    await applyTransition(tx, row, result, { now, who: SYSTEM, details: { version: row.version } });

    const location = ctx.shareLocation ? await loadLastLocationForTrip(tx, row.tripId) : null;
    const contact = await loadContact(tx, row.emergencyContactId, row.userId);
    let contactNotices = 0;
    const addresses = contact?.consentConfirmedAt ? contactAddresses(contact) : [];
    if (addresses.length && contact) {
      for (const addr of addresses) {
        const msg = buildOverdueContactMessage({
          channel: addr.channel,
          hikerFirstName: ctx.hikerFirstName,
          trailName: ctx.trailName,
          expectedReturnAt: row.expectedReturnAt,
          lastOkAt: row.lastOkAt,
          timeZone: ctx.timeZone,
          now,
          location,
          locationSharingDisabled: !ctx.shareLocation,
          staleMinutes: settings.staleLocationMinutes,
          emergencyNumber: ctx.emergencyNumber,
        });
        await createNotification(tx, {
          userId: row.userId,
          tripId: row.tripId,
          checkinId: row.id,
          checkinVersion: row.version,
          channel: addr.channel,
          recipientKind: "emergency_contact",
          recipientRef: contact.id,
          recipientMasked: addr.masked,
          template: NOTIFICATION_TEMPLATES.overdueContact,
          subject: msg.subject,
          body: msg.body,
          // unique: a duplicate, re-queued or delayed job can never double-notify
          dedupKey: `notify:${row.id}:v${row.version}:overdue:contact:${contact.id}:${addr.channel}`,
        });
        contactNotices++;
      }
    } else {
      await recordCheckinEvent(tx, row.id, "contact_not_notified", SYSTEM, {
        version: row.version,
        reason: !contact ? "no_contact_selected" : !contact.consentConfirmedAt ? "no_consent_on_file" : "no_valid_phone_or_email",
      });
    }

    const addr = userAddress(ctx);
    const channel = addr?.channel ?? "email";
    const userMsg = buildOverdueUserMessage({
      channel,
      trailName: ctx.trailName,
      expectedReturnAt: row.expectedReturnAt,
      timeZone: ctx.timeZone,
      contactWillBeNotified: contactNotices > 0,
    });
    await createNotification(tx, {
      userId: row.userId,
      tripId: row.tripId,
      checkinId: row.id,
      checkinVersion: row.version,
      channel,
      recipientKind: "user",
      recipientRef: row.userId,
      recipientMasked: addr?.masked ?? "no phone or email on file",
      template: NOTIFICATION_TEMPLATES.overdueUser,
      subject: userMsg.subject,
      body: userMsg.body,
      dedupKey: `notify:${row.id}:v${row.version}:overdue:user:${row.userId}:${channel}`,
      ...(addr ? {} : { status: "suppressed" as const, error: "No phone number or email address on file." }),
    });
    log.info("checkin.overdue", { checkinId: row.id, version: row.version, contactNotices });
    return { outcome: "done", note: `${contactNotices} contact notice(s) queued` };
  });
}

// ---------------------------------------------------------------------------
// checkins.scan_overdue — periodic safety net (every minute)
// ---------------------------------------------------------------------------
/**
 * Finds awaiting check-ins past expected return + grace and (re)queues the
 * SAME `checkin:<id>:v<version>:overdue` job, so the check never runs twice
 * in parallel and a lost, dead or prematurely-finished job is recovered.
 */
export async function scanOverdue(now: Date): Promise<JobOutcome> {
  const due = await withSystem(
    (tx) => tx<{ id: string; version: number }[]>`
      select id, version from public.trip_checkins
      where status = any(${AWAITING_STATUSES as string[]}::checkin_status[])
        and expected_return_at + make_interval(mins => grace_minutes) <= ${now}::timestamptz
      order by expected_return_at
      limit 500`,
  );
  let enqueued = 0;
  let requeued = 0;
  for (const c of due) {
    const key = overdueDedupKey(c.id, c.version);
    await withSystem(async (tx) => {
      const res = await enqueueJob(tx, "checkins.overdue", { checkinId: c.id, version: c.version }, { dedupKey: key, maxAttempts: 10 });
      if (!res.deduped) {
        enqueued++;
        return;
      }
      const rows = await tx`
        update public.jobs set status = 'queued', run_at = now(), finished_at = null, locked_at = null,
          max_attempts = greatest(max_attempts, attempts + 3), last_error = 'requeued by checkins.scan_overdue'
        where dedup_key = ${key} and status in ('succeeded', 'failed', 'dead', 'cancelled')
        returning id`;
      requeued += rows.length;
    });
  }
  if (enqueued || requeued) log.warn("checkin.scan_overdue.recovered", { enqueued, requeued });
  return { outcome: enqueued || requeued ? "done" : "noop", note: `${due.length} due, ${enqueued} enqueued, ${requeued} requeued` };
}
