import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CheckCircle2, Clock } from "lucide-react";
import { Alert, ButtonLink, Card, Container, SimulatedBadge } from "@/components/ui";
import { AutoRefresh } from "@/components/commerce/auto-refresh";
import { BookingStatusBadge } from "@/components/commerce/status-badges";
import { requireUser } from "@/server/auth";
import { getOwnedBooking } from "@/server/commerce/queries";
import { bookingStatusCopy } from "@/domain/booking";
import { formatDate, formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Booking status", robots: { index: false } };
export const dynamic = "force-dynamic";

/**
 * Return page after checkout. It NEVER confirms anything itself: it shows the
 * booking's real status, which only the signed payment webhook (or the
 * reconciliation job) can change. While pending it re-checks automatically.
 */
export default async function CheckoutSuccessPage({ searchParams }: PageProps<"/checkout/success">) {
  const sp = await searchParams;
  const bookingId = typeof sp.booking === "string" ? sp.booking : "";
  const user = await requireUser(`/checkout/success?booking=${encodeURIComponent(bookingId)}`);
  const b = await getOwnedBooking(user, bookingId);
  if (!b) notFound();
  const copy = bookingStatusCopy(b.status, { paidAt: b.paidAt });
  const tripHref = `/trips/${b.tripId}`;

  return (
    <Container className="max-w-2xl py-10">
      <Card>
        <div aria-live="polite" className="space-y-4">
          {b.status === "confirmed" ? (
            <>
              <CheckCircle2 aria-hidden className="size-12 text-forest-700" />
              <h1 className="text-3xl font-bold">You&apos;re booked!</h1>
              <p className="text-lg">
                {b.trailName} on {formatDate(b.hikeDate, { weekday: "long", month: "long", day: "numeric" })} for {b.partySize}{" "}
                {b.partySize === 1 ? "hiker" : "hikers"}.
              </p>
              <p>
                Receipt <span className="font-mono font-semibold">{b.receiptNumber}</span> · {formatMoney(b.totalCents, b.currency)} paid
              </p>
              {b.paymentProvider === "demo" ? <SimulatedBadge label="Simulated payment — nothing was charged" /> : null}
              <p className="text-muted">Next: review add-on statuses, download your trip for offline use, and set up optional check-ins from your trip page.</p>
              <div className="flex flex-wrap gap-3">
                <ButtonLink href={tripHref} size="lg">
                  Go to your trip
                </ButtonLink>
                <ButtonLink href={`/bookings/${b.id}/receipt`} variant="secondary" size="lg">
                  View receipt
                </ButtonLink>
              </div>
            </>
          ) : b.status === "pending_payment" ? (
            <>
              <Clock aria-hidden className="size-12 text-amber-ink" />
              <h1 className="text-3xl font-bold">Confirming your payment…</h1>
              <p>
                We&apos;re waiting for the payment provider to confirm your payment. Your booking is confirmed only after that confirmation arrives —
                usually within a few seconds.
              </p>
              <p>
                Status: <BookingStatusBadge status={b.status} />
              </p>
              <AutoRefresh />
              <ButtonLink href={tripHref} variant="secondary">
                Go to your trip
              </ButtonLink>
            </>
          ) : (
            <>
              <h1 className="text-3xl font-bold">{copy.label}</h1>
              <p>
                Status: <BookingStatusBadge status={b.status} paidAt={b.paidAt} />
              </p>
              <Alert tone={copy.tone}>{copy.description}</Alert>
              <div className="flex flex-wrap gap-3">
                {b.status === "payment_failed" || b.status === "expired" ? (
                  <ButtonLink href={`${tripHref}/checkout`}>Try booking again</ButtonLink>
                ) : null}
                <ButtonLink href={tripHref} variant="secondary">
                  Go to your trip
                </ButtonLink>
              </div>
            </>
          )}
        </div>
      </Card>
    </Container>
  );
}
