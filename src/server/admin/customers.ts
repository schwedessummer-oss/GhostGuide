import "server-only";
import type { SessionUser } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import { assertCan, auditInStaffTx, fail, guarded, isUuid, likePattern, ok, staffTx, type ActionResult, type Page, type Paged } from "./common";

export interface CustomerListRow {
  id: string;
  email: string | null;
  fullName: string | null;
  createdAt: Date;
  tripCount: number;
  bookingCount: number;
  isStaff: boolean;
}

export async function searchCustomers(user: SessionUser, q: string | undefined, page: Page): Promise<Paged<CustomerListRow>> {
  assertCan(user, "customers.view");
  const term = q?.trim().slice(0, 120) || null;
  const rows = await staffTx(user, (tx) => tx<(CustomerListRow & { total: number })[]>`
    select p.id, p.email, p.full_name, p.created_at,
           (select count(*)::int from public.trips t where t.user_id = p.id) as trip_count,
           (select count(*)::int from public.bookings b where b.user_id = p.id) as booking_count,
           exists (select 1 from public.staff_roles sr where sr.user_id = p.id) as is_staff,
           count(*) over()::int as total
    from public.profiles p
    where (${term}::text is null or p.email ilike ${likePattern(term ?? "")} or p.full_name ilike ${likePattern(term ?? "")})
    order by p.created_at desc
    limit ${page.limit} offset ${page.offset}`);
  return { rows, total: rows[0]?.total ?? 0, ...page };
}

export interface CustomerDetail {
  profile: { id: string; email: string | null; fullName: string | null; phoneOnFile: boolean; units: string; marketingOptIn: boolean; createdAt: Date };
  trips: { id: string; status: string; plannedDate: string | null; partySize: number; trailName: string; createdAt: Date }[];
  bookings: { id: string; status: string; hikeDate: string; totalCents: number; refundedCents: number; currency: string; trailName: string; createdAt: Date }[];
  tickets: { id: string; subject: string; status: string; priority: string; createdAt: Date }[];
  feedback: { id: string; tripId: string; rating: number; comments: string | null; issues: string[]; createdAt: Date }[];
  activeHikes: { id: string; tripId: string; status: string; startedAt: Date; lastLocationAt: Date | null }[];
  canSeeSensitive: boolean;
}

export async function getCustomerDetail(user: SessionUser, customerId: string): Promise<CustomerDetail | null> {
  assertCan(user, "customers.view");
  if (!isUuid(customerId)) return null;
  return staffTx(user, async (tx) => {
    const [profile] = await tx<(Omit<CustomerDetail["profile"], "phoneOnFile"> & { phoneOnFile: boolean })[]>`
      select id, email, full_name, coalesce(public.profile_has_phone(id), false) as phone_on_file, units, marketing_opt_in, created_at
      from public.profiles where id = ${customerId}`;
    if (!profile) return null;
    const [trips, bookings, tickets, feedback, activeHikes] = await Promise.all([
      tx<CustomerDetail["trips"]>`
        select tr.id, tr.status, to_char(tr.planned_date, 'YYYY-MM-DD') as planned_date, tr.party_size, t.name as trail_name, tr.created_at
        from public.trips tr join public.trails t on t.id = tr.trail_id where tr.user_id = ${customerId} order by tr.created_at desc limit 50`,
      tx<CustomerDetail["bookings"]>`
        select b.id, b.status, to_char(b.hike_date, 'YYYY-MM-DD') as hike_date, b.total_cents, b.refunded_cents, b.currency, t.name as trail_name, b.created_at
        from public.bookings b join public.trails t on t.id = b.trail_id where b.user_id = ${customerId} order by b.created_at desc limit 50`,
      tx<CustomerDetail["tickets"]>`
        select id, subject, status, priority, created_at from public.support_tickets where user_id = ${customerId} order by created_at desc limit 50`,
      tx<CustomerDetail["feedback"]>`
        select id, trip_id, rating, comments, issues, created_at from public.trip_feedback where user_id = ${customerId} order by created_at desc limit 50`,
      tx<CustomerDetail["activeHikes"]>`
        select id, trip_id, status, started_at, last_location_at from public.hike_sessions
        where user_id = ${customerId} and status in ('active', 'paused') order by started_at desc`,
    ]);
    return { profile, trips, bookings, tickets, feedback, activeHikes, canSeeSensitive: can(user.roles, "safety.sensitive") };
  });
}

export interface CustomerSensitive {
  contacts: { name: string; phone: string | null; email: string | null; relationship: string | null; consentConfirmedAt: Date | null }[];
  locations: { hikeSessionId: string; lat: number; lng: number; accuracyM: number | null; recordedAt: Date }[];
  phone: string | null;
}

/**
 * Reveal emergency contacts, the customer's phone and last-known precise
 * locations. Requires safety.sensitive (admin/safety); RLS enforces the same.
 * Every reveal writes an audit entry.
 */
export async function revealCustomerSensitive(user: SessionUser, customerId: string, reason: unknown): Promise<ActionResult<CustomerSensitive>> {
  assertCan(user, "customers.view");
  assertCan(user, "safety.sensitive");
  if (!isUuid(customerId)) return fail("Customer not found.");
  const why = typeof reason === "string" ? reason.trim().slice(0, 300) : "";
  if (why.length < 3) return fail("Give a short reason for viewing restricted details (it is recorded in the audit log).");
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [profile] = await tx<{ phone: string | null }[]>`select public.profile_phone(id) as phone from public.profiles where id = ${customerId}`;
      if (!profile) return fail("Customer not found.");
      const contacts = await tx<CustomerSensitive["contacts"]>`
        select name, phone, email, relationship, consent_confirmed_at from public.emergency_contacts where user_id = ${customerId} order by created_at`;
      const locations = await tx<CustomerSensitive["locations"]>`
        select l.hike_session_id, l.lat, l.lng, l.accuracy_m, l.recorded_at
        from public.hike_last_locations l join public.hike_sessions s on s.id = l.hike_session_id
        where l.user_id = ${customerId} and s.status in ('active', 'paused')`;
      await auditInStaffTx(tx, user, "customer.view_emergency_contacts", "user", customerId, { reason: why, contactCount: contacts.length });
      if (locations.length) {
        await auditInStaffTx(tx, user, "safety.view_location", "user", customerId, { reason: why, sessions: locations.map((l) => l.hikeSessionId) });
      }
      return ok("Restricted details shown. This access was recorded in the audit log.", { data: { contacts, locations, phone: profile.phone } });
    }),
  );
}
