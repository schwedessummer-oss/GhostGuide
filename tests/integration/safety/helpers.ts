import { sql, withSystem } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import type { Job } from "@/server/jobs/queue";
import { safetyHandlers } from "@/server/jobs/handlers/safety";
import { createContact } from "@/server/account/contacts";
import { setupCheckin } from "@/server/checkins/manage";
import { toLocalInputValue } from "@/domain/checkin";
import { localDateInZone } from "@/lib/time";
import { trailBySlug } from "../../helpers/db";

export const TZ = "America/Los_Angeles";
export const MIN = 60_000;
export const addMin = (d: Date, n: number) => new Date(d.getTime() + n * MIN);

/** A booked trip (status written as trusted code, like the commerce webhook would). */
export async function bookedTrip(user: SessionUser, opts: { status?: "booked" | "active" | "saved"; trail?: string } = {}) {
  const trail = await trailBySlug(opts.trail ?? "lantern-creek-loop");
  const plannedDate = localDateInZone(new Date(), TZ);
  const [trip] = await withSystem(
    (tx) => tx<{ id: string }[]>`
      insert into public.trips (user_id, region_id, trail_id, status, planned_date, start_time, party_size, itinerary)
      values (${user.id}, ${trail.regionId}, ${trail.id}, ${opts.status ?? "booked"}, ${plannedDate}::date, '09:00'::time, 1,
              ${tx.json({ version: 1, plannedDate, startTime: "09:00", estimatedFinishTime: "11:00", estimatedDurationMin: 120 })})
      returning id`,
  );
  return { id: trip.id, trailId: trail.id };
}

export async function setFullName(user: SessionUser, name: string) {
  await withSystem((tx) => tx`update public.profiles set full_name = ${name} where id = ${user.id}`);
}

export async function consentedContact(user: SessionUser, over: Record<string, unknown> = {}) {
  const r = await createContact(user, { name: "Casey Contact", phone: "+1 555 555 0123", email: "casey@example.com", relationship: "Friend", consent: true, ...over });
  if (!r.ok) throw new Error(r.error);
  return r.id;
}

/** Opt in with an expected return `minutesAhead` from `now`. */
export async function optIn(
  user: SessionUser,
  tripId: string,
  contactId: string,
  opts: { now?: Date; minutesAhead?: number; graceMinutes?: number; reminders?: number[] } = {},
) {
  const now = opts.now ?? new Date();
  const res = await setupCheckin(
    user,
    tripId,
    {
      contactId,
      expectedReturnLocal: toLocalInputValue(addMin(now, opts.minutesAhead ?? 180), TZ),
      graceMinutes: opts.graceMinutes ?? 30,
      reminderOffsetsMin: opts.reminders ?? [60, 15],
    },
    now,
  );
  if (!res.ok) throw new Error(res.error);
  const [c] = await sql()<{ id: string; version: number; status: string; expectedReturnAt: Date; graceMinutes: number }[]>`
    select id, version, status, expected_return_at, grace_minutes from public.trip_checkins where trip_id = ${tripId}`;
  return c;
}

export async function checkinRow(tripId: string) {
  const [c] = await sql()<
    {
      id: string;
      version: number;
      status: string;
      expectedReturnAt: Date;
      graceMinutes: number;
      lastOkAt: Date | null;
      overdueAt: Date | null;
      contactNotifiedAt: Date | null;
      completedAt: Date | null;
    }[]
  >`select id, version, status, expected_return_at, grace_minutes, last_ok_at, overdue_at, contact_notified_at, completed_at
    from public.trip_checkins where trip_id = ${tripId}`;
  return c;
}

export async function jobsFor(checkinId: string) {
  return sql()<{ id: number; kind: string; status: string; dedupKey: string; runAt: Date; payload: Record<string, unknown> }[]>`
    select id, kind, status, dedup_key, run_at, payload from public.jobs where dedup_key like ${`checkin:${checkinId}:%`} order by id`;
}

export async function notificationsFor(checkinId: string) {
  return sql()<
    {
      id: string;
      channel: string;
      recipientKind: string;
      recipientRef: string;
      recipientMasked: string;
      template: string;
      body: string;
      status: string;
      provider: string;
      error: string | null;
      dedupKey: string;
      checkinVersion: number;
      attempts: number;
    }[]
  >`select id, channel, recipient_kind, recipient_ref, recipient_masked, template, body, status, provider, error, dedup_key, checkin_version, attempts
    from public.notifications where checkin_id = ${checkinId} order by created_at, id`;
}

/**
 * Run this check-in's due jobs (and the notification sends they create)
 * as the job runner would, but with a controllable clock. Isolated from
 * other tests' jobs. Failures re-queue (or dead-letter) like the real queue.
 */
export async function runCheckinJobs(checkinId: string, now: Date, opts: { kinds?: string[] } = {}) {
  const summary = { ran: 0, noop: 0, failed: 0, errors: [] as string[] };
  for (let round = 0; round < 10; round++) {
    const jobs = await sql()<Job[]>`
      update public.jobs j set status = 'running', locked_at = now(), attempts = j.attempts + 1
      where j.id in (
        select id from public.jobs
        where status = 'queued' and run_at <= ${now}::timestamptz
          and (${opts.kinds ?? null}::text[] is null or kind = any(${opts.kinds ?? null}::text[]))
          and (dedup_key like ${`checkin:${checkinId}:%`}
               or (kind = 'notifications.send' and payload ->> 'notificationId' in (
                     select id::text from public.notifications where checkin_id = ${checkinId})))
        order by run_at, id
        for update skip locked)
      returning j.*`;
    if (!jobs.length) break;
    for (const job of jobs) {
      summary.ran++;
      try {
        const out = await safetyHandlers[job.kind](job, { now });
        if (out?.outcome === "noop") summary.noop++;
        await sql()`update public.jobs set status = 'succeeded', finished_at = now(), last_error = ${out?.note ?? null} where id = ${job.id}`;
      } catch (err) {
        summary.failed++;
        summary.errors.push(err instanceof Error ? err.message : String(err));
        const dead = job.attempts >= job.maxAttempts;
        await sql()`update public.jobs set status = ${dead ? "dead" : "queued"}, run_at = now() + interval '1 hour', last_error = ${String(err)} where id = ${job.id}`;
      }
    }
  }
  return summary;
}

export async function addLastLocation(user: SessionUser, tripId: string, fix: { lat: number; lng: number; accuracyM: number; recordedAt: Date }) {
  return withSystem(async (tx) => {
    const [existing] = await tx<{ id: string }[]>`select id from public.hike_sessions where trip_id = ${tripId} and status in ('active', 'paused')`;
    const sessionId =
      existing?.id ??
      (await tx<{ id: string }[]>`insert into public.hike_sessions (trip_id, user_id, status) values (${tripId}, ${user.id}, 'active') returning id`)[0].id;
    await tx`
      insert into public.hike_last_locations (hike_session_id, user_id, lat, lng, accuracy_m, recorded_at)
      values (${sessionId}, ${user.id}, ${fix.lat}, ${fix.lng}, ${fix.accuracyM}, ${fix.recordedAt}::timestamptz)
      on conflict (hike_session_id) do update set lat = excluded.lat, lng = excluded.lng, accuracy_m = excluded.accuracy_m, recorded_at = excluded.recorded_at`;
    return sessionId;
  });
}
