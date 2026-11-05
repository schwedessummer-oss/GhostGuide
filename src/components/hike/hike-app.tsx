"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { CheckCircle2, CloudOff, Loader2, ShieldAlert } from "lucide-react";
import { Alert, Badge, ButtonLink, Card, SimulatedBadge } from "@/components/ui";
import { RouteView } from "@/components/map/route-view";
import { HikeEngine, type HikeSnapshot } from "./engine/hike-engine";
import { HikeStatus } from "./hike-status";
import { DeviationPrompt, GapWarning, ReminderCard } from "./hike-alerts";
import { NarrationPanel } from "./narration-panel";
import { HikeControls } from "./hike-controls";
import { HikeSettingsPanel } from "./hike-settings";
import { GpsSimulatorPanel } from "./gps-simulator-panel";
import { HikePrestart } from "./hike-prestart";
import { formatDistanceBoth, formatElapsed, formatMinutes } from "./format";

/**
 * The active-hike screen. The server page passes only the trip id; all
 * data comes from IndexedDB (downloaded bundle) so the screen works with
 * no connection. Links to Help are plain <a> elements so they become full
 * page loads that the service worker can answer offline.
 */
export function HikeApp({ tripId, demoMode }: { tripId: string; demoMode: boolean }) {
  const [engine] = useState(() => new HikeEngine(tripId, demoMode));
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
  const finishedHere = useRef(false);
  const router = useRouter();
  const mapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void engine.init();
    return () => engine.dispose();
  }, [engine]);

  // After finishing on this screen, go to the summary once the server confirmed it.
  useEffect(() => {
    if (snap.phase === "finished" && snap.finishPending) finishedHere.current = true;
    if (snap.phase === "finished" && snap.finishSynced && finishedHere.current) {
      finishedHere.current = false;
      router.push(`/trips/${tripId}/complete`);
    }
  }, [snap.phase, snap.finishPending, snap.finishSynced, tripId, router]);

  const helpHref = `/trips/${tripId}/help`;
  const hc = snap.settings.highContrast;
  const showRoute = () => {
    mapRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    mapRef.current?.focus();
  };

  return (
    <div className={clsx("pb-6", hc && "high-contrast [&_section]:border-ink")} data-testid="hike-app" data-phase={snap.phase}>
      <div aria-live="polite" className="sr-only" data-testid="hike-announcer">
        {snap.announcement}
      </div>
      <Header snap={snap} />

      {snap.phase === "loading" ? (
        <p className="flex items-center gap-2 py-10 text-muted" role="status">
          <Loader2 aria-hidden className="size-5 motion-safe:animate-spin" /> Loading your trip from this device…
        </p>
      ) : snap.phase === "no_bundle" || snap.phase === "error" ? (
        <Alert tone={snap.phase === "error" ? "red" : "amber"} title="This hike can't open here" className="my-6">
          <p>{snap.error}</p>
          <p className="mt-2">
            Download your trip on the <a className="font-semibold underline" href={`/trips/${tripId}/prepare`}>preparation page</a> while you have
            signal. In an emergency call 911.
          </p>
        </Alert>
      ) : snap.phase === "ready" ? (
        <HikePrestart snap={snap} engine={engine} prepareHref={`/trips/${tripId}/prepare`} />
      ) : snap.phase === "finished" ? (
        <Finished snap={snap} engine={engine} tripId={tripId} />
      ) : (
        <div className="space-y-4">
          <DeviationPrompt snap={snap} engine={engine} helpHref={helpHref} onShowRoute={showRoute} />
          <ReminderCard snap={snap} engine={engine} />
          <GapWarning snap={snap} />
          {snap.startError ? (
            <Alert tone="amber" title="Not registered with Ghost Guide yet">
              {snap.startError} Your hike is still being recorded on this device.
            </Alert>
          ) : null}
          {snap.phase === "paused" ? (
            <Alert tone="blue" live="polite" title="Paused">
              Time, reminders, narration triggers and off-route prompts are paused. Your location is still saved on this device.
            </Alert>
          ) : null}
          <HikeStatus snap={snap} onSyncNow={() => engine.syncNow()} />
          {snap.gps.message && snap.gps.state !== "tracking" && snap.gps.source === "device" ? (
            <Alert tone={snap.gps.state === "denied" ? "red" : "amber"}>{snap.gps.message}</Alert>
          ) : null}
          <div ref={mapRef} tabIndex={-1} className="outline-none">
            <RouteMap snap={snap} />
          </div>
          <Stats snap={snap} />
          <Card className={clsx(hc && "border-2")}>
            <NarrationPanel snap={snap} engine={engine} />
          </Card>
          <HikeSettingsPanel snap={snap} engine={engine} />
          <GpsSimulatorPanel snap={snap} engine={engine} />
          <p className="flex gap-2 text-sm text-muted">
            <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            Ghost Guide is not an emergency service and does not monitor you continuously. In an emergency call 911 if you have any signal.
          </p>
          <HikeControls snap={snap} engine={engine} helpHref={helpHref} />
        </div>
      )}
      {snap.phase === "ready" ? <div className="mt-6"><GpsSimulatorPanel snap={snap} engine={engine} /></div> : null}
    </div>
  );
}

