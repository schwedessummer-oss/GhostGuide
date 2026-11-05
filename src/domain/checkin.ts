/**
 * Trip check-in state machine and schedule (pure; no I/O).
 *
 * A check-in is a promise: "if Ghost Guide has not received 'I'm okay' or
 * 'Finish trip' by the expected return time plus the grace period, send my
 * emergency contact a notice". It is NOT continuous monitoring and NOT a
 * rescue service; nothing here ever contacts emergency services.
 *
 * States (enum checkin_status):
 *   scheduled        opted in, hike not started in the app yet
 *   active           hike in progress, awaiting confirmation
 *   confirmed_ok     user tapped "I'm okay" before the expected return
 *                    (reminders continue; overdue is still evaluated)
 *   overdue          no confirmation by expected return + grace
 *   contact_notified overdue notice delivered to the emergency contact
 *   completed        user finished the trip (terminal)
 *   cancelled        opted out, or trip/booking cancelled (terminal for jobs)
 *
 * Rules:
 *   setup            -> scheduled (or active if a hike session is already open); version++
 *   hike start       scheduled -> active
 *   "I'm okay" before the expected return -> confirmed_ok (records last_ok_at)
 *   "I'm okay" AFTER the expected return, or while overdue/contact_notified
 *                    -> counts as confirmation: AUTO-EXTEND the expected return
 *                       to now + 60 min (OK_AUTO_EXTEND_MIN), version++, reschedule,
 *                       follow-up to the contact if they were already notified
 *   extend           -> new expected return, version++, back to active/confirmed_ok
 *   finish           -> completed (terminal), cancel every queued job
 *   overdue job      at expected_return + grace if still awaiting -> overdue
 *   notice delivered -> contact_notified
 *   cancel           -> cancelled, version++
 *
 * Every schedule change bumps `version`. Jobs carry the version they were
 * scheduled for and become no-ops when it no longer matches.
 */
import type { CheckinStatus } from "./types";
import { formatInZone, localDateInZone, localTimeInZone, zonedTimeToUtc } from "@/lib/time";

export const GRACE_MIN = 15;
export const GRACE_MAX = 720;
/** "I'm okay" received after the expected return extends it to now + this. */
export const OK_AUTO_EXTEND_MIN = 60;
export const EXTEND_PRESETS_MIN = [30, 60, 120] as const;
/** Choices offered in the UI for reminders (minutes before the expected return). */
export const REMINDER_OFFSET_CHOICES = [180, 120, 60, 30, 15] as const;
export const REMINDER_OFFSET_MIN = 5;
export const REMINDER_OFFSET_MAX = 720;
export const MAX_REMINDERS = 5;
/** Default expected return = itinerary estimated finish + this buffer. */
export const DEFAULT_RETURN_BUFFER_MIN = 30;
/** A new expected return must be at least this far in the future. */
export const MIN_LEAD_MIN = 5;
/** An extension may move the expected return at most this far ahead of now. */
export const MAX_EXTEND_AHEAD_MIN = 24 * 60;
/** Setup: expected return no more than this many days ahead. */
export const MAX_SETUP_AHEAD_DAYS = 120;

/** Awaiting confirmation: reminders fire and overdue is evaluated. */
export const AWAITING_STATUSES: readonly CheckinStatus[] = ["scheduled", "active", "confirmed_ok"];
/** Not finished/cancelled. */
export const OPEN_STATUSES: readonly CheckinStatus[] = ["scheduled", "active", "confirmed_ok", "overdue", "contact_notified"];
export const TERMINAL_STATUSES: readonly CheckinStatus[] = ["completed", "cancelled"];

export const isAwaiting = (s: CheckinStatus) => AWAITING_STATUSES.includes(s);
export const isOpen = (s: CheckinStatus) => OPEN_STATUSES.includes(s);
export const isTerminal = (s: CheckinStatus) => TERMINAL_STATUSES.includes(s);
export const isOverdueState = (s: CheckinStatus) => s === "overdue" || s === "contact_notified";

export interface CheckinState {
  status: CheckinStatus;
  version: number;
  expectedReturnAt: Date;
  graceMinutes: number;
  reminderOffsetsMin: number[];
  lastOkAt: Date | null;
  overdueAt: Date | null;
  contactNotifiedAt: Date | null;
  completedAt: Date | null;
}

export type FollowUpKind = "ok" | "finished" | "extended";

