import Link from "next/link";
import type { Metadata } from "next";
import { Card } from "@/components/ui";
import { AdminHeader, StatusBadge, When } from "@/components/admin/admin-ui";
import { FilterBar, Pagination } from "@/components/admin/data-table";
import { ActionForm } from "@/components/admin/action-form";
import { SelectField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import { listAssignableStaff, listTickets, TICKET_PRIORITIES, TICKET_PRIORITY_FILTERS, TICKET_STATUS_FILTERS, TICKET_STATUSES } from "@/server/admin/support";
import { parsePage, sp } from "@/server/admin/common";
import { updateTicketAction } from "./actions";

export const metadata: Metadata = { title: "Support" };

export default async function SupportPage({ searchParams }: PageProps<"/admin/support">) {
  const user = await requirePermission("support.manage", "/admin/support");
  const q = await searchParams;
  const filters = { status: sp(q.status), priority: sp(q.priority), assigned: sp(q.assigned) };
  const page = parsePage({ limit: sp(q.limit), offset: sp(q.offset) });
  const [data, staff] = await Promise.all([listTickets(user, filters, page), listAssignableStaff(user)]);
  const canCustomers = can(user.roles, "customers.view");
  const canBookings = can(user.roles, "bookings.view");

  return (
    <>
      <AdminHeader title="Support tickets" description="Open tickets first, by priority. Ticket text is customer-written and shown as plain text." />
      <FilterBar action="/admin/support" resetHref="/admin/support">
        <SelectField id="st-status" name="status" label="Status" options={TICKET_STATUS_FILTERS} placeholder="Any status" defaultValue={filters.status ?? ""} />
        <SelectField id="st-priority" name="priority" label="Priority" options={TICKET_PRIORITY_FILTERS} placeholder="Any priority" defaultValue={filters.priority ?? ""} />
        <SelectField
          id="st-assigned"
          name="assigned"
          label="Assigned"
          options={[{ value: "me", label: "Assigned to me" }, { value: "unassigned", label: "Unassigned" }, ...staff.map((s) => ({ value: s.id, label: s.label }))]}
          placeholder="Anyone"
          defaultValue={filters.assigned ?? ""}
        />
      </FilterBar>
      <h2 className="sr-only">Tickets</h2>
      {data.rows.length ? (
        <ul className="space-y-3">
          {data.rows.map((t) => (
            <li key={t.id}>
              <Card className="p-4 sm:p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">{t.subject}</h3>
                  <StatusBadge status={t.status} />
                  <StatusBadge status={t.priority} label={`${t.priority} priority`} />
                </div>
                <p className="mt-1 text-sm text-muted">
                  {t.customerEmail ? (
                    canCustomers && t.userId ? (
                      <Link className="underline" href={`/admin/customers/${t.userId}`}>
                        {t.customerEmail}
                      </Link>
                    ) : (
                      t.customerEmail
                    )
                  ) : (
                    "Unknown customer"
                  )}{" "}
                  · opened <When at={t.createdAt} /> · {t.assigneeEmail ? `assigned to ${t.assigneeEmail}` : "unassigned"}
                  {t.bookingId && canBookings ? (
                    <>
                      {" "}
                      ·{" "}
                      <Link className="underline" href={`/admin/bookings/${t.bookingId}`}>
                        booking
                      </Link>
                    </>
                  ) : null}
                </p>
                <p className="mt-2 whitespace-pre-wrap break-words">{t.body}</p>
                <ActionForm action={updateTicketAction.bind(null, t.id)} submitLabel="Update ticket" compact inline className="mt-3">
                  <SelectField id={`tk-${t.id}-status`} name="status" label="Status" options={TICKET_STATUSES} defaultValue={t.status} />
                  <SelectField id={`tk-${t.id}-priority`} name="priority" label="Priority" options={TICKET_PRIORITIES} defaultValue={t.priority} />
                  <SelectField id={`tk-${t.id}-assignee`} name="assignedTo" label="Assignee" options={staff.map((s) => ({ value: s.id, label: s.label }))} placeholder="Unassigned" defaultValue={t.assignedTo ?? ""} />
                </ActionForm>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed border-sand-300 bg-surface p-6 text-center text-muted">No tickets match.</p>
      )}
      <Pagination basePath="/admin/support" params={filters} total={data.total} limit={data.limit} offset={data.offset} />
    </>
  );
}