function Header({ snap }: { snap: HikeSnapshot }) {
  const b = snap.bundle;
  return (
    <header className="mb-4 flex flex-wrap items-start justify-between gap-2">
      <div>
        <p className="text-sm font-semibold uppercase tracking-wide text-forest-700">
          {snap.phase === "active" ? "Hiking" : snap.phase === "paused" ? "Paused" : snap.phase === "finished" ? "Finished" : "Your hike"}
        </p>
        <h1 className="text-2xl font-bold sm:text-3xl">{b?.trail.name ?? "Hike"}</h1>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {b?.trail.isDemo ? <SimulatedBadge label="Demo trail" /> : null}
        {snap.simulator.enabled ? <SimulatedBadge label="Simulated GPS" /> : null}
        {!snap.sync.online ? (
          <Badge tone="amber">
            <CloudOff aria-hidden className="size-3.5" /> Offline
          </Badge>
        ) : null}
      </div>
    </header>
  );
}

function RouteMap({ snap }: { snap: HikeSnapshot }) {
  if (!snap.route) return null;
  const fix = snap.lastFix;
  return (
    <figure>
      <RouteView
        coordinates={snap.route.coords}
        pois={snap.pois.map((p) => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng, triggerRadiusM: p.triggerRadiusM, state: p.heard ? "triggered" : "pending" }))}
        current={fix ? { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM, stale: snap.staleness === "stale" } : null}
        progressIndex={snap.progress.vertexIndex}
        label={`Route map for ${snap.bundle?.trail.name ?? "this hike"}. ${Math.round(snap.progress.fraction * 100)}% walked.${fix ? " Your position is shown in blue" + (snap.staleness === "stale" ? " (stale, shown in brown)" : "") + "." : ""}`}
        height={340}
      />
      <figcaption className="mt-1 text-xs text-muted">
        Offline route view without map tiles. Light green = walked; circles = story stops ({snap.pois.filter((p) => p.heard).length} heard).
        {snap.staleness === "stale" ? " Your location is out of date." : ""}
      </figcaption>
    </figure>
  );
}

function Stats({ snap }: { snap: HikeSnapshot }) {
  const p = snap.progress;
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="hike-progress">
      <StatBox label="Progress" value={`${Math.round(p.fraction * 100)}%`} hint={`${formatDistanceBoth(p.alongM)} done`} />
      <StatBox label="Time hiking" value={formatElapsed(snap.activeElapsedMs)} hint="Excludes pauses" />
      <StatBox label="Remaining" value={formatDistanceBoth(p.remainingM)} hint="Along the planned route" />
      <StatBox
        label="Time left (estimate)"
        value={p.remainingMin === null ? "—" : formatMinutes(p.remainingMin)}
        hint={p.remainingBasis === "observed" ? "Based on your pace so far" : p.remainingBasis === "planned" ? "Based on your itinerary" : "Not enough data"}
      />
      <StatBox
        label="From route"
        value={p.distanceFromRouteM === null ? "—" : `${Math.round(p.distanceFromRouteM)} m`}
        hint={snap.deviation.status === "off_route" ? "Possibly off route" : "Near the route"}
      />
      <StatBox label="Started" value={snap.startedAt ? new Date(snap.startedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "—"} />
    </dl>
  );
}

function StatBox({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-sand-100 p-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-bold text-ink">{value}</dd>
      {hint ? <dd className="mt-0.5 text-xs text-muted">{hint}</dd> : null}
    </div>
  );
}

function Finished({ snap, engine, tripId }: { snap: HikeSnapshot; engine: HikeEngine; tripId: string }) {
  return (
    <Card aria-labelledby="finished-heading">
      <h2 id="finished-heading" className="flex items-center gap-2 text-xl font-bold">
        <CheckCircle2 aria-hidden className="size-6 text-forest-700" /> Hike finished
      </h2>
      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatBox label="Distance" value={formatDistanceBoth(snap.progress.alongM)} />
        <StatBox label="Time hiking" value={formatElapsed(snap.activeElapsedMs)} />
        <StatBox label="Stories heard" value={`${snap.pois.filter((p) => p.heard).length} of ${snap.pois.length}`} />
      </dl>
      {snap.finishSynced ? (
        <div className="mt-4 space-y-3" role="status">
          <p>Your finish reached Ghost Guide. Any check-in reminders for this trip have stopped.</p>
          <ButtonLink href={`/trips/${tripId}/complete`} size="lg">
            See summary &amp; leave feedback
          </ButtonLink>
        </div>
      ) : (
        <Alert tone="amber" live="polite" className="mt-4" title="Finish saved on this device">
          It will be sent automatically when you&apos;re back online ({snap.sync.queued} {snap.sync.queued === 1 ? "item" : "items"} waiting). Until
          then our servers still consider you on the trail — if you set up a check-in, let your contact know you&apos;re back.
          {snap.sync.online ? (
            <button type="button" className="mt-2 block min-h-11 font-semibold underline" onClick={() => engine.syncNow()}>
              Try sending now
            </button>
          ) : null}
        </Alert>
      )}
    </Card>
  );
}
