import { OctagonAlert, TriangleAlert } from "lucide-react";
import { formatInZone } from "@/lib/time";
import type { BundleClosure } from "@/lib/offline/wire";

/**
 * Trail closures (from the trip data the server sent; never invented). A full
 * closure is red and states the hike can't be started; partial closures and
 * advisories are amber and listed prominently. Presentational only (no hooks):
 * used by the hike pre-start and active screens and the prepare page.
 */
const SEVERITY_LABEL: Record<string, string> = { closed: "Trail closed", partial: "Partial closure", advisory: "Advisory" };

function period(c: BundleClosure, timeZone: string): string {
  const f = (iso: string) => formatInZone(iso, timeZone, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const from = c.startsAt && Date.parse(c.startsAt) > Date.now() ? `from ${f(c.startsAt)}` : null;
  const to = c.endsAt ? `until ${f(c.endsAt)}` : "until further notice";
  return [from, to].filter(Boolean).join(" ");
}

export function ClosureNotice({
  closures,
  blocking,
  timeZone,
  context,
  className,
}: {
  closures: BundleClosure[];
  /** a full closure that blocks the hike (today, or the booked date) */
  blocking: BundleClosure | null;
  timeZone: string;
  /** what the blocking closure means here */
  context: "start" | "booked" | "active";
  className?: string;
}) {
  if (!closures.length && !blocking) return null;
  const others = closures.filter((c) => c !== blocking && !(blocking && c.reason === blocking.reason && c.severity === blocking.severity));
  const full = others.filter((c) => c.severity === "closed");
  const partial = others.filter((c) => c.severity !== "closed");
  return (
    <div className={className} data-testid="closure-notice">
      {blocking ? (
        <div role="alert" className="rounded-[var(--radius-card)] border-2 border-red-ink/50 bg-red-bg p-4 text-red-ink" data-testid="closure-blocking">
          <p className="flex items-center gap-2 text-lg font-bold">
            <OctagonAlert aria-hidden className="size-5 shrink-0" /> Trail closed
          </p>
          <p className="mt-1 text-ink">
            <strong>{blocking.reason.replace(/[.\s]+$/, "")}.</strong> {period(blocking, timeZone)}.
          </p>
          <p className="mt-2 text-ink">
            {context === "start"
              ? "This hike can't be started while the trail is closed — Ghost Guide won't start it, even in a demonstration. Do not hike a closed trail."
              : context === "booked"
                ? "The trail is closed on your booked date, so the hike can't be started that day. Contact us from your trip page about changing or cancelling your booking."
                : "The trail has been closed. Follow posted signs and instructions from rangers or land managers, and leave the trail by the safest route."}
          </p>
        </div>
      ) : null}
      {full.length || partial.length ? (
        <div
          role={blocking ? undefined : "status"}
          className={`${blocking ? "mt-3 " : ""}rounded-[var(--radius-card)] border-2 ${full.length ? "border-red-ink/40 bg-red-bg" : "border-[#f1d9b0] bg-amber-bg"} p-4`}
          data-testid="closure-list"
        >
          <p className={`flex items-center gap-2 font-bold ${full.length ? "text-red-ink" : "text-amber-ink"}`}>
            <TriangleAlert aria-hidden className="size-5 shrink-0" /> {full.length ? "Closures on this trail" : "Partial closure or advisory on this trail"}
          </p>
          <ul className="mt-2 space-y-1.5 text-ink">
            {[...full, ...partial].map((c, i) => (
              <li key={`${c.severity}-${i}`}>
                <strong>{SEVERITY_LABEL[c.severity] ?? "Notice"}:</strong> {c.reason.replace(/[.\s]+$/, "")} ({period(c, timeZone)}).
              </li>
            ))}
          </ul>
          {partial.length ? <p className="mt-2 text-sm text-ink">Part of the route may be closed or different from the route shown. Follow posted signs.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
