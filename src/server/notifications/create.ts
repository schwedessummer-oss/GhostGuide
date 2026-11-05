import "server-only";
import type { Tx } from "@/server/db";
import { enqueueJob } from "@/server/jobs/queue";
import { expectedProviderName } from "@/integrations/notifications";
import type { NotifyChannel } from "@/domain/notification-messages";

export const NOTIFICATION_TEMPLATES = {
  reminder: "checkin_reminder",
  overdueContact: "checkin_overdue_contact",
  overdueUser: "checkin_overdue_user",
  followUpOk: "checkin_followup_ok",
  followUpFinished: "checkin_followup_finished",
  followUpExtended: "checkin_followup_extended",
} as const;
export type NotificationTemplate = (typeof NOTIFICATION_TEMPLATES)[keyof typeof NOTIFICATION_TEMPLATES];

/** Templates that become obsolete when the check-in version changes or it ends. */
export const VERSIONED_TEMPLATES: readonly string[] = [NOTIFICATION_TEMPLATES.reminder, NOTIFICATION_TEMPLATES.overdueContact, NOTIFICATION_TEMPLATES.overdueUser];

export interface NewNotification {
  userId: string;
  tripId: string | null;
  checkinId: string | null;
  checkinVersion: number | null;
  channel: NotifyChannel;
  recipientKind: "user" | "emergency_contact";
  /** emergency_contacts.id or the user id — never the address itself */
  recipientRef: string;
  recipientMasked: string;
  template: NotificationTemplate;
  subject: string;
  body: string;
  /** unique; duplicate/delayed jobs creating the same notice are no-ops */
  dedupKey: string;
  /** "suppressed" records a notice we could not send (e.g. no address) without queueing it */
  status?: "queued" | "suppressed";
  error?: string;
}

export const sendJobDedupKey = (notificationId: string) => `notify:${notificationId}`;

/**
 * Insert a notification (audit trail: masked recipient + body) and enqueue
 * its `notifications.send` job in the caller's transaction. Idempotent per
 * dedup key: returns created=false when it already exists.
 */
export async function createNotification(tx: Tx, n: NewNotification): Promise<{ id: string | null; created: boolean }> {
  const status = n.status ?? "queued";
  const rows = await tx<{ id: string }[]>`
    insert into public.notifications (user_id, trip_id, checkin_id, checkin_version, channel, recipient_kind, recipient_ref,
                                      recipient_masked, template, subject, body, status, provider, dedup_key, error)
    values (${n.userId}, ${n.tripId}, ${n.checkinId}, ${n.checkinVersion}, ${n.channel}, ${n.recipientKind}, ${n.recipientRef},
            ${n.recipientMasked}, ${n.template}, ${n.subject}, ${n.body}, ${status}, ${expectedProviderName(n.channel)},
            ${n.dedupKey}, ${n.error ?? null})
    on conflict (dedup_key) do nothing
    returning id`;
  if (!rows.length) return { id: null, created: false };
  const id = rows[0].id;
  if (status === "queued") {
    await enqueueJob(tx, "notifications.send", { notificationId: id }, { dedupKey: sendJobDedupKey(id), maxAttempts: 6 });
  }
  return { id, created: true };
}
