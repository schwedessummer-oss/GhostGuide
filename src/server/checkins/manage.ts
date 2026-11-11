import "server-only";
import { z } from "zod";
import { withSystem, withUser, type Tx } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { checkRateLimit } from "@/server/rate-limit";
import { isEnabled } from "@/server/flags";
import { getOwnedTrip, type TripRow } from "@/server/trips/queries";
import { getRegionById } from "@/server/catalog/trails";
import { finishHike } from "@/server/hike/sessions";
import { env } from "@/config/env";
import {
  EXTEND_PRESETS_MIN,
  GRACE_MAX,
  GRACE_MIN,
  MAX_REMINDERS,
  REMINDER_OFFSET_MAX,
  REMINDER_OFFSET_MIN,
  cancelTransition,
  confirmOkTransition,
  defaultExpectedReturn,
  extendTransition,
  extendedReturnAt,
  finishTransition,
  isTerminal,
  parseLocalInputValue,
  setupTransition,
  type CheckinState,
} from "@/domain/checkin";
import type { CheckinStatus } from "@/domain/types";
import { NOTIFICATION_TEMPLATES } from "@/server/notifications/create";
import { applyTransition, lockCheckinByTrip, type CheckinRow } from "./core";
import { getSafetySettings } from "./settings";

/**
 * Customer-facing check-in use-cases. Each takes an explicit SessionUser,
 * authorizes ownership through RLS (getOwnedTrip -> 404 semantics), then
 * performs the lifecycle write in a system transaction with a row lock.
 */
export type ActionResult = { ok: true; message: string } | { ok: false; error: string; notFound?: boolean };

const ELIGIBLE_TRIP_STATUSES = ["booked", "active"] as const;
const ACTION_LIMIT = { limit: 30, windowSec: 600 };

export interface CheckinView extends CheckinState {
  id: string;
  tripId: string;
  emergencyContactId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** completed by Ghost Guide staff ("hiker confirmed safe"), not by the hiker */
  closedByStaff: boolean;
}

