import { ExternalLink, KeyRound, Package, ScrollText } from "lucide-react";
import { Badge, SimulatedBadge } from "@/components/ui";
import { formatInZone } from "@/lib/time";
import type { BundleAddon, BundleLogistics, BundlePermit } from "@/lib/offline/wire";

/**
 * Booked add-on details (locker location and access code, shuttle pickup,
 * meal pickup) and permit status. Presentational only (no hooks): rendered
 * from the downloaded trip data on the offline help and pre-start screens,
 * and from live data on the prepare page.
 */
const PERMIT_LABEL: Record<BundlePermit["status"], string> = {
  not_started: "Not started",
  applied: "Applied",
  obtained: "Obtained",
  denied: "Denied",
  not_required: "Not required",
};

function when(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  try {
    return formatInZone(iso, timeZone, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return null;
  }
}

function AddonDetails({ a, timeZone }: { a: BundleAddon; timeZone: string }) {
  return (
    <li className="rounded-xl border border-sand-200 p-3" data-testid="logistics-addon">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-semibold">
          {a.name}
          {a.quantity > 1 ? <span className="font-normal text-muted"> × {a.quantity}</span> : null}
        </p>
        {a.simulated ? <SimulatedBadge label="Simulated partner" /> : null}
      </div>
      <p className="mt-1 text-sm text-muted">{a.statusText}</p>
      {a.locker ? (
        <div className="mt-2 space-y-1.5 text-sm">
          {a.locker.name || a.locker.location ? (
            <p>
              <span className="font-semibold">Pickup:</span> {[a.locker.name, a.locker.location].filter(Boolean).join(" — ")}
            </p>
          ) : null}
          {a.locker.items.length ? (
            <p>
              <span className="font-semibold">Reserved:</span> {a.locker.items.join(", ")}
            </p>
          ) : null}
          {a.locker.accessCode ? (
            <details className="rounded-lg bg-sand-100 p-3">
              <summary className="min-h-11 cursor-pointer content-center font-semibold">
                <KeyRound aria-hidden className="mr-1 inline size-4" /> Show locker access code
              </summary>
              <p className="mt-2 font-mono text-2xl tracking-[0.3em]" aria-label={`Access code ${a.locker.accessCode.split("").join(" ")}`} data-testid="logistics-access-code">
                {a.locker.accessCode}
              </p>
              <p className="mt-1 text-xs text-muted">
                {a.locker.codeExpiresAt ? `Valid until ${when(a.locker.codeExpiresAt, timeZone)}. ` : ""}Keep it private.
              </p>
            </details>
          ) : a.locker.codeHint ? (
            <p className="text-muted">
              Access code ending in {a.locker.codeHint}. The full code wasn&apos;t available when this trip was downloaded — download again closer to
              your hike date, or see your trip page.
            </p>
          ) : null}
          {a.locker.disclaimer ? (
            <p className="rounded-lg border border-[#f1d9b0] bg-amber-bg p-2 text-amber-ink">
              <span className="font-semibold">Important:</span> {a.locker.disclaimer}
            </p>
          ) : null}
        </div>
      ) : null}
      {a.shuttle ? (
        <div className="mt-2 space-y-1 text-sm">
          {a.shuttle.pickup ? (
            <p>
              <span className="font-semibold">{a.shuttle.confirmed ? "Pickup" : "Proposed pickup (not confirmed)"}:</span> {a.shuttle.pickup}
              {a.shuttle.pickupAt ? ` at ${when(a.shuttle.pickupAt, timeZone)}` : ""}
            </p>
          ) : null}
          {a.shuttle.dropoff ? (
            <p>
              <span className="font-semibold">Drop-off:</span> {a.shuttle.dropoff}
            </p>
          ) : null}
          {!a.shuttle.confirmed ? <p className="text-muted">No ride is booked until you confirm it on your trip page.</p> : null}
        </div>
      ) : null}
      {a.meal?.pickup ? <p className="mt-2 text-sm">{a.meal.pickup}</p> : null}
    </li>
  );
}

/** Just the add-on details (the prepare page shows permits with their own form). */
export function AddonDetailsList({ addons, timeZone }: { addons: BundleAddon[]; timeZone: string }) {
  if (!addons.length) return <p className="mt-2 text-muted">No add-ons on this booking.</p>;
  return (
    <ul className="mt-3 space-y-2">
      {addons.map((a) => (
        <AddonDetails key={a.id} a={a} timeZone={timeZone} />
      ))}
    </ul>
  );
}

export function TripLogistics({
  logistics,
  timeZone,
  headingLevel = 2,
  savedNote,
}: {
  logistics: BundleLogistics | undefined | null;
  timeZone: string;
  headingLevel?: 2 | 3;
  /** e.g. "Saved on this device when you downloaded the trip" */
  savedNote?: string;
}) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const cls = headingLevel === 2 ? "text-xl font-bold" : "text-lg font-bold";
  if (!logistics) {
    return (
      <section aria-labelledby="logistics-heading" data-testid="trip-logistics">
        <H id="logistics-heading" className={`flex items-center gap-2 ${cls}`}>
          <Package aria-hidden className="size-5" /> Your booking details
        </H>
        <p className="mt-2 text-sm text-muted">
          Not in this download. Download the trip again while you have signal to keep your add-on and permit details on this device.
        </p>
      </section>
    );
  }
  return (
    <section aria-labelledby="logistics-heading" className="space-y-4" data-testid="trip-logistics">
      <div>
        <H id="logistics-heading" className={`flex items-center gap-2 ${cls}`}>
          <Package aria-hidden className="size-5" /> Gear, shuttle &amp; meals
        </H>
        {savedNote ? <p className="mt-1 text-sm text-muted">{savedNote}</p> : null}
        <AddonDetailsList addons={logistics.addons} timeZone={timeZone} />
      </div>
      <div>
        <H className={`flex items-center gap-2 ${cls}`}>
          <ScrollText aria-hidden className="size-5" /> Permits
        </H>
        {logistics.permits.length ? (
          <ul className="mt-3 space-y-2">
            {logistics.permits.map((p) => (
              <li key={p.name} className="rounded-xl border border-sand-200 p-3 text-sm" data-testid="logistics-permit">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">{p.name}</p>
                  <Badge tone={p.status === "obtained" || p.status === "not_required" ? "forest" : p.status === "denied" ? "red" : "amber"}>
                    {PERMIT_LABEL[p.status] ?? p.status}
                  </Badge>
                </div>
                {p.confirmationRef ? <p className="mt-1">Confirmation: <span className="font-mono">{p.confirmationRef}</span></p> : null}
                <p className="mt-1 text-muted">{p.requirementSummary}</p>
                <a href={p.officialUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex min-h-11 items-center gap-1 font-semibold text-forest-800 underline">
                  Official permit page ({p.authority}) <ExternalLink aria-hidden className="size-4" />
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">No permit is listed for this trail. Always check the land manager&apos;s current rules.</p>
        )}
      </div>
    </section>
  );
}
