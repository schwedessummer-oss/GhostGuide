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
 *   "I'm okay"       is applied as if it had arrived when it was TAPPED (taps
 *                    recorded offline reach us later), so the outcome never
 *                    depends on whether a sync beat the overdue job:
 *                    - tapped before the expected return -> confirmed_ok (records
 *                      last_ok_at; deadline unchanged). If the check-in is already
 *                      overdue/contact_notified it STAYS overdue: an old tap only
 *                      records last_ok_at (event ok_recorded_late) — it says
 *                      nothing about the hiker since the deadline.
 *                    - tapped after the expected return -> counts as confirmation:
 *                      AUTO-EXTEND the expected return to tap + 60 min
 *                      (OK_AUTO_EXTEND_MIN), version++, reschedule, follow-up to
 *                      an already-notified contact stating the tap time — unless
 *                      that extended deadline plus grace has also passed by the
 *                      time it arrives (then only last_ok_at is recorded).
 *   extend           -> new expected return, version++, back to active/confirmed_ok
 *                    (device extensions: deviceExtendTransition, same "as of when
 *                    it was made" rule; a stale one never overrides newer changes)
 *   staff resolution -> completed (staff recorded that the hiker is safe)
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
  /**
   * tell contacts who already received an overdue notice what happened.
   * `at`: when the hiker acted (tap / extension made on the device), when it
   * differs from processing time; `by: "staff"`: Ghost Guide staff closed it.
   */
  | { type: "follow_up_contact"; kind: FollowUpKind; at?: Date; by?: "staff" };

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
 * taps recorded offline; a future time from a fast device clock counts as
 * `now`); `now` is when the server processes it. The tap is applied as if it
 * had arrived when it was tapped (see the rules at the top of this file).
 */
