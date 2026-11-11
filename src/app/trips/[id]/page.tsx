import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Bell, ChevronLeft, Sparkles } from "lucide-react";
import { Alert, Badge, ButtonLink, Card, Container, PageHeader, SimulatedBadge } from "@/components/ui";
import { BookingStatusBadge, DemoTrailBadge, TripStatusBadge } from "@/components/commerce/status-badges";
import { PriceBreakdown } from "@/components/commerce/price-breakdown";
import { FulfillmentList } from "@/components/commerce/fulfillment-list";
import { ItinerarySummary } from "@/components/commerce/itinerary-summary";
import { HikeActionsCard } from "@/components/trip/hike-actions-card";
import { CheckinStatusCard } from "@/components/checkin/checkin-status-card";
import { getCurrentUser, requireUser } from "@/server/auth";
import { getOwnedTrip } from "@/server/trips/queries";
import { getRegionById, getTrailById } from "@/server/catalog/trails";
import { getTripBookingView, listTripReminders } from "@/server/commerce/queries";
import { getCommerceSettings } from "@/server/commerce/settings";
import { getClosuresOnDay } from "@/server/commerce/trip-plan";
import { tripStartTime } from "@/server/commerce/checkout";
import { BOOKING_STATUS_COPY, LIVE_BOOKING_STATUSES, describeCancellationPolicy } from "@/domain/booking";
import { formatDate, formatMoney, titleCase } from "@/lib/format";
import { formatInZone } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/trips/[id]">): Promise<Metadata> {
  const { id } = await params;
  const user = await getCurrentUser();
  const trip = user ? await getOwnedTrip(user, id) : null;
  return { title: trip ? `${trip.trailName} — your trip` : "Trip" };
}

