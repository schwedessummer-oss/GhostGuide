"use client";

import { useEffect, useState } from "react";
import { Footprints, LifeBuoy } from "lucide-react";
import { listStoredBundles } from "@/lib/offline/bundle-store";
import { listHikeStates } from "@/lib/offline/hike-state";
import { SIGN_IN_AGAIN, enforceDeviceOwner } from "@/lib/offline/owner";
import { formatDate } from "@/lib/format";

interface Item {
  tripId: string;
  name: string;
  date: string | null;
  complete: boolean | null;
}

/**
 * Trips downloaded on this device (read from IndexedDB), for the offline
 * fallback page. Only the signed-in account's trips are listed (anything
 * else is removed from the device first), and finished hikes are left out.
 */
export function OfflineTrips() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [removed, setRemoved] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const check = await enforceDeviceOwner();
      const [all, states] = await Promise.all([listStoredBundles(), listHikeStates()]);
      if (!alive) return;
      const finished = new Set(states.filter((s) => s.status === "finished").map((s) => s.tripId));
      setRemoved(check.purged.length > 0);
      setItems(
        all
          .filter((b) => !!check.owner && b.bundle.ownerHint === check.owner)
          .filter((b) => b.bundle.trip.status !== "completed" && b.bundle.trip.status !== "cancelled" && !finished.has(b.tripId))
          .map((b) => ({
            tripId: b.tripId,
            name: b.bundle.trail.name,
            date: b.bundle.trip.bookedDate ?? b.bundle.trip.plannedDate,
            complete: b.verification?.complete ?? null,
          })),
      );
    })().catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, []);

  if (items === null) return <p className="text-muted">Looking for downloaded trips…</p>;
  const notice = removed ? (
    <p className="mb-3 rounded-xl border border-[#f1d9b0] bg-amber-bg p-3 text-sm text-amber-ink" role="status" data-testid="offline-signed-out">
      <strong>{SIGN_IN_AGAIN}.</strong> Trips downloaded by an account that isn&apos;t signed in on this browser were removed from this device for
      privacy.
    </p>
  ) : null;
  if (!items.length)
    return (
      <>
        {notice}
        <p className="text-muted">No downloaded trips on this device.</p>
      </>
    );
  return (
    <>
      {notice}
      <ul className="space-y-3">
        {items.map((t) => (
          <li key={t.tripId} className="rounded-2xl border border-sand-200 bg-surface p-4">
            <p className="font-semibold">{t.name}</p>
            <p className="text-sm text-muted">
              {t.date ? formatDate(t.date, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "Date not set"}
              {t.complete === false ? " · download incomplete" : ""}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <a href={`/trips/${t.tripId}/hike`} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-forest-700 px-4 font-semibold text-white">
                <Footprints aria-hidden className="size-4" /> Hike screen
              </a>
              <a href={`/trips/${t.tripId}/help`} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#f5c6c1] bg-red-bg px-4 font-semibold text-red-ink">
                <LifeBuoy aria-hidden className="size-4" /> Help
              </a>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
