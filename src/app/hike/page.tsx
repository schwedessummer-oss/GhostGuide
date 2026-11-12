import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CalendarClock, CloudDownload, Compass, Footprints, LifeBuoy, Play } from "lucide-react";
import { Badge, ButtonLink, Container } from "@/components/ui";
import { getCurrentUser, type SessionUser } from "@/server/auth";
import { listOwnedTrips, type TripRow } from "@/server/trips/queries";
import { listTripBookingSummaries } from "@/server/commerce/queries";
import { getHikeOverview, type HikeOverview } from "@/server/hike/queries";
import { getRegionById } from "@/server/catalog/trails";
import { formatInZone, localDateInZone } from "@/lib/time";
import { formatBookedDate, hikeStartWindow } from "@/lib/offline/start-window";
import { formatLength } from "@/lib/units";
import { getUnitsPreference } from "@/components/site/units-server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Hike" };

const TRACKING_NOTE =
  "Live tracking with check-ins works on Ghost Guide trips today, and is coming to every trail. You can still open any trail’s page for the forecast, daylight and directions.";

/** Trips in progress (with their open session) and booked hikes from today on, soonest first. */
async function loadHikes(user: SessionUser) {
  const [trips, summaries] = await Promise.all([listOwnedTrips(user), listTripBookingSummaries(user)]);
  const active = trips.filter((t) => t.status === "active");
  const booked = trips.filter((t) => t.status === "booked");
  const tz = new Map<string, string>();
  for (const regionId of new Set(booked.map((t) => t.regionId))) {
    tz.set(regionId, (await getRegionById(regionId))?.timezone ?? "UTC");
  }
  const now = new Date();
  const upcoming = booked
    .map((trip) => {
      const s = summaries[trip.id];
      const date = s?.live ? s.hikeDate : trip.plannedDate;
      const timezone = tz.get(trip.regionId) ?? "UTC";
      return { trip, date, timezone, window: hikeStartWindow(date, timezone, now) };
    })
    .filter((u) => !u.date || u.date >= localDateInZone(now, u.timezone))
    .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));
  const activeOverviews = (await Promise.all(active.map((t) => getHikeOverview(user, t.id)))).filter((o): o is HikeOverview => o !== null);
  return { active: activeOverviews, upcoming };
}

function ChooseTrail({ signedIn }: { signedIn: boolean }) {
  return (
    <section aria-labelledby="choose-heading" className="rounded-[var(--radius-card)] border border-sand-200 bg-surface p-6 sm:p-8">
      <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-forest-100 text-forest-800">
        <Compass aria-hidden className="size-6" />
      </span>
      <h2 id="choose-heading" className="mt-4 text-2xl font-bold text-ink">
        Choose a trail to hike
      </h2>
      <p className="mt-2 max-w-prose text-muted">{TRACKING_NOTE}</p>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <ButtonLink href="/explore" size="lg">
          Explore trails <ArrowRight aria-hidden className="size-5" />
        </ButtonLink>
        {signedIn ? null : (
          <p className="text-muted">
            Booked a Ghost Guide trip?{" "}
            <Link href="/login?next=/hike" className="font-semibold text-forest-800 underline underline-offset-2">
              Sign in
            </Link>{" "}
            to open it here.
          </p>
        )}
      </div>
    </section>
  );
}

const rowLink = "flex min-h-12 items-center gap-3 rounded-xl border border-sand-200 px-4 py-3 font-semibold text-ink hover:bg-forest-50";

