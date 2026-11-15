import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui";
import { AdminHeader, KeyValue, Section, StatusBadge, When } from "@/components/admin/admin-ui";
import { DataTable } from "@/components/admin/data-table";
import { requirePermission } from "@/server/auth";
import { getCustomerDetail, type CustomerDetail } from "@/server/admin/customers";

export const metadata: Metadata = { title: "Customer" };

export default async function CustomerDetailPage({ params }: PageProps<"/admin/customers/[id]">) {
  const { id } = await params;
  const user = await requirePermission("customers.view", `/admin/customers/${id}`);
  const c = await getCustomerDetail(user, id);
  if (!c) notFound();

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
