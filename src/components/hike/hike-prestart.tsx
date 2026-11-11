"use client";

import { CalendarClock, CalendarDays, Download, MapPin, Play, Route } from "lucide-react";
import { Alert, Badge, Button, Card, Checkbox, SimulatedBadge } from "@/components/ui";
import { formatBookedDate, startAllowed } from "@/lib/offline/start-window";
import type { HikeEngine, HikeSnapshot } from "./engine/hike-engine";
import { LimitationsList } from "./limitations";
import { formatDistanceBoth, formatMinutes } from "./format";

/**
 * Before the hike starts: trip summary (with the booked date), the
 * limitations (which must be acknowledged before starting) and the Start
 * button — enabled on the booked date only (region time zone). In demo mode
 * a clearly labelled "Start anyway (demo)" lets a demonstration run on any day.
 */
export function HikePrestart({ snap, engine, prepareHref }: { snap: HikeSnapshot; engine: HikeEngine; prepareHref: string }) {
  const b = snap.bundle!;
  const it = b.trip.itinerary;
  const expected = b.expectedReturnAt ? new Date(b.expectedReturnAt) : null;
  const w = snap.startWindow;
  const booked = w?.bookedDate ?? b.trip.bookedDate ?? b.trip.plannedDate;
  const onDate = !w || startAllowed(w);
  const bookedLong = booked ? formatBookedDate(booked, { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : null;
  const bookedShort = booked ? formatBookedDate(booked, { weekday: "short", month: "short", day: "numeric" }) : null;
  const dt = "flex items-center gap-2 text-sm text-muted";
  const icon = "size-4 shrink-0 text-forest-700";
  const canStart = snap.limitationsAcknowledged && onDate;
  const hintId = !snap.limitationsAcknowledged ? "start-hint" : !onDate ? "start-date-hint" : undefined;

  return (
    <div className="space-y-5">
      <Card aria-labelledby="ready-heading">
        <h2 id="ready-heading" className="text-xl font-bold">
          Ready when you are
        </h2>
        <dl className="mt-3 grid gap-3 text-[0.95rem] sm:grid-cols-2">
          <div>
            <dt className={dt}>
              <CalendarDays aria-hidden className={icon} /> Booked for
            </dt>
            <dd data-testid="hike-booked-date">{bookedLong ?? "Date not set"}</dd>
          </div>
          <div>
            <dt className={dt}>
              <CalendarClock aria-hidden className={icon} /> Planned
            </dt>
            <dd>
              {b.trip.startTime ? `Start ${b.trip.startTime}` : "Start time not set"}
              {it.estimatedDurationMin ? ` · about ${formatMinutes(it.estimatedDurationMin)} (estimate)` : null}
            </dd>
          </div>
          <div>
            <dt className={dt}>
              <MapPin aria-hidden className={icon} /> Trailhead
            </dt>
            <dd>{b.trail.trailheadName ?? "See trail page"}</dd>
          </div>
          <div>
            <dt className={dt}>
              <Route aria-hidden className={icon} /> Route
            </dt>
            <dd>{formatDistanceBoth(b.trail.distanceKm * 1000)}</dd>
          </div>
        </dl>
        {!onDate && w && bookedShort ? (
          <Alert tone="amber" className="mt-4" title={w.status === "early" ? `This hike is booked for ${bookedShort}` : `This hike was booked for ${bookedShort}`}>
            <p id="start-date-hint" data-testid="hike-date-notice">
              {w.status === "early"
                ? `You can start on ${bookedShort}. Until then, prepare and download your trip.`
                : "That date has passed, so this hike can't be started. Contact us from your trip page if your plans changed."}{" "}
              Dates are in {b.region.name} local time.
            </p>
          </Alert>
        ) : null}
        {expected ? (
          <p className="mt-3 text-sm">
            <Badge tone="blue">Check-in</Badge> Expected back by{" "}
            {expected.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: b.region.timezone })}. If we
            haven&apos;t received your confirmation by then plus your grace period, your contact is notified that we haven&apos;t heard from you — it
            doesn&apos;t mean we know something is wrong, and nobody calls 911 automatically.
            {b.notificationsSimulated ? (
              <>
                {" "}
                <SimulatedBadge label="Simulated notices (demo)" /> In this demo no message is actually sent.
              </>
            ) : null}
          </p>
        ) : null}
        {snap.bundleSource !== "download" || snap.downloadComplete === false ? (
          <Alert tone="amber" className="mt-4" title={snap.bundleSource !== "download" ? "Not downloaded for offline use" : "Download incomplete"}>
            This hike screen may not work without signal. <a href={prepareHref} className="font-semibold underline">Download your trip</a> on the
            preparation page before you leave coverage.
          </Alert>
        ) : (
          <p className="mt-4 flex items-center gap-2 text-sm text-forest-800">
            <Download aria-hidden className="size-4 shrink-0" /> Downloaded and verified for offline use on this device.
          </p>
        )}
        {b.trail.isDemo ? (
          <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
            <SimulatedBadge label="Demonstration trail" /> Fictional route and stories — not for navigation.
          </p>
        ) : null}
      </Card>

      <Card aria-labelledby="limits-heading" className="border-[#f1d9b0]">
        <h2 id="limits-heading" className="text-xl font-bold">
          Before you start: what this web app can&apos;t do
        </h2>
        <LimitationsList className="mt-4" />
        <div className="mt-5 border-t border-sand-200 pt-4">
          <Checkbox
            className="[&>input]:shrink-0"
            label="I've read these limitations. I'll keep the app open, carry a backup map and call 911 myself in an emergency."
            checked={snap.limitationsAcknowledged}
            onChange={(e) => engine.acknowledgeLimitations(e.target.checked)}
            data-testid="limitations-ack"
          />
        </div>
      </Card>

      <Button size="lg" className="w-full" disabled={!canStart} onClick={() => engine.start()} data-testid="hike-start" aria-describedby={hintId}>
        <Play aria-hidden className="size-5" /> Start hike
      </Button>
      {!snap.limitationsAcknowledged ? (
        <p id="start-hint" className="text-center text-sm text-muted">
          Tick the box above to start.
        </p>
      ) : null}
      {!onDate && snap.demoMode ? (
        <div className="rounded-2xl border-2 border-dashed border-amber-ink/50 bg-amber-bg/50 p-4" data-testid="hike-demo-start">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <SimulatedBadge label="Demo only" /> Demonstrations can start on any day. A real hike starts only on its booked date.
          </p>
          <Button
            variant="secondary"
            className="mt-3 w-full"
            disabled={!snap.limitationsAcknowledged}
            onClick={() => engine.start({ demoStartAnyway: true })}
            data-testid="hike-start-demo"
          >
            <Play aria-hidden className="size-5" /> Start anyway (demo)
          </Button>
        </div>
      ) : null}
    </div>
  );
}
