import type { Metadata } from "next";
import { Card, SimulatedBadge } from "@/components/ui";
import { AdminHeader, Section, StatusBadge, When } from "@/components/admin/admin-ui";
import { DataTable, FilterBar, Pagination } from "@/components/admin/data-table";
import { ActionForm } from "@/components/admin/action-form";
import { CheckField, SelectField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import { isDemoMode } from "@/config/env";
import { integrationSummary, JOB_STATUSES, listFailedWebhooks, listIntegrationEvents, listJobs, type IntegrationEventRow, type JobRow, type WebhookRow } from "@/server/admin/jobs";
import { parsePage, sp } from "@/server/admin/common";
import { cancelJobAction, retryJobAction, runDueJobsAction } from "./actions";

export const metadata: Metadata = { title: "Jobs & integrations" };

export default async function JobsPage({ searchParams }: PageProps<"/admin/jobs">) {
  const user = await requirePermission("jobs.manage", "/admin/jobs");
  const q = await searchParams;
  const filters = { status: sp(q.status) ?? "dead", kind: sp(q.kind) };
  const page = parsePage({ limit: sp(q.limit), offset: sp(q.offset) });
  const canIntegrations = can(user.roles, "integrations.view");
  const [jobs, events, summary, webhooks] = await Promise.all([
    listJobs(user, { status: filters.status === "all" ? undefined : filters.status, kind: filters.kind }, page),
    canIntegrations ? listIntegrationEvents(user, { outcome: "failure" }, parsePage({ limit: 20 })) : null,
    canIntegrations ? integrationSummary(user) : null,
    canIntegrations ? listFailedWebhooks(user, parsePage({ limit: 20 })) : null,
  ]);

  return (
    <>
      <AdminHeader
        title="Jobs & integrations"
        description="Background work retries automatically with backoff; jobs that exhaust their attempts are “dead” and wait here. Handlers re-check current state, so retrying is safe."
      />

      {isDemoMode() ? (
        <Card className="mb-6">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">Run due jobs now</h2>
            <SimulatedBadge label="Demo mode only" />
          </div>
          <p className="mb-3 text-sm text-muted">Runs everything that is due (including periodic jobs) once, so the demo works without a cron scheduler. In live mode jobs run only on the cron schedule.</p>
          <ActionForm action={runDueJobsAction} submitLabel="Run due jobs now" pendingLabel="Running…" />
        </Card>
      ) : null}

      <Section id="queue" title="Job queue" description={`Counts: ${Object.entries(jobs.counts).map(([s, n]) => `${s} ${n}`).join(" · ") || "no jobs"}`}>
        <FilterBar action="/admin/jobs" resetHref="/admin/jobs">
          <SelectField id="j-status" name="status" label="Status" options={[...JOB_STATUSES, "all"]} defaultValue={filters.status} />
          <SelectField id="j-kind" name="kind" label="Kind" options={jobs.kinds} placeholder="Any kind" defaultValue={filters.kind ?? ""} />
        </FilterBar>
        <DataTable<JobRow>
          caption={`Jobs (${filters.status})`}
          rows={jobs.rows}
          rowKey={(j) => j.id}
          empty="No jobs match."
          columns={[
            { header: "Job", cell: (j) => <span><span className="font-semibold">#{j.id} {j.kind}</span><span className="block break-all font-mono text-xs text-muted">{j.payloadPreview}</span></span> },
            { header: "Status", cell: (j) => <StatusBadge status={j.status} /> },
            { header: "Attempts", cell: (j) => `${j.attempts} / ${j.maxAttempts}` },
            { header: "Run at", cell: (j) => <When at={j.runAt} /> },
            { header: "Last error / note", cell: (j) => (j.lastError ? <span className={j.status === "dead" || j.status === "failed" ? "text-red-ink" : "text-muted"}>{j.lastError}</span> : "—") },
            {
              header: "Actions",
              hideLabelOnMobile: true,
              cell: (j) => (
                <div className="flex flex-col gap-2">
                  {["dead", "failed", "cancelled"].includes(j.status) ? <ActionForm action={retryJobAction.bind(null, j.id)} submitLabel="Retry" pendingLabel="Re-queueing…" compact /> : null}
                  {["queued", "failed", "dead"].includes(j.status) ? (
                    <details className="rounded-lg border border-sand-200 p-2">
                      <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold">Cancel</summary>
                      <ActionForm action={cancelJobAction.bind(null, j.id)} submitLabel="Cancel job" variant="danger" compact className="mt-2">
                        <CheckField id={`job-${j.id}-cancel`} name="confirm" required label="The work will not run." />
                      </ActionForm>
                    </details>
                  ) : null}
                </div>
              ),
            },
          ]}
        />
        <Pagination basePath="/admin/jobs" params={filters} total={jobs.total} limit={jobs.limit} offset={jobs.offset} />
      </Section>

      {canIntegrations && events && summary && webhooks ? (
        <>
          <Section id="integrations" title="Integration health (24 h)" description="Every provider call is logged, including simulated ones.">
            {summary.length ? (
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {summary.map((s) => (
                  <li key={`${s.providerKind}-${s.outcome}`} className="flex items-center justify-between rounded-xl border border-sand-200 bg-surface px-4 py-3">
                    <span className="font-semibold">{s.providerKind.replace(/_/g, " ")}</span>
                    <span className="flex items-center gap-2">
                      <StatusBadge status={s.outcome} /> {s.n}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">No provider calls in the last 24 hours.</p>
            )}
            <div className="mt-4">
              <DataTable<IntegrationEventRow>
                caption="Recent integration failures"
                rows={events.rows}
                rowKey={(e) => e.id}
                empty="No integration failures recorded."
                columns={[
                  { header: "When", cell: (e) => <When at={e.createdAt} /> },
                  { header: "Provider", cell: (e) => `${e.providerKind} · ${e.providerKey}` },
                  { header: "Operation", cell: (e) => e.operation },
                  { header: "Entity", cell: (e) => (e.entityType ? `${e.entityType} ${e.entityId?.slice(0, 8) ?? ""}` : "—") },
                  { header: "Error", cell: (e) => <span className="text-red-ink">{e.error ?? "—"}</span> },
                ]}
              />
            </div>
          </Section>

          <Section id="webhooks" title="Failed webhook deliveries" description="Provider webhooks that could not be processed. Providers redeliver automatically; processing is idempotent per event id.">
            <DataTable<WebhookRow>
              caption="Failed webhook events"
              captionHidden
              rows={webhooks.rows}
              rowKey={(w) => w.id}
              empty="No failed webhooks."
              columns={[
                { header: "Received", cell: (w) => <When at={w.receivedAt} /> },
                { header: "Event", cell: (w) => <span className="break-all">{w.provider} · {w.type}<span className="block font-mono text-xs text-muted">{w.eventId}</span></span> },
                { header: "Attempts", cell: (w) => w.attempts },
                { header: "Error", cell: (w) => <span className="text-red-ink">{w.error ?? "—"}</span> },
              ]}
            />
          </Section>
        </>
      ) : null}
    </>
  );
}
