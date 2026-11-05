import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChevronLeft, Compass } from "lucide-react";
import { Container, SimulatedBadge } from "@/components/ui";
import { PrintButton } from "@/components/commerce/print-button";
import { PriceBreakdown } from "@/components/commerce/price-breakdown";
import { BookingStatusBadge, DemoTrailBadge } from "@/components/commerce/status-badges";
import { requireUser } from "@/server/auth";
import { getReceipt } from "@/server/commerce/queries";
import { formatDate, formatMoney, titleCase } from "@/lib/format";
import { formatInZone } from "@/lib/time";

export const metadata: Metadata = { title: "Receipt", robots: { index: false } };
export const dynamic = "force-dynamic";

const PRINT_CSS = `@media print {
  body > header, body > footer, body > a.skip-link, nav[aria-label="Main"] { display: none !important; }
  body { background: #fff; }
  .receipt { box-shadow: none !important; border: none !important; }
}`;

export default async function ReceiptPage({ params }: PageProps<"/bookings/[id]/receipt">) {
  const { id } = await params;
  const user = await requireUser(`/bookings/${id}/receipt`);
  const r = await getReceipt(user, id);
  if (!r) notFound();
  const b = r.booking;
  const tz = b.timezone;
  const simulated = b.paymentProvider === "demo";
  const paid = r.payments.filter((p) => p.status !== "failed").reduce((s, p) => s + p.amountCents, 0);
  const refunded = r.refunds.filter((x) => x.status === "succeeded").reduce((s, x) => s + x.amountCents, 0);

  return (
    <Container className="max-w-3xl py-8 sm:py-10">
      <style>{PRINT_CSS}</style>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/trips/${b.tripId}`} className="inline-flex min-h-11 items-center gap-1 font-semibold text-forest-800 hover:underline">
          <ChevronLeft aria-hidden className="size-4" /> Back to trip
        </Link>
        <PrintButton />
      </div>

      <article className="receipt rounded-[var(--radius-card)] border border-sand-200 bg-surface p-6 sm:p-10" aria-labelledby="receipt-title">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-sand-200 pb-6">
          <div>
            <p className="flex items-center gap-2 text-lg font-bold text-forest-800">
              <Compass aria-hidden className="size-5" /> Ghost Guide
            </p>
            <h1 id="receipt-title" className="mt-2 text-2xl font-bold">
              Receipt
            </h1>
            <p className="font-mono text-lg">{b.receiptNumber}</p>
          </div>
          <div className="text-right text-sm">
            <p>Paid {b.paidAt ? formatInZone(b.paidAt, tz) : "—"}</p>
            <p className="mt-1">
              <BookingStatusBadge status={b.status} />
            </p>
          </div>
        </header>

        {simulated || b.trailIsDemo ? (
          <div className="mt-6 flex flex-wrap gap-2">
            {simulated ? <SimulatedBadge label="Simulated payment — no money was charged" /> : null}
            {b.trailIsDemo ? <DemoTrailBadge /> : null}
          </div>
        ) : null}

        <section className="mt-6 grid gap-4 sm:grid-cols-2" aria-label="Booking details">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Billed to</h2>
            <p>{r.customerName ?? "Customer"}</p>
            <p className="text-muted">{r.customerEmail}</p>
          </div>
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Experience</h2>
            <p>Self-guided hike: {b.trailName}</p>
            <p className="text-muted">
              {formatDate(b.hikeDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" })} · {b.partySize}{" "}
              {b.partySize === 1 ? "hiker" : "hikers"}
            </p>
          </div>
        </section>

        <section className="mt-8" aria-labelledby="items-heading">
          <h2 id="items-heading" className="text-lg font-bold">
            Items
          </h2>
          <div className="mt-2">
            <PriceBreakdown lines={b.priceBreakdown.lines ?? []} totalCents={b.totalCents} currency={b.currency} caption="Receipt line items" />
          </div>
        </section>

        <section className="mt-8" aria-labelledby="payments-heading">
          <h2 id="payments-heading" className="text-lg font-bold">
            Payments
          </h2>
          <table className="mt-2 w-full text-left text-[0.95rem]">
            <thead>
              <tr className="border-b border-sand-200 text-sm text-muted">
                <th scope="col" className="py-2 font-semibold">Date</th>
                <th scope="col" className="py-2 font-semibold">Method</th>
                <th scope="col" className="py-2 font-semibold">Status</th>
                <th scope="col" className="py-2 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-sand-200">
              {r.payments.map((p) => (
                <tr key={p.id}>
                  <td className="py-2">{formatInZone(p.createdAt, tz, { dateStyle: "medium" })}</td>
                  <td className="py-2">{p.provider === "demo" ? "Simulated provider" : "Card (Stripe)"}</td>
                  <td className="py-2">{titleCase(p.status)}</td>
                  <td className="py-2 text-right tabular-nums">{formatMoney(p.amountCents, p.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {r.refunds.length ? (
          <section className="mt-8" aria-labelledby="refunds-heading">
            <h2 id="refunds-heading" className="text-lg font-bold">
              Refunds
            </h2>
            <table className="mt-2 w-full text-left text-[0.95rem]">
              <thead>
                <tr className="border-b border-sand-200 text-sm text-muted">
                  <th scope="col" className="py-2 font-semibold">Date</th>
                  <th scope="col" className="py-2 font-semibold">Reason</th>
                  <th scope="col" className="py-2 font-semibold">Status</th>
                  <th scope="col" className="py-2 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand-200">
                {r.refunds.map((x) => (
                  <tr key={x.id}>
                    <td className="py-2">{formatInZone(x.createdAt, tz, { dateStyle: "medium" })}</td>
                    <td className="py-2">{x.reason}</td>
                    <td className="py-2">{x.status === "succeeded" ? "Refunded" : x.status === "failed" ? "Delayed — retrying" : "Processing"}</td>
                    <td className="py-2 text-right tabular-nums">−{formatMoney(x.amountCents, b.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        <section className="mt-8 border-t-2 border-ink/80 pt-4" aria-label="Summary">
          <dl className="ml-auto max-w-xs space-y-1">
            <div className="flex justify-between">
              <dt>Paid</dt>
              <dd className="tabular-nums">{formatMoney(paid, b.currency)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Refunded</dt>
              <dd className="tabular-nums">−{formatMoney(refunded, b.currency)}</dd>
            </div>
            <div className="flex justify-between text-lg font-bold">
              <dt>Net</dt>
              <dd className="tabular-nums">{formatMoney(paid - refunded, b.currency)}</dd>
            </div>
          </dl>
        </section>

        <footer className="mt-10 text-xs text-muted">
          <p>Prices include all pricing-rule adjustments shown above. Taxes are not itemized in this MVP.</p>
          {simulated ? <p className="mt-1">This receipt documents a simulated demo transaction and is not a record of a real payment.</p> : null}
        </footer>
      </article>
    </Container>
  );
}
