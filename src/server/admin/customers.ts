import "server-only";
import type { SessionUser } from "@/server/auth";
import { assertCan, isUuid, likePattern, staffTx, type Page, type Paged } from "./common";

export interface CustomerListRow {
  id: string;
  email: string | null;
  fullName: string | null;
  createdAt: Date;
  isStaff: boolean;
}

export async function searchCustomers(user: SessionUser, q: string | undefined, page: Page): Promise<Paged<CustomerListRow>> {
  assertCan(user, "customers.view");
  const term = q?.trim().slice(0, 120) || null;
  const rows = await staffTx(user, (tx) => tx<(CustomerListRow & { total: number })[]>`
    select p.id, p.email, p.full_name, p.created_at,
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
  tickets: { id: string; subject: string; status: string; priority: string; createdAt: Date }[];
}

export async function getCustomerDetail(user: SessionUser, customerId: string): Promise<CustomerDetail | null> {
  assertCan(user, "customers.view");
  if (!isUuid(customerId)) return null;
  return staffTx(user, async (tx) => {
    const [profile] = await tx<CustomerDetail["profile"][]>`
      select id, email, full_name, units, marketing_opt_in, created_at from public.profiles where id = ${customerId}`;
    if (!profile) return null;
    const tickets = await tx<CustomerDetail["tickets"]>`
      select id, subject, status, priority, created_at from public.support_tickets where user_id = ${customerId} order by created_at desc limit 50`;
    return { profile, tickets };
  });
}
