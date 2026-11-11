"use client";

import clsx from "clsx";
import { CloudOff, Cloud, Crosshair, HardDrive, RefreshCw, Sun } from "lucide-react";
import { accuracyGrade } from "@/domain/location-quality";
import type { HikeSnapshot } from "./engine/hike-engine";
import { formatAgo, formatClock } from "./format";

const GRADE_LABEL = { good: "good", fair: "fair", poor: "poor", unknown: "unknown" } as const;

/**
 * Connection, GPS accuracy, local save and server sync status. Every state
 * is spelled out in text (never colour alone).
 */
export function HikeStatus({ snap, onSyncNow }: { snap: HikeSnapshot; onSyncNow: () => void }) {
  const { sync, lastFix, gps, now } = snap;
  const grade = accuracyGrade(lastFix?.accuracyM);
  const stale = snap.staleness === "stale";
  const gpsText =
    gps.state === "denied" || gps.state === "unsupported" || gps.state === "unavailable"
      ? (gps.message ?? "No location")
      : lastFix
        ? `± ${Math.round(lastFix.accuracyM)} m (${GRADE_LABEL[grade]})${stale ? " · stale" : ""}`
        : gps.state === "waiting"
          ? "Waiting for GPS…"
          : "GPS off";
  return (
    <div>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div className={clsx("rounded-xl border p-2.5", sync.online ? "border-forest-200 bg-forest-50" : "border-[#f1d9b0] bg-amber-bg")} data-testid="hike-connection">
          <dt className="flex items-center gap-1.5 font-semibold">
            {sync.online ? <Cloud aria-hidden className="size-4" /> : <CloudOff aria-hidden className="size-4" />}
            {sync.online ? "Online" : "Offline"}
          </dt>
          <dd className="mt-0.5 text-muted" data-testid="hike-queued">
            {sync.queued === 0 ? "Nothing waiting to send" : `${sync.queued} ${sync.queued === 1 ? "item" : "items"} waiting to send`}
          </dd>
        </div>
        <div className={clsx("rounded-xl border p-2.5", stale || grade === "poor" ? "border-[#f1d9b0] bg-amber-bg" : "border-sand-200 bg-surface")}>
          <dt className="flex items-center gap-1.5 font-semibold">
            <Crosshair aria-hidden className="size-4" /> {gps.source === "simulator" ? "Simulated GPS" : "GPS accuracy"}
          </dt>
          <dd className="mt-0.5 text-muted" data-testid="hike-accuracy">
            {gpsText}
          </dd>
        </div>
        <div className="rounded-xl border border-sand-200 bg-surface p-2.5">
          <dt className="flex items-center gap-1.5 font-semibold">
            <HardDrive aria-hidden className="size-4" /> Saved on device
          </dt>
          <dd className="mt-0.5 text-muted" data-testid="hike-last-saved">
            {snap.lastSavedAt ? `Location at ${formatClock(snap.lastSavedAt)}` : lastFix ? "Saving…" : "No location yet"}
          </dd>
        </div>
        <div className="rounded-xl border border-sand-200 bg-surface p-2.5">
          <dt className="flex items-center gap-1.5 font-semibold">
            <RefreshCw aria-hidden className={clsx("size-4", sync.status === "syncing" && "motion-safe:animate-spin")} /> Last sync
          </dt>
          <dd className="mt-0.5 text-muted" data-testid="hike-last-sync">
            {sync.lastSyncAt ? formatAgo(sync.lastSyncAt, now) : "Not yet"}
            {sync.status === "auth_required" ? (
              <span className="block font-semibold text-amber-ink">Sign in again to sync</span>
            ) : sync.queued > 0 && sync.online && sync.status !== "syncing" ? (
              <button type="button" onClick={onSyncNow} className="block min-h-11 font-semibold text-forest-800 underline">
                Sync now
              </button>
            ) : null}
          </dd>
        </div>
      </dl>
      {snap.wakeLock !== "off" ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
          <Sun aria-hidden className="size-3.5 shrink-0" />
          {snap.wakeLock === "active"
            ? "Screen kept on while hiking (uses more battery)."
            : snap.wakeLock === "unsupported"
              ? "This browser can't keep the screen on — the screen may lock and pause GPS."
              : snap.wakeLock === "released"
                ? "Your phone turned off keep-screen-on; it will be requested again when the app is visible."
                : "Couldn't keep the screen on. Keep it awake yourself if you can."}
        </p>
      ) : null}
    </div>
  );
}
