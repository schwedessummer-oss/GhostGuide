import { formatInZone } from "@/lib/time";
import { redactString } from "@/server/log";

/**
 * Plain-language descriptions of checkin_events for the staff safety
 * monitor (pure; unit tested). Wording rules: "overdue" means no
 * confirmation was received — never "emergency"; `contact_notified` means
 * the notice was handed to the provider, not that it was delivered; staff
 * actions never imply anyone (hiker, contact, emergency services) was
 * contacted by Ghost Guide unless a notice says so. Raw keys, ids and
 * versions are never shown.
 */
export interface CheckinEventInput {
  kind: string;
  actor: string;
  details: unknown;
}

export interface DescribedCheckinEvent {
  label: string;
  /** extra plain-language detail (reason, staff note, new time) or "" */
  detail: string;
}

const EVENT_LABEL: Record<string, string> = {
  opted_in: "Check-ins turned on",
  updated: "Check-in details changed",
  hike_started: "Hike started",
  ok_confirmed: "Hiker confirmed they're okay",
  ok_confirmed_auto_extended: "Hiker confirmed they're okay after the expected return — return time extended by 60 minutes",
  ok_ignored: "“I'm okay” received after the check-in had ended (ignored)",
  extended: "Expected return changed",
  extend_ignored: "Return-time change from the hiker's device not applied",
  ok_recorded_late: "Late “I'm okay” recorded (check-in still not confirmed)",
  finished: "Trip finished",
  finish_ignored: "“Finish” received after the check-in had ended (ignored)",
  overdue: "No confirmation by the expected return time plus grace period",
  overdue_skipped: "Overdue check skipped (no longer due)",
  contact_notified: "Notice to the hiker's contact handed to the messaging provider",
  contact_notified_late: "Notice to the contact went out after the hiker had already responded",
  contact_not_notified: "The hiker's contact was not notified",
  reminder_queued: "Reminder to the hiker queued",
  cancelled: "Check-in cancelled",
  cancel_ignored: "Cancellation ignored (the check-in had already ended)",
};

const STAFF_RESOLVED = "Staff closed the check-in: hiker confirmed safe";
const STAFF_NOTE = "Staff note";

/** Staff events by outcome (preferred) or kind. */
const STAFF_LABEL: Record<string, string> = {
  hiker_confirmed_safe: STAFF_RESOLVED,
  staff_resolved: STAFF_RESOLVED,
  resolved: STAFF_RESOLVED,
  finished: STAFF_RESOLVED,
  completed: STAFF_RESOLVED,
  note_only: STAFF_NOTE,
  staff_note: STAFF_NOTE,
  note: STAFF_NOTE,
};

/**
 * Why a contact was not notified: `contact_not_notified` details.reason,
 * from the overdue job (no_contact_selected, no_consent_on_file,
 * no_valid_phone_or_email) or the send step (contact_removed,
 * consent_withdrawn, no_valid_phone_or_email).
 */
export const NOT_NOTIFIED_REASON: Record<string, string> = {
  no_contact_selected: "no emergency contact was chosen for this check-in",
  no_consent_on_file: "the contact has no consent on file",
  consent_withdrawn: "the contact's consent was withdrawn",
  contact_removed: "the contact was removed by the hiker",
  no_valid_phone_or_email: "the contact has no valid phone number or email address",
};

const CANCEL_REASON: Record<string, string> = {
  trip_cancelled: "the trip or booking was cancelled",
  opted_out: "the hiker turned check-ins off",
};

const SOURCE_LABEL: Record<string, string> = {
  device: "from the hiker's device (sent when it had signal)",
  web: "from the hiker's account",
};

function humanize(kind: string): string {
  const s = kind.replace(/[_.]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Event";
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

function when(iso: string, timeZone: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return formatInZone(d, timeZone, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

export function describeCheckinEvent(e: CheckinEventInput, timeZone: string): DescribedCheckinEvent {
  const d = e.details && typeof e.details === "object" && !Array.isArray(e.details) ? (e.details as Record<string, unknown>) : {};
  const isStaff = e.actor === "staff";
  const outcome = str(d.outcome);
  const label = isStaff
    ? (outcome && STAFF_LABEL[outcome]) || STAFF_LABEL[e.kind] || `Staff: ${(EVENT_LABEL[e.kind] ?? humanize(e.kind)).toLowerCase()}`
    : (EVENT_LABEL[e.kind] ?? humanize(e.kind));
  const parts: string[] = [];

  const reason = str(d.reason);
  if (e.kind === "contact_not_notified") {
    parts.push(reason ? (NOT_NOTIFIED_REASON[reason] ?? humanize(reason).toLowerCase()) : "no reason recorded");
  } else if (reason) {
    parts.push(NOT_NOTIFIED_REASON[reason] ?? CANCEL_REASON[reason] ?? humanize(reason).toLowerCase());
  }

  const source = str(d.source);
  if (source) parts.push(SOURCE_LABEL[source] ?? `source: ${humanize(source).toLowerCase()}`);

  for (const key of ["newExpectedReturnAt", "expectedReturnAt"]) {
    const v = str(d[key]);
    const formatted = v ? when(v, timeZone) : null;
    if (formatted) {
      parts.push(`new expected return ${formatted}`);
      break;
    }
  }

  if (e.kind === "reminder_queued" && typeof d.offsetMin === "number") parts.push(`${d.offsetMin} min before the expected return`);

  // Notes: staff notes are free text written by staff, the others are short
  // system notes ("check-in is completed"). Both are masked for phone
  // numbers, emails and coordinates (operators read this view but may not
  // see contact details).
  const note = str(d.note);
  if (note) {
    const safe = redactString(note).slice(0, 1000);
    parts.push(isStaff ? `“${safe}”` : safe);
  }

  return { label, detail: parts.join(" · ") };
}

/** Event kinds this module has a specific label for (exported for tests). */
export const KNOWN_EVENT_KINDS = Object.keys(EVENT_LABEL);
