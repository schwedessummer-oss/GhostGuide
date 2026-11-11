/**
 * Check-in notification messages (pure). Wording rules:
 *  - An overdue notice means "Ghost Guide has NOT received confirmation" —
 *    never "emergency detected", "in danger", "SOS" or "rescue".
 *  - It always says Ghost Guide has NOT contacted emergency services and
 *    what the contact can do (call the hiker; if concerned, call local
 *    emergency services and share this information).
 *  - Location: coordinates (5 decimals) + timestamp + accuracy when known, an
 *    explicit "STALE — N min old" label when old, and "No location has been
 *    reported" when there is none or the hiker turned location sharing off.
 *  - SMS bodies stay within SMS_MAX_CHARS.
 */
import { classifyLocation, DEFAULT_STALE_MINUTES } from "./staleness";
import { formatCheckinTime, formatClock, formatWhen } from "./checkin";

export type NotifyChannel = "sms" | "email";

export const SMS_MAX_CHARS = 600;

/** Phrases a check-in message must never contain. */
export const BANNED_PHRASES: readonly RegExp[] = [/emergency detected/i, /in danger/i, /\bSOS\b/, /rescue/i, /emergency alert/i];

export function containsBannedPhrase(text: string): boolean {
  return BANNED_PHRASES.some((re) => re.test(text));
}

export interface BuiltMessage {
  subject: string;
  body: string;
}

export interface LastLocation {
  lat: number;
  lng: number;
  accuracyM: number | null;
  recordedAt: Date | string;
}

// ---------------------------------------------------------------------------
// Contact details: normalization & masking
// ---------------------------------------------------------------------------

/**
 * Normalize a phone number to E.164. Accepts "+44 20 7946 0958",
 * "(555) 555-0123" (assumed +1 for 10-digit numbers), "1-555-555-0123",
 * "0044…". Returns null when it can't be a valid E.164 number.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed.length > 32) return null;
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  let e164: string;
  if (trimmed.startsWith("+")) e164 = `+${digits}`;
  else if (digits.startsWith("00")) e164 = `+${digits.slice(2)}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  else return null;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

const BULLETS = "•••••";

/** "+15555550123" -> "+1•••••0123". */
export function maskPhone(phone: string): string {
  const p = phone.replace(/[^\d+]/g, "");
  if (p.length <= 6) return `${p.slice(0, 1)}${BULLETS}`;
  return `${p.slice(0, 2)}${BULLETS}${p.slice(-4)}`;
}

/** "casey@example.com" -> "c•••@example.com". */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

export function maskRecipient(channel: NotifyChannel, to: string): string {
  return channel === "sms" ? maskPhone(to) : maskEmail(to);
}

