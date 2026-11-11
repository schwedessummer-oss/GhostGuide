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
 *  - SMS bodies stay within SMS_MAX_CHARS BY CONSTRUCTION: SMS wording is
 *    compact, every variable part has a bounded length (names, trail names,
 *    times, coordinates, accuracy, emergency number), and only whole
 *    optional sentences are ever dropped — never a cut mid-sentence or
 *    mid-coordinates. The worst case is unit tested.
 *  - Every notice to an emergency contact carries a one-click opt-out link
 *    (`optOutUrl`) so the contact can withdraw consent themselves.
 */
import { classifyLocation, DEFAULT_STALE_MINUTES } from "./staleness";
import { formatCheckinTime, formatClock, formatWhen } from "./checkin";
import { formatInZone, localDateInZone } from "@/lib/time";

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

/** Longest name / trail name / emergency number written into a notice. */
export const NAME_MAX = 24;
export const SMS_TRAIL_MAX = 30;
export const SMS_TRAIL_MIN = 12;
export const EMERGENCY_NUMBER_MAX = 16;

/**
 * Compact time for SMS: "3:30 PM PST" on the same local (region) day as
 * `now`, else "Nov 14, 3:30 PM PST" (no weekday, to keep texts short).
 */
export function formatSmsTime(d: Date | string, timeZone: string, now: Date): string {
  const date = new Date(d);
  return localDateInZone(date, timeZone) === localDateInZone(now, timeZone)
    ? formatClock(date, timeZone)
    : formatInZone(date, timeZone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

/** "accuracy ±12 m" (bounded length), or "accuracy unknown". */
export function accuracyText(accuracyM: number | null | undefined): string {
  if (accuracyM == null || !Number.isFinite(accuracyM)) return "accuracy unknown";
  const m = Math.max(0, Math.round(accuracyM));
  return `accuracy ±${m > 99_999 ? "99999+" : m} m`;
}

function emergencyNumberOf(raw: string | null | undefined): string {
  return (raw ?? "911").trim().slice(0, EMERGENCY_NUMBER_MAX).trim() || "911";
}

type Segment = { text: string; /** optional: dropped (lowest first) when an SMS is too long */ dropRank?: number };

/**
 * Join whole sentences for an SMS; while over SMS_MAX_CHARS drop optional
 * sentences, lowest dropRank first. Never cuts a sentence.
 */
function fitSms(segments: Segment[]): string {
  const parts = [...segments];
  const join = () => parts.map((p) => p.text).join(" ");
  let body = join();
  const optional = parts.filter((p) => p.dropRank !== undefined).sort((a, b) => a.dropRank! - b.dropRank!);
  for (const seg of optional) {
    if (body.length <= SMS_MAX_CHARS) break;
    parts.splice(parts.indexOf(seg), 1);
    body = join();
  }
  return body;
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

/**
 * Hide the token of opt-out links (/contact/opt-out/<token>) when a stored
 * notice body is shown to anyone but the contact it was sent to.
 */
export function maskOptOutLinks(body: string): string {
  return body.replace(/\/contact\/opt-out\/[A-Za-z0-9_-]+/g, "/contact/opt-out/…");
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
  if (input.locationSharingDisabled) {
    return channel === "sms"
      ? "No location has been reported (the hiker turned location sharing off)."
      : "No location has been reported in this notice (the hiker chose not to share location in check-in notices).";
  }
  if (!input.location) return "No location has been reported.";
  const { lat, lng, accuracyM, recordedAt } = input.location;
  const age = classifyLocation(recordedAt, input.now, input.staleMinutes ?? DEFAULT_STALE_MINUTES);
  const when = channel === "sms" ? formatSmsTime(recordedAt, input.timeZone, input.now) : formatCheckinTime(recordedAt, input.timeZone);
  const stale = age.state === "stale" ? ` [${age.label}]` : "";
  const base = `Last reported location: ${formatCoords(lat, lng)} at ${when}, ${accuracyText(accuracyM)}${stale}.`;
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
  /** one-click opt-out link for this contact (/contact/opt-out/<token>) */
  optOutUrl?: string | null;
}

/** Overdue notice to an emergency contact. */
export function buildOverdueContactMessage(i: OverdueContactInput): BuiltMessage {
  const name = truncate(i.hikerFirstName ?? "", NAME_MAX) || null;
  const subjectTrail = truncate(i.trailName, i.channel === "sms" ? SMS_TRAIL_MAX : 80);
  const subject = `Check-in notice: ${name ?? "a Ghost Guide hiker"} hasn't confirmed they're back from ${subjectTrail}`;
  if (i.channel === "sms") return { subject, body: overdueContactSms(i, name) };

  const who = name ?? "the hiker who listed you as their emergency contact";
  const they = name ?? "the hiker";
  const trail = truncate(i.trailName, 80);
  const expected = formatCheckinTime(i.expectedReturnAt, i.timeZone);
  const num = emergencyNumberOf(i.emergencyNumber);
  const paragraphs = [
    `Ghost Guide check-in notice about ${who}.`,
    `${name ?? "They"} planned to be back from ${trail} by ${expected}, and Ghost Guide has NOT received their “I'm okay” or “Finish trip” confirmation.`,
    "This does not necessarily mean anything is wrong — phones often lose signal or battery on trails.",
    ...(i.lastOkAt ? [`Their last “I'm okay” was at ${formatWhen(i.lastOkAt, i.timeZone, i.now)}.`] : []),
    locationSentence(i, "email"),
    "Ghost Guide has NOT contacted emergency services.",
    `What you can do: try calling ${they}. If you are concerned, contact local emergency services (${num}) and share this information.`,
    "Ghost Guide is not a monitoring or emergency service: it only knows what the hiker's phone last sent. " +
      `You received this because ${they} chose you as their check-in contact and confirmed you agreed to receive these notices.`,
    ...(i.optOutUrl ? [`If you didn't agree or no longer want these notices, stop them here (no sign-in needed): ${i.optOutUrl}`] : []),
  ];
  return { subject, body: paragraphs.join("\n\n") };
}

/**
 * SMS overdue notice. Every variable part is bounded (name <= NAME_MAX,
 * trail <= SMS_TRAIL_MAX, times <= 26 chars, coordinates <= 21, accuracy,
 * STALE label and emergency number bounded), so the mandatory sentences
 * plus a 16-character opt-out token on an origin of up to ~80 characters
 * always fit SMS_MAX_CHARS. When room is short, whole optional sentences go
 * first (the reassurance, then the last-"I'm okay" time), then the trail name
 * is shortened (down to SMS_TRAIL_MIN). The name appears once (the hiker is
 * "them" afterwards). Worst cases are unit tested.
 */
function overdueContactSms(i: OverdueContactInput, name: string | null): string {
  const t = (d: Date) => formatSmsTime(d, i.timeZone, i.now);
  const num = emergencyNumberOf(i.emergencyNumber);
  const build = (trailMax: number) =>
    fitSms([
      {
        text: `Ghost Guide check-in notice: ${name ?? "the hiker who listed you"} planned to be back from ${truncate(i.trailName, trailMax)} by ${t(i.expectedReturnAt)} and has NOT sent “I'm okay” or “Finish trip”.`,
      },
      { text: "This does not necessarily mean anything is wrong (phones often lose signal).", dropRank: 1 },
      ...(i.lastOkAt ? [{ text: `Last “I'm okay”: ${t(i.lastOkAt)}.`, dropRank: 2 }] : []),
      { text: locationSentence(i, "sms") },
      { text: "Ghost Guide has NOT contacted emergency services." },
      { text: `Try calling them. If you're concerned, call local emergency services (${num}) and share this message.` },
      ...(i.optOutUrl ? [{ text: `Stop these notices: ${i.optOutUrl}` }] : []),
    ]);
  let body = build(SMS_TRAIL_MAX);
  if (body.length > SMS_MAX_CHARS) body = build(Math.max(SMS_TRAIL_MIN, SMS_TRAIL_MAX - (body.length - SMS_MAX_CHARS)));
  return body;
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

export interface ContactOptedOutInput {
  channel: NotifyChannel;
  /** the hiker's own label for the contact */
  contactName: string;
  trailName: string;
}

/** To the hiker: their emergency contact withdrew consent using the link in a notice. */
export function buildContactOptedOutUserMessage(i: ContactOptedOutInput): BuiltMessage {
  const contact = truncate(i.contactName, 40);
  const trail = truncate(i.trailName, 60);
  const subject = `${contact} opted out of your check-in notices`;
  const lines = [
    `Ghost Guide: ${contact} used the link in one of our notices to stop receiving check-in notices about you.`,
    `They won't be notified if we don't hear from you on ${trail}.`,
    "Choose another emergency contact for this trip in the app, and tell someone you trust your plan.",
  ];
  return { subject, body: i.channel === "sms" ? fitSms(lines.map((text) => ({ text }))) : lines.join("\n\n") };
}

export interface FollowUpInput {
  channel: NotifyChannel;
  kind: "ok" | "finished" | "extended";
  hikerFirstName: string | null;
  trailName: string;
  /** when the hiker confirmed / finished / extended (the tap or device time), or staff recorded it */
  at: Date;
  /** when it reached Ghost Guide; mentioned when noticeably later than `at` (sent offline) */
  receivedAt?: Date | null;
  newExpectedReturnAt?: Date | null;
  /** grace period, to say when the next notice would go out */
  graceMinutes?: number | null;
  timeZone: string;
  /** one-click opt-out link for this contact */
  optOutUrl?: string | null;
  /** "staff": Ghost Guide staff recorded that the hiker is safe (kind "finished") */
  by?: "staff";
}

const LATE_ARRIVAL_MS = 2 * 60_000;

/** Follow-up to a contact who already received an overdue notice. */
export function buildContactFollowUpMessage(i: FollowUpInput): BuiltMessage {
  const sms = i.channel === "sms";
  const name = truncate(i.hikerFirstName ?? "", NAME_MAX) || "The hiker";
  const trail = truncate(i.trailName, sms ? SMS_TRAIL_MAX : 60);
  const ref = i.receivedAt ?? i.at;
  const when = (d: Date) => (sms ? formatSmsTime(d, i.timeZone, ref) : formatCheckinTime(d, i.timeZone));
  const late = i.receivedAt && i.receivedAt.getTime() - i.at.getTime() > LATE_ARRIVAL_MS ? `; it reached Ghost Guide at ${when(i.receivedAt)}` : "";
  const next = i.newExpectedReturnAt ? when(i.newExpectedReturnAt) : null;
  const due =
    i.newExpectedReturnAt && i.graceMinutes != null && Number.isFinite(i.graceMinutes)
      ? when(new Date(i.newExpectedReturnAt.getTime() + i.graceMinutes * 60_000))
      : null;
  const nextLine = next
    ? `Their new expected return time is ${next}. ${
        due ? `If we don't hear from them by ${due}, we'll send you another notice.` : "If we don't hear from them again after that, we'll send you another notice."
      }`
    : "";
  let subject: string;
  let lines: string[];
  if (i.kind === "finished" && i.by === "staff") {
    subject = `Update: ${name} is safe — check-in closed`;
    lines = [
      `Ghost Guide update: our team has confirmed that ${name} is safe (${trail}, recorded at ${when(i.at)}).`,
      "This check-in is closed, so no further notices will be sent. Thank you for being their contact.",
    ];
  } else if (i.kind === "finished") {
    subject = `Update: ${name} has confirmed they finished their hike`;
    lines = [
      `Ghost Guide update: ${name} has now confirmed they finished their hike on ${trail} (at ${when(i.at)}${late}).`,
      "No further action is needed for this check-in. Thank you for being their contact.",
    ];
  } else if (i.kind === "ok") {
    subject = `Update: ${name} has confirmed they're okay`;
    lines = [`Ghost Guide update: ${name} has confirmed they're okay on ${trail} (tapped “I'm okay” at ${when(i.at)}${late}).`, nextLine];
  } else {
    subject = `Update: ${name} has checked in and extended their trip`;
    lines = [`Ghost Guide update: ${name} has checked in with Ghost Guide (at ${when(i.at)}${late}) and extended their trip on ${trail}.`, nextLine];
  }
  if (i.optOutUrl) lines.push(sms ? `Stop these notices: ${i.optOutUrl}` : `No longer want these notices? Stop them here (no sign-in needed): ${i.optOutUrl}`);
  const text = lines.filter(Boolean);
  return { subject, body: sms ? fitSms(text.map((t) => ({ text: t }))) : text.join("\n\n") };
}