export type CheckinEffect =
  /** cancel queued jobs for older versions and schedule computeSchedule(new state) */
  | { type: "reschedule" }
  /** cancel every queued reminder/overdue job for this check-in */
  | { type: "cancel_jobs" }
  /** mark queued (undelivered) reminder/overdue notices as suppressed */
  | { type: "suppress_pending_notices" }
  /** tell contacts who already received an overdue notice what happened */
  | { type: "follow_up_contact"; kind: FollowUpKind };

export interface TransitionResult {
  state: CheckinState;
  changed: boolean;
  /** checkin_events.kind to record (only when changed, or for ignored inputs) */
  event: string;
  effects: CheckinEffect[];
  note?: string;
}

const addMin = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);
const maxDate = (a: Date | null, b: Date) => (a && a.getTime() > b.getTime() ? a : b);

/** Instant at which the check-in becomes overdue. */
export function overdueDueAt(c: Pick<CheckinState, "expectedReturnAt" | "graceMinutes">): Date {
  return addMin(c.expectedReturnAt, c.graceMinutes);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Unique, integer, in-range offsets sorted descending (earliest reminder first). */
export function normalizeReminderOffsets(offsets: readonly number[]): number[] {
  const set = new Set<number>();
  for (const o of offsets) {
    const n = Math.round(Number(o));
    if (Number.isFinite(n) && n >= REMINDER_OFFSET_MIN && n <= REMINDER_OFFSET_MAX) set.add(n);
  }
  return [...set].sort((a, b) => b - a).slice(0, MAX_REMINDERS);
}

export interface ScheduleInput {
  expectedReturnAt: Date;
  graceMinutes: number;
  reminderOffsetsMin: number[];
}

/** Returns a user-facing error, or null when the schedule is acceptable. */
export function validateScheduleInput(input: ScheduleInput, now: Date): string | null {
  const t = input.expectedReturnAt.getTime();
  if (!Number.isFinite(t)) return "Enter a valid expected return time.";
  if (t < now.getTime() + MIN_LEAD_MIN * 60_000) return `Your expected return time must be at least ${MIN_LEAD_MIN} minutes from now.`;
  if (t > now.getTime() + MAX_SETUP_AHEAD_DAYS * 86_400_000) return "Your expected return time is too far in the future.";
  if (!Number.isInteger(input.graceMinutes) || input.graceMinutes < GRACE_MIN || input.graceMinutes > GRACE_MAX) {
    return `The grace period must be between ${GRACE_MIN} and ${GRACE_MAX} minutes.`;
  }
  if (input.reminderOffsetsMin.length > MAX_REMINDERS) return `Choose at most ${MAX_REMINDERS} reminders.`;
  for (const o of input.reminderOffsetsMin) {
    if (!Number.isInteger(o) || o < REMINDER_OFFSET_MIN || o > REMINDER_OFFSET_MAX) return "Reminder times must be between 5 and 720 minutes before your return.";
  }
  return null;
}

/** Returns a user-facing error, or null when the new expected return is acceptable for an extension. */
export function validateExtension(newExpectedReturnAt: Date, now: Date): string | null {
  const t = newExpectedReturnAt.getTime();
  if (!Number.isFinite(t)) return "Choose a valid new return time.";
  if (t < now.getTime() + MIN_LEAD_MIN * 60_000) return `Your new return time must be at least ${MIN_LEAD_MIN} minutes from now.`;
  if (t > now.getTime() + MAX_EXTEND_AHEAD_MIN * 60_000) return "You can extend your trip by up to 24 hours at a time.";
  return null;
}

/** New expected return for a "+N minutes" extension: from the later of now and the current expected return. */
export function extendedReturnAt(current: Date, minutes: number, now: Date): Date {
  return addMin(current.getTime() > now.getTime() ? current : now, minutes);
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function unchanged(state: CheckinState, event: string, note?: string): TransitionResult {
  return { state, changed: false, event, effects: [], note };
}

/** Opt in or update the schedule. Allowed when there is no check-in, it is awaiting, or it was cancelled (opted out). */
export function setupTransition(
  prev: CheckinState | null,
  input: ScheduleInput,
  ctx: { now: Date; hikeOpen: boolean },
): TransitionResult | { error: string } {
  if (prev && !(isAwaiting(prev.status) || prev.status === "cancelled")) {
    return {
      error:
        prev.status === "completed"
          ? "This trip is finished, so check-ins can't be changed."
          : "We're waiting for your confirmation. Use “I'm okay”, “Extend my trip” or “Finish trip” instead.",
    };
  }
  const normalized = { ...input, reminderOffsetsMin: normalizeReminderOffsets(input.reminderOffsetsMin) };
  const err = validateScheduleInput(normalized, ctx.now);
  if (err) return { error: err };
  const status: CheckinStatus = ctx.hikeOpen ? "active" : "scheduled";
  return {
    state: {
      status,
      version: (prev?.version ?? 0) + 1,
      expectedReturnAt: input.expectedReturnAt,
      graceMinutes: input.graceMinutes,
      reminderOffsetsMin: normalized.reminderOffsetsMin,
      lastOkAt: prev?.status === "cancelled" ? null : (prev?.lastOkAt ?? null),
      overdueAt: null,
      contactNotifiedAt: prev?.contactNotifiedAt ?? null,
      completedAt: null,
    },
    changed: true,
    event: prev ? (prev.status === "cancelled" ? "opted_in" : "updated") : "opted_in",
    effects: [{ type: "reschedule" }],
  };
}

export function hikeStartedTransition(prev: CheckinState): TransitionResult {
  if (prev.status !== "scheduled") return unchanged(prev, "hike_started", `no change from ${prev.status}`);
  return { state: { ...prev, status: "active" }, changed: true, event: "hike_started", effects: [] };
}

/**
 * "I'm okay". `tappedAt` is when the user tapped (may be in the past for
 * taps recorded offline); `now` is when the server processes it.
 */
export function confirmOkTransition(prev: CheckinState, ctx: { tappedAt: Date; now: Date }): TransitionResult {
  if (isTerminal(prev.status)) return unchanged(prev, "ok_ignored", `check-in is ${prev.status}`);
  const lastOkAt = maxDate(prev.lastOkAt, ctx.tappedAt);
  const afterDue = isOverdueState(prev.status) || ctx.tappedAt.getTime() >= prev.expectedReturnAt.getTime();
  if (!afterDue) {
    return { state: { ...prev, status: "confirmed_ok", lastOkAt }, changed: true, event: "ok_confirmed", effects: [] };
  }
  // Counts as confirmation: auto-extend the expected return so a later
  // silence is still caught, and tell an already-notified contact.
  const base = ctx.now.getTime() > ctx.tappedAt.getTime() ? ctx.now : ctx.tappedAt;
  const effects: CheckinEffect[] = [{ type: "reschedule" }];
  if (isOverdueState(prev.status)) effects.push({ type: "suppress_pending_notices" });
  if (prev.status === "contact_notified") effects.push({ type: "follow_up_contact", kind: "ok" });
  return {
    state: { ...prev, status: "confirmed_ok", lastOkAt, version: prev.version + 1, expectedReturnAt: addMin(base, OK_AUTO_EXTEND_MIN) },
    changed: true,
    event: "ok_confirmed_auto_extended",
    effects,
    note: `expected return auto-extended to now + ${OK_AUTO_EXTEND_MIN} min`,
  };
}

export function extendTransition(prev: CheckinState, ctx: { newExpectedReturnAt: Date; now: Date }): TransitionResult | { error: string } {
  if (isTerminal(prev.status)) return { error: prev.status === "completed" ? "This trip is already finished." : "Check-ins are off for this trip." };
  const err = validateExtension(ctx.newExpectedReturnAt, ctx.now);
  if (err) return { error: err };
  const status: CheckinStatus = prev.status === "scheduled" ? "scheduled" : prev.status === "confirmed_ok" ? "confirmed_ok" : "active";
  const effects: CheckinEffect[] = [{ type: "reschedule" }];
  if (isOverdueState(prev.status)) effects.push({ type: "suppress_pending_notices" });
  if (prev.status === "contact_notified") effects.push({ type: "follow_up_contact", kind: "extended" });
  return {
    state: { ...prev, status, version: prev.version + 1, expectedReturnAt: ctx.newExpectedReturnAt },
    changed: true,
    event: "extended",
    effects,
  };
}

export function finishTransition(prev: CheckinState, now: Date): TransitionResult {
  if (isTerminal(prev.status)) return unchanged(prev, "finish_ignored", `check-in is ${prev.status}`);
  const effects: CheckinEffect[] = [{ type: "cancel_jobs" }, { type: "suppress_pending_notices" }];
  if (prev.contactNotifiedAt) effects.push({ type: "follow_up_contact", kind: "finished" });
  return { state: { ...prev, status: "completed", completedAt: now }, changed: true, event: "finished", effects };
}

/** Overdue evaluation: only when awaiting and the grace period has passed. */
export function overdueTransition(prev: CheckinState, now: Date): TransitionResult {
  if (!isAwaiting(prev.status)) return unchanged(prev, "overdue_skipped", `status ${prev.status}`);
  if (now.getTime() < overdueDueAt(prev).getTime()) return unchanged(prev, "overdue_skipped", "not yet due");
  return { state: { ...prev, status: "overdue", overdueAt: now }, changed: true, event: "overdue", effects: [] };
}

/** Called after an overdue notice to a contact was delivered (or simulated). */
export function contactNotifiedTransition(prev: CheckinState, noticeVersion: number, now: Date): TransitionResult {
  const contactNotifiedAt = prev.contactNotifiedAt ?? now;
  if (prev.status === "overdue" && prev.version === noticeVersion) {
    return { state: { ...prev, status: "contact_notified", contactNotifiedAt }, changed: true, event: "contact_notified", effects: [] };
  }
  // Already moved on (user confirmed/finished while the notice was in flight):
  // keep the status, but record the fact that the contact was notified.
  if (!prev.contactNotifiedAt) return { state: { ...prev, contactNotifiedAt }, changed: true, event: "contact_notified_late", effects: [] };
  return unchanged(prev, "contact_notified_late");
}

export function cancelTransition(prev: CheckinState): TransitionResult {
  if (isTerminal(prev.status)) return unchanged(prev, "cancel_ignored", `check-in is ${prev.status}`);
  return {
    state: { ...prev, status: "cancelled", version: prev.version + 1 },
    changed: true,
    event: "cancelled",
    effects: [{ type: "cancel_jobs" }, { type: "suppress_pending_notices" }],
  };
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export const checkinJobPrefix = (checkinId: string) => `checkin:${checkinId}:`;
export const checkinVersionPrefix = (checkinId: string, version: number) => `checkin:${checkinId}:v${version}:`;
export const reminderDedupKey = (checkinId: string, version: number, offsetMin: number) =>
  `checkin:${checkinId}:v${version}:reminder:${offsetMin}`;
export const overdueDedupKey = (checkinId: string, version: number) => `checkin:${checkinId}:v${version}:overdue`;

export type ScheduleStep =
  | { step: "reminder"; kind: "checkins.reminder"; at: Date; offsetMin: number; dedupKey: string }
  | { step: "overdue"; kind: "checkins.overdue"; at: Date; dedupKey: string };

/**
 * Jobs for the current version: one reminder per offset (skipping reminders
 * whose time has already passed when `now` is given) plus the overdue check
 * at expected return + grace (always scheduled; if already past it runs at once).
 */
export function computeSchedule(
  c: { id: string; version: number; expectedReturnAt: Date; graceMinutes: number; reminderOffsetsMin: number[] },
  now?: Date,
): ScheduleStep[] {
  const steps: ScheduleStep[] = [];
  for (const offsetMin of normalizeReminderOffsets(c.reminderOffsetsMin)) {
    const at = addMin(c.expectedReturnAt, -offsetMin);
    if (now && at.getTime() <= now.getTime()) continue;
    steps.push({ step: "reminder", kind: "checkins.reminder", at, offsetMin, dedupKey: reminderDedupKey(c.id, c.version, offsetMin) });
  }
  steps.push({ step: "overdue", kind: "checkins.overdue", at: overdueDueAt(c), dedupKey: overdueDedupKey(c.id, c.version) });
  return steps;
}

// ---------------------------------------------------------------------------
// Defaults & local-time helpers (region time zone)
// ---------------------------------------------------------------------------

/**
 * Default expected return: itinerary estimated finish + 30 min on the planned
 * date (region time). Falls back to start + duration + 30 min. A finish time
 * earlier than the start time is taken to be after midnight.
 */
export function defaultExpectedReturn(
  input: { plannedDate: string | null; startTime: string | null; estimatedFinishTime?: string | null; estimatedDurationMin?: number | null },
  timeZone: string,
): Date | null {
  if (!input.plannedDate) return null;
  const start = input.startTime ? zonedTimeToUtc(input.plannedDate, input.startTime.slice(0, 5), timeZone) : null;
  if (input.estimatedFinishTime && /^\d{2}:\d{2}/.test(input.estimatedFinishTime)) {
    let finish = zonedTimeToUtc(input.plannedDate, input.estimatedFinishTime.slice(0, 5), timeZone);
    if (start && finish.getTime() < start.getTime()) finish = new Date(finish.getTime() + 86_400_000);
    return addMin(finish, DEFAULT_RETURN_BUFFER_MIN);
  }
  if (start && input.estimatedDurationMin && input.estimatedDurationMin > 0) {
    return addMin(start, input.estimatedDurationMin + DEFAULT_RETURN_BUFFER_MIN);
  }
  return null;
}

/** "YYYY-MM-DDTHH:MM" for a datetime-local input, in the region time zone. */
export function toLocalInputValue(d: Date, timeZone: string): string {
  return `${localDateInZone(d, timeZone)}T${localTimeInZone(d, timeZone)}`;
}

/** Parse a datetime-local value ("YYYY-MM-DDTHH:MM") as region-local time. Returns null when malformed. */
export function parseLocalInputValue(value: string, timeZone: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  try {
    const d = zonedTimeToUtc(m[1], m[2], timeZone);
    return Number.isFinite(d.getTime()) ? d : null;
  } catch {
    return null;
  }
}

/** "Sat, Nov 14, 3:30 PM PST" in the region time zone. */
export function formatCheckinTime(d: Date | string, timeZone: string): string {
  return formatInZone(d, timeZone, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

/** "3:30 PM PST" in the region time zone. */
export function formatClock(d: Date | string, timeZone: string): string {
  return formatInZone(d, timeZone, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

// ---------------------------------------------------------------------------
// Plain-language status text
// ---------------------------------------------------------------------------

export interface StatusCopy {
  title: string;
  detail: string;
  tone: "neutral" | "forest" | "amber" | "blue";
}

/** Owner-facing summary. Never says "emergency"; overdue means "no confirmation received". */
export function describeCheckinForOwner(
  c: Pick<CheckinState, "status" | "expectedReturnAt" | "graceMinutes" | "lastOkAt" | "contactNotifiedAt" | "completedAt">,
  timeZone: string,
): StatusCopy {
  const due = formatCheckinTime(overdueDueAt(c), timeZone);
  const expected = formatCheckinTime(c.expectedReturnAt, timeZone);
  switch (c.status) {
    case "scheduled":
      return {
        title: "Check-ins are on",
        detail: `You're expected back by ${expected}. If we haven't heard “I'm okay” or “Finish trip” from you by ${due}, we'll send your contact a notice.`,
        tone: "forest",
      };
    case "active":
      return {
        title: "Waiting for your confirmation",
        detail: `You're expected back by ${expected}. Tap “I'm okay” or “Finish trip” before ${due} so we don't send your contact a notice.`,
        tone: "forest",
      };
    case "confirmed_ok":
      return {
        title: c.lastOkAt ? `You confirmed you're okay at ${formatClock(c.lastOkAt, timeZone)}` : "You confirmed you're okay",
        detail: `Thanks. Please still tap “Finish trip” when you're back. Expected back by ${expected}; your contact gets a notice if we hear nothing by ${due}.`,
        tone: "forest",
      };
    case "overdue":
      return {
        title: "We haven't received your confirmation",
        detail: `Your expected return (${expected}) plus the grace period has passed. We're sending your contact a notice. If you're okay, tap “I'm okay” or “Finish trip” now and we'll let them know.`,
        tone: "amber",
      };
    case "contact_notified":
      return {
        title: "Your contact was sent a notice",
        detail: `We hadn't received your confirmation${c.contactNotifiedAt ? `, so we notified your contact at ${formatClock(c.contactNotifiedAt, timeZone)}` : ""}. If you're okay, tap “I'm okay” or “Finish trip” and we'll send them a follow-up.`,
        tone: "amber",
      };
    case "completed":
      return {
        title: "Trip finished",
        detail: `${c.completedAt ? `You finished at ${formatClock(c.completedAt, timeZone)}. ` : ""}No more check-in notices will be sent for this trip.`,
        tone: "neutral",
      };
    case "cancelled":
    default:
      return { title: "Check-ins are off", detail: "No reminders or notices will be sent for this trip.", tone: "neutral" };
  }
}

/** Neutral wording for the public trip-share page. */
export function describeCheckinForShare(
  c: Pick<CheckinState, "status" | "lastOkAt" | "completedAt"> | null,
  timeZone: string,
): string {
  if (!c || c.status === "cancelled") return "Check-ins are not turned on for this trip.";
  if (c.status === "completed") return c.completedAt ? `Finished the trip at ${formatClock(c.completedAt, timeZone)}` : "Finished the trip";
  if (isOverdueState(c.status)) {
    return c.lastOkAt
      ? `Last confirmed okay at ${formatClock(c.lastOkAt, timeZone)}. No confirmation received since the expected return time`
      : "No confirmation received by the expected return time";
  }
  if (c.lastOkAt) return `Confirmed okay at ${formatClock(c.lastOkAt, timeZone)}`;
  return "No confirmation received yet";
}