/** First word of a full name, trimmed to a sensible length. */
export function firstNameOf(fullName: string | null | undefined): string | null {
  const first = (fullName ?? "").trim().split(/\s+/)[0] ?? "";
  const clean = first.replace(/[^\p{L}\p{M}'’.-]/gu, "");
  return clean ? clean.slice(0, 24) : null;
}

export function formatCoords(lat: number, lng: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Patterns for precise location written into stored notice bodies (by
 * formatCoords / mapLink). Written so the same source works as a JS RegExp
 * and a PostgreSQL ARE (regexp_replace), so "Delete my location history" and
 * the retention purge can redact old notices in SQL.
 */
export const COORDS_PATTERN = "-?\\d{1,3}\\.\\d{5}, ?-?\\d{1,3}\\.\\d{5}";
export const MAP_LINK_PATTERN = "https://www\\.openstreetmap\\.org/\\S*";
export const LOCATION_REMOVED = "[location removed]";
export const MAP_LINK_REMOVED = "[map link removed]";

/** Replace coordinates and map links in a notice body (pure twin of the SQL redaction). */
export function redactLocation(text: string): string {
  return text.replace(new RegExp(MAP_LINK_PATTERN, "g"), MAP_LINK_REMOVED).replace(new RegExp(COORDS_PATTERN, "g"), LOCATION_REMOVED);
}

/** OpenStreetMap link for a coordinate (no tracking parameters). */
export function mapLink(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lng.toFixed(5)}#map=15/${lat.toFixed(5)}/${lng.toFixed(5)}`;
}

/** Join segments; for SMS drop optional segments (from the end) until it fits. */
function assemble(segments: { text: string; optional?: boolean }[], channel: NotifyChannel, sep = " "): string {
  const parts = [...segments];
  let body = parts.map((p) => p.text).join(sep);
  if (channel !== "sms") return body;
  for (let i = parts.length - 1; i >= 0 && body.length > SMS_MAX_CHARS; i--) {
    if (parts[i].optional) {
      parts.splice(i, 1);
      body = parts.map((p) => p.text).join(sep);
    }
  }
  return body.length > SMS_MAX_CHARS ? truncate(body, SMS_MAX_CHARS) : body;
}

// ---------------------------------------------------------------------------
// Location sentence
// ---------------------------------------------------------------------------

export interface LocationSentenceInput {
  location: LastLocation | null;
  /** hiker turned off "include my last reported location in check-in notices" */
  locationSharingDisabled: boolean;
  now: Date;
  staleMinutes?: number;
  timeZone: string;
}

export function locationSentence(input: LocationSentenceInput, channel: NotifyChannel): string {
  if (input.locationSharingDisabled) return "No location has been reported in this notice (the hiker chose not to share location in check-in notices).";
  if (!input.location) return "No location has been reported.";
  const { lat, lng, accuracyM, recordedAt } = input.location;
  const age = classifyLocation(recordedAt, input.now, input.staleMinutes ?? DEFAULT_STALE_MINUTES);
  const acc = accuracyM != null && Number.isFinite(accuracyM) ? `, accuracy ±${Math.round(accuracyM)} m` : ", accuracy unknown";
  const when = channel === "sms" ? formatWhen(recordedAt, input.timeZone, input.now) : formatCheckinTime(recordedAt, input.timeZone);
  const stale = age.state === "stale" ? ` [${age.label}]` : "";
  const base = `Last reported location: ${formatCoords(lat, lng)} at ${when}${acc}${stale}.`;
  return channel === "email" ? `${base}\nMap: ${mapLink(lat, lng)}` : base;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export interface ReminderInput {
  channel: NotifyChannel;
  trailName: string;
  expectedReturnAt: Date;
  graceMinutes: number;
  timeZone: string;
}

/** Reminder to the hiker before their expected return. */
export function buildReminderMessage(i: ReminderInput): BuiltMessage {
  const trail = truncate(i.trailName, 60);
  const expected = formatClock(i.expectedReturnAt, i.timeZone);
  const due = formatClock(new Date(i.expectedReturnAt.getTime() + i.graceMinutes * 60_000), i.timeZone);
  const subject = `Reminder: you're expected back from ${trail} by ${expected}`;
  const body = assemble(
    [
      { text: `Ghost Guide reminder: you're expected back from ${trail} by ${expected}.` },
      { text: `If you're okay, open Ghost Guide and tap “I'm okay” or “Finish trip”. Need more time? Tap “Extend my trip”.` },
      { text: `If we hear nothing by ${due}, we'll send your emergency contact a check-in notice.` },
      ...(i.channel === "email"
        ? [{ text: "\n\nGhost Guide does not monitor you continuously and can't tell whether you are safe; it only knows what your phone last sent." }]
        : []),
    ],
    i.channel,
  );
  return { subject, body };
}

export interface OverdueContactInput extends LocationSentenceInput {
  channel: NotifyChannel;
  hikerFirstName: string | null;
  trailName: string;
  expectedReturnAt: Date;
  lastOkAt?: Date | null;
  /** region emergency number, e.g. "911" */
  emergencyNumber?: string;
}

/** Overdue notice to an emergency contact. */
export function buildOverdueContactMessage(i: OverdueContactInput): BuiltMessage {
  const sms = i.channel === "sms";
  const name = truncate(i.hikerFirstName ?? "", 24) || null;
  const who = name ?? "the hiker who listed you as their emergency contact";
  const they = name ?? "the hiker";
  const trail = truncate(i.trailName, sms ? 40 : 80);
  const expected = formatCheckinTime(i.expectedReturnAt, i.timeZone);
  const num = (i.emergencyNumber ?? "911").trim() || "911";
  const subject = `Check-in notice: ${name ?? "a Ghost Guide hiker"} hasn't confirmed they're back from ${trail}`;
  const segments: { text: string; optional?: boolean }[] = [
    { text: `Ghost Guide check-in notice about ${who}.` },
    { text: `${name ?? "They"} planned to be back from ${trail} by ${expected}, and Ghost Guide has NOT received their “I'm okay” or “Finish trip” confirmation.` },
    { text: "This does not necessarily mean anything is wrong — phones often lose signal or battery on trails." },
    ...(i.lastOkAt ? [{ text: `Their last “I'm okay” was at ${formatWhen(i.lastOkAt, i.timeZone, i.now)}.`, optional: true }] : []),
    { text: locationSentence(i, i.channel) },
    { text: "Ghost Guide has NOT contacted emergency services." },
    { text: `What you can do: try calling ${they}. If you are concerned, contact local emergency services (${num}) and share this information.` },
  ];
  if (!sms) {
    segments.push({
      text:
        "\n\nGhost Guide is not a monitoring or emergency service: it only knows what the hiker's phone last sent. " +
        `You received this because ${they} chose you as their check-in contact and confirmed you agreed to receive these notices.`,
    });
  }
  return { subject, body: assemble(segments, i.channel, sms ? " " : "\n\n").replace(/\n\n\n\n/g, "\n\n") };
}

export interface OverdueUserInput {
  channel: NotifyChannel;
  trailName: string;
  expectedReturnAt: Date;
  timeZone: string;
  /** whether a consenting contact is being sent a notice */
  contactWillBeNotified: boolean;
}

/** Overdue notice to the hiker themselves. */
export function buildOverdueUserMessage(i: OverdueUserInput): BuiltMessage {
  const trail = truncate(i.trailName, 60);
  const expected = formatCheckinTime(i.expectedReturnAt, i.timeZone);
  const subject = `We haven't received your check-in for ${trail}`;
  const body = assemble(
    [
      { text: `Ghost Guide: we haven't received your “I'm okay” or “Finish trip” for ${trail} (expected back by ${expected}).` },
      {
        text: i.contactWillBeNotified
          ? "We're sending your emergency contact a check-in notice now."
          : "You don't have a consenting emergency contact on this check-in, so no one else is being notified.",
      },
      { text: `If you're okay, open Ghost Guide and tap “I'm okay” or “Finish trip”${i.contactWillBeNotified ? " — we'll let them know" : ""}.` },
      { text: "Ghost Guide has not contacted emergency services." },
    ],
    i.channel,
  );
  return { subject, body };
}

export interface FollowUpInput {
  channel: NotifyChannel;
  kind: "ok" | "finished" | "extended";
  hikerFirstName: string | null;
  trailName: string;
  /** when the hiker confirmed / finished / extended */
  at: Date;
  newExpectedReturnAt?: Date | null;
  timeZone: string;
}

/** Follow-up to a contact who already received an overdue notice. */
export function buildContactFollowUpMessage(i: FollowUpInput): BuiltMessage {
  const name = truncate(i.hikerFirstName ?? "", 24) || "The hiker";
  const trail = truncate(i.trailName, 60);
  const at = formatClock(i.at, i.timeZone);
  const next = i.newExpectedReturnAt ? formatCheckinTime(i.newExpectedReturnAt, i.timeZone) : null;
  let subject: string;
  let lines: string[];
  if (i.kind === "finished") {
    subject = `Update: ${name} has confirmed they finished their hike`;
    lines = [
      `Ghost Guide update: ${name} has now confirmed they finished their hike on ${trail} (at ${at}).`,
      "No further action is needed for this check-in. Thank you for being their contact.",
    ];
  } else if (i.kind === "ok") {
    subject = `Update: ${name} has confirmed they're okay`;
    lines = [
      `Ghost Guide update: ${name} has now confirmed they're okay on ${trail} (tapped “I'm okay” at ${at}).`,
      next ? `Their new expected return time is ${next}. If we don't hear from them again after that, we'll send you another notice.` : "",
    ];
  } else {
    subject = `Update: ${name} has checked in and extended their trip`;
    lines = [
      `Ghost Guide update: ${name} has checked in with Ghost Guide (at ${at}) and extended their trip on ${trail}.`,
      next ? `Their new expected return time is ${next}. If we don't hear from them again after that, we'll send you another notice.` : "",
    ];
  }
  return { subject, body: assemble(lines.filter(Boolean).map((text) => ({ text })), i.channel) };
}
