import Link from "next/link";
import type { Metadata } from "next";
import { Alert, Card } from "@/components/ui";
import { AdminHeader, Restricted, Section, StatusBadge, When } from "@/components/admin/admin-ui";
import { DataTable, FilterBar } from "@/components/admin/data-table";
import { ActionForm } from "@/components/admin/action-form";
import { SelectField, TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { canTrackTripPermits, listPermitRequirements, listUpcomingTripPermits, PERMIT_REMINDER_DEFAULT_DAYS, TRIP_PERMIT_STATUSES, type PermitRequirementRow, type TripPermitRow } from "@/server/admin/permits";
import { sp } from "@/server/admin/common";
import { formatDate } from "@/lib/format";
import { queueRemindersAction, updateTripPermitAction } from "./actions";

export const metadata: Metadata = { title: "Permits" };

export default async function PermitsPage({ searchParams }: PageProps<"/admin/permits">) {
  const user = await requirePermission("permits.manage", "/admin/permits");
  const q = await searchParams;
  const status = sp(q.status);
  const track = canTrackTripPermits(user);
  const [reqs, trips] = await Promise.all([listPermitRequirements(user), track ? listUpcomingTripPermits(user, { status }) : Promise.resolve([])]);

  return (
    <>
      <AdminHeader title="Permits" description="Official links, requirements, reminders and status tracking." />
      <Alert tone="blue" className="mb-6" title="No permit bots">
        Ghost Guide never buys permits on a customer&apos;s behalf and never automates permit queues, lotteries or CAPTCHAs. Customers apply on the
        official site; staff only record the status they report.
      </Alert>

      <Section id="requirements" title="Requirements by trail" description="Edit requirements on each trail's Permits tab.">
        <DataTable<PermitRequirementRow>
          caption="Permit requirements"
          captionHidden
          rows={reqs}
          rowKey={(r) => r.id}
          empty="No permit requirements recorded."
          columns={[
            { header: "Trail", cell: (r) => <Link className="font-semibold text-forest-800 underline" href={`/admin/trails/${r.trailId}/permits`}>{r.trailName}</Link> },
            { header: "Permit", cell: (r) => <span>{r.name}<span className="block text-xs text-muted">{r.authority}</span></span> },
            { header: "Official link", cell: (r) => <a className="break-all underline" href={r.officialUrl} target="_blank" rel="noopener noreferrer">{r.officialUrl}</a> },
            { header: "Lead time", cell: (r) => (r.leadTimeDays !== null ? `${r.leadTimeDays} day(s)` : "—") },
            { header: "Verified", cell: (r) => (r.verifiedAt ? formatDate(r.verifiedAt) : <span className="font-semibold text-amber-ink">Never</span>) },
            { header: "Summary", cell: (r) => <span className="line-clamp-3">{r.requirementSummary}</span> },
          ]}
        />
      </Section>

      <Section
        id="trips"
        title="Upcoming trips that need a permit"
        description={`Reminders are in-app notices created daily for booked trips whose permit is not obtained, starting max(lead time, ${PERMIT_REMINDER_DEFAULT_DAYS}) days before the hike (one per trip, permit and day).`}
        actions={<ActionForm action={queueRemindersAction} submitLabel="Queue reminder run now" variant="secondary" compact />}
      >
        {!track ? (
          <Restricted>customers&apos; trip permits are visible to operators and admins.</Restricted>
        ) : (
          <>
            <FilterBar action="/admin/permits#trips" resetHref="/admin/permits">
              <SelectField id="pm-status" name="status" label="Permit status" options={TRIP_PERMIT_STATUSES} placeholder="Any status" defaultValue={status ?? ""} />
            </FilterBar>
            <DataTable<TripPermitRow>
              caption="Trip permits (next 60 days)"
              captionHidden
              rows={trips}
              rowKey={(t) => `${t.tripId}:${t.permitRequirementId}`}
              empty="No upcoming trips need a permit."
              columns={[
                { header: "Hike", cell: (t) => <span><span className="font-semibold">{t.trailName}</span><span className="block text-xs text-muted">{t.plannedDate ? formatDate(t.plannedDate) : "No date"} · party {t.partySize} · trip {t.tripStatus}</span></span> },
                { header: "Customer", cell: (t) => t.customerEmail ?? "—" },
                { header: "Permit", cell: (t) => t.permitName },
                { header: "Status", cell: (t) => <span><StatusBadge status={t.status} />{t.confirmationRef ? <span className="block text-xs">Ref {t.confirmationRef}</span> : null}</span> },
                { header: "Updated", cell: (t) => <When at={t.updatedAt} /> },
                {
                  header: "Update",
                  hideLabelOnMobile: true,
                  cell: (t) => (
                    <details className="rounded-lg border border-sand-200 p-2">
                      <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold">Record status</summary>
                      <ActionForm action={updateTripPermitAction.bind(null, t.tripId, t.permitRequirementId)} submitLabel="Save status" compact className="mt-2">
                        <SelectField id={`tp-${t.tripId}-${t.permitRequirementId}-s`} name="status" label="Status" options={TRIP_PERMIT_STATUSES} defaultValue={t.status} />
                        <TextField id={`tp-${t.tripId}-${t.permitRequirementId}-r`} name="confirmationRef" label="Confirmation reference" maxLength={120} defaultValue={t.confirmationRef ?? ""} />
                        <TextField id={`tp-${t.tripId}-${t.permitRequirementId}-n`} name="notes" label="Notes" maxLength={2000} defaultValue={t.notes ?? ""} />
                      </ActionForm>
                    </details>
                  ),
                },
              ]}
            />
          </>
        )}
      </Section>
      <Card className="mt-6">
        <p className="text-sm text-muted">Reminders are general notices, not legal advice. The issuing authority&apos;s rules always take precedence.</p>
      </Card>
    </>
  );
}