export function confirmOkTransition(prev: CheckinState, ctx: { tappedAt: Date; now: Date }): TransitionResult {
  if (isTerminal(prev.status)) return unchanged(prev, "ok_ignored", `check-in is ${prev.status}`);
  const tapped = ctx.tappedAt.getTime() > ctx.now.getTime() ? ctx.now : ctx.tappedAt;
  const lastOkAt = maxDate(prev.lastOkAt, tapped);
  const overdue = isOverdueState(prev.status);
  const recordOnly = (note: string): TransitionResult =>
    prev.lastOkAt && lastOkAt.getTime() === prev.lastOkAt.getTime()
      ? unchanged(prev, "ok_recorded_late", note)
      : { state: { ...prev, lastOkAt }, changed: true, event: "ok_recorded_late", effects: [], note };

  if (tapped.getTime() < prev.expectedReturnAt.getTime()) {
    if (!overdue) return { state: { ...prev, status: "confirmed_ok", lastOkAt }, changed: true, event: "ok_confirmed", effects: [] };
    // Tapped (offline) before the deadline, received after the check-in went
    // overdue: it only tells us when the hiker was last okay, nothing about
    // them since. The overdue state and any notice stand.
    return recordOnly("tapped before the expected return; it reached us after the check-in became overdue");
  }
  // After the expected return: counts as confirmation, extended from the tap.
  const expectedReturnAt = addMin(tapped, OK_AUTO_EXTEND_MIN);
  if (overdueDueAt({ expectedReturnAt, graceMinutes: prev.graceMinutes }).getTime() <= ctx.now.getTime()) {
    // Even the extended deadline (plus grace) has passed without word since.
    return recordOnly("tapped after the expected return, but it reached us after the extended deadline had also passed");
  }
  const effects: CheckinEffect[] = [{ type: "reschedule" }];
  if (overdue) effects.push({ type: "suppress_pending_notices" });
  if (prev.status === "contact_notified") effects.push({ type: "follow_up_contact", kind: "ok", at: tapped });
  return {
    state: { ...prev, status: "confirmed_ok", lastOkAt, version: prev.version + 1, expectedReturnAt },
    changed: true,
    event: "ok_confirmed_auto_extended",
    effects,
    note: `expected return auto-extended to the tap + ${OK_AUTO_EXTEND_MIN} min`,
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

/** Device clocks may run a little fast; an extension may end at most this much beyond now + 24 h. */
export const DEVICE_CLOCK_SKEW_MIN = 15;

export interface DeviceExtendContext {
  /** when the extension was made on the device (a future time counts as `now`) */
  occurredAt: Date;
  newExpectedReturnAt: Date;
  now: Date;
  /** latest time the user changed the schedule otherwise (setup/update/extension), if any */
  lastScheduleChangeAt: Date | null;
}

/**
 * "Extend my trip" recorded on the device (possibly offline) and synced
 * later. Applied as if it had arrived when it was made:
 *  - rejected when the new time is not after the moment it was made or more
 *    than 24 h after it, or the check-in has ended;
 *  - STALE (a newer schedule change was already applied) -> ignored; stale
 *    relative to a later "I'm okay" -> applied only if it moves the expected
 *    return later (never backwards);
 *  - an overdue check-in is resolved only while the new time plus grace has
 *    not passed yet (otherwise the hiker has been silent past it too).
 */
export function deviceExtendTransition(prev: CheckinState, ctx: DeviceExtendContext): { ok: true; result: TransitionResult } | { ok: false; reason: string } {
  const t = ctx.occurredAt instanceof Date ? ctx.occurredAt.getTime() : Number.NaN;
  const n = ctx.newExpectedReturnAt instanceof Date ? ctx.newExpectedReturnAt.getTime() : Number.NaN;
  if (!Number.isFinite(t) || !Number.isFinite(n)) return { ok: false, reason: "invalid time" };
  const madeAt = new Date(Math.min(t, ctx.now.getTime()));
  if (isTerminal(prev.status)) return { ok: false, reason: `check-in is ${prev.status}` };
  if (n <= t) return { ok: false, reason: "the new return time is not after the time the extension was made" };
  // 24 h from when it was made — and a fast device clock can't push it further than that from now.
  if (n > t + MAX_EXTEND_AHEAD_MIN * 60_000 || n > ctx.now.getTime() + (MAX_EXTEND_AHEAD_MIN + DEVICE_CLOCK_SKEW_MIN) * 60_000) {
    return { ok: false, reason: "more than 24 hours after the time the extension was made" };
  }
  if (ctx.lastScheduleChangeAt && ctx.lastScheduleChangeAt.getTime() > madeAt.getTime()) {
    return { ok: false, reason: "stale: a newer change to the check-in was already applied" };
  }
  if (prev.lastOkAt && prev.lastOkAt.getTime() > madeAt.getTime() && n <= prev.expectedReturnAt.getTime()) {
    return { ok: false, reason: "stale: it would move the expected return earlier than a later confirmation left it" };
  }
  const overdue = isOverdueState(prev.status);
  if (overdue && overdueDueAt({ expectedReturnAt: ctx.newExpectedReturnAt, graceMinutes: prev.graceMinutes }).getTime() <= ctx.now.getTime()) {
    return { ok: false, reason: "the new return time plus the grace period has also passed" };
  }
  const status: CheckinStatus = prev.status === "scheduled" ? "scheduled" : prev.status === "confirmed_ok" ? "confirmed_ok" : "active";
  const effects: CheckinEffect[] = [{ type: "reschedule" }];
  if (overdue) effects.push({ type: "suppress_pending_notices" });
  if (prev.status === "contact_notified") effects.push({ type: "follow_up_contact", kind: "extended", at: madeAt });
  return {
    ok: true,
    result: { state: { ...prev, status, version: prev.version + 1, expectedReturnAt: ctx.newExpectedReturnAt }, changed: true, event: "extended", effects },
  };
}

/** Statuses from which staff may record that the hiker is safe. */
export const STAFF_RESOLVABLE_STATUSES: readonly CheckinStatus[] = ["overdue", "contact_notified", "active", "confirmed_ok"];

/**
 * Ghost Guide staff recorded that the hiker is safe (e.g. after calling
 * them): the check-in is completed, queued jobs are cancelled, undelivered
 * notices suppressed, and an already-notified contact gets a follow-up.
 */
export function staffResolveTransition(prev: CheckinState, now: Date): TransitionResult | { error: string } {
  if (!STAFF_RESOLVABLE_STATUSES.includes(prev.status)) {
    return {
      error:
        prev.status === "scheduled"
          ? "This check-in hasn't started yet; there is nothing to resolve."
          : `This check-in is already ${prev.status === "completed" ? "finished" : "cancelled"}.`,
    };
  }
  const effects: CheckinEffect[] = [{ type: "cancel_jobs" }, { type: "suppress_pending_notices" }];
  if (prev.contactNotifiedAt) effects.push({ type: "follow_up_contact", kind: "finished", by: "staff" });
  return { state: { ...prev, status: "completed", completedAt: now }, changed: true, event: "staff_resolved", effects };
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

/**
 * "3:30 PM PST" when `d` falls on the same local (region) day as `now`,
 * otherwise "Sat, Nov 14, 3:30 PM PST" — a bare clock time is ambiguous on
 * multi-day trips.
 */
export function formatWhen(d: Date | string, timeZone: string, now: Date = new Date()): string {
  const date = new Date(d);
  return localDateInZone(date, timeZone) === localDateInZone(now, timeZone) ? formatClock(date, timeZone) : formatCheckinTime(date, timeZone);
}

/**
 * DST-neutral name of a time zone for labels next to time inputs, e.g.
 * "Pacific Time" (the abbreviation of *today* can be wrong for a chosen date
 * on the other side of a daylight-saving change). Falls back to the
 * abbreviation in effect at `at`, then to the IANA name.
 */
export function timeZoneLabel(timeZone: string, at: Date = new Date()): string {
  for (const timeZoneName of ["longGeneric", "short"] as const) {
    try {
      const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value;
      if (part && !/^GMT[+-]/.test(part)) return part;
    } catch {
      // unsupported option or zone: try the next form
    }
  }
  return timeZone;
}

// ---------------------------------------------------------------------------
// Plain-language status text
// ---------------------------------------------------------------------------

export interface StatusCopy {
  title: string;
  detail: string;
  tone: "neutral" | "forest" | "amber" | "blue";
}

export interface OwnerCopyOptions {
  /**
   * Whether the check-in's contact can receive a notice right now (selected,
   * consent on file, a phone or email). Default true. When false the copy
   * never promises a notice or follow-up that will not be sent.
   */
  contactReachable?: boolean;
  /** Demo notification provider: notices are recorded as "simulated", never delivered. Default false. */
  simulated?: boolean;
  /** Reference time for "today" (clock-only times); default now. */
  now?: Date;
  /** A completed check-in was closed by Ghost Guide staff (staff_resolved), not by the hiker. */
  closedByStaff?: boolean;
}

/**
 * Owner-facing summary. Never says "emergency"; overdue means "no
 * confirmation received". Honest about who will (not) be notified and about
 * simulated (demo) notices.
 */
export function describeCheckinForOwner(
  c: Pick<CheckinState, "status" | "expectedReturnAt" | "graceMinutes" | "lastOkAt" | "contactNotifiedAt" | "completedAt">,
  timeZone: string,
  opts: OwnerCopyOptions = {},
): StatusCopy {
  const reachable = opts.contactReachable ?? true;
  const simulated = opts.simulated ?? false;
  const now = opts.now ?? new Date();
  const due = formatCheckinTime(overdueDueAt(c), timeZone);
  const expected = formatCheckinTime(c.expectedReturnAt, timeZone);
  const nobody = "No emergency contact who agreed to receive notices is on this check-in";
  switch (c.status) {
    case "scheduled":
      return {
        title: "Check-ins are on",
        detail: reachable
          ? `You're expected back by ${expected}. If we haven't heard “I'm okay” or “Finish trip” from you by ${due}, we'll send your contact a notice${simulated ? " (simulated in this demo — nothing is actually sent)" : ""}.`
          : `You're expected back by ${expected}. ${nobody}, so nobody else will be notified if we haven't heard from you by ${due}.`,
        tone: reachable ? "forest" : "amber",
      };
    case "active":
      return {
        title: "Waiting for your confirmation",
        detail: reachable
          ? `You're expected back by ${expected}. Tap “I'm okay” or “Finish trip” before ${due} so we don't send your contact a notice.`
          : `You're expected back by ${expected}. Tap “I'm okay” or “Finish trip” when you can. ${nobody}, so nobody else will be notified if we haven't heard from you by ${due}.`,
        tone: reachable ? "forest" : "amber",
      };
    case "confirmed_ok":
      return {
        title: c.lastOkAt ? `You confirmed you're okay at ${formatWhen(c.lastOkAt, timeZone, now)}` : "You confirmed you're okay",
        detail: reachable
          ? `Thanks. Please still tap “Finish trip” when you're back. Expected back by ${expected}; your contact gets a notice if we hear nothing by ${due}.`
          : `Thanks. Please still tap “Finish trip” when you're back. Expected back by ${expected}. ${nobody}, so nobody else will be notified if we hear nothing by ${due}.`,
        tone: "forest",
      };
    case "overdue":
      return {
        title: "We haven't received your confirmation",
        detail: reachable
          ? `Your expected return (${expected}) plus the grace period has passed. ${
              simulated
                ? "We're recording a simulated notice to your contact (demo — nothing is actually sent)."
                : "We're sending your contact a notice."
            } If you're okay, tap “I'm okay” or “Finish trip” now and we'll let them know.`
          : `Your expected return (${expected}) plus the grace period has passed. ${nobody}, so nobody else is being notified. If you're okay, tap “I'm okay” or “Finish trip” now.`,
        tone: "amber",
      };
    case "contact_notified": {
      const at = c.contactNotifiedAt ? formatWhen(c.contactNotifiedAt, timeZone, now) : null;
      const what = simulated
        ? `We hadn't received your confirmation, so ${at ? `at ${at} ` : ""}we recorded a simulated notice to your contact. In this demo nothing is actually sent.`
        : `We hadn't received your confirmation, so we sent your contact a notice${at ? ` at ${at}` : ""}.`;
      const next = reachable
        ? `If you're okay, tap “I'm okay” or “Finish trip” and we'll ${simulated ? "record a simulated follow-up for them" : "send them a follow-up"}.`
        : "If you're okay, tap “I'm okay” or “Finish trip”. Your contact can no longer receive notices from us (removed, or consent withdrawn), so please tell them yourself.";
      return {
        title: simulated ? "A simulated notice was recorded for your contact (demo — nothing was sent)" : "Your contact was sent a notice",
        detail: `${what} ${next}`,
        tone: "amber",
      };
    }
    case "completed":
      if (opts.closedByStaff) {
        return {
          title: "Check-in closed by Ghost Guide staff",
          detail: `Our team recorded that you're safe${c.completedAt ? ` at ${formatWhen(c.completedAt, timeZone, now)}` : ""}. No more check-in notices will be sent for this trip.`,
          tone: "neutral",
        };
      }
      return {
        title: "Trip finished",
        detail: `${c.completedAt ? `You finished at ${formatWhen(c.completedAt, timeZone, now)}. ` : ""}No more check-in notices will be sent for this trip.`,
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
  now: Date = new Date(),
): string {
  if (!c || c.status === "cancelled") return "Check-ins are not turned on for this trip.";
  if (c.status === "completed") return c.completedAt ? `Finished the trip at ${formatWhen(c.completedAt, timeZone, now)}` : "Finished the trip";
  if (isOverdueState(c.status)) {
    return c.lastOkAt
      ? `Last confirmed okay at ${formatWhen(c.lastOkAt, timeZone, now)}. No confirmation received since the expected return time`
      : "No confirmation received by the expected return time";
  }
  if (c.lastOkAt) return `Confirmed okay at ${formatWhen(c.lastOkAt, timeZone, now)}`;
  return "No confirmation received yet";
}

/** Whether the share page should explain that "no confirmation" doesn't mean something is wrong. */
export function shareNeedsNoConfirmationNote(c: Pick<CheckinState, "status" | "lastOkAt"> | null): boolean {
  if (!c) return false;
  return isOverdueState(c.status) || (isAwaiting(c.status) && !c.lastOkAt);
}
