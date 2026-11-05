import Link from "next/link";
import { Badge, SimulatedBadge, buttonClass } from "@/components/ui";
import { describeFulfillment } from "@/domain/booking";
import { formatInZone } from "@/lib/time";
import { formatMoney } from "@/lib/format";
import type { FulfillmentView } from "@/server/commerce/queries";

/**
 * Add-ons with a SEPARATE status per partner, e.g.
 * "Gear locker: confirmed — code ready", "Shuttle: awaiting your confirmation".
 * A partner problem never changes the hike booking itself.
 */
export function FulfillmentList({
  tripId,
  fulfillments,
  timezone,
  currency,
}: {
  tripId: string;
  fulfillments: FulfillmentView[];
  timezone: string;
  currency: string;
}) {
  return (
    <ul className="space-y-4">
      {fulfillments.map((f) => {
        const quoteExpired = !!f.shuttle?.quoteExpired;
        const d = describeFulfillment(f.kind, f.status, { codeReady: !!f.accessCode, shuttleQuoteExpired: quoteExpired });
        const det = f.details as Record<string, string | number | string[] | undefined>;
        return (
          <li key={f.id} className="rounded-xl border border-sand-200 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{f.addonName}</p>
                <p className="text-sm text-muted">Quantity: {f.quantity}</p>
              </div>
              {f.simulated ? <SimulatedBadge label="Simulated partner" /> : null}
            </div>
            <p className="mt-2">
              <Badge tone={d.tone}>{d.text}</Badge>
            </p>
            <p className="mt-1 text-sm text-muted">{d.detail}</p>

            {(f.kind === "gear_locker" || f.kind === "satellite_device") && f.status === "confirmed" ? (
              <div className="mt-3 space-y-2 text-sm">
                <p>
                  <span className="font-semibold">Pickup:</span> {det.lockerName} — {det.locationDescription}
                </p>
                {Array.isArray(det.items) ? (
                  <p>
                    <span className="font-semibold">Reserved:</span> {det.items.join(", ")}
                  </p>
                ) : null}
                {f.accessCode ? (
                  <details className="rounded-lg bg-sand-100 p-3">
                    <summary className="min-h-11 cursor-pointer content-center font-semibold">Show locker access code</summary>
                    <p className="mt-2 font-mono text-2xl tracking-[0.3em]" aria-label={`Access code ${f.accessCode.split("").join(" ")}`}>
                      {f.accessCode}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Valid on your hike date until {det.codeExpiresAt ? formatInZone(String(det.codeExpiresAt), timezone) : "the end of the day"}. Keep it private.
                    </p>
                  </details>
                ) : det.codeHint ? (
                  <p className="text-muted">Access code ending in {det.codeHint} (shown here on your hike date window).</p>
                ) : null}
                {det.disclaimer ? (
                  <p className="rounded-lg border border-[#f1d9b0] bg-amber-bg p-3 text-amber-ink">
                    <span className="font-semibold">Important:</span> {det.disclaimer}
                  </p>
                ) : null}
              </div>
            ) : null}

            {f.kind === "satellite_device" && f.status !== "confirmed" ? (
              <p className="mt-2 text-sm text-muted">
                The device&apos;s own satellite subscription and SOS service apply. Ghost Guide does not provide SOS.
              </p>
            ) : null}

            {f.kind === "meal_pack" && f.status === "confirmed" && det.pickup ? <p className="mt-3 text-sm">{det.pickup}</p> : null}

            {f.kind === "shuttle" ? (
              <div className="mt-3 space-y-2 text-sm">
                {det.pickup ? (
                  <p>
                    <span className="font-semibold">Pickup:</span> {det.pickup}
                    {det.pickupAt ? ` at ${formatInZone(String(det.pickupAt), timezone, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}
                    {typeof det.priceCents === "number" ? ` · ${formatMoney(det.priceCents, currency)}` : ""}
                  </p>
                ) : null}
                {f.status === "awaiting_customer" ? (
                  <Link href={`/trips/${tripId}/shuttle/${f.id}`} className={buttonClass("primary", "md")}>
                    {quoteExpired ? "Request a new quote" : "Review and confirm shuttle"}
                  </Link>
                ) : f.status === "requested" || f.status === "confirmed" ? (
                  <Link href={`/trips/${tripId}/shuttle/${f.id}`} className="inline-flex min-h-11 items-center font-semibold text-forest-800 underline">
                    Shuttle details
                  </Link>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
