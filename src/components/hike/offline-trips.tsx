"use client";

import { useEffect, useState } from "react";
import { Footprints, LifeBuoy } from "lucide-react";
import { listStoredBundles } from "@/lib/offline/bundle-store";

interface Item {
  tripId: string;
  name: string;
  date: string | null;
  complete: boolean | null;
}

/** Trips downloaded on this device (read from IndexedDB), for the offline fallback page. */
export function OfflineTrips() {
  const [items, setItems] = useState<Item[] | null>(null);
  useEffect(() => {
    let alive = true;
    listStoredBundles()
      .then((all) => {
        if (!alive) return;
        setItems(
          all
            .filter((b) => b.bundle.trip.status !== "completed")
            .map((b) => ({ tripId: b.tripId, name: b.bundle.trail.name, date: b.bundle.trip.plannedDate, complete: b.verification?.complete ?? null })),
        );
      })
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, []);

  if (items === null) return <p className="text-muted">Looking for downloaded trips…</p>;
  if (!items.length) return <p className="text-muted">No downloaded trips on this device.</p>;
  return (
    <ul className="space-y-3">
      {items.map((t) => (
        <li key={t.tripId} className="rounded-2xl border border-sand-200 bg-surface p-4">
          <p className="font-semibold">{t.name}</p>
          <p className="text-sm text-muted">
            {t.date ?? "Date not set"}
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
  );
}
