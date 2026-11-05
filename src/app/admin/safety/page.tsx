import type { Metadata } from "next";
import { Alert, Card } from "@/components/ui";
import { AdminHeader, Age, DemoBadge, OverdueBanner, Restricted, Section, StatusBadge, When } from "@/components/admin/admin-ui";
import { DataTable } from "@/components/admin/data-table";
import { RevealSensitive } from "@/components/admin/reveal";
import { requirePermission } from "@/server/auth";
import { canSeePreciseLocation, listActiveHikes, listAttentionCheckins, type ActiveHikeRow } from "@/server/admin/safety";
import { revealLocationAction } from "./actions";

export const metadata: Metadata = { title: "Safety monitor" };

export default async function SafetyPage() {
  const user = await requirePermission("trips.monitor", "/admin/safety");
  const [hikes, checkins] = await Promise.all([listActiveHikes(user), listAttentionCheckins(user)]);
  const precise = canSeePreciseLocation(user);

  return (
    <>
      <AdminHeader title="Safety monitor" description="Active hikes and check-ins that have not been confirmed. Location ages come from the hiker's phone when it has signal." />
      <OverdueBanner />

      <Section id="checkins" title={`Check-ins without confirmation (${checkins.length})`} description="Overdue = no confirmation received by the expected return time plus grace. The hiker's chosen contact may have been notified.">
        {checkins.length ? (
          <ul className="space-y-3">
            {checkins.map((c) => (
              <li key={c.id}>
                <Card className="p-4 sm:p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={c.status} label={c.status === "contact_notified" ? "No confirmation · contact notified" : "No confirmation received"} />
                    <span className="font-semibold">{c.trailName}</span>
                    <span className="text-sm text-muted">{c.customerEmail ?? "Customer"}</span>
                  </div>
                  <p className="mt-2 text-sm">
                    Expected back <When at={c.expectedReturnAt} /> (+{c.graceMinutes} min grace) · overdue since <When at={c.overdueAt} />
                    {c.lastOkAt ? (
                      <>
                        {" "}
                        · last “I’m okay” <When at={c.lastOkAt} />
                      </>
                    ) : null}
                    {c.contactNotifiedAt ? (
                      <>
                        {" "}
                        · contact notified <When at={c.contactNotifiedAt} />
                      </>
                    ) : null}
                    {!c.hasEmergencyContact ? " · no emergency contact chosen" : ""}
                  </p>
                  <details className="mt-3 rounded-xl border border-sand-200 p-3">
                    <summary className="min-h-11 cursor-pointer content-center font-semibold">Timeline ({c.events.length} event(s))</summary>
                    <ol className="mt-2 space-y-1 border-l-2 border-sand-300 pl-4 text-sm">
                      {c.events.map((e, i) => (
                        <li key={i}>
                          <When at={e.createdAt} /> — <span className="font-semibold">{e.kind.replace(/[_.]/g, " ")}</span> ({e.actor})
                          {e.summary ? <span className="block text-muted">{e.summary}</span> : null}
                        </li>
                      ))}
                    </ol>
                  </details>
                  {c.activeSessionId ? (
                    <div className="mt-3">
                      {precise ? (
                        <RevealSensitive
                          action={revealLocationAction.bind(null, c.activeSessionId)}
                          buttonLabel="Show last known location"
                          description="Shows the precise last-known position of this hike. Access is recorded in the audit log."
                        />
                      ) : (
                        <Restricted>precise location is visible to safety staff and admins.</Restricted>
                      )}
                    </div>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <Alert tone="forest" title="No overdue check-ins." />
        )}
      </Section>

      <Section id="hikes" title={`Active hikes (${hikes.length})`} description="“Last sync” is when the app last reached our servers; “last location” is the age of the newest position it sent. Neither is continuous monitoring.">
        <DataTable<ActiveHikeRow>
          caption="Active and paused hikes"
          captionHidden
          rows={hikes}
          rowKey={(h) => h.id}
          empty="No hikes in progress."
          columns={[
            { header: "Hiker / trail", cell: (h) => <span><span className="font-semibold">{h.customerEmail ?? "Customer"}</span><span className="flex flex-wrap items-center gap-1 text-xs text-muted">{h.trailName}{h.trailIsDemo ? <DemoBadge /> : null}</span></span> },
            { header: "Status", cell: (h) => <StatusBadge status={h.status} /> },
            { header: "Started", cell: (h) => <When at={h.startedAt} age /> },
            { header: "Last sync", cell: (h) => <Age at={h.lastSyncAt} staleAfterMin={15} /> },
            { header: "Last location", cell: (h) => <Age at={h.lastLocationAt} staleAfterMin={15} /> },
            { header: "Distance", cell: (h) => `${(h.distanceCompletedM / 1000).toFixed(1)} km` },
            { header: "Check-in", cell: (h) => (h.checkinStatus ? <span><StatusBadge status={h.checkinStatus} />{h.expectedReturnAt ? <span className="block text-xs text-muted">back by <When at={h.expectedReturnAt} /></span> : null}</span> : "Not opted in") },
            {
              header: "Precise location",
              hideLabelOnMobile: true,
              cell: (h) =>
                precise ? (
                  <details className="rounded-lg border border-sand-200 p-2">
                    <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold">Reveal (audited)</summary>
                    <div className="mt-2">
                      <RevealSensitive action={revealLocationAction.bind(null, h.id)} buttonLabel="Show location" description="Recorded in the audit log." />
                    </div>
                  </details>
                ) : (
                  <Restricted />
                ),
            },
          ]}
        />
      </Section>
    </>
  );
}
