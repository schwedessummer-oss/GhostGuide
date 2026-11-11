import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, ButtonLink, Card, Container } from "@/components/ui";
import { BookingStatusBadge } from "@/components/commerce/status-badges";
import { requireUser } from "@/server/auth";
import { getOwnedBooking } from "@/server/commerce/queries";
import { bookingStatusCopy, holdIsValid } from "@/domain/booking";
import { formatInZone } from "@/lib/time";

export const metadata: Metadata = { title: "Checkout status", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function CheckoutCancelledPage({ searchParams }: PageProps<"/checkout/cancelled">) {
  const sp = await searchParams;
  const bookingId = typeof sp.booking === "string" ? sp.booking : "";
  const reason = sp.reason === "declined" ? "declined" : sp.reason === "cancelled" ? "cancelled" : null;
  const user = await requireUser(`/checkout/cancelled?booking=${encodeURIComponent(bookingId)}`);
  const b = await getOwnedBooking(user, bookingId);
  if (!b) notFound();
  const stillHeld = b.status === "pending_payment" && holdIsValid(b.holdExpiresAt, new Date());
  // A payment that still arrived after the checkout ended is refunded: never say "not charged" then.
  const latePaid = !!b.paidAt && (b.status === "expired" || b.status === "payment_failed");
  const tripHref = `/trips/${b.tripId}`;

  return (
    <Container className="max-w-2xl py-10">
      <Card>
        <div className="space-y-4" aria-live="polite">
          <h1 className="text-3xl font-bold">
            {b.status === "confirmed" ? "Your booking is confirmed" : reason === "declined" ? "Payment declined" : "Checkout not completed"}
          </h1>
          <p>
            Status: <BookingStatusBadge status={b.status} paidAt={b.paidAt} />
          </p>
          {b.status === "confirmed" ? (
            <Alert tone="forest" title="Good news — this booking is confirmed">
              The payment went through after all.
            </Alert>
          ) : latePaid ? (
            <Alert tone="amber">{bookingStatusCopy(b.status, { paidAt: b.paidAt }).description}</Alert>
          ) : stillHeld ? (
            <Alert tone="amber" title="Your spots are still held">
              You haven&apos;t been charged. We hold your spots until{" "}
              {b.holdExpiresAt ? formatInZone(b.holdExpiresAt, b.timezone, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "shortly"} if you
              want to finish paying. You can also release them and change the details from the checkout page.
            </Alert>
          ) : (
            <Alert tone="blue">
              {reason === "declined"
                ? "The (simulated) payment was declined. You were not charged and your spots were released."
                : "You were not charged and the held spots were released."}
            </Alert>
          )}
          <div className="flex flex-wrap gap-3">
            {b.status !== "confirmed" ? (
              <ButtonLink href={`${tripHref}/checkout`}>{stillHeld ? "Continue or change details" : "Try again"}</ButtonLink>
            ) : null}
            <ButtonLink href={tripHref} variant="secondary">
              Back to your trip
            </ButtonLink>
          </div>
        </div>
      </Card>
    </Container>
  );
}
