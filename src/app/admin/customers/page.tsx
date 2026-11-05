import Link from "next/link";
import type { Metadata } from "next";
import { Badge } from "@/components/ui";
import { AdminHeader, When } from "@/components/admin/admin-ui";
import { DataTable, FilterBar, Pagination } from "@/components/admin/data-table";
import { TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { searchCustomers, type CustomerListRow } from "@/server/admin/customers";
import { parsePage, sp } from "@/server/admin/common";

export const metadata: Metadata = { title: "Customers" };

export default async function CustomersPage({ searchParams }: PageProps<"/admin/customers">) {
  const user = await requirePermission("customers.view", "/admin/customers");
  const q = await searchParams;
  const term = sp(q.q);
  const page = parsePage({ limit: sp(q.limit), offset: sp(q.offset) });
  const data = await searchCustomers(user, term, page);
  return (
    <>
      <AdminHeader title="Customers" description="Search by email or name. Emergency contacts and precise locations are restricted to safety staff and admins." />
      <FilterBar action="/admin/customers" resetHref="/admin/customers">
        <TextField id="c-q" name="q" type="search" label="Email or name" defaultValue={term ?? ""} className="sm:min-w-80" />
      </FilterBar>
      <DataTable<CustomerListRow>
        caption={term ? `Customers matching “${term}”` : "Newest customers"}
        rows={data.rows}
        rowKey={(c) => c.id}
        empty="No customers match."
        columns={[
          {
            header: "Customer",
            cell: (c) => (
              <span className="flex flex-wrap items-center gap-2">
                <Link href={`/admin/customers/${c.id}`} className="font-semibold text-forest-800 underline-offset-2 hover:underline">
                  {c.fullName ?? c.email ?? "Unnamed"}
                </Link>
                {c.isStaff ? <Badge tone="blue">Staff</Badge> : null}
              </span>
            ),
          },
          { header: "Email", cell: (c) => c.email ?? "—" },
          { header: "Trips", cell: (c) => c.tripCount },
          { header: "Bookings", cell: (c) => c.bookingCount },
          { header: "Joined", cell: (c) => <When at={c.createdAt} /> },
        ]}
      />
      <Pagination basePath="/admin/customers" params={{ q: term }} total={data.total} limit={data.limit} offset={data.offset} />
    </>
  );
}
