import type { Metadata } from "next";
import { Alert } from "@/components/ui";
import { AdminHeader, StatusBadge } from "@/components/admin/admin-ui";
import { DataTable, FilterBar } from "@/components/admin/data-table";
import { ActionForm } from "@/components/admin/action-form";
import { CheckField, SelectField, TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { availabilityTrailOptions, getAvailability, type DayRow } from "@/server/admin/availability";
import { sp } from "@/server/admin/common";
import { formatDate } from "@/lib/format";
import { isWeekend } from "@/domain/pricing";
import { setDayAction } from "./actions";

export const metadata: Metadata = { title: "Availability" };

export default async function AvailabilityPage({ searchParams }: PageProps<"/admin/availability">) {
  const user = await requirePermission("inventory.manage", "/admin/availability");
  const q = await searchParams;
  const trails = await availabilityTrailOptions(user);
  const trailId = sp(q.trail) ?? trails[0]?.id;
  const data = trailId ? await getAvailability(user, trailId, 30) : null;

  return (
    <>
      <AdminHeader
        title="Availability"
        description="Next 30 days per trail. Booked = paid or awaiting cancellation; held = checkouts in progress within their hold window. Changes apply to the next reservation (checkout re-checks capacity under a lock)."
      />
      <FilterBar action="/admin/availability">
        <SelectField id="av-trail" name="trail" label="Trail" options={trails.map((t) => ({ value: t.id, label: `${t.name}${t.status !== "published" ? ` (${t.status})` : ""}` }))} defaultValue={trailId ?? ""} />
      </FilterBar>
      {!data ? (
        <Alert tone="amber">Choose a trail.</Alert>
      ) : (
        <DataTable<DayRow>
          caption={`${data.trail.name}: default capacity ${data.trail.dailyCapacity} hikers/day (${data.trail.timezone})`}
          rows={data.rows}
          rowKey={(r) => r.day}
          columns={[
            {
              header: "Day",
              cell: (r) => (
                <span className="font-semibold">
                  {formatDate(r.day, { weekday: "short", month: "short", day: "numeric" })}
                  {r.day === data.today ? <span className="ml-1 text-xs text-muted">(today)</span> : isWeekend(r.day) ? <span className="ml-1 text-xs text-muted">(weekend)</span> : null}
                </span>
              ),
            },
            { header: "Capacity", cell: (r) => <span>{r.capacity}{r.capacityOverride !== null ? <span className="text-xs text-muted"> (override)</span> : null}</span> },
            { header: "Booked", cell: (r) => r.booked },
            { header: "Held", cell: (r) => r.held },
            { header: "Remaining", cell: (r) => (r.blocked ? <StatusBadge status="closed" label="Blocked" /> : r.remaining === 0 ? <StatusBadge status="failed" label="Full" /> : r.remaining) },
            {
              header: "Adjust",
              hideLabelOnMobile: true,
              cell: (r) => (
                <details className="rounded-lg border border-sand-200 p-2">
                  <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold">{r.blocked ? `Blocked: ${r.note ?? ""}` : r.note ? `Note: ${r.note}` : "Edit day"}</summary>
                  <ActionForm action={setDayAction.bind(null, data.trail.id, r.day)} submitLabel="Save day" compact className="mt-2">
                    <TextField id={`av-${r.day}-cap`} name="capacity" label="Capacity override" type="number" min="0" max="1000" defaultValue={r.capacityOverride ?? ""} hint={`Empty = default (${data.trail.dailyCapacity})`} />
                    <CheckField id={`av-${r.day}-blk`} name="blocked" defaultChecked={r.blocked} label="Block new bookings this day" />
                    <TextField id={`av-${r.day}-note`} name="note" label="Note (required when blocking)" maxLength={300} defaultValue={r.note ?? ""} />
                  </ActionForm>
                </details>
              ),
            },
          ]}
        />
      )}
    </>
  );
}
