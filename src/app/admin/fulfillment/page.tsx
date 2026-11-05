import Link from "next/link";
import type { Metadata } from "next";
import { Alert, SimulatedBadge } from "@/components/ui";
import { AdminHeader, Section, StatusBadge, When, money } from "@/components/admin/admin-ui";
import { DataTable, FilterBar, Pagination } from "@/components/admin/data-table";
import { ActionForm } from "@/components/admin/action-form";
import { SelectField, TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { FULFILLMENT_QUEUES, listFulfillments, listShuttlesAwaitingCustomer, PROVIDER_KINDS, type FulfillmentRow, type ShuttleAwaitingRow } from "@/server/admin/fulfillment";
import { parsePage, sp } from "@/server/admin/common";
import { formatDate } from "@/lib/format";
import { retryFulfillmentAction, setFulfillmentStatusAction } from "./actions";

export const metadata: Metadata = { title: "Fulfillment" };

const QUEUE_LABELS: Record<string, string> = {
  attention: "Failed or needs attention",
  failed: "Failed",
  needs_attention: "Needs attention",
  awaiting_customer: "Awaiting customer",
  in_progress: "In progress",
  all: "All",
};

export default async function FulfillmentPage({ searchParams }: PageProps<"/admin/fulfillment">) {
  const user = await requirePermission("fulfillment.manage", "/admin/fulfillment");
  const q = await searchParams;
  const filters = { queue: sp(q.queue) ?? "attention", kind: sp(q.kind) };
  const page = parsePage({ limit: sp(q.limit), offset: sp(q.offset) });
  const [data, shuttles] = await Promise.all([listFulfillments(user, filters, page), listShuttlesAwaitingCustomer(user)]);

  return (
    <>
      <AdminHeader
        title="Partner fulfillment"
        description={
          <span className="flex flex-wrap items-center gap-2">
            Each add-on&apos;s partner status is tracked separately from the booking. All partners are simulated in this deployment. <SimulatedBadge label="Simulated partners" />
          </span>
        }
      />
      <FilterBar action="/admin/fulfillment" resetHref="/admin/fulfillment">
        <SelectField id="ff-queue" name="queue" label="Queue" options={Object.keys(FULFILLMENT_QUEUES).map((k) => ({ value: k, label: QUEUE_LABELS[k] ?? k }))} defaultValue={filters.queue} />
        <SelectField id="ff-kind" name="kind" label="Partner type" options={PROVIDER_KINDS} placeholder="All partner types" defaultValue={filters.kind ?? ""} />
      </FilterBar>
      <DataTable<FulfillmentRow>
        caption={QUEUE_LABELS[filters.queue] ?? "Fulfillments"}
        rows={data.rows}
        rowKey={(f) => f.id}
        empty="Nothing in this queue."
        columns={[
          {
            header: "Add-on",
            cell: (f) => (
              <span>
                <span className="font-semibold">{f.addonName}</span>
                <span className="block text-xs text-muted">
                  {f.providerKind.replace(/_/g, " ")} · {f.providerKey}
                  {f.externalRef ? ` · ref ${f.externalRef}` : ""}
                </span>
              </span>
            ),
          },
          { header: "Partner status", cell: (f) => <StatusBadge status={f.status} /> },
          {
            header: "Booking",
            cell: (f) => (
              <Link href={`/admin/bookings/${f.bookingId}`} className="underline">
                {f.trailName} · {formatDate(f.hikeDate)} <StatusBadge status={f.bookingStatus} />
              </Link>
            ),
          },
          { header: "Attempts / error", cell: (f) => <span>{f.attempts} attempt(s){f.lastError ? <span className="block text-red-ink">{f.lastError}</span> : null}</span> },
          { header: "Updated", cell: (f) => <When at={f.updatedAt} /> },
          {
            header: "Actions",
            hideLabelOnMobile: true,
            cell: (f) =>
              f.status === "cancelled" ? (
                <span className="text-sm text-muted">Cancelled</span>
              ) : (
                <div className="space-y-2">
                  {f.status === "failed" || f.status === "needs_attention" ? (
                    <ActionForm action={retryFulfillmentAction.bind(null, f.id)} submitLabel="Retry" pendingLabel="Queueing…" compact />
                  ) : null}
                  <details className="rounded-lg border border-sand-200 p-2">
                    <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold">Set status manually</summary>
                    <ActionForm action={setFulfillmentStatusAction.bind(null, f.id)} submitLabel="Set status" variant="secondary" compact className="mt-2">
                      <SelectField id={`fs-${f.id}-status`} name="status" label="New status" options={["confirmed", "completed", "cancelled", "failed"]} defaultValue="confirmed" />
                      <TextField id={`fs-${f.id}-note`} name="note" label="Note (e.g. confirmed by phone)" required minLength={3} maxLength={500} />
                    </ActionForm>
                  </details>
                </div>
              ),
          },
        ]}
      />
      <Pagination basePath="/admin/fulfillment" params={{ queue: filters.queue, kind: filters.kind }} total={data.total} limit={data.limit} offset={data.offset} />

      <Section id="shuttles" title="Shuttle quotes awaiting the customer" description="Read-only. A paid ride is requested only after the customer confirms pickup location, price and time themselves; staff cannot confirm on their behalf.">
        {shuttles.length ? (
          <DataTable<ShuttleAwaitingRow>
            caption="Shuttle requests awaiting customer confirmation"
            captionHidden
            rows={shuttles}
            rowKey={(s) => s.id}
            columns={[
              { header: "Hike", cell: (s) => <Link className="underline" href={`/admin/bookings/${s.bookingId}`}>{s.trailName} · {formatDate(s.hikeDate)}</Link> },
              { header: "Quote", cell: (s) => <StatusBadge status={s.status} /> },
              { header: "Pickup", cell: (s) => <span>{s.pickupDescription ?? "Not chosen yet"}{s.pickupAt ? <span className="block text-xs text-muted"><When at={s.pickupAt} /></span> : null}</span> },
              { header: "Price", cell: (s) => money(s.quotedPriceCents, s.currency) },
              { header: "Quote expires", cell: (s) => <When at={s.quoteExpiresAt} /> },
            ]}
          />
        ) : (
          <Alert tone="forest" title="No shuttle quotes are waiting for customers." />
        )}
      </Section>
    </>
  );
}