export interface CheckinEventView {
  id: number;
  kind: string;
  actor: "user" | "system" | "staff";
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface NotificationView {
  id: string;
  channel: string;
  recipientKind: "user" | "emergency_contact" | "operator";
  recipientMasked: string;
  template: string;
  subject: string | null;
  body: string;
  status: "queued" | "simulated" | "sent" | "delivered" | "failed" | "suppressed";
  provider: string;
  error: string | null;
  attempts: number;
  createdAt: Date;
  sentAt: Date | null;
}

const notFound = (): ActionResult => ({ ok: false, error: "Trip not found.", notFound: true });

async function rateLimited(user: SessionUser): Promise<boolean> {
  const r = await checkRateLimit(`checkin:action:user:${user.id}`, ACTION_LIMIT.limit, ACTION_LIMIT.windowSec);
  return !r.allowed;
}

/** The user's own check-in for a trip (RLS), or null. */
export async function getOwnedCheckin(user: SessionUser, tripId: string): Promise<CheckinView | null> {
  if (!z.uuid().safeParse(tripId).success) return null;
  const [c] = await withUser(
    user,
    (tx) => tx<CheckinView[]>`
      select c.id, c.trip_id, c.emergency_contact_id, c.expected_return_at, c.grace_minutes, c.reminder_offsets_min, c.status, c.version,
             c.last_ok_at, c.overdue_at, c.contact_notified_at, c.completed_at, c.created_at, c.updated_at,
             (c.status = 'completed' and exists (select 1 from public.checkin_events e where e.checkin_id = c.id and e.kind = 'staff_resolved'))
               as closed_by_staff
      from public.trip_checkins c where c.trip_id = ${tripId} and c.user_id = ${user.id}`,
  );
  return c ?? null;
}

export async function listCheckinEvents(user: SessionUser, checkinId: string): Promise<CheckinEventView[]> {
  return withUser(
    user,
    (tx) => tx<CheckinEventView[]>`
      select e.id, e.kind, e.actor, e.details, e.created_at
      from public.checkin_events e join public.trip_checkins c on c.id = e.checkin_id
      where e.checkin_id = ${checkinId} and c.user_id = ${user.id}
      order by e.created_at desc, e.id desc
      limit 100`,
  );
}

/** Notification history for a trip (the user's audit trail; masked recipients + bodies). */
export async function listTripNotifications(user: SessionUser, tripId: string): Promise<NotificationView[]> {
  if (!z.uuid().safeParse(tripId).success) return [];
  return withUser(
    user,
    (tx) => tx<NotificationView[]>`
      select id, channel, recipient_kind, recipient_masked, template, subject, body, status, provider, error, attempts, created_at, sent_at
      from public.notifications where trip_id = ${tripId} and user_id = ${user.id}
      order by created_at desc
      limit 100`,
  );
}

export interface CheckinDefaults {
  expectedReturnAt: Date | null;
  graceMinutes: number;
  reminderOffsetsMin: number[];
  timeZone: string;
}

/** Defaults for the setup form: itinerary finish + 30 min (region time), operator grace/reminder defaults. */
export async function getCheckinDefaults(trip: TripRow): Promise<CheckinDefaults> {
  const [settings, region] = await Promise.all([getSafetySettings(), getRegionById(trip.regionId)]);
  const timeZone = region?.timezone ?? "America/Los_Angeles";
  const itin = trip.itinerary ?? {};
  const expectedReturnAt = defaultExpectedReturn(
    {
      plannedDate: trip.plannedDate ?? itin.plannedDate ?? null,
      startTime: trip.startTime ?? itin.startTime ?? null,
      estimatedFinishTime: itin.estimatedFinishTime ?? null,
      estimatedDurationMin: itin.estimatedDurationMin ?? null,
    },
    timeZone,
  );
  return { expectedReturnAt, graceMinutes: settings.graceMinutes, reminderOffsetsMin: settings.reminderOffsetsMin, timeZone };
}

// ---------------------------------------------------------------------------
// Setup / opt out
// ---------------------------------------------------------------------------

export const setupSchema = z.object({
  contactId: z.uuid({ message: "Choose an emergency contact." }),
  expectedReturnLocal: z.string().trim().min(1, "Enter your expected return time.").max(25),
  graceMinutes: z.coerce
    .number({ message: "Enter a grace period in minutes." })
    .int("Use whole minutes.")
    .min(GRACE_MIN, `The grace period must be at least ${GRACE_MIN} minutes.`)
    .max(GRACE_MAX, `The grace period can be at most ${GRACE_MAX} minutes.`),
  reminderOffsetsMin: z
    .array(z.coerce.number().int().min(REMINDER_OFFSET_MIN).max(REMINDER_OFFSET_MAX))
    .max(MAX_REMINDERS, `Choose at most ${MAX_REMINDERS} reminders.`),
});
export type SetupInput = z.input<typeof setupSchema>;

export async function setupCheckin(user: SessionUser, tripId: string, input: unknown, now = new Date()): Promise<ActionResult> {
  const trip = z.uuid().safeParse(tripId).success ? await getOwnedTrip(user, tripId) : null;
  if (!trip) return notFound();
  if (!(await isEnabled("checkins_enabled"))) return { ok: false, error: "Trip check-ins are not available right now." };
  if (!ELIGIBLE_TRIP_STATUSES.includes(trip.status as (typeof ELIGIBLE_TRIP_STATUSES)[number])) {
    return { ok: false, error: "Check-ins can be set up for booked or active trips only." };
  }
  const parsed = setupSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the form." };
  if (await rateLimited(user)) return { ok: false, error: "Too many changes in a short time. Please wait a few minutes." };

  const region = await getRegionById(trip.regionId);
  const expectedReturnAt = parseLocalInputValue(parsed.data.expectedReturnLocal, region?.timezone ?? "America/Los_Angeles");
  if (!expectedReturnAt) return { ok: false, error: "Enter a valid expected return date and time." };

  // The contact must be the user's own AND have consent on file.
  const [contact] = await withUser(
    user,
    (tx) => tx<{ id: string; consentConfirmedAt: Date | null }[]>`
      select id, consent_confirmed_at from public.emergency_contacts where id = ${parsed.data.contactId} and user_id = ${user.id}`,
  );
  if (!contact) return { ok: false, error: "Choose one of your emergency contacts." };
  if (!contact.consentConfirmedAt) {
    return { ok: false, error: "This contact hasn't agreed to receive notices yet. Confirm their consent on the Emergency contacts page first." };
  }

  return withSystem(async (tx) => {
    // Serialize setup per trip, then re-check the trip state under the lock.
    const [locked] = await tx<{ status: string }[]>`select status from public.trips where id = ${trip.id} and user_id = ${user.id} for update`;
    if (!locked || !ELIGIBLE_TRIP_STATUSES.includes(locked.status as (typeof ELIGIBLE_TRIP_STATUSES)[number])) {
      return { ok: false as const, error: "Check-ins can be set up for booked or active trips only." };
    }
    const [open] = await tx`select 1 from public.hike_sessions where trip_id = ${trip.id} and status in ('active', 'paused')`;
    let row = await lockCheckinByTrip(tx, trip.id);
    const result = setupTransition(row, { ...parsed.data, expectedReturnAt }, { now, hikeOpen: !!open });
    if ("error" in result) return { ok: false as const, error: result.error };
    if (!row) {
      const [created] = await tx<{ id: string }[]>`
        insert into public.trip_checkins (trip_id, user_id, emergency_contact_id, expected_return_at, grace_minutes, reminder_offsets_min, status, version)
        values (${trip.id}, ${user.id}, ${contact.id}, ${expectedReturnAt}::timestamptz, ${result.state.graceMinutes},
                ${result.state.reminderOffsetsMin}::int[], 'cancelled', 0)
        returning id`;
      row = await lockCheckinByTrip(tx, trip.id);
      if (!row || row.id !== created.id) throw new Error("check-in insert failed");
    } else {
      await tx`update public.trip_checkins set emergency_contact_id = ${contact.id} where id = ${row.id}`;
    }
    await applyTransition(tx, { ...row, emergencyContactId: contact.id }, result, {
      now,
      who: { actor: "user", actorId: user.id },
      details: { graceMinutes: result.state.graceMinutes, reminders: result.state.reminderOffsetsMin.length },
    });
    return { ok: true as const, message: result.event === "updated" ? "Check-in details updated." : "Check-ins are on for this trip." };
  });
}

export async function optOutOfCheckin(user: SessionUser, tripId: string, now = new Date()): Promise<ActionResult> {
  const trip = z.uuid().safeParse(tripId).success ? await getOwnedTrip(user, tripId) : null;
  if (!trip) return notFound();
  if (await rateLimited(user)) return { ok: false, error: "Too many changes in a short time. Please wait a few minutes." };
  return withSystem(async (tx) => {
    const row = await lockCheckinByTrip(tx, trip.id);
    if (!row || row.userId !== user.id) return { ok: false as const, error: "Check-ins aren't set up for this trip." };
    if (row.status === "overdue" || row.status === "contact_notified") {
      return { ok: false as const, error: "We're waiting for your confirmation. Tap “I'm okay” or “Finish trip” instead." };
    }
    if (row.status === "cancelled" || row.status === "completed") return { ok: true as const, message: "Check-ins are already off for this trip." };
    await applyTransition(tx, row, cancelTransition(row), { now, who: { actor: "user", actorId: user.id }, details: { reason: "opted_out" } });
    return { ok: true as const, message: "Check-ins are off for this trip. No reminders or notices will be sent." };
  });
}

// ---------------------------------------------------------------------------
// I'm okay / extend / finish
// ---------------------------------------------------------------------------

async function withOwnedCheckin(
  user: SessionUser,
  tripId: string,
  fn: (row: CheckinRow, tx: Tx, timeZone: string) => Promise<ActionResult>,
): Promise<ActionResult> {
  const trip = z.uuid().safeParse(tripId).success ? await getOwnedTrip(user, tripId) : null;
  if (!trip) return notFound();
  if (await rateLimited(user)) return { ok: false, error: "Too many requests in a short time. Please wait a minute and try again." };
  const region = await getRegionById(trip.regionId);
  return withSystem(async (tx) => {
    const row = await lockCheckinByTrip(tx, trip.id);
    if (!row || row.userId !== user.id) return { ok: false as const, error: "Check-ins aren't set up for this trip." };
    return fn(row, tx, region?.timezone ?? "America/Los_Angeles");
  });
}

export async function confirmOkByUser(user: SessionUser, tripId: string, now = new Date()): Promise<ActionResult> {
  return withOwnedCheckin(user, tripId, async (row, tx) => {
    if (row.status === "completed") return { ok: false, error: "This trip is already finished." };
    if (row.status === "cancelled") return { ok: false, error: "Check-ins are off for this trip." };
    const result = confirmOkTransition(row, { tappedAt: now, now });
    await applyTransition(tx, row, result, { now, who: { actor: "user", actorId: user.id }, details: { source: "web" } });
    if (result.event === "ok_recorded_late") {
      // Not reachable with a live tap (an overdue check-in's deadline is always in the past), but never claim more than happened.
      return { ok: true, message: "We've recorded your “I'm okay”, but your check-in is still waiting for confirmation. Please try again." };
    }
    if (result.state.version === row.version) {
      return { ok: true, message: "Thanks — you're confirmed okay. Please still tap “Finish trip” when you're back." };
    }
    const extendedMsg = "Thanks — you're confirmed okay. We've extended your expected return by 60 minutes";
    if (row.status !== "contact_notified") return { ok: true, message: `${extendedMsg}.` };
    return {
      ok: true,
      message: (await followUpExists(tx, row.id, NOTIFICATION_TEMPLATES.followUpOk, row.version))
        ? `${extendedMsg} and we're letting your contact know${simulatedSuffix()}.`
        : `${extendedMsg}. Your contact can no longer receive notices from us (removed, or consent withdrawn), so please tell them you're okay.`,
    };
  });
}

export const extendSchema = z.union([
  z.object({ minutes: z.coerce.number().refine((m) => (EXTEND_PRESETS_MIN as readonly number[]).includes(m), "Choose 30, 60 or 120 minutes.") }),
  z.object({ untilLocal: z.string().trim().min(1, "Choose a new return time.").max(25) }),
]);

export async function extendCheckinByUser(user: SessionUser, tripId: string, input: unknown, now = new Date()): Promise<ActionResult> {
  const parsed = extendSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Choose how long to extend your trip." };
  return withOwnedCheckin(user, tripId, async (row, tx, timeZone) => {
    let newExpectedReturnAt: Date | null;
    if ("minutes" in parsed.data) newExpectedReturnAt = extendedReturnAt(row.expectedReturnAt, parsed.data.minutes, now);
    else newExpectedReturnAt = parseLocalInputValue(parsed.data.untilLocal, timeZone);
    if (!newExpectedReturnAt) return { ok: false, error: "Choose a valid new return time." };
    const result = extendTransition(row, { newExpectedReturnAt, now });
    if ("error" in result) return { ok: false, error: result.error };
    await applyTransition(tx, row, result, { now, who: { actor: "user", actorId: user.id }, details: { source: "web" } });
    return { ok: true, message: "Your expected return time is updated." };
  });
}

/**
 * "Finish trip" from the check-in UI ("Yes, I'm back — finish trip").
 *
 * Ends the TRIP, the same way finishing from the hike screen does: when the
 * trip is active (a hike was started), the hike slice's finishHike closes the
 * open hike session, marks the trip completed and completes the check-in via
 * onTripFinished in one transaction (cancelling queued jobs, suppressing
 * undelivered notices, and following up with a contact who was already
 * notified). A booked trip whose hike was never started in the app has no
 * session to close; only its check-in is completed. Safe to call repeatedly.
 */
export async function finishTripByUser(user: SessionUser, tripId: string, now = new Date()): Promise<ActionResult> {
  const trip = z.uuid().safeParse(tripId).success ? await getOwnedTrip(user, tripId) : null;
  if (!trip) return notFound();
  if (await rateLimited(user)) return { ok: false, error: "Too many requests in a short time. Please wait a minute and try again." };
  const before = await getOwnedCheckin(user, trip.id);
  if (!before) return { ok: false, error: "Check-ins aren't set up for this trip." };
  if (before.status === "cancelled" && trip.status !== "active") return { ok: false, error: "Check-ins are off for this trip." };
  if (before.status === "completed" && trip.status !== "active") return { ok: true, message: "This trip is already finished." };

  if (trip.status === "active") {
    // Ownership was checked above; finishHike re-checks it and locks the
    // trip, then the session, then the check-in (same lock order as the hike
    // screen). Its "no recorded hike" conflict still completes the trip.
    const r = await finishHike(user, { tripId: trip.id }, now);
    if (!r.ok && r.status !== 409) return { ok: false, error: r.error };
  }

  // Complete the check-in if finishHike did not (booked trip, or the trip was
  // already completed while the check-in stayed open).
  const outcome = await withSystem(async (tx) => {
    const row = await lockCheckinByTrip(tx, trip.id);
    if (!row || row.userId !== user.id) return { notified: false, followUp: false };
    if (!isTerminal(row.status)) {
      await applyTransition(tx, row, finishTransition(row, now), { now, who: { actor: "user", actorId: user.id }, details: { source: "web" } });
    }
    return { notified: !!row.contactNotifiedAt, followUp: await followUpExists(tx, row.id, NOTIFICATION_TEMPLATES.followUpFinished, row.version) };
  });
  if (before.status === "cancelled") return { ok: true, message: "Welcome back! Your trip is finished." };
  return {
    ok: true,
    message: outcome.followUp
      ? `Welcome back! Your trip is finished and we're letting your contact know${simulatedSuffix()}.`
      : outcome.notified
        ? "Welcome back! Your trip is finished. Your contact can no longer receive notices from us (removed, or consent withdrawn), so please tell them you're back."
        : "Welcome back! Your trip is finished — no more check-in notices will be sent.",
  };
}

/** Whether a follow-up notice of this kind exists for the check-in's episode (version). */
async function followUpExists(tx: Tx, checkinId: string, template: string, version: number): Promise<boolean> {
  const [row] = await tx`
    select 1 from public.notifications where checkin_id = ${checkinId} and template = ${template} and checkin_version = ${version} limit 1`;
  return !!row;
}

/** Demo mode: follow-ups are recorded as simulated, never sent. */
const simulatedSuffix = () => (env().NOTIFY_PROVIDER !== "live" ? " (a simulated follow-up in this demo — nothing is actually sent)" : "");

export const STATUS_IS_ACTIONABLE = (s: CheckinStatus) => s !== "completed" && s !== "cancelled";
