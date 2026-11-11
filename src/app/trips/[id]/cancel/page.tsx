import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Alert, Badge, ButtonLink, Card, Container, PageHeader } from "@/components/ui";
import { DemoTrailBadge } from "@/components/commerce/status-badges";
import { requireUser } from "@/server/auth";
import { getCancellationPreview } from "@/server/commerce/cancellation";
import { ADDON_KIND_LABEL, type AddonKind } from "@/domain/booking";
import { formatMoney } from "@/lib/format";
import { formatInZone } from "@/lib/time";
import { CancelForm } from "./cancel-form";

export const metadata: Metadata = { title: "Cancel trip" };
export const dynamic = "force-dynamic";

function hoursText(h: number) {
  if (h < 0) return "Your start time has passed.";
  if (h < 48) return `${Math.floor(h)} hours until your start time.`;
  return `${Math.floor(h / 24)} days until your start time.`;
}

export default async function CancelTripPage({ params }: PageProps<"/trips/[id]/cancel">) {
  const { id } = await params;
  const user = await requireUser(`/trips/${id}/cancel`);
  const p = await getCancellationPreview(user, id);
  if (!p) notFound();
  const b = p.booking;
  const refund = p.refund;
  const currency = b?.currency ?? "usd";

  return (
    <Container className="max-w-2xl py-8 sm:py-10">
      <p className="mb-4">
        <Link href={`/trips/${id}`} className="inline-flex min-h-11 items-center gap-1 font-semibold text-forest-800 hover:underline">
          <ChevronLeft aria-hidden className="size-4" /> Back to trip
        </Link>
      </p>
      <PageHeader
        title={b ? "Cancel your booking" : "Cancel this trip"}
        description={p.trailName}
        actions={p.trailIsDemo ? <DemoTrailBadge /> : null}
      />

      {!p.canCancel ? (
        <Alert tone="amber" title="This trip can't be cancelled here">
          <p>{p.blockedReason}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            {b?.status === "pending_payment" ? <ButtonLink href={`/trips/${id}/checkout`}>Review or release the checkout</ButtonLink> : null}
            <ButtonLink href={`/trips/${id}`} variant="secondary">
              Back to trip
            </ButtonLink>
          </div>
        </Alert>
      ) : (
        <div className="space-y-6">
          {b && refund ? (
            <Card aria-labelledby="refund-heading">
              <h2 id="refund-heading" className="text-xl font-bold">
                Your refund
              </h2>
              {p.hikeStart ? (
                <p className="mt-1 text-muted">
                  Start: {formatInZone(p.hikeStart, p.timezone)}. {hoursText(refund.hoursBeforeStart)}
                </p>
              ) : null}
              <dl className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <dt className="text-sm font-semibold text-muted">You paid</dt>
                  <dd className="text-lg tabular-nums">{formatMoney(b.paidCents, currency)}</dd>
                </div>
                <div>
                  <dt className="text-sm font-semibold text-muted">Refund if you cancel now</dt>
                  <dd className="text-2xl font-bold tabular-nums">{formatMoney(refund.refundCents, currency)}</dd>
                  <dd>
                    <Badge tone={refund.tier === "full" ? "forest" : refund.tier === "partial" ? "amber" : "red"}>
                      {refund.tier === "full" ? "Full refund" : refund.tier === "partial" ? `${refund.pct}% refund` : "No refund"}
                    </Badge>
                  </dd>
                </div>
              </dl>
              {b.refundedCents > 0 ? <p className="mt-3 text-sm text-muted">Already refunded: {formatMoney(b.refundedCents, currency)}.</p> : null}
              <p className="mt-3 text-sm text-muted">Refunds go back to the original payment method. In demo mode refunds are simulated.</p>
            </Card>
          ) : (
            <Card>
              <p>This trip isn&apos;t booked, so there is nothing to refund. Cancelling removes it from your upcoming plans.</p>
            </Card>
          )}

          <Card aria-labelledby="policy-heading">
            <h2 id="policy-heading" className="text-lg font-bold">
              Cancellation policy
            </h2>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {p.policyLines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            {p.openAddons.length ? (
              <>
                <h3 className="mt-4 font-semibold">These add-ons will be cancelled too</h3>
                <ul className="mt-1 list-disc pl-5">
                  {p.openAddons.map((a, i) => (
                    <li key={`${a.kind}-${i}`}>{ADDON_KIND_LABEL[a.kind as AddonKind] ?? a.kind}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {b ? <p className="mt-3 text-sm text-muted">Any check-ins and reminders for this trip will stop.</p> : null}
          </Card>

          <Card>
            <CancelForm
              tripId={id}
              buttonLabel={b && refund ? (refund.refundCents > 0 ? `Cancel and refund ${formatMoney(refund.refundCents, currency)}` : "Cancel without refund") : "Cancel trip"}
              acknowledgement={
                b ? "I understand this cancels my booking and add-ons and can't be undone." : "I understand this cancels the trip and can't be undone."
              }
            />
          </Card>
        </div>
      )}
    </Container>
  );
}
