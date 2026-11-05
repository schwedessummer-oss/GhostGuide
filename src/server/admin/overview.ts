import "server-only";
import type { SessionUser } from "@/server/auth";
import { can, type Permission } from "@/server/auth/rbac";
import { integrationStatus } from "@/config/env";
import { getLaunchRegion } from "@/server/catalog/trails";
import { zonedTimeToUtc, localDateInZone } from "@/lib/time";
import { assertCan, staffTx, systemTx } from "./common";

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
  generatedAt: Date;
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
      display: `$${(counts.revenue7d / 100).toFixed(2)}`,
      hint: `Captured payments; ${(counts.refunds7d / 100).toFixed(2)} refunded`,
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
  alert((counts.overdue ?? 0) > 0, {
    key: "overdue",
    tone: "amber",
    title: `${counts.overdue} check-in(s) overdue`,
    detail: "Ghost Guide has not received confirmation from these hikers. That is not proof of an emergency.",
    href: "/admin/safety",
    linkLabel: "Open safety monitor",
  });
  alert((counts.deadJobs ?? 0) > 0, { key: "deadJobs", tone: "red", title: `${counts.deadJobs} dead job(s)`, detail: "Background work exhausted its retries.", href: "/admin/jobs?status=dead", linkLabel: "Open retry queue" });
  alert((counts.failedNotifications ?? 0) > 0, { key: "notifications", tone: "red", title: `${counts.failedNotifications} notification(s) failed in 24 h`, detail: "Check the delivery log for errors.", href: "/admin/notifications?status=failed", linkLabel: "Open delivery log" });
  alert((counts.fulfillmentAttention ?? 0) > 0, { key: "fulfillment", tone: "amber", title: `${counts.fulfillmentAttention} partner fulfillment(s) need attention`, detail: "Failed or flagged partner requests.", href: "/admin/fulfillment", linkLabel: "Open fulfillment queue" });
  alert((counts.bookingsAttention ?? 0) > 0, { key: "bookingsAttention", tone: "amber", title: `${counts.bookingsAttention} booking(s) need attention`, detail: "Payments that could not be matched to capacity or amount.", href: "/admin/bookings?status=needs_attention", linkLabel: "Review bookings" });
  alert((counts.staleHolds ?? 0) > 0, { key: "staleHolds", tone: "blue", title: `${counts.staleHolds} expired checkout hold(s) still pending`, detail: "The hold-expiry job may be behind.", href: "/admin/bookings?status=pending_payment", linkLabel: "Review pending checkouts" });
  alert((counts.integrationFailures ?? 0) > 0, { key: "integrations", tone: "amber", title: `${counts.integrationFailures} integration failure(s) in 24 h`, detail: "Provider calls that failed.", href: "/admin/jobs#integrations", linkLabel: "Open integration log" });
  alert((counts.narrationsInReview ?? 0) > 0, { key: "narration", tone: "blue", title: `${counts.narrationsInReview} narration(s) awaiting review`, detail: "Approve with a cited source, or reject with a reason.", href: "/admin/content?status=in_review", linkLabel: "Open content queue" });
  alert((counts.marketingInReview ?? 0) > 0, { key: "marketing", tone: "blue", title: `${counts.marketingInReview} marketing draft(s) awaiting review`, detail: "Check sources and freshness warnings.", href: "/admin/marketing?status=in_review", linkLabel: "Open marketing drafts" });
  alert((counts.urgentTickets ?? 0) > 0, { key: "tickets", tone: "amber", title: `${counts.urgentTickets} high-priority support ticket(s) open`, detail: "", href: "/admin/support?priority=urgent", linkLabel: "Open support queue" });

  return { kpis, alerts, integrations, generatedAt: new Date() };
}
