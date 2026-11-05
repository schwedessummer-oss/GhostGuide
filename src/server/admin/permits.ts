import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import { env } from "@/config/env";
import type { Tx } from "@/server/db";
import { localDateInZone } from "@/lib/time";
import { formatDate } from "@/lib/format";
import { enqueueJob } from "@/server/jobs/queue";
import {
  assertCan,
  auditInStaffTx,
  auditInSystemTx,
  fail,
  guarded,
  hasRole,
  httpsUrl,
  isUuid,
  isoDate,
  ok,
  optionalText,
  requiredText,
  staffTx,
  systemTx,
  zodFail,
  type ActionResult,
} from "./common";

/**
 * Permits: official links, requirements, status tracking and reminders.
 * Ghost Guide never buys permits for customers and never automates permit
 * queues, lotteries or CAPTCHAs.
 */
export const TRIP_PERMIT_STATUSES = ["not_started", "applied", "obtained", "denied", "not_required"] as const;
export type TripPermitStatus = (typeof TRIP_PERMIT_STATUSES)[number];
export const PERMIT_REMINDER_DEFAULT_DAYS = 7;

export interface PermitRequirementRow {
  id: string;
  trailId: string;
  trailName: string;
  name: string;
  authority: string;
  officialUrl: string;
  requirementSummary: string;
  howToObtain: string;
  leadTimeDays: number | null;
  sourceId: string | null;
  sourceLabel: string | null;
  verifiedAt: Date | null;
}

export async function listPermitRequirements(user: SessionUser, trailId?: string): Promise<PermitRequirementRow[]> {
  assertCan(user, "permits.manage");
  const tid = trailId && isUuid(trailId) ? trailId : null;
  if (trailId && !tid) return [];
  return staffTx(user, (tx) => tx<PermitRequirementRow[]>`
    select pr.id, pr.trail_id, t.name as trail_name, pr.name, pr.authority, pr.official_url, pr.requirement_summary, pr.how_to_obtain,
           pr.lead_time_days, pr.source_id, s.label as source_label, pr.verified_at
    from public.permit_requirements pr join public.trails t on t.id = pr.trail_id left join public.sources s on s.id = pr.source_id
    where (${tid}::uuid is null or pr.trail_id = ${tid}::uuid)
    order by t.name, pr.name`);
}

const requirementSchema = z.object({
  name: requiredText(3, 200, "Name"),
  authority: requiredText(2, 200, "Issuing authority"),
  officialUrl: httpsUrl,
  requirementSummary: requiredText(5, 2000, "Requirement summary"),
  howToObtain: z.string().trim().max(4000).default(""),
  leadTimeDays: z.union([z.coerce.number().int().min(0).max(365), z.literal("")]).transform((v) => (v === "" ? null : v)),
  sourceId: z.union([z.uuid(), z.literal("")]).transform((v) => (v === "" ? null : v)),
  verifiedAt: z.union([isoDate, z.literal("")]).transform((v) => (v === "" ? null : v)),
});
export type PermitRequirementInput = z.input<typeof requirementSchema>;

const ts = (d: string | null) => (d ? `${d}T12:00:00Z` : null);

export async function createPermitRequirement(user: SessionUser, trailId: string, input: PermitRequirementInput): Promise<ActionResult<{ id: string }>> {
  assertCan(user, "permits.manage");
  if (!isUuid(trailId)) return fail("Trail not found.");
  const p = requirementSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const d = p.data;
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [t] = await tx`select 1 from public.trails where id = ${trailId}`;
      if (!t) return fail("Trail not found.");
      const [row] = await tx<{ id: string }[]>`
        insert into public.permit_requirements (trail_id, name, authority, official_url, requirement_summary, how_to_obtain, lead_time_days, source_id, verified_at)
        values (${trailId}, ${d.name}, ${d.authority}, ${d.officialUrl}, ${d.requirementSummary}, ${d.howToObtain}, ${d.leadTimeDays},
                ${d.sourceId}, ${ts(d.verifiedAt)}::timestamptz)
        returning id`;
      await auditInStaffTx(tx, user, "permit_requirement.created", "trail", trailId, { permitRequirementId: row.id, name: d.name });
      return ok("Permit requirement added. Remember to mark the trail fact “Permit required” if it applies to everyone.", { data: { id: row.id } });
    }),
  );
}

