import "server-only";
import { z } from "zod";
import { withSystem, type Tx } from "@/server/db";
import type { JobOutcome } from "@/server/jobs/queue";
import { checkRateLimit } from "@/server/rate-limit";
import { recordIntegrationEvent } from "@/server/integration-log";
import { log, redactString } from "@/server/log";
import { sha256 } from "@/server/auth/tokens";
import { getNotificationProvider, NotificationSendError, type NotificationSendResult } from "@/integrations/notifications";
import { AWAITING_STATUSES, contactNotifiedTransition, isOverdueState } from "@/domain/checkin";
import type { CheckinStatus } from "@/domain/types";
import { addressOn, type Address } from "./addresses";
import { NOTIFICATION_TEMPLATES } from "./create";
import { applyTransition, lockCheckinById, queueContactFollowUps, recordCheckinEvent } from "@/server/checkins/core";

/**
 * `notifications.send` job: deliver one notification.
 *
 *  1. Lock the row. Skip if already delivered/suppressed. Suppress if it is
 *     obsolete (check-in version changed, or the check-in ended) — so a
 *     delayed reminder or overdue notice never goes out after the user
 *     confirmed / extended / finished.
 *  2. Resolve the REAL address now from emergency_contacts / profiles (the
 *     row stores only a masked label). A contact that was deleted or whose
 *     consent was withdrawn is never messaged.
 *  3. Rate limits per check-in and per recipient.
 *  4. Send via the provider OUTSIDE the transaction.
 *  5. Record the outcome. Transient failures throw (job retries with
 *     backoff, then dead-letters for the operator); permanent provider
 *     rejections are marked failed without retrying.
 *
 * Contact notification semantics: a check-in becomes `contact_notified` only
 * after an overdue notice to the contact was actually handed to the provider
 * (status sent, or simulated in demo mode) — not merely queued.
 */
const payloadSchema = z.object({ notificationId: z.uuid() });

const PER_CHECKIN_LIMIT = { limit: 30, windowSec: 3600 };
const PER_RECIPIENT_LIMIT = { limit: 12, windowSec: 3600 };

interface NotificationRow {
  id: string;
  userId: string | null;
  tripId: string | null;
  checkinId: string | null;
  checkinVersion: number | null;
  channel: "sms" | "email" | "push" | "in_app";
  recipientKind: "user" | "emergency_contact" | "operator";
  recipientRef: string | null;
  template: string;
  subject: string | null;
  body: string;
  status: string;
  attempts: number;
  createdAt: Date;
  checkinStatus: CheckinStatus | null;
  currentVersion: number | null;
}

type Prepared = { skip: string } | { n: NotificationRow; address: Address };

async function suppress(tx: Tx, id: string, reason: string) {
  await tx`update public.notifications set status = 'suppressed', error = ${reason} where id = ${id}`;
}

function obsoleteReason(n: NotificationRow): string | null {
  if (!n.checkinId) return null;
  if (n.checkinStatus === null) return "Not sent: the check-in no longer exists.";
  const versionMatches = n.checkinVersion === n.currentVersion;
  if (n.template === NOTIFICATION_TEMPLATES.reminder) {
    if (!versionMatches || !AWAITING_STATUSES.includes(n.checkinStatus)) return "Not sent: the check-in changed before this reminder was due.";
  }
  if (n.template === NOTIFICATION_TEMPLATES.overdueContact || n.template === NOTIFICATION_TEMPLATES.overdueUser) {
    if (!versionMatches || !isOverdueState(n.checkinStatus)) {
      return n.checkinStatus === "completed"
        ? "Not sent: you finished your trip before it was delivered."
        : n.checkinStatus === "cancelled"
          ? "Not sent: check-ins were turned off for this trip."
          : "Not sent: you confirmed before it was delivered.";
    }
  }
  return null;
}

type Unresolved = { reason: string; code?: "contact_removed" | "consent_withdrawn" | "no_valid_phone_or_email" };

