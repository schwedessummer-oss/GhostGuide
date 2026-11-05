"use client";

import { CalendarClock, Download, MapPin, Play } from "lucide-react";
import { Alert, Badge, Button, Card, Checkbox, SimulatedBadge } from "@/components/ui";
import type { HikeEngine, HikeSnapshot } from "./engine/hike-engine";
import { LimitationsList } from "./limitations";
import { formatDistanceBoth, formatMinutes } from "./format";

/**
 * Before the hike starts: trip summary, the limitations (which must be
 * acknowledged before starting) and the Start button.
 */
export function HikePrestart({ snap, engine, prepareHref }: { snap: HikeSnapshot; engine: HikeEngine; prepareHref: string }) {
  const b = snap.bundle!;
  const it = b.trip.itinerary;
  const expected = b.expectedReturnAt ? new Date(b.expectedReturnAt) : null;
  return (
    <div className="space-y-5">
      <Card aria-labelledby="ready-heading">
        <h2 id="ready-heading" className="text-xl font-bold">
          Ready when you are
        </h2>
        <dl className="mt-3 grid gap-3 text-[0.95rem] sm:grid-cols-3">
          <div className="flex gap-2">
            <MapPin aria-hidden className="mt-0.5 size-4 shrink-0 text-forest-700" />
            <div>
              <dt className="text-sm text-muted">Trailhead</dt>
              <dd>{b.trail.trailheadName ?? "See trail page"}</dd>
            </div>
          </div>
          <div className="flex gap-2">
            <CalendarClock aria-hidden className="mt-0.5 size-4 shrink-0 text-forest-700" />
            <div>
              <dt className="text-sm text-muted">Planned</dt>
              <dd>
                {b.trip.startTime ? `Start ${b.trip.startTime}` : "Start time not set"}
                {it.estimatedDurationMin ? ` · about ${formatMinutes(it.estimatedDurationMin)} (estimate)` : null}
              </dd>
            </div>
          </div>
          <div>
            <dt className="text-sm text-muted">Route</dt>
            <dd>{formatDistanceBoth(b.trail.distanceKm * 1000)}</dd>
          </div>
        </dl>
        {expected ? (
          <p className="mt-3 text-sm">
            <Badge tone="blue">Check-in</Badge> Expected back by{" "}
            {expected.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: b.region.timezone })}. If we
            haven&apos;t received your confirmation by then plus your grace period, your contact is notified that we haven&apos;t heard from you — it
            doesn&apos;t mean we know something is wrong, and nobody calls 911 automatically.
          </p>
        ) : null}
        {snap.bundleSource !== "download" || snap.downloadComplete === false ? (
          <Alert tone="amber" className="mt-4" title={snap.bundleSource !== "download" ? "Not downloaded for offline use" : "Download incomplete"}>
            This hike screen may not work without signal. <a href={prepareHref} className="font-semibold underline">Download your trip</a> on the
            preparation page before you leave coverage.
          </Alert>
        ) : (
          <p className="mt-4 flex items-center gap-2 text-sm text-forest-800">
            <Download aria-hidden className="size-4" /> Downloaded and verified for offline use on this device.
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
            label="I've read these limitations. I'll keep the app open, carry a backup map and call 911 myself in an emergency."
            checked={snap.limitationsAcknowledged}
            onChange={(e) => engine.acknowledgeLimitations(e.target.checked)}
            data-testid="limitations-ack"
          />
        </div>
      </Card>

      <Button
        size="lg"
        className="w-full"
        disabled={!snap.limitationsAcknowledged}
        onClick={() => engine.start()}
        data-testid="hike-start"
        aria-describedby={!snap.limitationsAcknowledged ? "start-hint" : undefined}
      >
        <Play aria-hidden className="size-5" /> Start hike
      </Button>
      {!snap.limitationsAcknowledged ? (
        <p id="start-hint" className="text-center text-sm text-muted">
          Tick the box above to start.
        </p>
      ) : null}
    </div>
  );
}
