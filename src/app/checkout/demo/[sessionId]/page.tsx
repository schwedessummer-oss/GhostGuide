import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { Alert, ButtonLink, Card, Container, SimulatedBadge } from "@/components/ui";
import { BookingStatusBadge } from "@/components/commerce/status-badges";
import { env } from "@/config/env";
import { requireUser } from "@/server/auth";
import { getDemoCheckoutView } from "@/server/commerce/demo-checkout";
import { formatDate, formatMoney } from "@/lib/format";
import { formatInZone } from "@/lib/time";
import type { BookingStatus } from "@/domain/types";
import { DemoPaymentControls } from "./demo-payment-controls";

export const metadata: Metadata = { title: "Simulated checkout", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function DemoCheckoutPage({ params }: PageProps<"/checkout/demo/[sessionId]">) {
  const { sessionId } = await params;
  if (env().APP_MODE !== "demo") notFound();
  const user = await requireUser(`/checkout/demo/${sessionId}`);
  const view = await getDemoCheckoutView(user, sessionId);
  if (!view) notFound();
  const { session } = view;
  const open = session.status === "open";

  return (
    <Container className="max-w-2xl py-8 sm:py-10">
      <div role="note" className="mb-6 flex items-start gap-3 rounded-xl border-2 border-amber-ink/40 bg-amber-bg p-4 text-amber-ink">
        <ShieldAlert aria-hidden className="mt-0.5 size-6 shrink-0" />
        <div>
          <p className="text-lg font-bold">Simulated checkout — no real payment</p>
          <p className="text-[0.95rem]">
            This page stands in for a payment provider in demo mode. No card details are collected and no money moves. In live mode customers pay on
            Stripe&apos;s hosted checkout instead.
          </p>
        </div>
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-bold">Pay for your hike</h1>
          <SimulatedBadge label="Simulated provider" />
        </div>
        <p className="mt-1 text-muted">
          {view.trailName} · {formatDate(view.hikeDate, { weekday: "short", month: "short", day: "numeric", year: "numeric" })} · {view.partySize}{" "}
          {view.partySize === 1 ? "hiker" : "hikers"}
        </p>

        <table className="mt-5 w-full text-left">
          <caption className="sr-only">Line items</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sand-200">
            {session.lineItems.map((li, i) => (
              <tr key={`${li.label}-${i}`}>
                <th scope="row" className="py-2 pr-4 font-normal">
                  {li.label}
                </th>
                <td className="py-2 text-right tabular-nums">{formatMoney(li.amountCents, session.currency)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-ink/80">
              <th scope="row" className="pt-3 text-lg font-bold">
                Amount due
              </th>
              <td className="pt-3 text-right text-2xl font-bold tabular-nums">{formatMoney(session.amountTotal, session.currency)}</td>
            </tr>
          </tfoot>
        </table>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
          <span className="text-muted">Booking:</span>
          <BookingStatusBadge status={view.bookingStatus as BookingStatus} />
          {open && view.holdExpiresAt ? (
            <span className="text-muted">Spots held until {formatInZone(view.holdExpiresAt, view.timezone, { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</span>
          ) : null}
        </div>
      </Card>

      {!open ? (
        <Alert tone="blue" className="mt-6" title={session.status === "complete" ? "This simulated payment is complete" : "This simulated checkout has ended"}>
          <div className="mt-2 flex flex-wrap gap-3">
            <ButtonLink href={session.status === "complete" ? session.successUrl : session.cancelUrl} variant="secondary">
              {session.status === "complete" ? "See booking status" : "Back to checkout result"}
            </ButtonLink>
          </div>
        </Alert>
      ) : null}

      <Card className="mt-6">
        <DemoPaymentControls sessionId={session.id} open={open} canRedeliver={!!session.lastEventBody} />
      </Card>
    </Container>
  );
}
