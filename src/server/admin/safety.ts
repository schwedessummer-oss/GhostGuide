import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import { redactString } from "@/server/log";
import { staffResolveCheckin } from "@/server/checkins/service";
import { describeCheckinEvent } from "./checkin-events";
import { assertCan, auditInStaffTx, auditInSystemTx, fail, guarded, isUuid, ok, staffTx, systemTx, zodFail, type ActionResult, type Page, type Paged } from "./common";

/**
 * Operator safety monitor. "Overdue" means Ghost Guide has not received a
 * confirmation — it is not proof of an emergency, and Ghost Guide never
 * contacts emergency services automatically. Precise coordinates are only
 * revealed to safety.sensitive roles, on request, with an audit entry.
 */
export interface ActiveHikeRow {
  id: string;
  tripId: string;
  userId: string;
  customerEmail: string | null;
  trailName: string;
  trailIsDemo: boolean;
  status: string;
  startedAt: Date;
  pausedAt: Date | null;
  lastSyncAt: Date | null;
  lastLocationAt: Date | null;
  distanceCompletedM: number;
  checkinStatus: string | null;
  expectedReturnAt: Date | null;
  /** trail region's IANA zone: staff see times as the hiker does */
  timeZone: string;
}

export async function listActiveHikes(user: SessionUser): Promise<ActiveHikeRow[]> {
  assertCan(user, "trips.monitor");
  return staffTx(user, (tx) => tx<ActiveHikeRow[]>`
    select s.id, s.trip_id, s.user_id, p.email as customer_email, t.name as trail_name, t.is_demo as trail_is_demo, s.status, s.started_at,
           s.paused_at, s.last_sync_at, s.last_location_at, s.distance_completed_m, c.status as checkin_status, c.expected_return_at,
           r.timezone as time_zone
    from public.hike_sessions s
    join public.trips tr on tr.id = s.trip_id
    join public.trails t on t.id = tr.trail_id
    join public.regions r on r.id = t.region_id
    left join public.profiles p on p.id = s.user_id
    left join public.trip_checkins c on c.trip_id = s.trip_id
    where s.status in ('active', 'paused')
    order by s.started_at`);
}

export interface CheckinEventView {
  kind: string;
  actor: string;
  createdAt: Date;
  /** plain-language description (see ./checkin-events) */
  label: string;
  detail: string;
}

export interface AttentionCheckinRow {
  id: string;
  tripId: string;
  userId: string;
  customerEmail: string | null;
  trailName: string;
  status: string;
  expectedReturnAt: Date;
  graceMinutes: number;
  overdueAt: Date | null;
  contactNotifiedAt: Date | null;
  lastOkAt: Date | null;
  hasEmergencyContact: boolean;
  activeSessionId: string | null;
  /** trail region's IANA zone */
  timeZone: string;
  events: CheckinEventView[];
}

export async function listAttentionCheckins(user: SessionUser): Promise<AttentionCheckinRow[]> {
  assertCan(user, "trips.monitor");
  return staffTx(user, async (tx) => {
    const rows = await tx<Omit<AttentionCheckinRow, "events">[]>`
      select c.id, c.trip_id, c.user_id, p.email as customer_email, t.name as trail_name, c.status, c.expected_return_at, c.grace_minutes,
             c.overdue_at, c.contact_notified_at, c.last_ok_at, (c.emergency_contact_id is not null) as has_emergency_contact,
             (select s.id from public.hike_sessions s where s.trip_id = c.trip_id and s.status in ('active', 'paused') limit 1) as active_session_id,
             r.timezone as time_zone
      from public.trip_checkins c
      join public.trips tr on tr.id = c.trip_id
      join public.trails t on t.id = tr.trail_id
      join public.regions r on r.id = t.region_id
      left join public.profiles p on p.id = c.user_id
      where c.status in ('overdue', 'contact_notified')
      order by c.overdue_at nulls last, c.expected_return_at`;
    if (!rows.length) return [];
    const events = await tx<{ checkinId: string; kind: string; actor: string; details: unknown; createdAt: Date }[]>`
      select checkin_id, kind, actor, details, created_at from public.checkin_events
      where checkin_id = any(${rows.map((r) => r.id)}::uuid[]) order by created_at`;
    return rows.map((r) => ({
      ...r,
      events: events
        .filter((e) => e.checkinId === r.id)
        .map((e) => ({ kind: e.kind, actor: e.actor, createdAt: e.createdAt, ...describeCheckinEvent(e, r.timeZone) })),
    }));
  });
}

export interface RevealedLocation {
  lat: number;
  lng: number;
  accuracyM: number | null;
  recordedAt: Date;
  receivedAt: Date;
}

