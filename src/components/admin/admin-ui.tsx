import Link from "next/link";
import clsx from "clsx";
import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { Badge, SimulatedBadge } from "@/components/ui";
import { formatAge } from "@/lib/format";
import { formatAdminDateTime } from "./time";

export { formatAdminDateTime };

/*
 * Small presentational helpers for admin pages (server-component safe).
 * Status is always conveyed by TEXT; colour only reinforces it.
 */
type Tone = "neutral" | "forest" | "amber" | "red" | "blue";

const STATUS_TONES: Record<string, Tone> = {
  // trails / content
  published: "forest",
  approved: "forest",
  draft: "neutral",
  in_review: "blue",
  rejected: "red",
  retired: "neutral",
  archived: "neutral",
  closed: "red",
  partial: "amber",
  advisory: "blue",
  valid: "forest",
  invalid: "red",
  pending: "neutral",
  // bookings
  pending_payment: "blue",
  confirmed: "forest",
  cancellation_requested: "amber",
  cancelled: "neutral",
  refund_pending: "amber",
  refunded: "neutral",
  payment_failed: "red",
  expired: "neutral",
  needs_attention: "red",
  succeeded: "forest",
  partially_refunded: "amber",
  requested: "blue",
  // fulfillment
  awaiting_customer: "amber",
  completed: "forest",
  failed: "red",
  quote_pending: "neutral",
  quoted: "amber",
  // hikes / check-ins
  active: "blue",
  paused: "amber",
  finished: "neutral",
  abandoned: "neutral",
  scheduled: "neutral",
  confirmed_ok: "forest",
  overdue: "amber",
  contact_notified: "red",
  // jobs / notifications / integrations
  queued: "blue",
  running: "blue",
  dead: "red",
  simulated: "amber",
  sent: "forest",
  delivered: "forest",
  suppressed: "neutral",
  success: "forest",
  failure: "red",
  processed: "forest",
  received: "blue",
  ignored: "neutral",
  // gear
  available: "forest",
  reserved: "blue",
  checked_out: "amber",
  maintenance: "amber",
  online: "forest",
  offline: "red",
  picked_up: "blue",
  returned: "forest",
  // permits / tickets
  not_started: "neutral",
  applied: "blue",
  obtained: "forest",
  denied: "red",
  not_required: "neutral",
  open: "blue",
  resolved: "neutral",
  urgent: "red",
  high: "amber",
  normal: "neutral",
  low: "neutral",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge tone={STATUS_TONES[status] ?? "neutral"}>{label ?? status.replace(/_/g, " ")}</Badge>;
}

export function DemoBadge() {
  return <SimulatedBadge label="Demo data" />;
}

export function Restricted({ children }: { children?: ReactNode }) {
  return (
    <p className="inline-flex items-center gap-2 rounded-lg bg-sand-100 px-3 py-2 text-sm font-semibold text-muted">
      <Lock aria-hidden className="size-4" />
      Restricted{children ? <span className="font-normal">— {children}</span> : null}
    </p>
  );
}

export function Section({ title, description, actions, children, id, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string; className?: string }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className={clsx("mt-8 first:mt-0", className)}>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id={id ? `${id}-title` : undefined} className="text-xl font-bold text-ink">
            {title}
          </h2>
          {description ? <div className="mt-1 max-w-3xl text-sm text-muted">{description}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function AdminHeader({ title, description, eyebrow, actions }: { title: ReactNode; description?: ReactNode; eyebrow?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-3xl">
        {eyebrow ? <p className="mb-1 text-sm font-semibold uppercase tracking-wide text-forest-700">{eyebrow}</p> : null}
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">{title}</h1>
        {description ? <div className="mt-2 text-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function When({ at, tz, age }: { at: Date | string | null | undefined; tz?: string | null; age?: boolean }) {
  if (!at) return <span className="text-muted">—</span>;
  return (
    <time dateTime={new Date(at).toISOString()} title={new Date(at).toISOString()}>
      {formatAdminDateTime(at, tz)}
      {age ? <span className="block text-xs text-muted">{formatAge(at)}</span> : null}
    </time>
  );
}

/** Minutes elapsed since `at` (request time; pages are rendered per request). */
function minutesSince(at: Date | string): number {
  return (new Date().getTime() - new Date(at).getTime()) / 60_000;
}

export function Age({ at, staleAfterMin, label }: { at: Date | string | null | undefined; staleAfterMin?: number; label?: string }) {
  if (!at) return <span className="text-muted">{label ? `${label}: ` : ""}none received</span>;
  const mins = minutesSince(at);
  const stale = staleAfterMin !== undefined && mins > staleAfterMin;
  return (
    <span className={clsx(stale && "font-semibold text-amber-ink")}>
      {label ? `${label}: ` : ""}
      {formatAge(at)}
      {stale ? " (stale)" : ""}
    </span>
  );
}

export function KpiCard({ label, value, hint, href, tone = "neutral", badge }: { label: string; value: ReactNode; hint?: ReactNode; href?: string; tone?: "neutral" | "amber" | "red"; badge?: ReactNode }) {
  const body = (
    <>
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className={clsx("mt-1 text-2xl font-bold", tone === "red" ? "text-red-ink" : tone === "amber" ? "text-amber-ink" : "text-ink")}>{value}</dd>
      {hint || badge ? (
        <dd className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
          {hint}
          {badge}
        </dd>
      ) : null}
    </>
  );
  const cls = clsx("block rounded-xl border bg-surface p-4", tone === "red" ? "border-[#f5c6c1]" : tone === "amber" ? "border-[#f1d9b0]" : "border-sand-200");
  return href ? (
    <Link href={href} className={clsx(cls, "hover:border-forest-500")}>
      <dl>{body}</dl>
    </Link>
  ) : (
    <div className={cls}>
      <dl>{body}</dl>
    </div>
  );
}

/** Mandatory wording for overdue check-ins. */
export function OverdueBanner() {
  return (
    <div role="note" className="rounded-xl border border-[#f1d9b0] bg-amber-bg p-4 text-amber-ink">
      <p className="font-semibold">
        Overdue means Ghost Guide has not received confirmation. It is not proof of an emergency. Ghost Guide does not contact emergency services
        automatically.
      </p>
      <p className="mt-1 text-sm">
        Monitoring depends on the hiker&apos;s phone having signal and the app open; it is not continuous. If you believe someone is in danger, staff
        follow the region&apos;s escalation procedure (call 911 yourself) — the app never does.
      </p>
    </div>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{k}</dt>
          <dd className="break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function money(cents: number | null | undefined, currency = "usd") {
  if (cents === null || cents === undefined) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}
