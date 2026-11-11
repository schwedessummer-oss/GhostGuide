import "server-only";
import type { SessionUser } from "@/server/auth";
import { can, type Permission } from "@/server/auth/rbac";
import { integrationStatus } from "@/config/env";
import { getLaunchRegion } from "@/server/catalog/trails";
import { zonedTimeToUtc, localDateInZone } from "@/lib/time";
import { formatMoney } from "@/lib/format";
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
  simulated?: boolean;
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
  /** launch region zone, for displaying times */
  timeZone: string;
  generatedAt: Date;
}

/** "1 dead job", "2 dead jobs" (no "(s)"). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Alert for a stale job runner. Check-in reminders, overdue notices and
 * notification sends are background jobs: when the runner (cron) stops,
 * they are delayed, and staff must be told plainly.
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
    title: `${since} — check-in reminders and overdue notices are delayed`,
    detail: `The job runner should be invoked about once a minute (it is flagged after ${RUNNER_STALE_AFTER_MIN} min without a run). Until it runs, reminders, overdue check-in notices and other notifications are not processed. Check the cron configuration (see docs/DEPLOYMENT.md).`,
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
  const region = await getLaunchRegion();
  const todayLocal = localDateInZone(new Date(), region.timezone);
  const dayStart = zonedTimeToUtc(todayLocal, "00:00", region.timezone);
  const integrations = integrationStatus();
  const paymentsSimulated = integrations.payments === "simulated";

  const counts = await staffTx(user, async (tx) => {
    const one = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    const out: Record<string, number> = {};
    if (allow("bookings.view")) {
      out.bookingsToday = await one(tx`
        select count(*)::int as n from public.bookings where paid_at is not null and created_at >= ${dayStart}::timestamptz`);
      out.bookings7d = await one(tx`
        select count(*)::int as n from public.bookings where paid_at is not null and created_at >= now() - interval '7 days'`);
      out.bookingsAttention = await one(tx`select count(*)::int as n from public.bookings where status = 'needs_attention'`);
      out.staleHolds = await one(tx`
        select count(*)::int as n from public.bookings where status = 'pending_payment' and hold_expires_at < now() - interval '15 minutes'`);
    }
    if (allow("bookings.refund")) {
      out.revenue7d = await one(tx`
        select coalesce(sum(amount_cents), 0)::int as n from public.payments
        where status in ('succeeded', 'partially_refunded', 'refunded') and created_at >= now() - interval '7 days'`);
      out.refunds7d = await one(tx`
        select coalesce(sum(amount_cents), 0)::int as n from public.refunds where status = 'succeeded' and created_at >= now() - interval '7 days'`);
    }
    if (allow("trips.monitor")) {
      out.activeHikes = await one(tx`select count(*)::int as n from public.hike_sessions where status in ('active', 'paused')`);
      out.overdue = await one(tx`select count(*)::int as n from public.trip_checkins where status in ('overdue', 'contact_notified')`);
    }
    if (allow("notifications.view")) {
      out.failedNotifications = await one(tx`
        select count(*)::int as n from public.notifications where status = 'failed' and created_at >= now() - interval '24 hours'`);
    }
    if (allow("fulfillment.manage")) {
      out.fulfillmentAttention = await one(tx`select count(*)::int as n from public.fulfillments where status in ('failed', 'needs_attention')`);
    }
    if (allow("integrations.view")) {
      out.integrationFailures = await one(tx`
        select count(*)::int as n from public.integration_events where outcome = 'failure' and created_at >= now() - interval '24 hours'`);
    }
    if (allow("content.approve")) {
      out.narrationsInReview = await one(tx`select count(*)::int as n from public.narrations where status = 'in_review'`);
    }
    if (allow("marketing.approve")) {
      out.marketingInReview = await one(tx`select count(*)::int as n from public.marketing_drafts where status = 'in_review'`);
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
  // The heartbeat matters to whoever runs jobs or watches check-ins.
  const runner = allow("jobs.manage") || allow("trips.monitor") ? await getRunnerHealth() : null;

  const has = (k: string) => Object.hasOwn(counts, k);
  const kpis: Kpi[] = [];
  const push = (k: Kpi) => kpis.push(k);
  if (has("bookingsToday")) push({ key: "bookingsToday", label: "Paid bookings today", value: counts.bookingsToday, hint: `Since midnight ${region.timezone}`, href: "/admin/bookings" });
  if (has("bookings7d")) push({ key: "bookings7d", label: "Paid bookings, 7 days", value: counts.bookings7d, href: "/admin/bookings" });
  if (has("revenue7d")) {
    push({
      key: "revenue7d",
      label: paymentsSimulated ? "Simulated revenue, 7 days" : "Test/live revenue, 7 days",
      value: counts.revenue7d,
      display: formatMoney(counts.revenue7d),
      hint: `Captured payments; ${formatMoney(counts.refunds7d)} refunded`,
      simulated: paymentsSimulated,
    });
  }
  if (has("activeHikes")) push({ key: "activeHikes", label: "Active hikes", value: counts.activeHikes, href: "/admin/safety" });
  if (has("overdue")) push({ key: "overdue", label: "Overdue check-ins", value: counts.overdue, href: "/admin/safety", tone: counts.overdue ? "amber" : "neutral", hint: "Not proof of an emergency" });
  if (has("failedNotifications")) push({ key: "failedNotifications", label: "Failed notifications, 24 h", value: counts.failedNotifications, href: "/admin/notifications?status=failed", tone: counts.failedNotifications ? "red" : "neutral" });
  if (has("deadJobs")) push({ key: "deadJobs", label: "Dead jobs", value: counts.deadJobs, href: "/admin/jobs?status=dead", tone: counts.deadJobs ? "red" : "neutral" });
  if (has("fulfillmentAttention")) push({ key: "fulfillmentAttention", label: "Fulfillments needing attention", value: counts.fulfillmentAttention, href: "/admin/fulfillment", tone: counts.fulfillmentAttention ? "amber" : "neutral" });
  if (has("integrationFailures")) push({ key: "integrationFailures", label: "Integration failures, 24 h", value: counts.integrationFailures, href: "/admin/jobs#integrations", tone: counts.integrationFailures ? "amber" : "neutral" });

  const alerts: OverviewAlert[] = [];
  const alert = (cond: boolean, a: OverviewAlert) => cond && alerts.push(a);
  const stale = runner ? runnerAlert(runner, allow("jobs.manage")) : null;
  if (stale) alerts.push(stale);
  const needs = (n: number) => (n === 1 ? "needs" : "need");
  alert((counts.overdue ?? 0) > 0, {
    key: "overdue",
    tone: "amber",
    title: `${plural(counts.overdue, "check-in")} overdue`,
    detail: "Ghost Guide has not received confirmation from these hikers. That is not proof of an emergency.",
    href: "/admin/safety",
    linkLabel: "Open safety monitor",
  });
  alert((counts.deadJobs ?? 0) > 0, { key: "deadJobs", tone: "red", title: plural(counts.deadJobs, "dead job"), detail: "Background work exhausted its retries.", href: "/admin/jobs?status=dead", linkLabel: "Open retry queue" });
  alert((counts.failedNotifications ?? 0) > 0, { key: "notifications", tone: "red", title: `${plural(counts.failedNotifications, "notification")} failed in 24 h`, detail: "Check the delivery log for errors.", href: "/admin/notifications?status=failed", linkLabel: "Open delivery log" });
  alert((counts.fulfillmentAttention ?? 0) > 0, {
    key: "fulfillment",
    tone: "amber",
    title: `${plural(counts.fulfillmentAttention, "partner fulfillment")} ${needs(counts.fulfillmentAttention)} attention`,
    detail: "Failed or flagged partner requests.",
    href: "/admin/fulfillment",
    linkLabel: "Open fulfillment queue",
  });
  alert((counts.bookingsAttention ?? 0) > 0, {
    key: "bookingsAttention",
    tone: "amber",
    title: `${plural(counts.bookingsAttention, "booking")} ${needs(counts.bookingsAttention)} attention`,
    detail: "Payments that could not be matched to capacity or amount.",
    href: "/admin/bookings?status=needs_attention",
    linkLabel: "Review bookings",
  });
  alert((counts.staleHolds ?? 0) > 0, { key: "staleHolds", tone: "blue", title: `${plural(counts.staleHolds, "expired checkout hold")} still pending`, detail: "The hold-expiry job may be behind.", href: "/admin/bookings?status=pending_payment", linkLabel: "Review pending checkouts" });
  alert((counts.integrationFailures ?? 0) > 0, { key: "integrations", tone: "amber", title: `${plural(counts.integrationFailures, "integration failure")} in 24 h`, detail: "Provider calls that failed.", href: "/admin/jobs#integrations", linkLabel: "Open integration log" });
  alert((counts.narrationsInReview ?? 0) > 0, { key: "narration", tone: "blue", title: `${plural(counts.narrationsInReview, "narration")} awaiting review`, detail: "Approve with a cited source, or reject with a reason.", href: "/admin/content?status=in_review", linkLabel: "Open content queue" });
  alert((counts.marketingInReview ?? 0) > 0, { key: "marketing", tone: "blue", title: `${plural(counts.marketingInReview, "marketing draft")} awaiting review`, detail: "Check sources and freshness warnings.", href: "/admin/marketing?status=in_review", linkLabel: "Open marketing drafts" });
  alert((counts.urgentTickets ?? 0) > 0, {
    key: "tickets",
    tone: "amber",
    title: `${plural(counts.urgentTickets, "high-priority support ticket")} open`,
    detail: "Urgent or high priority, open or pending.",
    href: HIGH_PRIORITY_QUEUE_HREF,
    linkLabel: "Open these tickets",
  });

  return { kpis, alerts, integrations, runner, timeZone: region.timezone, generatedAt: new Date() };
}