export async function updatePermitRequirement(user: SessionUser, requirementId: string, input: PermitRequirementInput): Promise<ActionResult> {
  assertCan(user, "permits.manage");
  if (!isUuid(requirementId)) return fail("Permit requirement not found.");
  const p = requirementSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const d = p.data;
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [row] = await tx<{ trailId: string }[]>`
        update public.permit_requirements set name = ${d.name}, authority = ${d.authority}, official_url = ${d.officialUrl},
          requirement_summary = ${d.requirementSummary}, how_to_obtain = ${d.howToObtain}, lead_time_days = ${d.leadTimeDays},
          source_id = ${d.sourceId}, verified_at = ${ts(d.verifiedAt)}::timestamptz
        where id = ${requirementId} returning trail_id`;
      if (!row) return fail("Permit requirement not found.");
      await auditInStaffTx(tx, user, "permit_requirement.updated", "trail", row.trailId, { permitRequirementId: requirementId, name: d.name });
      return ok("Permit requirement saved.");
    }),
  );
}

export async function deletePermitRequirement(user: SessionUser, requirementId: string): Promise<ActionResult> {
  assertCan(user, "permits.manage");
  if (!isUuid(requirementId)) return fail("Permit requirement not found.");
  // trip_permits are not readable by every permits.manage role; count them as trusted code.
  const [{ n }] = await systemTx((tx) => tx<{ n: number }[]>`select count(*)::int as n from public.trip_permits where permit_requirement_id = ${requirementId}`);
  if (n > 0) return fail(`${n} trip(s) track this permit. Edit the requirement instead of deleting it.`);
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [row] = await tx<{ trailId: string; name: string }[]>`delete from public.permit_requirements where id = ${requirementId} returning trail_id, name`;
      if (!row) return fail("Permit requirement not found.");
      await auditInStaffTx(tx, user, "permit_requirement.deleted", "trail", row.trailId, { permitRequirementId: requirementId, name: row.name });
      return ok("Permit requirement deleted.");
    }),
  );
}

// ---------------------------------------------------------------------------
// Trip permit tracking (customer support)
// ---------------------------------------------------------------------------
/** Trip permit tracking is shown to roles that may also read trips (RLS: admin/operator/support). */
export function canTrackTripPermits(user: SessionUser): boolean {
  return hasRole(user, "admin", "operator");
}

export interface TripPermitRow {
  tripId: string;
  tripStatus: string;
  plannedDate: string | null;
  partySize: number;
  trailName: string;
  customerEmail: string | null;
  permitRequirementId: string;
  permitName: string;
  officialUrl: string;
  leadTimeDays: number | null;
  tripPermitId: string | null;
  status: TripPermitStatus;
  confirmationRef: string | null;
  notes: string | null;
  updatedAt: Date | null;
}

