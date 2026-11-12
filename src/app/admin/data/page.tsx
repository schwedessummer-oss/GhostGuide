import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui";
import { AdminHeader, Age, KpiCard, Restricted, Section, StatusBadge, When } from "@/components/admin/admin-ui";
import { DataTable } from "@/components/admin/data-table";
import { ActionForm } from "@/components/admin/action-form";
import { Hidden, TextAreaField, TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import type { Bbox } from "@/domain/catalog";
import {
  getCatalogJobs,
  getCatalogOverview,
  getCoverageOverview,
  getProviderUsage,
  type CatalogJobRow,
  type CatalogTrailRow,
  type ProviderUsageRow,
  type TileCountRow,
  type TileListRow,
  type TrailCountRow,
  type UsageWindow,
} from "@/server/admin/catalog";
import { formatBytes, formatUsd } from "@/server/admin/provider-costs";
import { hideTrailAction, retryTileAction, unhideTrailAction } from "./actions";

export const metadata: Metadata = { title: "Trail data" };

const nf = new Intl.NumberFormat("en-US");
const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)} %`);
const km = (m: number) => `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;

function fmtBbox(b: Bbox | null): string {
  if (!b) return "";
  const lat = (v: number) => `${Math.abs(v).toFixed(2)}°${v < 0 ? "S" : "N"}`;
  const lng = (v: number) => `${Math.abs(v).toFixed(2)}°${v < 0 ? "W" : "E"}`;
  return `${lat(b[1])}–${lat(b[3])}, ${lng(b[0])}–${lng(b[2])}`;
}

function UsageLine({ label, w }: { label: string; w: UsageWindow }) {
  return (
    <>
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd>
        <span className="whitespace-nowrap">
          <span className="font-semibold">{nf.format(w.requests)}</span> req · {nf.format(w.errors)} err
          {w.errorRate !== null ? <span className={w.errorRate >= 0.25 ? "text-red-ink" : "text-muted"}> ({pct(w.errorRate)})</span> : null}
        </span>
        {" "}
        <span className="whitespace-nowrap text-xs text-muted">
          · {nf.format(w.cacheHits)} cache · {formatBytes(w.bytes)}
        </span>
      </dd>
    </>
  );
}

function Usage({ p }: { p: ProviderUsageRow }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1">
      <UsageLine label="Today" w={p.today} />
      <UsageLine label="7 d" w={p.last7d} />
      <UsageLine label="30 d" w={p.last30d} />
    </dl>
  );
}

function Warnings({ row }: { row: ProviderUsageRow }) {
  if (!row.policy) return <span className="text-amber-ink">No cost policy configured for this provider.</span>;
  if (!row.warnings.length) return <span className="block text-sm text-muted">No warnings</span>;
  return (
    <ul className="space-y-1 text-sm">
      {row.warnings.map((w) => (
        <li key={w.message} className={w.level === "critical" ? "font-semibold text-red-ink" : "text-amber-ink"}>
          {w.level === "critical" ? "Critical: " : "Warning: "}
          {w.message}
        </li>
      ))}
    </ul>
  );
}

function TileCell({ t }: { t: TileListRow }) {
  return (
    <span>
      <span className="font-mono text-sm font-semibold">{t.tileKey}</span>
      <span className="block text-xs text-muted">{fmtBbox(t.bbox)}</span>
    </span>
  );
}

function TrailName({ t }: { t: CatalogTrailRow }) {
  return (
    <span>
      {t.state === "visible" ? (
        <Link href={t.path} className="font-semibold text-forest-800 underline underline-offset-2">
          {t.name}
        </Link>
      ) : (
        <span className="font-semibold">{t.name}</span>
      )}
      <span className="block break-all font-mono text-xs text-muted">{t.path}</span>
      <span className="block break-all font-mono text-xs text-muted">{t.id}</span>
    </span>
  );
}

const STATE_LABEL: Record<CatalogTrailRow["state"], { status: string; label: string }> = {
  visible: { status: "published", label: "Visible" },
  hidden: { status: "closed", label: "Hidden (moderation)" },
  retired: { status: "retired", label: "Retired (gone from source)" },
};

