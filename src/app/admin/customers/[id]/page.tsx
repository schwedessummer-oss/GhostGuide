import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui";
import { AdminHeader, KeyValue, Section, StatusBadge, When, money } from "@/components/admin/admin-ui";
import { DataTable } from "@/components/admin/data-table";
import { requirePermission } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import { getCustomerDetail, type CustomerDetail } from "@/server/admin/customers";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = { title: "Customer" };

export default async function CustomerDetailPage({ params }: PageProps<"/admin/customers/[id]">) {
  const { id } = await params;
  const user = await requirePermission("customers.view", `/admin/customers/${id}`);
  const c = await getCustomerDetail(user, id);
  if (!c) notFound();
  const canBookings = can(user.roles, "bookings.view");

  return (
    <>
      <p className="mb-3">
        <Link href="/admin/customers" className="inline-flex min-h-11 items-center font-semibold text-forest-800 hover:underline">
          ← Customers
        </Link>
      </p>
      <AdminHeader title={c.profile.fullName ?? c.profile.email ?? "Customer"} description={c.profile.email} />
      <Card>
        <KeyValue
          items={[
            ["Joined", <When key="j" at={c.profile.createdAt} />],
            ["Units", c.profile.units],
            ["Marketing emails", c.profile.marketingOptIn ? "Opted in" : "Not opted in"],
          ]}
        />
      </Card>

      <Section id="trips" title="Trips">
        <DataTable<CustomerDetail["trips"][number]>
          caption="Trips"
          captionHidden
          rows={c.trips}
          rowKey={(t) => t.id}
          empty="No trips."
          columns={[
            { header: "Trail", cell: (t) => t.trailName },
            { header: "Status", cell: (t) => <StatusBadge status={t.status} /> },
            { header: "Date", cell: (t) => (t.plannedDate ? formatDate(t.plannedDate) : "—") },
            { header: "Party", cell: (t) => t.partySize },
          ]}
        />
      </Section>

      <Section id="bookings" title="Bookings">
        <DataTable<CustomerDetail["bookings"][number]>
          caption="Bookings"
          captionHidden
          rows={c.bookings}
          rowKey={(b) => b.id}
          empty="No bookings."
          columns={[
            {
              header: "Booking",
              cell: (b) =>
                canBookings ? (
                  <Link className="font-semibold text-forest-800 underline" href={`/admin/bookings/${b.id}`}>
                    {b.trailName}
                  </Link>
                ) : (
                  b.trailName
                ),
            },
            { header: "Status", cell: (b) => <StatusBadge status={b.status} /> },
            { header: "Hike date", cell: (b) => formatDate(b.hikeDate) },
            { header: "Total", cell: (b) => `${money(b.totalCents, b.currency)}${b.refundedCents ? ` (refunded ${money(b.refundedCents, b.currency)})` : ""}` },
          ]}
        />
      </Section>

      <Section id="tickets" title="Support tickets">
        <DataTable<CustomerDetail["tickets"][number]>
          caption="Support tickets"
          captionHidden
          rows={c.tickets}
          rowKey={(t) => t.id}
          empty="No tickets."
          columns={[
            { header: "Subject", cell: (t) => t.subject },
            { header: "Status", cell: (t) => <StatusBadge status={t.status} /> },
            { header: "Priority", cell: (t) => <StatusBadge status={t.priority} /> },
            { header: "Opened", cell: (t) => <When at={t.createdAt} /> },
          ]}
        />
      </Section>
    </>
  );
}