async function resolveAddress(tx: Tx, n: NotificationRow): Promise<Address | Unresolved> {
  if (n.channel !== "sms" && n.channel !== "email") return { reason: `Channel ${n.channel} is not supported.` };
  if (!n.recipientRef || !n.userId) return { reason: "Not sent: no recipient reference." };
  if (n.recipientKind === "emergency_contact") {
    const [c] = await tx<{ phone: string | null; email: string | null; consentConfirmedAt: Date | null }[]>`
      select phone, email, consent_confirmed_at from public.emergency_contacts where id = ${n.recipientRef} and user_id = ${n.userId}`;
    if (!c) return { reason: "Not sent: the contact was removed.", code: "contact_removed" };
    if (!c.consentConfirmedAt) return { reason: "Not sent: the contact has no consent on file.", code: "consent_withdrawn" };
    return (
      addressOn(n.channel, c) ?? {
        reason: `Not sent: the contact has no valid ${n.channel === "sms" ? "phone number" : "email address"}.`,
        code: "no_valid_phone_or_email",
      }
    );
  }
  if (n.recipientKind === "user") {
    const [p] = await tx<{ phone: string | null; email: string | null }[]>`
      select p.phone, coalesce(nullif(p.email, ''), u.email) as email
      from auth.users u left join public.profiles p on p.id = u.id where u.id = ${n.recipientRef}`;
    if (!p) return { reason: "Not sent: account not found." };
    return addressOn(n.channel, p) ?? { reason: `Not sent: no ${n.channel === "sms" ? "phone number" : "email address"} on file.` };
  }
  return { reason: "Not sent: unsupported recipient." };
}

async function prepare(notificationId: string): Promise<Prepared> {
  return withSystem(async (tx) => {
    const [n] = await tx<NotificationRow[]>`
      select n.id, n.user_id, n.trip_id, n.checkin_id, n.checkin_version, n.channel, n.recipient_kind, n.recipient_ref,
             n.template, n.subject, n.body, n.status, n.attempts, n.created_at,
             c.status as checkin_status, c.version as current_version
      from public.notifications n left join public.trip_checkins c on c.id = n.checkin_id
      where n.id = ${notificationId}
      for update of n`;
    if (!n) return { skip: "notification not found" };
    if (["sent", "simulated", "delivered", "suppressed"].includes(n.status)) return { skip: `already ${n.status}` };
    const obsolete = obsoleteReason(n);
    if (obsolete) {
      await suppress(tx, n.id, obsolete);
      return { skip: "obsolete" };
    }
    const address = await resolveAddress(tx, n);
    if ("reason" in address) {
      await suppress(tx, n.id, address.reason);
      // An overdue notice that can no longer reach the contact: record it on
      // the check-in (once per version) so the hiker's activity says so.
      if (n.template === NOTIFICATION_TEMPLATES.overdueContact && n.checkinId && address.code) {
        const [seen] = await tx`
          select 1 from public.checkin_events
          where checkin_id = ${n.checkinId} and kind = 'contact_not_notified' and details ->> 'version' = ${String(n.checkinVersion)}`;
        if (!seen) {
          await recordCheckinEvent(tx, n.checkinId, "contact_not_notified", { actor: "system", actorId: null }, {
            version: n.checkinVersion,
            reason: address.code,
            notificationId: n.id,
          });
        }
      }
      return { skip: "no deliverable address" };
    }
    await tx`update public.notifications set attempts = attempts + 1, recipient_masked = ${address.masked} where id = ${n.id}`;
    return { n, address };
  });
}

/** Apply contact_notified after an overdue notice to a contact went out; follow up if the hiker already responded. */
async function afterContactNoticeDelivered(tx: Tx, n: NotificationRow, now: Date) {
  if (!n.checkinId || n.checkinVersion === null || !n.recipientRef) return;
  const row = await lockCheckinById(tx, n.checkinId);
  if (!row) return;
  const result = contactNotifiedTransition(row, n.checkinVersion, now);
  const next = result.changed ? await applyTransition(tx, row, result, { now, who: { actor: "system", actorId: null }, details: { notificationId: n.id } }) : row;
  // Delivered while (or after) the hiker confirmed / extended / finished:
  // the contact must hear that too.
  if (!isOverdueState(next.status) && next.status !== "cancelled") {
    const kind = next.status === "completed" ? "finished" : next.lastOkAt && next.lastOkAt.getTime() >= n.createdAt.getTime() ? "ok" : "extended";
    await queueContactFollowUps(tx, row.id, kind, {
      at: now,
      episodeVersion: kind === "finished" ? next.version : n.checkinVersion,
      newExpectedReturnAt: kind === "finished" ? null : next.expectedReturnAt,
      only: { recipientRef: n.recipientRef, channel: n.channel },
    });
  }
}