/** Reveal the precise last-known location of a hike session (safety.sensitive; audited). */
export async function revealHikeLocation(user: SessionUser, hikeSessionId: string, reason: unknown): Promise<ActionResult<RevealedLocation | null>> {
  assertCan(user, "trips.monitor");
  assertCan(user, "safety.sensitive");
  if (!isUuid(hikeSessionId)) return fail("Hike session not found.");
  const why = typeof reason === "string" ? reason.trim().slice(0, 300) : "";
  if (why.length < 3) return fail("Give a short reason for viewing the precise location (it is recorded in the audit log).");
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [s] = await tx<{ userId: string }[]>`select user_id from public.hike_sessions where id = ${hikeSessionId}`;
      if (!s) return fail("Hike session not found.");
      const [loc] = await tx<RevealedLocation[]>`
        select lat, lng, accuracy_m, recorded_at, received_at from public.hike_last_locations where hike_session_id = ${hikeSessionId}`;
      await auditInStaffTx(tx, user, "safety.view_location", "hike_session", hikeSessionId, { customerId: s.userId, reason: why, found: !!loc });
      return ok(loc ? "Precise location shown. This access was recorded in the audit log." : "No location has been received for this hike (access recorded).", {
        data: loc ?? null,
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Staff follow-up on a check-in (note, or close it when the hiker is safe)
// ---------------------------------------------------------------------------
export const STAFF_CHECKIN_OUTCOMES = ["note_only", "hiker_confirmed_safe"] as const;

const staffFollowUpSchema = z.object({
  outcome: z.enum(STAFF_CHECKIN_OUTCOMES, "Choose what you are recording."),
  note: z
    .string("Describe what you learned and how (e.g. “Hiker called the office at 6:40 PM, back at the car”).")
    .trim()
    .min(5, "Describe what you learned and how (at least 5 characters).")
    .max(1000, "Keep the note under 1000 characters."),
});
export type StaffFollowUpInput = z.input<typeof staffFollowUpSchema>;

/**
 * Record a staff follow-up on a check-in (trips.monitor; audited). The
 * state change is the safety slice's `staffResolveCheckin` (contract B),
 * which re-checks the permission and records the checkin_events row.
 * Neither outcome contacts the hiker or emergency services; closing a
 * check-in whose contact was already notified queues the standard
 * follow-up notice to that contact.
 */
export async function recordStaffCheckinFollowUp(user: SessionUser, checkinId: string, input: StaffFollowUpInput): Promise<ActionResult> {
  assertCan(user, "trips.monitor");
  if (!isUuid(checkinId)) return fail("Check-in not found.");
  const p = staffFollowUpSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const d = p.data;
  return guarded(() =>
    // Check-ins are lifecycle tables (not writable by API roles): trusted
    // transaction after the permission check above.
    systemTx(async (tx) => {
      const [before] = await tx<{ status: string; tripId: string; contactNotifiedAt: Date | null }[]>`
        select status, trip_id, contact_notified_at from public.trip_checkins where id = ${checkinId} for update`;
      if (!before) return fail("Check-in not found.");
      const r = await staffResolveCheckin(tx, checkinId, { id: user.id, roles: user.roles }, { outcome: d.outcome, note: d.note });
      if (!r.ok) return fail(r.error);
      const resolved = d.outcome === "hiker_confirmed_safe";
      await auditInSystemTx(tx, user, resolved ? "checkin.staff_resolved" : "checkin.staff_note", "trip_checkin", checkinId, {
        tripId: before.tripId,
        outcome: d.outcome,
        fromStatus: before.status,
        noteLength: d.note.length,
      });
      if (!resolved) return ok("Note added to the check-in timeline. The check-in stays open.");
      return ok("Check-in closed: hiker confirmed safe. Scheduled reminders and notices for it were cancelled.", {
        warnings: before.contactNotifiedAt
          ? ["The hiker's contact had already been notified, so Ghost Guide queued its standard follow-up notice to that contact. Nobody else is contacted."]
          : [],
      });
    }),
  );
}

export function canSeePreciseLocation(user: SessionUser) {
  return can(user.roles, "safety.sensitive");
}

// ---------------------------------------------------------------------------
// Notification delivery log
// ---------------------------------------------------------------------------
export const NOTIFICATION_STATUSES = ["queued", "simulated", "sent", "delivered", "failed", "suppressed"] as const;
export const NOTIFICATION_CHANNELS = ["sms", "email", "push", "in_app"] as const;

export interface NotificationLogRow {
  id: string;
  createdAt: Date;
  sentAt: Date | null;
  status: (typeof NOTIFICATION_STATUSES)[number];
  channel: string;
  recipientKind: string;
  recipientMasked: string;
  template: string;
  attempts: number;
  provider: string;
  error: string | null;
  tripId: string | null;
}

export async function listNotifications(user: SessionUser, f: { status?: string; channel?: string }, page: Page): Promise<Paged<NotificationLogRow>> {
  assertCan(user, "notifications.view");
  const status = z.enum(NOTIFICATION_STATUSES).safeParse(f.status).data ?? null;
  const channel = z.enum(NOTIFICATION_CHANNELS).safeParse(f.channel).data ?? null;
  const rows = await staffTx(user, (tx) => tx<(NotificationLogRow & { total: number })[]>`
    select id, created_at, sent_at, status, channel, recipient_kind, recipient_masked, template, attempts, provider, error, trip_id,
           count(*) over()::int as total
    from public.notifications
    where (${status}::public.notification_status is null or status = ${status}::public.notification_status)
      and (${channel}::text is null or channel = ${channel}::text)
    order by created_at desc
    limit ${page.limit} offset ${page.offset}`);
  return { rows: rows.map((r) => ({ ...r, error: r.error ? redactString(r.error) : null })), total: rows[0]?.total ?? 0, ...page };
}
