import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { ChevronLeft } from "lucide-react";
import { Alert, ButtonLink, Card, Container, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/commerce/submit-button";
import { DemoTrailBadge } from "@/components/commerce/status-badges";
import { requireUser } from "@/server/auth";
import { isEnabled } from "@/server/flags";
import { env } from "@/config/env";
import {
  MAX_ADVANCE_DAYS,
  getGearKitsAvailable,
  loadCheckoutTrip,
  loadOfferedAddons,
  previewQuote,
  tripStartTime,
  validateHikeDate,
} from "@/server/commerce/checkout";
import { getAddonRemaining, getDayAvailability } from "@/server/commerce/inventory";
import { getCommerceSettings } from "@/server/commerce/settings";
import { getTripBookingView } from "@/server/commerce/queries";
import { getClosuresOnDay, planForSelection } from "@/server/commerce/trip-plan";
import { getPaymentProvider } from "@/integrations/payments";
import { DEMO_PICKUP_POINTS } from "@/integrations/partners/shuttle/pickup-points";
import { closedOnDateMessage, describeCancellationPolicy, type ClosureVerdict } from "@/domain/booking";
import { formatDate, formatMoney } from "@/lib/format";
import { localDateInZone, formatInZone } from "@/lib/time";
import { CheckoutForm, type AddonOption } from "./checkout-form";
import { resumeCheckoutAction } from "./actions";
import { ReleaseCheckoutForm } from "./release-form";

export const metadata: Metadata = { title: "Book your hike" };
export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const longDate = (d: string) => formatDate(d, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

export default async function CheckoutPage({ params, searchParams }: PageProps<"/trips/[id]/checkout">) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser(`/trips/${id}/checkout`);
  const view = await loadCheckoutTrip(user, id);
  if (!view) notFound();
  const { trip, trail, region } = view;

  const back = (
    <p className="mb-4">
      <Link href={`/trips/${trip.id}`} className="inline-flex min-h-11 items-center gap-1 font-semibold text-forest-800 hover:underline">
        <ChevronLeft aria-hidden className="size-4" /> Back to trip
      </Link>
    </p>
  );

  // A pending checkout for this trip: show exactly what is held and offer to
  // continue it or release it (to change the details) — never a silent resume.
  const existing = await getTripBookingView(user, trip.id);
  if (existing?.booking.status === "pending_payment" && existing.holdValid) {
    const tz = region?.timezone ?? "UTC";
    const held = existing.booking;
    const heldAddons = (held.priceBreakdown.lines ?? []).filter((l) => l.kind === "addon").map((l) => l.label);
    return (
      <Container className="max-w-2xl py-8 sm:py-10">
        {back}
        <PageHeader title="Checkout in progress" description={`You already started booking ${trip.trailName}.`} />
        {one(sp.changed) ? (
          <Alert tone="amber" live="polite" className="mb-6" title="Your new choices were not applied">
            A checkout is already holding spots with the details below. Continue with it, or release it to book with different details.
          </Alert>
        ) : null}
        <Card aria-labelledby="held-heading">
          <h2 id="held-heading" className="text-lg font-bold">
            What is held for you
          </h2>
          <dl className="mt-3 grid gap-3 text-[0.95rem] sm:grid-cols-2">
            <div>
              <dt className="text-sm font-semibold text-muted">Hike date</dt>
              <dd>{longDate(held.hikeDate)}</dd>
            </div>
            <div>
              <dt className="text-sm font-semibold text-muted">Group</dt>
              <dd>
                {held.partySize} {held.partySize === 1 ? "hiker" : "hikers"}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-semibold text-muted">Add-ons</dt>
              <dd>{heldAddons.length ? heldAddons.join(", ") : "None"}</dd>
            </div>
            <div>
              <dt className="text-sm font-semibold text-muted">Total</dt>
              <dd className="font-semibold tabular-nums">{formatMoney(held.totalCents, held.currency)}</dd>
            </div>
          </dl>
          <p className="mt-4">
            Your spots are held until{" "}
            <strong>
              {held.holdExpiresAt ? formatInZone(held.holdExpiresAt, tz, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "soon"}
            </strong>
            . Nothing has been charged yet.
          </p>
          <div className="mt-5 space-y-5">
            <form action={resumeCheckoutAction.bind(null, trip.id, held.id)}>
              <SubmitButton size="lg" pendingLabel="Opening checkout…">
                Continue to payment
              </SubmitButton>
            </form>
            <ReleaseCheckoutForm tripId={trip.id} bookingId={held.id} />
          </div>
        </Card>
      </Container>
    );
  }

  if (trip.status !== "saved") {
    return (
      <Container className="max-w-2xl py-8 sm:py-10">
        {back}
        <PageHeader title="This trip is not open for booking" />
        <Card>
          <p>{trip.status === "cancelled" ? "This trip was cancelled. Plan a new hike to book again." : "This trip is already booked."}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <ButtonLink href={`/trips/${trip.id}`}>View trip</ButtonLink>
            <ButtonLink href="/plan" variant="secondary">
              Plan a hike
            </ButtonLink>
          </div>
        </Card>
      </Container>
    );
  }

  const tz = region?.timezone ?? "America/Los_Angeles";
  const now = new Date();
  const minDate = localDateInZone(now, tz);
  const maxDate = localDateInZone(new Date(now.getTime() + MAX_ADVANCE_DAYS * 86_400_000), tz);
  const startTime = tripStartTime(trip);
  const requestedDate = one(sp.date);
  const defaultDate = trip.plannedDate && trip.plannedDate >= minDate ? trip.plannedDate : localDateInZone(new Date(now.getTime() + 86_400_000), tz);
  const date = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : defaultDate;
  const partyRaw = Number(one(sp.party) ?? trip.partySize);
  const partySize = Number.isInteger(partyRaw) && partyRaw >= 1 && partyRaw <= 12 ? partyRaw : trip.partySize;
  const pickupRaw = one(sp.pickup);
  const pickup = DEMO_PICKUP_POINTS.some((p) => p.key === pickupRaw) ? pickupRaw! : DEMO_PICKUP_POINTS[0].key;

  const [checkoutEnabled, offered, settings] = await Promise.all([isEnabled("checkout_enabled"), loadOfferedAddons(trip.regionId), getCommerceSettings()]);
  const requestedCodes = (one(sp.addons) ?? "").split(",").filter(Boolean);
  // An impossible or out-of-range date never reaches the database.
  const dateError = validateHikeDate(date, startTime, tz, now);
  const [availability, remaining, gearKits, closures, selection] = dateError
    ? [null, {} as Record<string, number | null>, {} as Record<string, number>, null, null]
    : await Promise.all([
        getDayAvailability(trip.trailId, date),
        getAddonRemaining(offered, date),
        getGearKitsAvailable(offered, trip.regionId, date),
        getClosuresOnDay(trip.trailId, date, tz) as Promise<ClosureVerdict | null>,
        trail && region ? planForSelection(trip, trail, region, { hikeDate: date, partySize, startTime }, now) : Promise.resolve(null),
      ]);
  const addonOptions: AddonOption[] = offered.map((a) => ({
    code: a.code,
    name: a.name,
    description: a.description,
    kind: a.kind,
    priceCents: a.priceCents,
    pricingUnit: a.pricingUnit,
    requiresCustomerConfirmation: a.requiresCustomerConfirmation,
    remaining: remaining[a.id] ?? null,
    gearKitsLeft: a.kind === "gear_locker" ? (gearKits[a.id] ?? null) : null,
  }));
  const selected = offered.filter((a) => requestedCodes.includes(a.code));
  const occupancy = availability && availability.capacity > 0 ? Math.min(1, availability.used / availability.capacity) : 1;
  const quote = trail && !dateError ? await previewQuote({ trail, regionId: trip.regionId, hikeDate: date, partySize, addons: selected, occupancy }) : null;
  const provider = getPaymentProvider();
  const disabledReason = !checkoutEnabled ? "Booking is temporarily paused. Please check back soon." : view.unavailableReason;
  // Same rules createCheckout enforces: a full closure on the hike day (active
  // or scheduled), or a changed date/group that would finish after dark.
  const dateBlockedReason = closures?.closed ? closedOnDateMessage(closures.closed) : (selection?.daylightError ?? null);
  const dateNotices = (closures?.notices ?? []).map((c) => `${c.severity === "partial" ? "Partial closure" : "Advisory"} on this date: ${c.reason}`);
  const replanNote =
    selection?.changed && !dateBlockedReason && !dateError
      ? `Your saved plan was for ${trip.plannedDate ? longDate(trip.plannedDate) : "another date"} with ${trip.partySize} ${trip.partySize === 1 ? "hiker" : "hikers"}. Once payment is confirmed, your itinerary is recalculated for ${longDate(date)} with ${partySize} ${partySize === 1 ? "hiker" : "hikers"}: estimated finish ${selection.plan.itinerary.estimatedFinishTime}, off the trail by ${selection.plan.latestFinishTime} (conservative estimate, not an exact sunset).`
      : null;

  return (
    <Container className="py-8 sm:py-10">
      {back}
      <PageHeader
        eyebrow="Book your hike"
        title={trip.trailName}
        description={`Start time ${startTime} (${tz.replace(/_/g, " ")} time). Change the date, group size or add-ons and the price updates.`}
        actions={trip.trailIsDemo ? <DemoTrailBadge /> : null}
      />
      {one(sp.released) ? (
        <Alert tone="forest" live="polite" className="mb-6" title="Your held spots were released">
          Nothing was charged. Adjust the date, group size or add-ons, then continue when you&apos;re ready.
        </Alert>
      ) : null}
      <CheckoutForm
        tripId={trip.id}
        idempotencyKey={randomUUID()}
        minDate={minDate}
        maxDate={maxDate}
        initial={{ date, partySize, addonCodes: selected.map((a) => a.code), pickup }}
        addons={addonOptions}
        pickupPoints={DEMO_PICKUP_POINTS.map((p) => ({ key: p.key, label: p.label }))}
        quote={quote ? { lines: quote.lines, totalCents: quote.totalCents, currency: quote.currency } : null}
        quoteError={dateError}
        availability={availability ? { capacity: availability.capacity, remaining: availability.remaining, blocked: availability.blocked } : null}
        dateBlockedReason={dateBlockedReason}
        dateNotices={dateNotices}
        replanNote={replanNote}
        holdMinutes={settings.holdMinutes}
        providerSimulated={provider.simulated}
        demoMode={env().APP_MODE === "demo"}
        disabledReason={disabledReason}
      />
      <Card className="mt-6" aria-labelledby="policy-heading">
        <h2 id="policy-heading" className="text-lg font-bold">
          Cancellation policy
        </h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[0.95rem]">
          {describeCancellationPolicy(settings.policy).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Card>
      {trip.trailIsDemo ? (
        <Alert tone="amber" className="mt-6" title="Demonstration trail">
          This trail and its route are fictional. Do not use them to plan a real hike.
        </Alert>
      ) : null}
    </Container>
  );
}
