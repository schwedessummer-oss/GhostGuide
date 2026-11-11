import Link from "next/link";
import type { Metadata } from "next";
import { CalendarDays, Users } from "lucide-react";
import { ButtonLink, Card, Container, EmptyState, PageHeader } from "@/components/ui";
import { BookingStatusBadge, DemoTrailBadge, TripStatusBadge } from "@/components/commerce/status-badges";
import { requireUser } from "@/server/auth";
import { listOwnedTrips, type TripRow } from "@/server/trips/queries";
import { listTripBookingSummaries } from "@/server/commerce/queries";
import { nextActionForTrip } from "@/domain/booking";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = { title: "My trips" };
export const dynamic = "force-dynamic";

type Summary = Awaited<ReturnType<typeof listTripBookingSummaries>>[string];

function TripCard({ trip, summary }: { trip: TripRow; summary?: Summary }) {
  const action = nextActionForTrip({
    tripId: trip.id,
    tripStatus: trip.status,
    bookingId: summary?.bookingId,
    bookingStatus: summary?.status,
    holdValid: summary?.holdValid,
    resumeUrl: `/trips/${trip.id}/checkout`,
    awaitingShuttleFulfillmentId: summary?.awaitingShuttleFulfillmentId,
  });
  // A live (held or paid) booking defines the hike date and group shown here.
  const date = summary?.live ? summary.hikeDate : trip.plannedDate;
  const party = summary?.live ? summary.partySize : trip.partySize;
  return (
    <li>
      <Card className="flex h-full flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="text-lg font-bold">
            <Link href={`/trips/${trip.id}`} className="underline-offset-4 hover:underline">
              {trip.trailName}
            </Link>
          </h3>
          <div className="flex flex-wrap gap-1.5">
            <TripStatusBadge status={trip.status} />
            {summary ? <BookingStatusBadge status={summary.status} /> : null}
          </div>
        </div>
        {trip.trailIsDemo ? (
          <p>
            <DemoTrailBadge />
          </p>
        ) : null}
        <dl className="grid grid-cols-1 gap-2 text-[0.95rem] sm:grid-cols-2">
          <div className="flex items-center gap-2">
            <CalendarDays aria-hidden className="size-4 text-forest-700" />
            <dt className="sr-only">Date</dt>
            <dd>{date ? formatDate(date, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "Date not set"}</dd>
          </div>
          <div className="flex items-center gap-2">
            <Users aria-hidden className="size-4 text-forest-700" />
            <dt className="sr-only">Party size</dt>
            <dd>
              {party} {party === 1 ? "hiker" : "hikers"}
            </dd>
          </div>
        </dl>
        <div className="mt-auto flex flex-wrap gap-2">
          {action ? (
            <ButtonLink href={action.href} variant={action.label === "Book this hike" || action.label === "Complete payment" ? "primary" : "secondary"}>
              {action.label}
            </ButtonLink>
          ) : null}
          {action?.href !== `/trips/${trip.id}` ? (
            <ButtonLink href={`/trips/${trip.id}`} variant="ghost">
              Trip details
            </ButtonLink>
          ) : null}
        </div>
      </Card>
    </li>
  );
}

function Section({ title, trips, summaries }: { title: string; trips: TripRow[]; summaries: Record<string, Summary> }) {
  if (!trips.length) return null;
  const id = `trips-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="space-y-4">
      <h2 id={id} className="text-xl font-bold">
        {title} <span className="text-base font-normal text-muted">({trips.length})</span>
      </h2>
      <ul className="grid gap-4 md:grid-cols-2">
        {trips.map((t) => (
          <TripCard key={t.id} trip={t} summary={summaries[t.id]} />
        ))}
      </ul>
    </section>
  );
}

export default async function MyTripsPage() {
  const user = await requireUser("/trips");
  const [trips, summaries] = await Promise.all([listOwnedTrips(user), listTripBookingSummaries(user)]);

  const upcoming = trips.filter((t) => t.status === "booked" || t.status === "active");
  const saved = trips.filter((t) => t.status === "saved");
  const past = trips.filter((t) => t.status === "completed");
  const cancelled = trips.filter((t) => t.status === "cancelled");

  return (
    <Container className="py-8 sm:py-10">
      <PageHeader
        title="My trips"
        description="Saved plans, booked hikes and past adventures."
        actions={trips.length ? <ButtonLink href="/plan">Plan another hike</ButtonLink> : null}
      />
      {trips.length === 0 ? (
        <EmptyState title="No trips yet" action={<ButtonLink href="/plan" size="lg">Plan a hike</ButtonLink>}>
          Answer a few questions and we&apos;ll suggest a hike with a personalized itinerary you can book.
        </EmptyState>
      ) : (
        <div className="space-y-10">
          <Section title="Booked and active" trips={upcoming} summaries={summaries} />
          <Section title="Saved" trips={saved} summaries={summaries} />
          <Section title="Completed" trips={past} summaries={summaries} />
          <Section title="Cancelled" trips={cancelled} summaries={summaries} />
        </div>
      )}
    </Container>
  );
}
