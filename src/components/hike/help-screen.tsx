"use client";

import { useEffect, useState } from "react";
import { Copy, LocateFixed, MessageSquareText, Phone, Satellite, ShieldAlert, TreePine } from "lucide-react";
import { Alert, Button, Card, SimulatedBadge } from "@/components/ui";
import { fetchBundleDetailed, getStoredBundle } from "@/lib/offline/bundle-store";
import { loadHikeState, saveHikeState } from "@/lib/offline/hike-state";
import { SIGN_IN_AGAIN, currentOwnerHint, enforceDeviceOwner } from "@/lib/offline/owner";
import { accuracyGrade } from "@/domain/location-quality";
import type { BundleLogistics } from "@/lib/offline/wire";
import { TripLogistics } from "./trip-logistics";
import { formatAgo, formatClock, formatCoords } from "./format";
import { useOnline } from "./use-online";

export interface HelpLocation {
  lat: number;
  lng: number;
  accuracyM: number | null;
  recordedAt: number;
  source: "device" | "server" | "fresh";
}

interface Region {
  name: string;
  emergencyNumber: string;
  emergencyGuidance: string;
}

type Access = "checking" | "owner" | "signed_out";

async function confirmWithServer(tripId: string): Promise<{ tripId: string; ownerHint: string } | undefined> {
  const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 6_000));
  const fetched = fetchBundleDetailed(tripId)
    .then((r) => (r.source === "network" ? { tripId, ownerHint: r.bundle.ownerHint } : undefined))
    .catch(() => undefined);
  return Promise.race([fetched, timeout]);
}

/**
 * Help screen (cached for offline use). Shows the last known location from
 * THIS DEVICE (IndexedDB) or, failing that, the last one the server
 * received; a clear stale warning; how to call/text 911; and what Ghost
 * Guide cannot do.
 *
 * Shared devices: the page (and its server-rendered location) may be the
 * offline copy of someone else's download. Locations are shown only when the
 * account signed in on this browser (`gg_owner` cookie) is the one the page
 * and the on-device data belong to; otherwise the data is removed and the
 * hiker is asked to sign in again. The emergency guidance always shows.
 */
