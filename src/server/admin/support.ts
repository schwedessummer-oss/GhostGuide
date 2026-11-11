import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import { assertCan, auditInStaffTx, fail, guarded, isUuid, staffTx, systemTx, ok, type ActionResult, type Page, type Paged } from "./common";

export const TICKET_STATUSES = ["open", "pending", "resolved"] as const;
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export interface TicketRow {
  id: string;
  subject: string;
  body: string;
  status: (typeof TICKET_STATUSES)[number];
  priority: (typeof TICKET_PRIORITIES)[number];
  userId: string | null;
  customerEmail: string | null;
  tripId: string | null;
  bookingId: string | null;
  assignedTo: string | null;
  assigneeEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Group filters (the overview's "high-priority tickets" card links to exactly these). */
export const TICKET_STATUS_GROUPS = { unresolved: ["open", "pending"] } as const satisfies Record<string, readonly (typeof TICKET_STATUSES)[number][]>;
export const TICKET_PRIORITY_GROUPS = { high_or_urgent: ["high", "urgent"] } as const satisfies Record<string, readonly (typeof TICKET_PRIORITIES)[number][]>;
export const TICKET_STATUS_FILTERS = [...TICKET_STATUSES.map((s) => ({ value: s, label: s })), { value: "unresolved", label: "open or pending" }];
export const TICKET_PRIORITY_FILTERS = [...TICKET_PRIORITIES.map((p) => ({ value: p, label: p })), { value: "high_or_urgent", label: "high or urgent" }];
export const HIGH_PRIORITY_QUEUE_HREF = "/admin/support?status=unresolved&priority=high_or_urgent";

function filterValues<V extends string>(value: string | undefined, single: readonly V[], groups: Record<string, readonly V[]>): V[] | null {
  if (!value) return null;
  if ((single as readonly string[]).includes(value)) return [value as V];
  return Object.hasOwn(groups, value) ? [...groups[value]] : null;
}

export async function listTickets(user: SessionUser, f: { status?: string; priority?: string; assigned?: string }, page: Page): Promise<Paged<TicketRow>> {
  assertCan(user, "support.manage");
  const status = filterValues(f.status, TICKET_STATUSES, TICKET_STATUS_GROUPS);
  const priority = filterValues(f.priority, TICKET_PRIORITIES, TICKET_PRIORITY_GROUPS);
  const assigned = f.assigned === "me" ? user.id : f.assigned === "unassigned" ? "unassigned" : f.assigned && isUuid(f.assigned) ? f.assigned : null;
  const assignee = assigned && assigned !== "unassigned" ? assigned : null;
  const rows = await staffTx(user, (tx) => tx<(TicketRow & { total: number })[]>`
    select st.id, st.subject, st.body, st.status, st.priority, st.user_id, cp.email as customer_email, st.trip_id, st.booking_id,
           st.assigned_to, ap.email as assignee_email, st.created_at, st.updated_at, count(*) over()::int as total
    from public.support_tickets st
    left join public.profiles cp on cp.id = st.user_id
    left join public.profiles ap on ap.id = st.assigned_to
    where (${status}::text[] is null or st.status = any(${status}::text[]))
      and (${priority}::text[] is null or st.priority = any(${priority}::text[]))
      and (${assigned === "unassigned"}::boolean is false or st.assigned_to is null)
      and (${assignee}::uuid is null or st.assigned_to = ${assignee}::uuid)
    order by case st.status when 'open' then 0 when 'pending' then 1 else 2 end,
             case st.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, st.created_at
    limit ${page.limit} offset ${page.offset}`);
  return { rows, total: rows[0]?.total ?? 0, ...page };
}

export interface AssignableStaff {
  id: string;
  label: string;
}

/** Staff who can work tickets (staff_roles is admin-readable only, so this list is read as trusted code). */
export async function listAssignableStaff(user: SessionUser): Promise<AssignableStaff[]> {
  assertCan(user, "support.manage");
  const rows = await systemTx((tx) => tx<{ id: string; fullName: string | null; email: string | null; roles: string[] }[]>`
    select p.id, p.full_name, p.email, array_agg(sr.role::text order by sr.role) as roles
    from public.staff_roles sr join public.profiles p on p.id = sr.user_id
    group by p.id, p.full_name, p.email order by p.full_name nulls last`);
  return rows
    .filter((r) => can(r.roles, "support.manage"))
    .map((r) => ({ id: r.id, label: `${r.fullName ?? r.email ?? "Staff member"} (${r.roles.join(", ")})` }));
}

const updateSchema = z.object({
  status: z.enum(TICKET_STATUSES),
  priority: z.enum(TICKET_PRIORITIES),
  assignedTo: z.union([z.uuid(), z.literal("")]).transform((v) => (v === "" ? null : v)),
});

export async function updateTicket(user: SessionUser, ticketId: string, input: z.input<typeof updateSchema>): Promise<ActionResult> {
  assertCan(user, "support.manage");
  if (!isUuid(ticketId)) return fail("Ticket not found.");
  const p = updateSchema.safeParse(input);
  if (!p.success) return fail(p.error.issues[0].message);
  const d = p.data;
  if (d.assignedTo) {
    const staff = await listAssignableStaff(user);
    if (!staff.some((s) => s.id === d.assignedTo)) return fail("Tickets can only be assigned to staff who handle support.");
  }
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [before] = await tx<{ status: string; priority: string; assignedTo: string | null }[]>`
        select status, priority, assigned_to from public.support_tickets where id = ${ticketId} for update`;
      if (!before) return fail("Ticket not found.");
      await tx`update public.support_tickets set status = ${d.status}, priority = ${d.priority}, assigned_to = ${d.assignedTo} where id = ${ticketId}`;
      await auditInStaffTx(tx, user, "support.ticket_updated", "support_ticket", ticketId, { before, after: d });
      return ok("Ticket updated.");
    }),
  );
}
