import { Badge, SimulatedBadge } from "@/components/ui";
import type { CheckinEventView, NotificationView } from "@/server/checkins/manage";
import { formatCheckinTime } from "@/domain/checkin";

const TEMPLATE_LABEL: Record<string, string> = {
  checkin_reminder: "Reminder to you",
  checkin_overdue_contact: "Check-in notice to your contact",
  checkin_overdue_user: "“We haven't heard from you” notice to you",
  checkin_followup_ok: "Follow-up to your contact: you confirmed you're okay",
  checkin_followup_finished: "Follow-up to your contact: you finished your trip",
  checkin_followup_extended: "Follow-up to your contact: you extended your trip",
};

function StatusBadge({ n }: { n: NotificationView }) {
  switch (n.status) {
    case "simulated":
      return <SimulatedBadge label="Simulated — not delivered" />;
    case "sent":
      return <Badge tone="forest">Sent</Badge>;
    case "delivered":
      return <Badge tone="forest">Delivered</Badge>;
    case "queued":
      return <Badge tone="blue">Queued</Badge>;
    case "failed":
      return <Badge tone="red">Failed — retrying</Badge>;
    case "suppressed":
    default:
      return <Badge tone="neutral">Not sent</Badge>;
  }
}

/** The trip's notification audit trail: what was sent, to whom (masked), and the exact text. */
export function NotificationHistory({ notifications, timeZone }: { notifications: NotificationView[]; timeZone: string }) {
  if (!notifications.length) return <p className="text-muted">No reminders or notices have been sent for this trip.</p>;
  return (
    <ol className="space-y-3">
      {notifications.map((n) => (
        <li key={n.id} className="rounded-xl border border-sand-200 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-semibold">{TEMPLATE_LABEL[n.template] ?? n.template}</p>
              <p className="text-sm text-muted">
                {formatCheckinTime(n.sentAt ?? n.createdAt, timeZone)} · {n.channel === "sms" ? "Text message" : "Email"} to {n.recipientKind === "user" ? "you" : "your contact"} (
                {n.recipientMasked})
              </p>
            </div>
            <StatusBadge n={n} />
          </div>
          {n.error ? <p className="mt-1 text-sm">{n.error}</p> : null}
          <details className="mt-2">
            <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold text-forest-800">Show message</summary>
            {n.subject && n.channel === "email" ? <p className="mt-1 text-sm font-semibold">Subject: {n.subject}</p> : null}
            <p className="mt-1 whitespace-pre-line rounded-lg bg-sand-100 p-3 text-sm">{n.body}</p>
          </details>
        </li>
      ))}
    </ol>
  );
}

const EVENT_LABEL: Record<string, string> = {
  opted_in: "Check-ins turned on",
  updated: "Check-in details changed",
  hike_started: "Hike started",
  ok_confirmed: "You confirmed you're okay",
  ok_confirmed_auto_extended: "You confirmed you're okay after your expected return — return time extended by 60 minutes",
  ok_ignored: "“I'm okay” received after the trip ended (ignored)",
  extended: "Expected return changed",
  finished: "Trip finished",
  overdue: "No confirmation by expected return + grace period",
  // contact_notified = the notice was handed to the provider (sent), not confirmed delivered
  contact_notified: "Notice sent to your contact",
  contact_notified_late: "Notice was sent to your contact after you had responded",
  contact_not_notified: "Your contact was not notified",
  reminder_queued: "Reminder to you queued",
  cancelled: "Check-ins turned off",
};

/** Why a contact was not notified (checkin_events.details.reason). */
const NOT_NOTIFIED_REASON: Record<string, string> = {
  no_contact_selected: "no emergency contact on this check-in",
  no_consent_on_file: "no consent on file",
  consent_withdrawn: "their consent was withdrawn",
  contact_removed: "the contact was removed",
  no_valid_phone_or_email: "no valid phone number or email address",
};

/** Demo mode: nothing is sent, so never say "sent"/"delivered". */
const SIMULATED_EVENT_LABEL: Record<string, string> = {
  contact_notified: "Simulated notice to your contact recorded (demo — nothing was sent)",
  contact_notified_late: "Simulated notice to your contact recorded after you had responded (demo — nothing was sent)",
  reminder_queued: "Simulated reminder to you recorded (demo — nothing is sent)",
};

/** What happened, newest first (plain language). */
export function CheckinTimeline({ events, timeZone, simulated = false }: { events: CheckinEventView[]; timeZone: string; simulated?: boolean }) {
  const label = (kind: string) => (simulated ? (SIMULATED_EVENT_LABEL[kind] ?? EVENT_LABEL[kind]) : EVENT_LABEL[kind]);
  const visible = events.filter((e) => EVENT_LABEL[e.kind] && !e.kind.endsWith("_skipped"));
  if (!visible.length) return <p className="text-muted">Nothing has happened yet.</p>;
  return (
    <ol className="space-y-2 border-l-2 border-forest-200 pl-4">
      {visible.map((e) => (
        <li key={e.id}>
          <p className="font-semibold">
            {label(e.kind)}
            {e.kind === "contact_not_notified" && typeof e.details.reason === "string" && NOT_NOTIFIED_REASON[e.details.reason]
              ? ` (${NOT_NOTIFIED_REASON[e.details.reason]})`
              : ""}
          </p>
          <p className="text-sm text-muted">
            {formatCheckinTime(e.createdAt, timeZone)}
            {e.kind === "cancelled" && e.details.reason === "trip_cancelled" ? " · trip cancelled" : ""}
            {typeof e.details.expectedReturnAt === "string" ? ` · new expected return ${formatCheckinTime(e.details.expectedReturnAt, timeZone)}` : ""}
          </p>
        </li>
      ))}
    </ol>
  );
}
