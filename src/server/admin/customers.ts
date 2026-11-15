import "server-only";
import type { SessionUser } from "@/server/auth";
import { assertCan, isUuid, likePattern, staffTx, type Page, type Paged } from "./common";

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
  profile: { id: string; email: string | null; fullName: string | null; units: string; marketingOptIn: boolean; createdAt: Date };
  trips: { id: string; status: string; plannedDate: string | null; partySize: number; trailName: string; createdAt: Date }[];
  bookings: { id: string; status: string; hikeDate: string; totalCents: number; refundedCents: number; currency: string; trailName: string; createdAt: Date }[];
  tickets: { id: string; subject: string; status: string; priority: string; createdAt: Date }[];
}

export async function getCustomerDetail(user: SessionUser, customerId: string): Promise<CustomerDetail | null> {
  assertCan(user, "customers.view");
  if (!isUuid(customerId)) return null;
  return staffTx(user, async (tx) => {
    const [profile] = await tx<CustomerDetail["profile"][]>`
      select id, email, full_name, units, marketing_opt_in, created_at from public.profiles where id = ${customerId}`;
    if (!profile) return null;
    const [trips, bookings, tickets] = await Promise.all([
      tx<CustomerDetail["trips"]>`
        select tr.id, tr.status, to_char(tr.planned_date, 'YYYY-MM-DD') as planned_date, tr.party_size, t.name as trail_name, tr.created_at
        from public.trips tr join public.trails t on t.id = tr.trail_id where tr.user_id = ${customerId} order by tr.created_at desc limit 50`,
      tx<CustomerDetail["bookings"]>`
        select b.id, b.status, to_char(b.hike_date, 'YYYY-MM-DD') as hike_date, b.total_cents, b.refunded_cents, b.currency, t.name as trail_name, b.created_at
        from public.bookings b join public.trails t on t.id = b.trail_id where b.user_id = ${customerId} order by b.created_at desc limit 50`,
      tx<CustomerDetail["tickets"]>`
        select id, subject, status, priority, created_at from public.support_tickets where user_id = ${customerId} order by created_at desc limit 50`,
    ]);
    return { profile, trips, bookings, tickets };
  });
}