export async function listUpcomingTripPermits(user: SessionUser, opts: { status?: string; days?: number } = {}): Promise<TripPermitRow[]> {
  assertCan(user, "permits.manage");
  if (!canTrackTripPermits(user)) return [];
  const status = z.enum(TRIP_PERMIT_STATUSES).safeParse(opts.status).data ?? null;
  const days = Math.min(Math.max(opts.days ?? 60, 1), 365);
  return staffTx(user, (tx) => tx<TripPermitRow[]>`
    select tr.id as trip_id, tr.status as trip_status, to_char(tr.planned_date, 'YYYY-MM-DD') as planned_date, tr.party_size,
           t.name as trail_name, p.email as customer_email, pr.id as permit_requirement_id, pr.name as permit_name, pr.official_url,
           pr.lead_time_days, tp.id as trip_permit_id, coalesce(tp.status, 'not_started') as status, tp.confirmation_ref, tp.notes, tp.updated_at
    from public.trips tr
    join public.trails t on t.id = tr.trail_id
    join public.permit_requirements pr on pr.trail_id = tr.trail_id
    left join public.trip_permits tp on tp.trip_id = tr.id and tp.permit_requirement_id = pr.id
    left join public.profiles p on p.id = tr.user_id
    where tr.status in ('booked', 'saved', 'active') and tr.planned_date is not null
      and tr.planned_date >= current_date - 1 and tr.planned_date <= current_date + ${days}::int
      and (${status}::text is null or coalesce(tp.status, 'not_started') = ${status}::text)
    order by tr.planned_date, t.name`);
}

const tripPermitSchema = z.object({
  status: z.enum(TRIP_PERMIT_STATUSES),
  confirmationRef: optionalText(120),
  notes: optionalText(2000),
});

/**
 * Staff update a trip's permit status for customer support (e.g. the
 * customer emailed their confirmation). trip_permits has no staff write
 * policy, so this runs as trusted code after the permission check.
 */
export async function updateTripPermit(
  user: SessionUser,
  tripId: string,
  permitRequirementId: string,
  input: z.input<typeof tripPermitSchema>,
): Promise<ActionResult> {
  assertCan(user, "permits.manage");
  if (!canTrackTripPermits(user)) return fail("Your role can manage permit requirements but not customers' trip permits.");
  if (!isUuid(tripId) || !isUuid(permitRequirementId)) return fail("Trip permit not found.");
  const p = tripPermitSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const d = p.data;
  return guarded(() =>
    systemTx(async (tx) => {
      const [match] = await tx`
        select 1 from public.trips tr join public.permit_requirements pr on pr.trail_id = tr.trail_id
        where tr.id = ${tripId} and pr.id = ${permitRequirementId}`;
      if (!match) return fail("Trip permit not found.");
      const [before] = await tx<{ status: string }[]>`
        select status from public.trip_permits where trip_id = ${tripId} and permit_requirement_id = ${permitRequirementId} for update`;
      await tx`
        insert into public.trip_permits (trip_id, permit_requirement_id, status, confirmation_ref, notes)
        values (${tripId}, ${permitRequirementId}, ${d.status}, ${d.confirmationRef}, ${d.notes})
        on conflict (trip_id, permit_requirement_id) do update
          set status = excluded.status, confirmation_ref = excluded.confirmation_ref, notes = excluded.notes`;
      await auditInSystemTx(tx, user, "trip_permit.staff_updated", "trip", tripId, {
        permitRequirementId,
        from: before?.status ?? "not_started",
        to: d.status,
      });
      return ok(`Permit status set to ${d.status.replace("_", " ")}.`);
    }),
  );
}

// ---------------------------------------------------------------------------
// Reminder job (ops handler 'permits.remind')
// ---------------------------------------------------------------------------
export const PERMIT_REMIND_JOB = "permits.remind";

/** Dedup key for one daily permit-reminder run (shared with periodic scheduling). */
export function permitRemindRunKey(day: string) {
  return `periodic:${PERMIT_REMIND_JOB}:${day}`;
}

export function permitReminderDedupKey(tripId: string, permitRequirementId: string, day: string) {
  return `permit-remind:${tripId}:${permitRequirementId}:${day}`;
}

