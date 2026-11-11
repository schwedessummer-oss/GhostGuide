import Link from "next/link";
import type { Metadata } from "next";
import { Alert, Badge, Card, SimulatedBadge } from "@/components/ui";
import { AdminHeader, formatAdminDateTime, KpiCard, Section } from "@/components/admin/admin-ui";
import { requirePermission } from "@/server/auth";
import { getOverview } from "@/server/admin/overview";
import { formatAge } from "@/lib/format";

export const metadata: Metadata = { title: "Overview" };

const INTEGRATION_LABELS: Record<string, string> = {
  mode: "App mode",
  auth: "Authentication",
  storage: "File storage",
  payments: "Payments",
  maps: "Maps",
  ai: "AI explanations",
  notifications: "Notifications (SMS / email)",
  weather: "Weather",
  partners: "Partner services",
};

export default async function AdminOverviewPage() {
  const user = await requirePermission("admin.access", "/admin");
  const o = await getOverview(user);
  const integrations = Object.entries(o.integrations) as [string, string][];

  return (
    <>
      <AdminHeader
        eyebrow="Admin"
        title="Overview"
        description={<>What needs attention right now. Figures update on every page load ({formatAdminDateTime(o.generatedAt, o.timeZone)}).</>}
      />

      <Section title="Needs attention" id="alerts">
        {o.alerts.length ? (
          <ul className="space-y-3" aria-label="Alerts">
            {o.alerts.map((a) => (
              <li key={a.key}>
                <Alert tone={a.tone} title={a.title}>
                  {a.detail ? <p>{a.detail}</p> : null}
                  <Link href={a.href} className="mt-1 inline-flex min-h-11 items-center font-semibold underline underline-offset-2">
                    {a.linkLabel} →
                  </Link>
                </Alert>
              </li>
            ))}
          </ul>
        ) : (
          <Alert tone="forest" title="Nothing needs attention in the queues you can see." />
        )}
      </Section>

      <Section title="Key numbers" id="kpis" description="Only the figures your role can access are shown.">
        {o.kpis.length ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {o.kpis.map((k) => (
              <KpiCard
                key={k.key}
                label={k.label}
                value={k.display ?? (k.value ?? "—")}
                hint={k.hint}
                href={k.href}
                tone={k.tone}
                badge={k.simulated ? <SimulatedBadge label="Simulated payments" /> : null}
              />
            ))}
          </div>
        ) : (
          <p className="text-muted">Your role has no dashboard figures. Use the menu to open your sections.</p>
        )}
      </Section>

      <Section
        title="Integration status"
        id="integrations"
        description="Which services are live and which are simulated in this deployment. Simulated services never contact real people or partners."
      >
        <Card className="p-0 sm:p-0">
          <ul className="divide-y divide-sand-200">
            {integrations.map(([key, value]) => {
              const simulated = /simulated|demo|offline|local/i.test(value);
              return (
                <li key={key} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <span className="font-semibold">{INTEGRATION_LABELS[key] ?? key}</span>
                  <span className="flex items-center gap-2 text-sm">
                    {simulated ? <SimulatedBadge label="Simulated" /> : <Badge tone="forest">Live</Badge>}
                    <span className="text-muted">{value}</span>
                  </span>
                </li>
              );
            })}
            {o.runner ? (
              <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <span className="font-semibold">Background job runner</span>
                <span className="flex items-center gap-2 text-sm">
                  {o.runner.stale ? <Badge tone="red">Delayed</Badge> : <Badge tone="forest">On schedule</Badge>}
                  <span className="text-muted">
                    {o.runner.lastRunAt ? `Last run ${formatAge(o.runner.lastRunAt)} (${formatAdminDateTime(o.runner.lastRunAt, o.timeZone)})` : "No run recorded"}
                  </span>
                </span>
              </li>
            ) : null}
          </ul>
        </Card>
        <p className="mt-2 text-sm text-muted">
          Ghost Guide never contacts emergency services or search and rescue, and does not provide satellite SOS. Check-in notices go only to the
          hiker&apos;s chosen contact.
        </p>
      </Section>
    </>
  );
}
