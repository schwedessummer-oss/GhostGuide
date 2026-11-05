import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui";
import { AdminHeader, Age, KeyValue, Restricted, Section, StatusBadge, When, money } from "@/components/admin/admin-ui";
import { DataTable } from "@/components/admin/data-table";
import { RevealSensitive } from "@/components/admin/reveal";
import { requirePermission } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import { getCustomerDetail, type CustomerDetail } from "@/server/admin/customers";
import { formatDate } from "@/lib/format";
import { revealCustomerAction } from "../actions";

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
            ["Phone", c.canSeeSensitive ? (c.profile.phoneOnFile ? "On file (reveal below)" : "Not on file") : <Restricted key="p" />],
          ]}
        />
      </Card>

      <Section id="sensitive" title="Emergency contacts and precise location">
        <Card>
          {c.canSeeSensitive ? (
            <RevealSensitive
              action={revealCustomerAction.bind(null, c.profile.id)}
              buttonLabel="Show restricted details"
              description="Shows the customer's phone, emergency contacts and last-known location of any active hike. Only view this when you need it for the customer's safety or support."
            />
          ) : (
            <Restricted>emergency contacts and precise location are visible to safety staff and admins only.</Restricted>
          )}
          {c.activeHikes.length ? (
            <p className="mt-3 text-sm">
              Active hike: started <When at={c.activeHikes[0].startedAt} />, last location <Age at={c.activeHikes[0].lastLocationAt} staleAfterMin={15} />.{" "}
              {can(user.roles, "trips.monitor") ? (
                <Link className="underline" href="/admin/safety">
                  Open safety monitor
                </Link>
              ) : null}
            </p>
          ) : null}
        </Card>
      </Section>

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

      <Section id="feedback" title="Feedback">
        {c.feedback.length ? (
          <ul className="space-y-2">
            {c.feedback.map((f) => (
              <li key={f.id}>
                <Card className="p-4 sm:p-4">
                  <p className="font-semibold">Rating: {f.rating} / 5</p>
                  {f.issues.length ? <p className="text-sm text-muted">Issues: {f.issues.join(", ").replace(/_/g, " ")}</p> : null}
                  {f.comments ? <p className="mt-1 whitespace-pre-wrap">{f.comments}</p> : null}
                  <p className="mt-1 text-xs text-muted">
                    <When at={f.createdAt} />
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">No feedback.</p>
        )}
      </Section>
    </>
  );
}