function ActiveHike({ o, units }: { o: HikeOverview; units: "imperial" | "metric" }) {
  const session = o.openSession;
  const tz = o.booked?.timezone ?? "UTC";
  const base = `/trips/${o.trip.id}`;
  return (
    <section aria-labelledby={`active-${o.trip.id}`} className="rounded-[var(--radius-card)] border-2 border-forest-600 bg-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold tracking-wide text-forest-700 uppercase">Hike in progress</p>
        <Badge tone={session?.status === "paused" ? "amber" : "forest"}>{session?.status === "paused" ? "Paused" : "Active"}</Badge>
      </div>
      <h2 id={`active-${o.trip.id}`} className="mt-2 text-2xl font-bold text-ink">
        {o.trip.trailName}
      </h2>
      <p className="mt-1 text-muted">
        {session
          ? `Started ${formatInZone(session.startedAt, tz, { weekday: "short", hour: "numeric", minute: "2-digit" })} · ${formatLength(session.distanceCompletedM, units)} covered at the last sync`
          : "Your hike is in progress."}
      </p>
      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        {/* Plain anchors: full page loads the service worker can serve offline. */}
        <a href={`${base}/hike`} className="flex min-h-13 items-center justify-center gap-2 rounded-xl bg-forest-700 px-5 font-semibold text-white hover:bg-forest-800">
          <Play aria-hidden className="size-5" /> Resume hike
        </a>
        <a href={`${base}/help`} className={rowLink}>
          <LifeBuoy aria-hidden className="size-5 text-red-ink" /> Help &amp; emergency info
        </a>
      </div>
    </section>
  );
}

function UpcomingHike({ trip, date, window }: { trip: TripRow; date: string | null; window: ReturnType<typeof hikeStartWindow> }) {
  const base = `/trips/${trip.id}`;
  const today = window.status === "today";
  return (
    <li className="rounded-[var(--radius-card)] border border-sand-200 bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-bold">
            <Link href={base} className="underline-offset-4 hover:underline">
              {trip.trailName}
            </Link>
          </h3>
          <p className="mt-0.5 flex items-center gap-1.5 text-muted">
            <CalendarClock aria-hidden className="size-4" />
            {date ? formatBookedDate(date, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "Date not set"}
          </p>
        </div>
        {today ? <Badge tone="forest">Today</Badge> : null}
        {trip.trailIsDemo ? <Badge tone="amber">Demo trail</Badge> : null}
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <Link href={`${base}/prepare`} className={rowLink}>
          <CloudDownload aria-hidden className="size-5 text-forest-700" /> Prepare &amp; download
        </Link>
        <a href={`${base}/hike`} className={today ? "flex min-h-12 items-center justify-center gap-2 rounded-xl bg-forest-700 px-4 font-semibold text-white hover:bg-forest-800" : rowLink}>
          <Footprints aria-hidden className={today ? "size-5" : "size-5 text-forest-700"} /> {today ? "Start hike" : "Hike screen"}
        </a>
      </div>
      {!today && date ? <p className="mt-2 text-sm text-muted">You can start this hike on the booked date; until then the hike screen is a preview.</p> : null}
    </li>
  );
}

export default async function HikeTabPage() {
  const user = await getCurrentUser();
  const [data, units] = await Promise.all([user ? loadHikes(user) : null, getUnitsPreference()]);
  const hasHikes = Boolean(data && (data.active.length || data.upcoming.length));

  return (
    <Container className="py-8 sm:py-10">
      <div className="max-w-3xl">
        <h1 className="text-3xl font-bold text-ink sm:text-4xl">Hike</h1>
        <p className="mt-2 text-lg text-muted">{hasHikes ? "Your hike today and what’s coming up." : "Everything for the day you’re on the trail."}</p>

        <div className="mt-8 space-y-8">
          {data?.active.map((o) => <ActiveHike key={o.trip.id} o={o} units={units} />)}

          {data?.upcoming.length ? (
            <section aria-labelledby="upcoming-heading">
              <h2 id="upcoming-heading" className="mb-3 text-xl font-bold">
                Upcoming hikes
              </h2>
              <ul className="space-y-3">
                {data.upcoming.map((u) => (
                  <UpcomingHike key={u.trip.id} trip={u.trip} date={u.date} window={u.window} />
                ))}
              </ul>
            </section>
          ) : null}

          {hasHikes ? (
            <p className="text-sm text-muted">
              {TRACKING_NOTE}{" "}
              <Link href="/explore" className="font-semibold text-forest-800 underline underline-offset-2">
                Explore trails
              </Link>
            </p>
          ) : (
            <ChooseTrail signedIn={Boolean(user)} />
          )}
        </div>
      </div>
    </Container>
  );
}
