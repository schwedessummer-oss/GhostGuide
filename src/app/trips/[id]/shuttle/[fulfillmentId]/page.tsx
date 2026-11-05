import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Alert, Badge, Card, Container, PageHeader, SimulatedBadge } from "@/components/ui";
import { requireUser } from "@/server/auth";
import { getShuttleForOwner } from "@/server/fulfillment/shuttle";
import { DEMO_PICKUP_POINTS } from "@/integrations/partners/shuttle/pickup-points";
import { describeFulfillment } from "@/domain/booking";
import type { FulfillmentStatus } from "@/domain/types";
import { formatMoney } from "@/lib/format";
import { formatInZone } from "@/lib/time";
import { ConfirmShuttleForm, RequoteForm } from "./shuttle-forms";

export const metadata: Metadata = { title: "Confirm your shuttle" };
export const dynamic = "force-dynamic";

export default async function ShuttlePage({ params }: PageProps<"/trips/[id]/shuttle/[fulfillmentId]">) {
  const { id, fulfillmentId } = await params;
  const user = await requireUser(`/trips/${id}/shuttle/${fulfillmentId}`);
  const s = await getShuttleForOwner(user, id, fulfillmentId);
  if (!s) notFound();

  const tz = s.timezone;
  const status = describeFulfillment("shuttle", s.fulfillmentStatus as FulfillmentStatus, { shuttleQuoteExpired: s.quoteExpired });
  const quoted = s.requestStatus === "quoted" && s.fulfillmentStatus === "awaiting_customer";
  const confirmable = quoted && !s.quoteExpired && s.pickupAt && s.quotedPriceCents != null;
  const pickupTime = s.pickupAt ? formatInZone(s.pickupAt, tz, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
  const price = s.quotedPriceCents != null ? formatMoney(s.quotedPriceCents, s.currency) : null;
  const prepaidCovers = s.quotedPriceCents != null && s.quotedPriceCents <= s.prepaidCents;

  return (
    <Container className="max-w-2xl py-8 sm:py-10">
      <p className="mb-4">
        <Link href={`/trips/${id}`} className="inline-flex min-h-11 items-center gap-1 font-semibold text-forest-800 hover:underline">
          <ChevronLeft aria-hidden className="size-4" /> Back to trip
        </Link>
      </p>
      <PageHeader
        title="Trailhead shuttle"
        description="Review the quote. No ride is requested until you confirm the pickup location, time and price."
        actions={s.simulated ? <SimulatedBadge label="Simulated partner" /> : null}
      />

      <Card>
        <p aria-live="polite">
          <Badge tone={status.tone}>{status.text}</Badge>
        </p>
        {s.requestStatus ? (
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-semibold text-muted">Pickup location</dt>
              <dd className="text-lg">{s.pickupDescription ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-sm font-semibold text-muted">Drop-off</dt>
              <dd className="text-lg">{s.dropoffDescription ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-sm font-semibold text-muted">Pickup time</dt>
              <dd className="text-lg">{pickupTime ?? "—"}</dd>
              <dd className="text-xs text-muted">Timed to reach the trailhead about 15 minutes before your start (estimate).</dd>
            </div>
            <div>
              <dt className="text-sm font-semibold text-muted">Price</dt>
              <dd className="text-lg">{price ?? "—"}</dd>
              {prepaidCovers ? <dd className="text-xs text-muted">Covered by the {formatMoney(s.prepaidCents, s.currency)} you prepaid at checkout — no extra charge.</dd> : null}
            </div>
            {s.quoteExpiresAt && quoted ? (
              <div className="sm:col-span-2">
                <dt className="text-sm font-semibold text-muted">Quote valid until</dt>
                <dd>
                  {formatInZone(s.quoteExpiresAt, tz)}
                  {s.quoteExpired ? <Badge tone="red" className="ml-2">Expired</Badge> : null}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="mt-4 text-muted">We are still requesting a quote from the shuttle partner. Check back shortly.</p>
        )}
      </Card>

      {confirmable ? (
        <Card className="mt-6">
          <h2 className="text-xl font-bold">Confirm and request your ride</h2>
          <div className="mt-4">
            <ConfirmShuttleForm
              tripId={id}
              fulfillmentId={fulfillmentId}
              quotedPriceCents={s.quotedPriceCents!}
              pickupAt={new Date(s.pickupAt!).toISOString()}
              summary={`${s.pickupDescription} → ${s.dropoffDescription}, ${pickupTime}, ${price}.`}
            />
          </div>
        </Card>
      ) : null}

      {quoted || s.fulfillmentStatus === "needs_attention" ? (
        <Card className="mt-6">
          <h2 className="text-lg font-bold">{s.quoteExpired ? "This quote expired" : "Need a different pickup point?"}</h2>
          <p className="mt-1 text-sm text-muted">
            {s.quoteExpired ? "Request a new quote to continue. Nothing has been booked or charged." : "Request a new quote from another pickup point."}
          </p>
          <div className="mt-4">
            <RequoteForm
              tripId={id}
              fulfillmentId={fulfillmentId}
              pickupPoints={DEMO_PICKUP_POINTS.map((p) => ({ key: p.key, label: p.label }))}
              currentPickup={s.pickupKey}
              primary={s.quoteExpired}
            />
          </div>
        </Card>
      ) : null}

      {s.customerConfirmedAt ? (
        <Alert tone="forest" className="mt-6" title="You confirmed this shuttle">
          Confirmed {formatInZone(s.customerConfirmedAt, tz)}. {s.fulfillmentStatus === "confirmed" ? "The partner has booked your ride." : "We are requesting the ride from the partner."}
        </Alert>
      ) : null}

      <p className="mt-6 text-sm text-muted">
        Shuttle service in this demo is simulated: no real vehicle or driver is booked. If plans change, cancelling your trip cancels the shuttle too.
      </p>
    </Container>
  );
}