function countColumns(keyHeader: string, keyCell: (r: TrailCountRow) => ReactNode) {
  return [
    { header: keyHeader, cell: keyCell },
    { header: "Visible", cell: (r: TrailCountRow) => nf.format(r.visible) },
    { header: "Hidden", cell: (r: TrailCountRow) => nf.format(r.hidden) },
    { header: "Retired", cell: (r: TrailCountRow) => nf.format(r.retired) },
    { header: "Total", cell: (r: TrailCountRow) => <span className="font-semibold">{nf.format(r.total)}</span> },
  ];
}

const JOB_STATUS_ORDER = ["queued", "running", "succeeded", "failed", "dead", "cancelled"];

export default async function TrailDataPage() {
  const user = await requirePermission("integrations.view", "/admin/data");
  const canManage = can(user.roles, "catalog.manage");
  const canJobs = can(user.roles, "jobs.manage");
  const [providers, coverage, catalog, jobs] = await Promise.all([
    getProviderUsage(user),
    getCoverageOverview(user),
    getCatalogOverview(user),
    getCatalogJobs(user),
  ]);

  const today = providers.reduce((a, p) => ({ requests: a.requests + p.today.requests, errors: a.errors + p.today.errors, cacheHits: a.cacheHits + p.today.cacheHits }), {
    requests: 0,
    errors: 0,
    cacheHits: 0,
  });
  const monthlyCost = providers.reduce((sum, p) => sum + (p.estimatedMonthlyCostUsd ?? 0), 0);
  const warningCount = providers.reduce((n, p) => n + p.warnings.length, 0);
  const criticalCount = providers.reduce((n, p) => n + p.warnings.filter((w) => w.level === "critical").length, 0);
  const tiles = coverage.counts.reduce(
    (a, c) => ({ total: a.total + c.total, ready: a.ready + c.ready, loading: a.loading + c.pending + c.fetching, failed: a.failed + c.failed }),
    { total: 0, ready: 0, loading: 0, failed: 0 },
  );
  const jobKinds = [...new Set(jobs.counts.map((c) => c.kind))];
  const jobStatuses = [...new Set(jobs.counts.map((c) => c.status))].sort((a, b) => JOB_STATUS_ORDER.indexOf(a) - JOB_STATUS_ORDER.indexOf(b));
  const jobCount = (kind: string, status: string) => jobs.counts.find((c) => c.kind === kind && c.status === status)?.n ?? 0;

  return (
    <>
      <AdminHeader
        eyebrow="System"
        title="Trail data"
        description="Real trail data from open and official providers: usage and cost, what is loaded, background loading jobs, and moderation. Figures update on every page load; days are UTC."
      />

      {/* ------------------------------------------------------------------ Providers */}
      <Section
        id="providers"
        title="Providers"
        description="Requests are counted per HTTP attempt (retries included) by the shared provider client; cache hits are lookups answered from Ghost Guide's own cache. Peak request rates are not measured, only daily totals."
      >
        <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiCard label="Requests today" value={nf.format(today.requests)} hint={`${nf.format(today.cacheHits)} cache hits`} />
          <KpiCard
            label="Errors today"
            value={nf.format(today.errors)}
            hint={today.requests ? `${pct(today.errors / today.requests)} of requests` : "no requests yet today"}
            tone={today.requests >= 20 && today.errors / today.requests >= 0.25 ? "red" : "neutral"}
          />
          <KpiCard label="Estimated monthly cost" value={formatUsd(monthlyCost)} hint="from the last 30 days and provider-costs.ts" />
          <KpiCard
            label="Usage warnings"
            value={nf.format(warningCount)}
            hint={criticalCount ? `${criticalCount} critical` : warningCount ? "approaching documented limits" : "within documented limits, no outages"}
            tone={criticalCount ? "red" : warningCount ? "amber" : "neutral"}
          />
        </div>
        <DataTable<ProviderUsageRow>
          caption="Provider usage and health"
          rows={providers}
          rowKey={(p) => p.provider}
          columns={[
            {
              header: "Provider",
              cell: (p) => (
                <span>
                  <span className="font-semibold">{p.label}</span>
                  {!p.configured ? (
                    <span className="mt-1 flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">Not configured</Badge>
                      <span className="text-xs text-muted">needs {p.policy?.keyEnv}</span>
                    </span>
                  ) : null}
                  {p.policy ? (
                    <>
                      <span className="block text-xs text-muted">{p.policy.policy}</span>
                      <a href={p.policy.docsUrl} className="text-xs font-semibold text-forest-800 underline underline-offset-2" target="_blank" rel="noreferrer">
                        Usage policy
                      </a>
                    </>
                  ) : null}
                </span>
              ),
            },
            { header: "Requests (UTC days)", cell: (p) => <Usage p={p} />, className: "md:min-w-[15rem]" },
            {
              header: "Health",
              className: "md:min-w-[12rem]",
              cell: (p) => (
                <span className="text-sm">
                  <span className="block">Last success: {p.lastSuccessAt ? <Age at={p.lastSuccessAt} /> : <span className="text-muted">never recorded</span>}</span>
                  {p.lastError ? (
                    <span className="block text-red-ink">
                      Last error ({p.lastErrorDay}): {p.lastError}
                    </span>
                  ) : (
                    <span className="block text-muted">No errors recorded.</span>
                  )}
                  {p.lastStatus !== null ? <span className="block text-xs text-muted">Last HTTP status {p.lastStatus}</span> : null}
                </span>
              ),
            },
            {
              header: "Cost and warnings",
              className: "md:min-w-[14rem]",
              cell: (p) => (
                <span className="block space-y-1">
                  {p.estimatedMonthlyCostUsd === null ? (
                    <span className="block text-muted">Cost unknown</span>
                  ) : (
                    <span className="block">
                      <span className="font-semibold">{formatUsd(p.estimatedMonthlyCostUsd)}</span>
                      <span className="text-muted"> / month (est.)</span>
                      <span className="block text-xs text-muted">{p.policy?.plan}</span>
                    </span>
                  )}
                  <Warnings row={p} />
                </span>
              ),
            },
          ]}
        />
        <details className="mt-3 rounded-xl border border-sand-200 bg-surface p-4">
          <summary className="min-h-11 cursor-pointer content-center font-semibold">Limits, terms and scale-up options</summary>
          <ul className="mt-2 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {providers.flatMap((p) =>
              p.policy
                ? [
                    <li key={p.provider} className="text-sm">
                      <p className="font-semibold">{p.label}</p>
                      <p className="text-muted">
                        {p.policy.plan} · reviewed {p.policy.reviewedOn} ·{" "}
                        <a href={p.policy.docsUrl} className="font-semibold text-forest-800 underline underline-offset-2" target="_blank" rel="noreferrer">
                          terms
                        </a>
                      </p>
                      <ul className="mt-1 list-disc pl-5">
                        {p.policy.limits.map((l) => (
                          <li key={l.kind}>
                            {l.label} <span className="text-muted">({l.enforcement === "fair_use" ? "fair use" : "enforced"})</span>
                          </li>
                        ))}
                        {p.policy.requirements.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                      {p.policy.scaleOption ? <p className="mt-1 text-muted">At scale: {p.policy.scaleOption}</p> : null}
                    </li>,
                  ]
                : [],
            )}
          </ul>
          <p className="mt-3 text-xs text-muted">Maintained in src/server/admin/provider-costs.ts. Free plans are estimated at $0; their limits are usage policies, reported above as warnings.</p>
        </details>
      </Section>

      {/* ------------------------------------------------------------------ Coverage */}
      <Section
        id="coverage"
        title="Coverage and loading"
        description="Provider data is loaded on demand per 0.25° tile (about 28 km) when someone searches an area, then refreshed in the background. Failed tiles retry automatically with backoff; “Retry now” queues a load immediately."
      >
        <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiCard label="Tiles" value={nf.format(tiles.total)} hint={`${nf.format(tiles.ready)} ready · ${nf.format(tiles.loading)} loading`} />
          <KpiCard label="Failed tiles" value={nf.format(tiles.failed)} hint="never loaded; retrying with backoff" tone={tiles.failed ? "amber" : "neutral"} />
          <KpiCard
            label="Refresh or retry due"
            value={nf.format(coverage.dueNow)}
            hint={
              coverage.oldestDueAt ? (
                <>
                  oldest due <Age at={coverage.oldestDueAt} />
                </>
              ) : coverage.nextRefreshAt ? (
                <>
                  next refresh <When at={coverage.nextRefreshAt} />
                </>
              ) : (
                "no refresh scheduled"
              )
            }
          />
          <KpiCard
            label="Stuck loads"
            value={nf.format(coverage.staleFetching)}
            hint="fetching for over 5 minutes; reclaimed by the next run"
            tone={coverage.staleFetching ? "amber" : "neutral"}
          />
        </div>

        <DataTable<TileCountRow>
          caption="Tiles by layer and provider"
          rows={coverage.counts}
          rowKey={(c) => `${c.layer}-${c.provider}`}
          empty="No tiles yet: nothing has been searched or loaded."
          columns={[
            { header: "Layer · provider", cell: (c) => <span className="font-semibold">{c.layer} · {c.provider}</span> },
            { header: "Pending", cell: (c) => nf.format(c.pending) },
            { header: "Fetching", cell: (c) => nf.format(c.fetching) },
            { header: "Ready", cell: (c) => nf.format(c.ready) },
            { header: "Failed", cell: (c) => <span className={c.failed ? "font-semibold text-red-ink" : undefined}>{nf.format(c.failed)}</span> },
            { header: "Refresh failing", cell: (c) => <span className={c.readyRefreshFailing ? "text-amber-ink" : undefined}>{nf.format(c.readyRefreshFailing)}</span> },
            { header: "Total", cell: (c) => <span className="font-semibold">{nf.format(c.total)}</span> },
          ]}
        />

        <div className="mt-4">
          <DataTable<TileListRow>
            caption="Recent failures (latest 20)"
            rows={coverage.failures}
            rowKey={(t) => `${t.layer}-${t.provider}-${t.tileKey}`}
            empty="No tile has failed to load."
            columns={[
              { header: "Tile", cell: (t) => <TileCell t={t} /> },
              { header: "Provider", cell: (t) => `${t.provider} · ${t.layer}` },
              {
                header: "Status",
                cell: (t) => (
                  <span className="flex flex-col items-start gap-1">
                    <StatusBadge status={t.status} label={t.status === "ready" ? "ready (refresh failing)" : undefined} />
                    {t.jobStatus === "queued" || t.jobStatus === "running" ? <span className="text-xs text-muted">load {t.jobStatus}</span> : null}
                  </span>
                ),
              },
              { header: "Attempts", cell: (t) => nf.format(t.attempts) },
              { header: "Last error", cell: (t) => (t.lastError ? <span className="text-red-ink">{t.lastError}</span> : "—") },
              { header: "Next retry", cell: (t) => <When at={t.nextRefreshAt} /> },
              {
                header: "Actions",
                hideLabelOnMobile: true,
                cell: (t) =>
                  !canManage ? (
                    <span className="text-xs text-muted">Retry needs catalog access</span>
                  ) : !t.retryable ? (
                    <span className="text-xs text-muted">Provider not enabled</span>
                  ) : t.jobStatus === "running" ? (
                    <span className="text-xs text-muted">Loading now</span>
                  ) : (
                    <details className="rounded-lg border border-sand-200 p-2">
                      <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold">Retry now</summary>
                      <ActionForm action={retryTileAction.bind(null, t.layer, t.provider, t.tileKey)} submitLabel="Queue load now" pendingLabel="Queueing…" compact className="mt-2">
                        <TextField id={`retry-${t.layer}-${t.provider}-${t.tileKey.replace(/[^0-9a-z]/gi, "-")}`} name="reason" label="Reason (optional)" maxLength={300} />
                      </ActionForm>
                    </details>
                  ),
              },
            ]}
          />
        </div>

        <div className="mt-4">
          <DataTable<TileListRow>
            caption="Recently synced (latest 10)"
            rows={coverage.recentlySynced}
            rowKey={(t) => `${t.layer}-${t.provider}-${t.tileKey}`}
            empty="No tile has been loaded yet."
            columns={[
              { header: "Tile", cell: (t) => <TileCell t={t} /> },
              { header: "Provider", cell: (t) => `${t.provider} · ${t.layer}` },
              { header: "Trails", cell: (t) => nf.format(t.trailCount) },
              { header: "POIs", cell: (t) => nf.format(t.poiCount) },
              { header: "Synced", cell: (t) => <When at={t.lastSyncedAt} age /> },
              { header: "Next refresh", cell: (t) => <When at={t.nextRefreshAt} /> },
              { header: "Note", cell: (t) => (t.lastError ? <span className={t.attempts ? "text-red-ink" : "text-amber-ink"}>{t.lastError}</span> : "—") },
            ]}
          />
        </div>
      </Section>

      {/* ------------------------------------------------------------------ Catalog */}
      <Section
        id="catalog"
        title="Catalog"
        description="Hidden trails were hidden by staff (moderation). Retired trails were hidden automatically because their source no longer has them; they come back if the source does. Nothing is ever deleted."
      >
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <DataTable<TrailCountRow>
            caption="Trails by provider"
            rows={catalog.byProvider}
            rowKey={(r) => r.key}
            empty="The catalog has no trails yet."
            columns={countColumns("Provider", (r) => <span className="font-semibold">{r.key}</span>)}
          />
          <DataTable<TrailCountRow>
            caption={`Trails by country (top 20 of ${nf.format(catalog.countryCount)})`}
            rows={catalog.byCountry}
            rowKey={(r) => r.key}
            empty="The catalog has no trails yet."
            columns={countColumns("Country", (r) => <span className="font-semibold uppercase">{r.key === "xx" ? "unknown (xx)" : r.key}</span>)}
          />
        </div>
        <p className="mt-3 text-sm text-muted">
          Points of interest:{" "}
          {catalog.pois.length ? catalog.pois.map((p) => `${p.provider} ${p.layer} ${nf.format(p.n)}`).join(" · ") : "none stored yet"}.
        </p>
        <div className="mt-4">
          <DataTable<CatalogTrailRow>
            caption="Newest trails"
            rows={catalog.newest}
            rowKey={(t) => t.id}
            empty="No trails yet."
            columns={[
              { header: "Trail", cell: (t) => <TrailName t={t} /> },
              {
                header: "Source",
                cell: (t) => (
                  <span>
                    {t.provider}
                    <span className="block break-all font-mono text-xs text-muted">{t.providerId}</span>
                  </span>
                ),
              },
              { header: "Region", cell: (t) => `${t.countryCode.toUpperCase()}${t.regionName ? ` · ${t.regionName}` : ""}` },
              { header: "Length", cell: (t) => km(t.distanceM) },
              { header: "Added", cell: (t) => <When at={t.createdAt} /> },
              { header: "State", cell: (t) => <StatusBadge status={STATE_LABEL[t.state].status} label={STATE_LABEL[t.state].label} /> },
            ]}
          />
        </div>
      </Section>

      {/* ------------------------------------------------------------------ Jobs */}
      <Section
        id="jobs"
        title="Catalog jobs"
        description={
          <>
            Tile loads, the hourly stale-tile refresh and the daily cache purge run on the catalog runner (/api/cron/catalog), one at a time.
            {canJobs ? (
              <>
                {" "}
                Dead jobs can be retried in{" "}
                <Link href="/admin/jobs?status=dead" className="font-semibold underline underline-offset-2">
                  Jobs &amp; integrations
                </Link>
                .
              </>
            ) : null}
          </>
        }
      >
        {jobs.oldestDueQueuedAt ? (
          <p className={`mb-3 text-sm ${jobs.runnerLooksStopped ? "font-semibold text-amber-ink" : "text-muted"}`}>
            Oldest due job has been waiting since <When at={jobs.oldestDueQueuedAt} /> (<Age at={jobs.oldestDueQueuedAt} />)
            {jobs.runnerLooksStopped
              ? ". The catalog runner runs every minute when its schedule is configured; a long wait means it is not running."
              : "."}
          </p>
        ) : (
          <p className="mb-3 text-sm text-muted">No catalog job is waiting to run.</p>
        )}
        {jobKinds.length ? (
          <DataTable<string>
            caption="Jobs by kind and status"
            rows={jobKinds}
            rowKey={(k) => k}
            columns={[
              { header: "Kind", cell: (k) => <span className="font-mono text-sm font-semibold">{k}</span> },
              ...jobStatuses.map((s) => ({
                header: s.replace(/_/g, " "),
                cell: (k: string) => <span className={s === "dead" && jobCount(k, s) ? "font-semibold text-red-ink" : undefined}>{nf.format(jobCount(k, s))}</span>,
              })),
            ]}
          />
        ) : (
          <DataTable<string> caption="Jobs by kind and status" rows={[]} rowKey={(k) => k} columns={[]} empty="No catalog jobs have been queued yet." />
        )}
        <div className="mt-4">
          <DataTable<CatalogJobRow>
            caption="Latest failed and dead catalog jobs (10)"
            rows={jobs.failed}
            rowKey={(j) => j.id}
            empty="No catalog job has failed."
            columns={[
              {
                header: "Job",
                cell: (j) => (
                  <span>
                    <span className="font-semibold">
                      #{j.id} {j.kind}
                    </span>
                    {j.target ? <span className="block font-mono text-xs text-muted">{j.target}</span> : null}
                  </span>
                ),
              },
              { header: "Status", cell: (j) => <StatusBadge status={j.retrying ? "queued" : j.status} label={j.retrying ? "retrying" : undefined} /> },
              { header: "Attempts", cell: (j) => `${j.attempts} / ${j.maxAttempts}` },
              { header: "Last error", cell: (j) => (j.lastError ? <span className="text-red-ink">{j.lastError}</span> : "—") },
              { header: "Updated", cell: (j) => <When at={j.updatedAt} /> },
              { header: "Next run", cell: (j) => (j.retrying ? <When at={j.runAt} /> : "—") },
            ]}
          />
        </div>
      </Section>

      {/* ------------------------------------------------------------------ Moderation */}
      <Section
        id="moderation"
        title="Moderation"
        description="Hide a trail that should not be shown (wrong, dangerous, private land, duplicate). Hidden trails disappear for everyone from search, trail pages and saved lists; refreshes keep them hidden. Nothing is deleted, and every change is recorded in the audit log with its reason."
      >
        {canManage ? (
          <>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-sand-200 bg-surface p-4">
                <h3 className="mb-2 font-semibold">Hide a trail</h3>
                <ActionForm action={hideTrailAction} submitLabel="Hide trail" pendingLabel="Hiding…" variant="danger">
                  <TextField id="hide-trail" name="trail" label="Trail id or page path" placeholder="/trail/us/colorado/example-trail" required maxLength={500} hint="Paste the trail's page URL, its /trail/… path or its id." />
                  <TextAreaField id="hide-reason" name="reason" label="Reason" required minLength={5} maxLength={500} />
                </ActionForm>
              </div>
              <div className="rounded-xl border border-sand-200 bg-surface p-4">
                <h3 className="mb-2 font-semibold">Unhide a trail</h3>
                <ActionForm action={unhideTrailAction} submitLabel="Unhide trail" pendingLabel="Unhiding…" variant="secondary">
                  <TextField id="unhide-trail" name="trail" label="Trail id or page path" required maxLength={500} hint="Only trails hidden by moderation can be unhidden." />
                  <TextAreaField id="unhide-reason" name="reason" label="Reason" required minLength={5} maxLength={500} />
                </ActionForm>
              </div>
            </div>
            <div className="mt-4">
              <DataTable<CatalogTrailRow>
                caption="Hidden by moderation (latest 20)"
                rows={catalog.hidden}
                rowKey={(t) => t.id}
                empty="No trail is hidden by moderation."
                columns={[
                  { header: "Trail", cell: (t) => <TrailName t={t} /> },
                  { header: "Reason", cell: (t) => t.hiddenReason ?? "—" },
                  { header: "Last updated", cell: (t) => <When at={t.updatedAt} /> },
                  {
                    header: "Actions",
                    hideLabelOnMobile: true,
                    cell: (t) => (
                      <details className="rounded-lg border border-sand-200 p-2">
                        <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold">Unhide</summary>
                        <ActionForm action={unhideTrailAction} submitLabel="Unhide trail" pendingLabel="Unhiding…" variant="secondary" compact className="mt-2">
                          <Hidden name="trail" value={t.id} />
                          <TextField id={`unhide-${t.id}-reason`} name="reason" label="Reason" required minLength={5} maxLength={500} />
                        </ActionForm>
                      </details>
                    ),
                  },
                ]}
              />
            </div>
          </>
        ) : (
          <Restricted>hiding and unhiding trails needs the catalog.manage permission.</Restricted>
        )}
      </Section>
    </>
  );
}