export function permitReminderBody(p: { trailName: string; plannedDate: string; permitName: string; authority: string; officialUrl: string; daysLeft: number }) {
  const when = p.daysLeft <= 0 ? "today" : p.daysLeft === 1 ? "tomorrow" : `in ${p.daysLeft} days`;
  return (
    `Reminder: your ${p.trailName} hike on ${formatDate(p.plannedDate)} (${when}) requires "${p.permitName}" from ${p.authority}, ` +
    `and we have not recorded it as obtained. Apply or check your status on the official site: ${p.officialUrl}. ` +
    `Ghost Guide does not obtain permits for you. If you already have it, update the permit status on your trip page.`
  );
}

export interface PermitReminderSummary {
  candidates: number;
  created: number;
}

/**
 * Create in-app reminders for upcoming booked trips whose required permit is
 * not yet obtained, within each requirement's reminder window
 * (max(lead time, default days) before the hike). Idempotent per
 * trip/permit/day via the notification dedup key.
 */
export async function runPermitReminders(tx: Tx, now: Date = new Date(), defaultDays = PERMIT_REMINDER_DEFAULT_DAYS): Promise<PermitReminderSummary> {
  const rows = await tx<
    { tripId: string; userId: string; plannedDate: string; trailName: string; timezone: string; permitRequirementId: string; permitName: string; authority: string; officialUrl: string; leadTimeDays: number | null }[]
  >`
    select tr.id as trip_id, tr.user_id, to_char(tr.planned_date, 'YYYY-MM-DD') as planned_date, t.name as trail_name, r.timezone,
           pr.id as permit_requirement_id, pr.name as permit_name, pr.authority, pr.official_url, pr.lead_time_days
    from public.trips tr
    join public.trails t on t.id = tr.trail_id
    join public.regions r on r.id = tr.region_id
    join public.permit_requirements pr on pr.trail_id = tr.trail_id
    left join public.trip_permits tp on tp.trip_id = tr.id and tp.permit_requirement_id = pr.id
    where tr.status = 'booked' and tr.planned_date is not null
      and tr.planned_date between (${now}::timestamptz)::date - 1 and (${now}::timestamptz)::date + 400
      and coalesce(tp.status, 'not_started') in ('not_started', 'applied', 'denied')`;
  const simulated = env().APP_MODE === "demo";
  let candidates = 0;
  let created = 0;
  for (const row of rows) {
    const today = localDateInZone(now, row.timezone);
    const daysLeft = Math.round((Date.parse(`${row.plannedDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    const window = Math.max(row.leadTimeDays ?? 0, defaultDays);
    if (daysLeft < 0 || daysLeft > window) continue;
    candidates++;
    const inserted = await tx`
      insert into public.notifications (user_id, trip_id, channel, recipient_kind, recipient_masked, template, body, status, provider, dedup_key, attempts, sent_at)
      values (${row.userId}, ${row.tripId}, 'in_app', 'user', 'In-app (your account)', 'permit_reminder',
              ${permitReminderBody({ ...row, daysLeft })}, ${simulated ? "simulated" : "delivered"}, ${simulated ? "demo" : "in_app"},
              ${permitReminderDedupKey(row.tripId, row.permitRequirementId, today)}, 1, now())
      on conflict (dedup_key) do nothing
      returning id`;
    if (inserted.length) created++;
  }
  return { candidates, created };
}

/** Staff: queue a permit-reminder run now (deduplicated per day). */
export async function queuePermitReminders(user: SessionUser): Promise<ActionResult> {
  assertCan(user, "permits.manage");
  return guarded(() =>
    systemTx(async (tx) => {
      const day = new Date().toISOString().slice(0, 10);
      const r = await enqueueJob(tx, PERMIT_REMIND_JOB, { requestedBy: user.id }, { dedupKey: `${PERMIT_REMIND_JOB}:manual:${day}:${new Date().getUTCHours()}`, maxAttempts: 3 });
      await auditInSystemTx(tx, user, "permits.remind_queued", "job", r.id ? String(r.id) : null, { deduped: r.deduped });
      return ok(r.deduped ? "A reminder run was already queued this hour." : "Permit reminder run queued. It runs with the next job tick.");
    }),
  );
}