export function HelpScreen({
  tripId,
  serverLocation,
  region: serverRegion,
  staleMinutes: serverStale,
  ownerHint: pageOwnerHint,
  notificationsSimulated,
}: {
  tripId: string;
  serverLocation: HelpLocation | null;
  region: Region | null;
  staleMinutes: number;
  /** owner hint of the account this page was rendered for */
  ownerHint: string;
  /** check-in notices are simulated (demo) */
  notificationsSimulated: boolean;
}) {
  const online = useOnline();
  const [access, setAccess] = useState<Access>("checking");
  const [device, setDevice] = useState<HelpLocation | null>(null);
  const [region, setRegion] = useState<Region | null>(serverRegion);
  const [staleMinutes, setStaleMinutes] = useState(serverStale);
  const [now, setNow] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  const [booking, setBooking] = useState<{ logistics: BundleLogistics | null; timeZone: string } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      let owner = currentOwnerHint();
      let confirmed: { tripId: string; ownerHint: string } | undefined;
      if (owner !== pageOwnerHint && navigator.onLine) {
        // A signed-in hiker whose browser lacks the device tag: the server confirms the trip (and sets the tag).
        confirmed = await confirmWithServer(tripId);
        owner = currentOwnerHint();
      }
      const check = await enforceDeviceOwner({ confirmed }).catch(() => ({ owner, purged: [] as string[] }));
      if (!alive) return;
      const mine = !!check.owner && (check.owner === pageOwnerHint || confirmed?.ownerHint === check.owner);
      setAccess(mine ? "owner" : "signed_out");
      if (!mine) return;
      const [state, stored] = await Promise.all([loadHikeState(tripId).catch(() => null), getStoredBundle(tripId).catch(() => undefined)]);
      if (!alive) return;
      if (state?.lastFix && state.ownerHint === check.owner) {
        setDevice({ lat: state.lastFix.lat, lng: state.lastFix.lng, accuracyM: state.lastFix.accuracyM, recordedAt: state.lastFix.timestamp, source: "device" });
      }
      if (stored?.bundle && stored.bundle.ownerHint === check.owner) {
        setRegion((r) => r ?? stored.bundle.region);
        setStaleMinutes(stored.bundle.settings.staleLocationMinutes);
        // Booked add-ons (locker code, pickup point and time) and permit status, saved with the download.
        setBooking({ logistics: stored.bundle.logistics ?? null, timeZone: stored.bundle.region.timezone });
      }
    })().catch(() => alive && setAccess((a) => (a === "checking" ? "signed_out" : a)));
    const t = setInterval(() => setNow(Date.now()), 10_000);
    const first = setTimeout(() => setNow(Date.now()), 0);
    return () => {
      alive = false;
      clearInterval(t);
      clearTimeout(first);
    };
  }, [tripId, pageOwnerHint]);

  // Nothing location-related is shown until the device owner is confirmed.
  // (A position measured just now on this phone is always shown: it is nobody's stored data.)
  const candidates = (access === "owner" ? [device, serverLocation] : [device?.source === "fresh" ? device : null]).filter((x): x is HelpLocation => !!x);
  const loc = candidates.sort((a, b) => b.recordedAt - a.recordedAt)[0] ?? null;
  const ageMin = loc && now ? (now - loc.recordedAt) / 60_000 : 0;
  const stale = !!loc && now !== null && ageMin > staleMinutes;
  const number = region?.emergencyNumber ?? "911";

  const copy = async () => {
    if (!loc) return;
    const text = formatCoords(loc.lat, loc.lng);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
    } catch {
      setCopied(null);
      window.prompt("Copy these coordinates:", text);
    }
  };

  const locateNow = () => {
    if (!("geolocation" in navigator)) {
      setLocateError("This browser cannot provide location.");
      return;
    }
    setLocating(true);
    setLocateError(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy, recordedAt: pos.timestamp, source: "fresh" as const };
        setDevice(fix);
        setNow(Date.now());
        setLocating(false);
        // Keep it as this trip's last known location on the device too.
        const state = access === "owner" ? await loadHikeState(tripId).catch(() => null) : null;
        if (state && state.ownerHint === currentOwnerHint()) {
          await saveHikeState({ ...state, lastFix: { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM, timestamp: fix.recordedAt } }).catch(() => undefined);
        }
      },
      (err) => {
        setLocating(false);
        setLocateError(err.code === err.PERMISSION_DENIED ? "Location permission is off for this site." : "Couldn't get a GPS fix. Try again with a view of the sky.");
      },
      { enableHighAccuracy: true, timeout: 30_000, maximumAge: 0 },
    );
  };

  return (
    <div className="space-y-5">
      <section className="rounded-[var(--radius-card)] border-2 border-red-ink/40 bg-red-bg p-5 sm:p-6" aria-labelledby="call-heading">
        <h2 id="call-heading" className="flex items-center gap-2 text-2xl font-bold text-red-ink">
          <Phone aria-hidden className="size-6" /> In an emergency, call {number}
        </h2>
        <a
          href={`tel:${number.replace(/[^\d+]/g, "")}`}
          className="mt-4 flex min-h-16 w-full items-center justify-center gap-2 rounded-xl bg-red-ink px-4 text-xl font-bold text-white hover:brightness-110"
          data-testid="help-call"
        >
          <Phone aria-hidden className="size-6" /> Call {number}
        </a>
        <ul className="mt-4 space-y-3 text-[1.02rem]">
          <li className="flex gap-2">
            <Phone aria-hidden className="mt-1 size-4 shrink-0" />
            <span>
              <strong>Call {number} if you have any signal</strong> — even one bar. Calls to {number} may connect through other carriers&apos; networks.
            </span>
          </li>
          <li className="flex gap-2">
            <MessageSquareText aria-hidden className="mt-1 size-4 shrink-0" />
            <span>
              <strong>If a voice call fails, try texting {number}</strong> where text-to-911 is supported. Include your coordinates from below.
            </span>
          </li>
          <li className="flex gap-2">
            <Satellite aria-hidden className="mt-1 size-4 shrink-0" />
            <span>
              <strong>No signal?</strong> Use your own satellite communicator&apos;s SOS if you carry one (some phones also offer emergency satellite
              messaging). <strong>Ghost Guide cannot send an SOS.</strong>
            </span>
          </li>
          <li className="flex gap-2">
            <TreePine aria-hidden className="mt-1 size-4 shrink-0" />
            <span>
              <strong>If you are lost, stay where you are.</strong> Stay warm and visible, and save your phone battery.
            </span>
          </li>
        </ul>
        {region?.emergencyGuidance ? <p className="mt-4 text-sm text-ink">{region.emergencyGuidance}</p> : null}
      </section>

      <Card aria-labelledby="loc-heading">
        <h2 id="loc-heading" className="flex items-center gap-2 text-xl font-bold">
          <LocateFixed aria-hidden className="size-5" /> Your last known location
        </h2>
        {access === "signed_out" ? (
          <div className="mt-3 space-y-3 rounded-xl border border-[#f1d9b0] bg-amber-bg p-3 text-amber-ink" role="status" data-testid="help-signed-out">
            <p>
              <strong>{SIGN_IN_AGAIN}.</strong> Location and trip data saved on this browser belong to an account that isn&apos;t signed in here, so they
              aren&apos;t shown (and have been removed from this device).
            </p>
            <p>
              <a className="font-semibold underline" href={`/login?next=${encodeURIComponent(`/trips/${tripId}/help`)}`}>
                Sign in
              </a>{" "}
              — or use <strong>Get current location</strong> to read this phone&apos;s position now.
            </p>
          </div>
        ) : null}
        {access === "checking" ? (
          <p className="mt-3 text-muted" role="status">
            Checking this device…
          </p>
        ) : loc ? (
          <div className="mt-3 space-y-3" aria-live="polite">
            <p className="font-mono text-2xl font-bold tracking-tight" data-testid="help-coords">
              {formatCoords(loc.lat, loc.lng)}
            </p>
            <p className="text-muted">
              Decimal degrees (latitude, longitude) · accuracy {loc.accuracyM != null ? `± ${Math.round(loc.accuracyM)} m (${accuracyGrade(loc.accuracyM)})` : "unknown"} ·
              recorded {formatClock(loc.recordedAt)}
              {now ? ` (${formatAgo(loc.recordedAt, now)})` : ""} ·{" "}
              {loc.source === "server" ? "last location our server received" : loc.source === "fresh" ? "just measured on this device" : "saved on this device"}
            </p>
            {stale ? (
              <Alert tone="amber" title="This location is old" live="polite">
                It is more than {staleMinutes} minutes old and may not be where you are now. Get a new fix below before sharing it.
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button onClick={copy} data-testid="help-copy">
                <Copy aria-hidden className="size-4" /> Copy coordinates
              </Button>
              <Button variant="secondary" onClick={locateNow} disabled={locating}>
                <LocateFixed aria-hidden className="size-4" /> {locating ? "Getting location…" : "Get current location"}
              </Button>
            </div>
            <p role="status" className="text-sm text-forest-800">
              {copied ? `Copied ${copied}` : ""}
            </p>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            {access === "owner" ? <p className="text-muted">No location saved for this trip yet.</p> : null}
            <Button variant="secondary" onClick={locateNow} disabled={locating}>
              <LocateFixed aria-hidden className="size-4" /> {locating ? "Getting location…" : "Get current location"}
            </Button>
          </div>
        )}
        {locateError ? (
          <p className="mt-2 text-sm font-semibold text-red-ink" role="alert">
            {locateError}
          </p>
        ) : null}
        {!online ? <p className="mt-3 text-sm text-muted">You&apos;re offline — this page is working from your downloaded trip.</p> : null}
      </Card>

      {access === "owner" && booking ? (
        <Card>
          <TripLogistics
            logistics={booking.logistics}
            timeZone={booking.timeZone}
            savedNote="Saved on this device with your downloaded trip. Check your trip page for updates when you're online."
          />
        </Card>
      ) : null}

      <Alert tone="amber" title="What Ghost Guide can't do">
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>Ghost Guide cannot see your location in real time.</li>
          <li>It cannot contact 911, Search and Rescue or anyone else for you.</li>
          <li>It does not provide satellite SOS.</li>
          <li>
            If you set up a check-in, your contact is notified only after your expected return time plus grace period passes without a confirmation —
            that can be hours from now.
            {notificationsSimulated ? (
              <>
                {" "}
                <SimulatedBadge label="Simulated notices (demo)" /> In this demo no message is actually sent to your contact.
              </>
            ) : null}
          </li>
        </ul>
      </Alert>

      <p className="flex gap-2 text-sm text-muted">
        <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        <a href={`/trips/${tripId}/hike`} className="font-semibold text-forest-800 underline">
          Back to the hike screen
        </a>
      </p>
    </div>
  );
}