export async function processNotificationSend(payload: unknown, now: Date): Promise<JobOutcome> {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return { outcome: "noop", note: "invalid payload" };
  const prepared = await prepare(parsed.data.notificationId);
  if ("skip" in prepared) return { outcome: "noop", note: prepared.skip };
  const { n, address } = prepared;
  const channel = address.channel;

  // Rate limits (abuse protection). Reminders over the limit are dropped;
  // safety notices are deferred (retry later), never dropped.
  const scope = n.checkinId ?? n.userId ?? "none";
  const [perCheckin, perRecipient] = await Promise.all([
    checkRateLimit(`notify:checkin:${scope}`, PER_CHECKIN_LIMIT.limit, PER_CHECKIN_LIMIT.windowSec),
    checkRateLimit(`notify:recipient:${sha256(address.to).slice(0, 32)}`, PER_RECIPIENT_LIMIT.limit, PER_RECIPIENT_LIMIT.windowSec),
  ]);
  if (!perCheckin.allowed || !perRecipient.allowed) {
    if (n.template === NOTIFICATION_TEMPLATES.reminder) {
      await withSystem((tx) => suppress(tx, n.id, "Not sent: notification rate limit reached."));
      return { outcome: "noop", note: "rate limited (reminder suppressed)" };
    }
    await withSystem((tx) => tx`update public.notifications set error = 'Rate limited; will retry.' where id = ${n.id}`);
    throw new Error("notification rate limit reached; retrying later");
  }

  const provider = getNotificationProvider(channel);
  const started = Date.now();
  let result: NotificationSendResult;
  try {
    result = await provider.send({ channel, to: address.to, subject: n.subject ?? undefined, body: n.body, idempotencyKey: `notify:${n.id}` });
  } catch (err) {
    const sendErr =
      err instanceof NotificationSendError ? err : new NotificationSendError(err instanceof Error ? err.message : String(err), true, "config");
    const message = redactString(sendErr.message);
    await withSystem((tx) => tx`update public.notifications set status = 'failed', provider = ${provider.name}, error = ${message} where id = ${n.id}`);
    await recordIntegrationEvent({
      providerKind: "notifications",
      providerKey: provider.name,
      operation: `send_${channel}`,
      outcome: "failure",
      entityType: "notification",
      entityId: n.id,
      error: message,
      durationMs: Date.now() - started,
    });
    log.error("notification.send_failed", { notificationId: n.id, kind: n.template, provider: provider.name, retryable: sendErr.retryable, error: message });
    if (sendErr.retryable) throw new Error(`notification ${n.id} failed: ${message}`);
    return { outcome: "done", note: `permanent failure: ${message}` };
  }

  await withSystem(async (tx) => {
    await tx`
      update public.notifications set status = ${result.status}, provider = ${provider.name},
        provider_message_id = ${result.providerMessageId ?? null}, sent_at = now(), error = null
      where id = ${n.id}`;
    if (n.template === NOTIFICATION_TEMPLATES.overdueContact) await afterContactNoticeDelivered(tx, n, now);
  });
  await recordIntegrationEvent({
    providerKind: "notifications",
    providerKey: provider.name,
    operation: `send_${channel}`,
    outcome: result.status === "simulated" ? "simulated" : "success",
    entityType: "notification",
    entityId: n.id,
    durationMs: Date.now() - started,
  });
  log.info("notification.sent", { notificationId: n.id, kind: n.template, provider: provider.name, status: result.status });
  return { outcome: "done", note: result.status };
}
