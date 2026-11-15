import "server-only";
import type { SessionUser } from "@/server/auth";
import { can, type Permission } from "@/server/auth/rbac";
import { integrationStatus } from "@/config/env";
import { getRunnerHealth, RUNNER_STALE_AFTER_MIN, type RunnerHealth } from "@/server/jobs/health";
import { assertCan, staffTx, systemTx } from "./common";
import { HIGH_PRIORITY_QUEUE_HREF } from "./support";

export interface Kpi {
  key: string;
  label: string;
  value: number | null;
  /** formatted value, e.g. money */
  display?: string;
  hint?: string;
  href?: string;
  tone?: "neutral" | "amber" | "red";
}

export interface OverviewAlert {
  key: string;
  tone: "amber" | "red" | "blue";
  title: string;
  detail: string;
  href: string;
  linkLabel: string;
}

export interface Overview {
  kpis: Kpi[];
  alerts: OverviewAlert[];
  integrations: ReturnType<typeof integrationStatus>;
  /** background job runner heartbeat (only for roles that depend on it) */
  runner: RunnerHealth | null;
  /** zone for displaying times */
  timeZone: string;
  generatedAt: Date;
}

/** "1 dead job", "2 dead jobs" (no "(s)"). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Alert for a stale job runner. When the runner (cron) stops, queued
 * background work is delayed, and staff must be told plainly.
 */
export function runnerAlert(runner: RunnerHealth, canManageJobs: boolean): OverviewAlert | null {
  if (!runner.stale) return null;
  const since =
    runner.minutesSinceRun === null
      ? "Background jobs have not run yet in this deployment"
      : `Background jobs have not run for ${runner.minutesSinceRun} min`;
  return {
    key: "jobRunner",
    tone: "red",
    title: `${since} — background work is delayed`,
    detail: `The job runner should be invoked about once a minute (it is flagged after ${RUNNER_STALE_AFTER_MIN} min without a run). Until it runs, queued background jobs are not processed. Check the cron configuration (see docs/DEPLOYMENT.md).`,
    href: canManageJobs ? "/admin/jobs" : "/status",
    linkLabel: canManageJobs ? "Open jobs" : "Open status page",
  };
}

/**
 * Admin overview. Each KPI is computed only when the viewer holds the
 * permission for the underlying data (and read under RLS, except the
 * server-only jobs table which is counted as trusted code after the check).
 */
export async function getOverview(user: SessionUser): Promise<Overview> {
  assertCan(user, "admin.access");
  const allow = (p: Permission) => can(user.roles, p);
  const integrations = integrationStatus();

  const counts = await staffTx(user, async (tx) => {
    const one = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    const out: Record<string, number> = {};
    if (allow("integrations.view")) {
      out.integrationFailures = await one(tx`
        select count(*)::int as n from public.integration_events where outcome = 'failure' and created_at >= now() - interval '24 hours'`);
    }
    if (allow("support.manage")) {
      out.urgentTickets = await one(tx`
        select count(*)::int as n from public.support_tickets where status <> 'resolved' and priority in ('urgent', 'high')`);
    }
    return out;
  });
  if (allow("jobs.manage")) {
    const [r] = await systemTx((tx) => tx<{ dead: number; failed: number }[]>`
      select count(*) filter (where status = 'dead')::int as dead, count(*) filter (where status = 'failed')::int as failed from public.jobs`);
    counts.deadJobs = r.dead;
  }
  // The heartbeat matters to whoever runs jobs.
  const runner = allow("jobs.manage") ? await getRunnerHealth() : null;

  const has = (k: string) => Object.hasOwn(counts, k);
  const kpis: Kpi[] = [];
  const push = (k: Kpi) => kpis.push(k);
  if (has("deadJobs")) push({ key: "deadJobs", label: "Dead jobs", value: counts.deadJobs, href: "/admin/jobs?status=dead", tone: counts.deadJobs ? "red" : "neutral" });
  if (has("integrationFailures")) push({ key: "integrationFailures", label: "Integration failures, 24 h", value: counts.integrationFailures, href: "/admin/jobs#integrations", tone: counts.integrationFailures ? "amber" : "neutral" });

  const alerts: OverviewAlert[] = [];
  const alert = (cond: boolean, a: OverviewAlert) => cond && alerts.push(a);
  const stale = runner ? runnerAlert(runner, allow("jobs.manage")) : null;
  if (stale) alerts.push(stale);
  alert((counts.deadJobs ?? 0) > 0, { key: "deadJobs", tone: "red", title: plural(counts.deadJobs, "dead job"), detail: "Background work exhausted its retries.", href: "/admin/jobs?status=dead", linkLabel: "Open retry queue" });
  alert((counts.integrationFailures ?? 0) > 0, { key: "integrations", tone: "amber", title: `${plural(counts.integrationFailures, "integration failure")} in 24 h`, detail: "Provider calls that failed.", href: "/admin/jobs#integrations", linkLabel: "Open integration log" });
  alert((counts.urgentTickets ?? 0) > 0, {
    key: "tickets",
    tone: "amber",
    title: `${plural(counts.urgentTickets, "high-priority support ticket")} open`,
    detail: "Urgent or high priority, open or pending.",
    href: HIGH_PRIORITY_QUEUE_HREF,
    linkLabel: "Open these tickets",
  });

  return { kpis, alerts, integrations, runner, timeZone: "UTC", generatedAt: new Date() };
}