export default async function TripDashboardPage({ params, searchParams }: PageProps<"/trips/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser(`/trips/${id}`);
  const trip = await getOwnedTrip(user, id);
  if (!trip) notFound();

  const [trail, region, view, settings, reminders] = await Promise.all([
    getTrailById(trip.trailId),
    getRegionById(trip.regionId),
    getTripBookingView(user, trip.id),
    getCommerceSettings(),
    listTripReminders(user, trip.id),
  ]);
  const tz = region?.timezone ?? "America/Los_Angeles";
  const b = view?.booking ?? null;
  const startTime = tripStartTime(trip);
  // A live booking (held or paid) defines the hike date and group; an expired
  // or failed checkout does not — then the saved plan does.
  const liveBooking = b && (b.status === "pending_payment" ? view?.holdValid : LIVE_BOOKING_STATUSES.includes(b.status)) ? b : null;
  const hikeDate = liveBooking?.hikeDate ?? trip.plannedDate;
  const partySize = liveBooking?.partySize ?? trip.partySize;
  const pendingDiffers =
    !!liveBooking && liveBooking.status === "pending_payment" && (liveBooking.hikeDate !== trip.plannedDate || liveBooking.partySize !== trip.partySize);
  const shuttleSimulated = view?.fulfillments.some((f) => f.kind === "shuttle" && f.simulated) ?? false;
  // Closures scheduled for the hike day matter even before they become active.
  const dayClosures = hikeDate && trip.status !== "completed" && trip.status !== "cancelled" ? await getClosuresOnDay(trip.trailId, hikeDate, tz) : null;
  const closureNotices = [
    ...(dayClosures?.closed ? [{ key: "closed", text: `Closed on your hike date: ${dayClosures.closed.reason}` }] : []),
    ...(dayClosures?.notices ?? []).map((c, i) => ({ key: `n${i}`, text: `${c.severity === "partial" ? "Partial closure" : "Advisory"} on your hike date: ${c.reason}` })),
    ...(trail?.activeClosures ?? []).map((c) => ({ key: c.id, text: c.reason })),
  ].filter((n, i, all) => all.findIndex((m) => m.text.endsWith(n.text) || n.text.endsWith(m.text)) === i);
  const realAi = !!trip.aiProvider?.startsWith("anthropic");
  const showHikeCards = trip.status === "booked" || trip.status === "active" || trip.status === "completed";
  const canCancel = (trip.status === "saved" && b?.status !== "pending_payment") || (trip.status === "booked" && b?.status === "confirmed");
  const flash = typeof sp.cancelled === "string" ? "cancelled" : typeof sp.shuttle === "string" ? "shuttle" : null;
  const lines = b?.priceBreakdown?.lines ?? [];

  return (
    <Container className="py-8 sm:py-10">
      <p className="mb-4">
        <Link href="/trips" className="inline-flex min-h-11 items-center gap-1 font-semibold text-forest-800 hover:underline">
          <ChevronLeft aria-hidden className="size-4" /> My trips
        </Link>
      </p>
      <PageHeader
        eyebrow={region?.name ?? "Your trip"}
        title={trip.trailName}
        description={
          <span>
            {hikeDate ? formatDate(hikeDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "Date not set"} · start{" "}
            {startTime} · {partySize} {partySize === 1 ? "hiker" : "hikers"}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <TripStatusBadge status={trip.status} />
            {b ? <BookingStatusBadge status={b.status} /> : null}
            {trip.trailIsDemo ? <DemoTrailBadge /> : null}
          </div>
        }
      />

      <div aria-live="polite">
        {flash === "cancelled" ? (
          <Alert tone="forest" title="Your trip was cancelled" className="mb-6">
            {b && b.refundedCents === 0 && view?.refunds.some((r) => r.status !== "succeeded")
              ? "Your refund is being processed. You'll see it on your receipt once the payment provider confirms it."
              : "Any refund due is shown below."}
          </Alert>
        ) : null}
        {flash === "shuttle" ? (
          <Alert tone="forest" title="Shuttle confirmation received" className="mb-6">
            Thanks — you confirmed the pickup location, time and price. We&apos;re now requesting your ride from the shuttle partner
            {shuttleSimulated ? " (simulated in this demo)" : ""}; the ride is booked only once the partner confirms. Its status is shown below.
          </Alert>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {showHikeCards ? <HikeActionsCard tripId={trip.id} /> : null}

          <Card aria-labelledby="booking-heading">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="booking-heading" className="text-xl font-bold">
                Booking
              </h2>
              {b?.paymentProvider === "demo" ? <SimulatedBadge label="Simulated payment" /> : null}
            </div>

            {!b || ((b.status === "expired" || b.status === "payment_failed") && trip.status === "saved") ? (
              <div className="mt-4 space-y-4">
                {b ? <Alert tone={BOOKING_STATUS_COPY[b.status].tone}>{BOOKING_STATUS_COPY[b.status].description}</Alert> : null}
                <p className="text-muted">
                  {trip.status === "saved"
                    ? "This hike is saved but not booked yet. Book to reserve your spot and add optional gear, shuttle or meals."
                    : "There is no booking for this trip."}
                </p>
                {trip.status === "saved" ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <ButtonLink href={`/trips/${trip.id}/checkout`} size="lg">
                      Book this hike
                    </ButtonLink>
                    {trail ? (
                      <span className="text-sm text-muted">From {formatMoney(trail.basePriceCents, trail.currency)} per person</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <p>{BOOKING_STATUS_COPY[b.status].description}</p>
                {b.status === "pending_payment" && view?.holdValid ? (
                  <>
                    <p className="text-[0.95rem]">
                      <span className="font-semibold">Held:</span> {formatDate(b.hikeDate, { weekday: "short", month: "short", day: "numeric", year: "numeric" })} ·{" "}
                      {b.partySize} {b.partySize === 1 ? "hiker" : "hikers"} · {formatMoney(b.totalCents, b.currency)}
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                      <ButtonLink href={`/trips/${trip.id}/checkout`}>Complete payment</ButtonLink>
                      <ButtonLink href={`/trips/${trip.id}/checkout`} variant="secondary">
                        Change details
                      </ButtonLink>
                      {b.holdExpiresAt ? (
                        <span className="text-sm text-muted">
                          Spot held until {formatInZone(b.holdExpiresAt, tz, { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}
                        </span>
                      ) : null}
                    </div>
                  </>
                ) : null}
                {b.receiptNumber ? (
                  <p>
                    <span className="font-semibold">Receipt</span> <span className="font-mono">{b.receiptNumber}</span>
                    {b.paidAt ? <span className="text-muted"> · paid {formatInZone(b.paidAt, tz)}</span> : null}
                  </p>
                ) : null}
                {lines.length ? <PriceBreakdown lines={lines} totalCents={b.totalCents} currency={b.currency} refundedCents={b.refundedCents} /> : null}
                {view?.refunds.length ? (
                  <div>
                    <h3 className="font-semibold">Refunds</h3>
                    <ul className="mt-1 space-y-1 text-[0.95rem]">
                      {view.refunds.map((r) => (
                        <li key={r.id} className="flex flex-wrap justify-between gap-2">
                          <span>
                            {formatMoney(r.amountCents, b.currency)} — {r.reason}
                          </span>
                          <Badge tone={r.status === "succeeded" ? "forest" : r.status === "failed" ? "red" : "blue"}>
                            {r.status === "succeeded" ? "Refunded" : r.status === "failed" ? "Delayed — retrying" : "Processing"}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {b.paidAt ? (
                  <ButtonLink href={`/bookings/${b.id}/receipt`} variant="secondary">
                    View receipt
                  </ButtonLink>
                ) : null}
              </div>
            )}
          </Card>

          {view?.fulfillments.length ? (
            <Card aria-labelledby="addons-heading">
              <h2 id="addons-heading" className="text-xl font-bold">
                Add-ons and partner services
              </h2>
              <p className="mt-1 text-sm text-muted">Each partner has its own status. A delay with one add-on never affects your hike booking.</p>
              <div className="mt-4">
                <FulfillmentList tripId={trip.id} fulfillments={view.fulfillments} timezone={tz} currency={b?.currency ?? "usd"} />
              </div>
            </Card>
          ) : null}

          <Card aria-labelledby="itinerary-heading">
            <h2 id="itinerary-heading" className="text-xl font-bold">
              Itinerary
            </h2>
            {pendingDiffers && liveBooking ? (
              <p className="mt-3 rounded-lg bg-blue-bg p-3 text-sm text-blue-ink">
                This itinerary is for your saved plan ({trip.plannedDate ? formatDate(trip.plannedDate, { month: "short", day: "numeric" }) : "no date"},{" "}
                {trip.partySize} {trip.partySize === 1 ? "hiker" : "hikers"}). It will be recalculated for{" "}
                {formatDate(liveBooking.hikeDate, { month: "short", day: "numeric", year: "numeric" })} with {liveBooking.partySize}{" "}
                {liveBooking.partySize === 1 ? "hiker" : "hikers"} once your payment is confirmed.
              </p>
            ) : null}
            <div className="mt-4">
              <ItinerarySummary itinerary={trip.itinerary} startTime={startTime} />
            </div>
          </Card>

          {trip.aiSummary ? (
            <Card aria-labelledby="ai-heading">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="ai-heading" className="flex items-center gap-2 text-xl font-bold">
                  <Sparkles aria-hidden className="size-5 text-forest-700" /> Trip summary
                </h2>
                <div className="flex gap-1.5">
                  {/* Only text from a real model is labeled AI-generated; template text is labeled as simulated. */}
                  {realAi ? <Badge tone="blue">AI-generated</Badge> : <SimulatedBadge label="Simulated AI (template)" />}
                </div>
              </div>
              <p className="mt-3 whitespace-pre-line">{trip.aiSummary}</p>
              <p className="mt-3 text-sm text-muted">
                {realAi ? "Written by an AI model" : "Assembled from a fixed template (no AI model)"} to explain your plan. It can be wrong and never
                changes your route, booking or safety information — rely on the trail details, closures and itinerary above.
              </p>
            </Card>
          ) : null}
        </div>

        <aside className="space-y-6" aria-label="Trip tools">
          {showHikeCards ? <CheckinStatusCard tripId={trip.id} /> : null}

          {reminders.length ? (
            <Card aria-labelledby="reminders-heading">
              <h2 id="reminders-heading" className="flex items-center gap-2 text-lg font-bold">
                <Bell aria-hidden className="size-5 text-forest-700" /> Reminders
              </h2>
              <ul className="mt-3 space-y-3 text-[0.95rem]">
                {reminders.map((r) => (
                  <li key={r.id} className="rounded-lg border border-sand-200 p-3">
                    <p className="text-sm text-muted">Permit reminder · {formatInZone(r.createdAt, tz, { dateStyle: "medium" })}</p>
                    <p className="mt-1">{r.body}</p>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-muted">
                Reminders only. Apply through the official permit link; Ghost Guide does not obtain permits for you.
              </p>
            </Card>
          ) : null}

          <Card aria-labelledby="trail-heading">
            <h2 id="trail-heading" className="text-lg font-bold">
              Trail
            </h2>
            {trail ? (
              <dl className="mt-3 space-y-2 text-[0.95rem]">
                <div>
                  <dt className="text-sm text-muted">Trailhead</dt>
                  <dd>{trail.trailheadName ?? "See trail page"}</dd>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <dt className="text-sm text-muted">Distance</dt>
                    <dd>{trail.distanceKm.toFixed(1)} km</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted">Elevation gain</dt>
                    <dd>{trail.elevationGainM} m</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted">Difficulty</dt>
                    <dd>{titleCase(trail.difficulty)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted">Route</dt>
                    <dd>{titleCase(trail.routeType)}</dd>
                  </div>
                </div>
              </dl>
            ) : (
              <p className="mt-2 text-muted">This trail is no longer listed in the catalog.</p>
            )}
            {closureNotices.length ? (
              <Alert tone={dayClosures?.closed ? "red" : "amber"} title="Closure notice" className="mt-3">
                {closureNotices.map((c) => (
                  <p key={c.key}>{c.text}</p>
                ))}
                {dayClosures?.closed && trip.status === "booked" ? (
                  <p className="mt-2">Do not hike a closed trail. You can cancel from this page, or contact support about your booking.</p>
                ) : null}
              </Alert>
            ) : null}
            {trail ? (
              <Link href={`/trails/${trail.slug}`} className="mt-2 inline-flex min-h-11 items-center font-semibold text-forest-800 underline">
                Full trail details
              </Link>
            ) : null}
          </Card>

          {canCancel || trip.status === "booked" ? (
            <Card aria-labelledby="cancel-heading">
              <h2 id="cancel-heading" className="text-lg font-bold">
                Cancellation
              </h2>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                {describeCancellationPolicy(settings.policy).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              {canCancel ? (
                <ButtonLink href={`/trips/${trip.id}/cancel`} variant="secondary" className="mt-4 w-full">
                  {trip.status === "booked" ? "Cancel booking" : "Cancel trip"}
                </ButtonLink>
              ) : (
                <p className="mt-3 text-sm">This booking can&apos;t be cancelled online right now. Please contact support.</p>
              )}
            </Card>
          ) : null}
        </aside>
      </div>
    </Container>
  );
}
