import Link from "next/link";
import type { Metadata } from "next";
import { SimulatedBadge } from "@/components/ui";
import { AdminHeader, StatusBadge, When, money } from "@/components/admin/admin-ui";
import { DataTable, FilterBar, Pagination } from "@/components/admin/data-table";
import { SelectField, TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { BOOKING_STATUSES, bookingTrailOptions, listBookings, type BookingListRow } from "@/server/admin/bookings";
import { parsePage, sp } from "@/server/admin/common";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = { title: "Bookings" };

export default async function BookingsPage({ searchParams }: PageProps<"/admin/bookings">) {
  const user = await requirePermission("bookings.view", "/admin/bookings");
  const q = await searchParams;
  const filters = { status: sp(q.status), from: sp(q.from), to: sp(q.to), trailId: sp(q.trailId), q: sp(q.q) };
  const page = parsePage({ limit: sp(q.limit), offset: sp(q.offset) });
  const [data, trails] = await Promise.all([listBookings(user, filters, page), bookingTrailOptions(user)]);
  return (
    <>
      <AdminHeader title="Bookings" description="Booking status is separate from each partner fulfillment's status. Hike dates are region-local." />
      <FilterBar action="/admin/bookings" resetHref="/admin/bookings">
        <SelectField id="b-status" name="status" label="Status" options={BOOKING_STATUSES} placeholder="Any status" defaultValue={filters.status ?? ""} />
        <SelectField id="b-trail" name="trailId" label="Trail" options={trails.map((t) => ({ value: t.id, label: t.name }))} placeholder="Any trail" defaultValue={filters.trailId ?? ""} />
        <TextField id="b-from" name="from" type="date" label="Hike date from" defaultValue={filters.from ?? ""} />
        <TextField id="b-to" name="to" type="date" label="Hike date to" defaultValue={filters.to ?? ""} />
        <TextField id="b-q" name="q" type="search" label="Email, booking id or receipt" defaultValue={filters.q ?? ""} />
      </FilterBar>
      <DataTable<BookingListRow>
        caption="Bookings, newest first"
        rows={data.rows}
        rowKey={(b) => b.id}
        empty="No bookings match these filters."
        columns={[
          {
            header: "Booking",
            cell: (b) => (
              <Link href={`/admin/bookings/${b.id}`} className="font-semibold text-forest-800 underline-offset-2 hover:underline">
                {b.trailName} · {formatDate(b.hikeDate)}
              </Link>
            ),
          },
          { header: "Status", cell: (b) => <StatusBadge status={b.status} /> },
          { header: "Customer", cell: (b) => b.customerEmail ?? "—" },
          { header: "Party", cell: (b) => b.partySize },
          {
            header: "Total",
            cell: (b) => (
              <span className="flex flex-wrap items-center gap-1">
                {money(b.totalCents, b.currency)}
                {b.refundedCents ? <span className="text-muted">(−{money(b.refundedCents, b.currency)})</span> : null}
                {b.paymentProvider === "demo" ? <SimulatedBadge label="Simulated" /> : null}
              </span>
            ),
          },
          { header: "Created", cell: (b) => <When at={b.createdAt} /> },
        ]}
      />
      <Pagination basePath="/admin/bookings" params={{ status: filters.status, from: filters.from, to: filters.to, trailId: filters.trailId, q: filters.q }} total={data.total} limit={data.limit} offset={data.offset} />
    </>
  );
}
