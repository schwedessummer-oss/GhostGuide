import Link from "next/link";
import type { Metadata } from "next";
import { Card, SimulatedBadge } from "@/components/ui";
import { AdminHeader, Section, StatusBadge, When } from "@/components/admin/admin-ui";
import { DataTable, FilterBar } from "@/components/admin/data-table";
import { ActionForm } from "@/components/admin/action-form";
import { SelectField, TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { getGearOverview, ITEM_STATUSES, LOCKER_STATUSES, STAFF_SETTABLE_ITEM_STATUSES, type GearItemRow, type ReservationRow } from "@/server/admin/gear";
import { sp } from "@/server/admin/common";
import { formatDate } from "@/lib/format";
import { recordMaintenanceAction, setLockerStatusAction, setReservationStatusAction, updateGearItemAction } from "./actions";

export const metadata: Metadata = { title: "Gear lockers" };

const NEXT_RES: Record<string, { status: string; label: string }[]> = {
  reserved: [{ status: "picked_up", label: "Mark picked up" }],
  picked_up: [
    { status: "returned", label: "Mark returned" },
    { status: "overdue", label: "Mark overdue" },
  ],
  overdue: [{ status: "returned", label: "Mark returned" }],
};

export default async function GearPage({ searchParams }: PageProps<"/admin/gear">) {
  const user = await requirePermission("gear.manage", "/admin/gear");
  const q = await searchParams;
  const itemStatus = sp(q.itemStatus);
  const g = await getGearOverview(user, { itemStatus });

  return (
    <>
      <AdminHeader
        title="Gear lockers"
        description={
          <span className="flex flex-wrap items-center gap-2">
            Lockers, items and upcoming reservations. Locker hardware and access codes are a simulated partner in this demo. <SimulatedBadge label="Simulated partner" />
          </span>
        }
      />

      <Section id="lockers" title="Lockers">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {g.lockers.map((l) => (
            <Card key={l.id} className="p-4 sm:p-5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">{l.name}</p>
                <StatusBadge status={l.status} />
              </div>
              <p className="text-sm text-muted">{l.locationDescription}</p>
              <p className="mt-1 text-sm">
                {l.availableCount} of {l.itemCount} items available · provider {l.providerKey}
              </p>
              <ActionForm action={setLockerStatusAction.bind(null, l.id)} submitLabel="Update status" variant="secondary" compact inline className="mt-3">
                <SelectField id={`lk-${l.id}`} name="status" label="Locker status" options={LOCKER_STATUSES} defaultValue={l.status} />
              </ActionForm>
            </Card>
          ))}
        </div>
      </Section>

      <Section id="reservations" title={`Reservations (next ${g.days} days, plus anything still out)`}>
        <DataTable<ReservationRow>
          caption="Gear reservations"
          captionHidden
          rows={g.reservations}
          rowKey={(r) => r.id}
          empty="No upcoming reservations."
          columns={[
            { header: "Date", cell: (r) => formatDate(r.reservedFor) },
            { header: "Item", cell: (r) => `${r.itemLabel}${r.lockerName ? ` · ${r.lockerName}` : ""}` },
            { header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
            {
              header: "Booking",
              cell: (r) => (
                <Link className="underline" href={`/admin/bookings/${r.bookingId}`}>
                  <StatusBadge status={r.bookingStatus} />
                </Link>
              ),
            },
            { header: "Code hint", cell: (r) => (r.accessCodeHint ? `••••${r.accessCodeHint}` : "—") },
            {
              header: "Actions",
              hideLabelOnMobile: true,
              cell: (r) => (
                <div className="flex flex-wrap gap-2">
                  {(NEXT_RES[r.status] ?? []).map((n) => (
                    <ActionForm key={n.status} action={setReservationStatusAction.bind(null, r.id, n.status)} submitLabel={n.label} variant={n.status === "overdue" ? "secondary" : "primary"} compact />
                  ))}
                </div>
              ),
            },
          ]}
        />
      </Section>

      <Section id="items" title="Items">
        <FilterBar action="/admin/gear#items" resetHref="/admin/gear">
          <SelectField id="g-status" name="itemStatus" label="Item status" options={ITEM_STATUSES} placeholder="All items" defaultValue={itemStatus ?? ""} />
        </FilterBar>
        <DataTable<GearItemRow>
          caption={`${g.items.length} item(s)`}
          rows={g.items}
          rowKey={(i) => i.id}
          empty="No items match."
          columns={[
            { header: "Item", cell: (i) => <span><span className="font-semibold">{i.label}</span><span className="block text-xs text-muted">{i.kind.replace(/_/g, " ")} · {i.lockerName ?? "No locker"}</span></span> },
            { header: "Status", cell: (i) => <StatusBadge status={i.status} /> },
            { header: "Condition", cell: (i) => i.conditionNotes ?? "—" },
            { header: "Last maintenance", cell: (i) => <When at={i.lastMaintenanceAt} /> },
            {
              header: "Manage",
              hideLabelOnMobile: true,
              cell: (i) => (
                <details className="rounded-lg border border-sand-200 p-2">
                  <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold">Update / maintenance</summary>
                  <div className="mt-2 space-y-3">
                    <ActionForm action={updateGearItemAction.bind(null, i.id)} submitLabel="Save item" compact>
                      <SelectField
                        id={`it-${i.id}-status`}
                        name="status"
                        label="Status"
                        options={STAFF_SETTABLE_ITEM_STATUSES}
                        defaultValue={(STAFF_SETTABLE_ITEM_STATUSES as readonly string[]).includes(i.status) ? i.status : "maintenance"}
                      />
                      <TextField id={`it-${i.id}-notes`} name="conditionNotes" label="Condition notes" maxLength={1000} defaultValue={i.conditionNotes ?? ""} />
                    </ActionForm>
                    <ActionForm action={recordMaintenanceAction.bind(null, i.id)} submitLabel="Record maintenance" variant="secondary" compact>
                      <TextField id={`it-${i.id}-mnt`} name="notes" label="Maintenance performed" required minLength={3} maxLength={1000} />
                    </ActionForm>
                  </div>
                </details>
              ),
            },
          ]}
        />
      </Section>
    </>
  );
}
