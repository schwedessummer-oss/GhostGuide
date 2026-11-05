import { Badge } from "@/components/ui";
import { addMinutesToClock } from "@/lib/time";
import type { Itinerary } from "@/domain/types";

function clock12(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${suffix}`;
}

/**
 * Deterministic itinerary from trips.itinerary. Every time shown is an
 * ESTIMATE based on the catalog duration and the hiker's pace, not a promise.
 */
export function ItinerarySummary({ itinerary, startTime }: { itinerary: Partial<Itinerary>; startTime: string | null }) {
  const start = (itinerary.startTime ?? startTime ?? "").slice(0, 5);
  const stops = itinerary.stops ?? [];
  if (!start || (!stops.length && !itinerary.estimatedFinishTime)) {
    return <p className="text-muted">No itinerary has been generated for this trip yet.</p>;
  }
  return (
    <div className="space-y-4">
      <p>
        <Badge tone="blue">Estimates</Badge>{" "}
        <span className="text-sm text-muted">Times are estimates from the trail data and your pace — not guarantees. Conditions change; turn back if needed.</span>
      </p>
      <ol className="relative space-y-3 border-l-2 border-forest-200 pl-5">
        <li>
          <p className="font-semibold">Start · {clock12(start)}</p>
        </li>
        {stops.map((s) => (
          <li key={s.poiId}>
            <p>
              <span className="font-semibold">{s.name}</span> · about {clock12(addMinutesToClock(start, s.etaOffsetMin))}
            </p>
            <p className="text-sm text-muted">{(s.alongM / 1000).toFixed(1)} km along the route (estimated arrival)</p>
          </li>
        ))}
        {itinerary.estimatedFinishTime ? (
          <li>
            <p className="font-semibold">Estimated finish · {clock12(itinerary.estimatedFinishTime)}</p>
            {itinerary.estimatedDurationMin ? (
              <p className="text-sm text-muted">
                About {Math.floor(itinerary.estimatedDurationMin / 60)} h {itinerary.estimatedDurationMin % 60} min on the trail (estimate)
              </p>
            ) : null}
          </li>
        ) : null}
      </ol>
      {itinerary.turnaroundBy ? (
        <p className="rounded-lg bg-amber-bg p-3 text-sm text-amber-ink">
          <span className="font-semibold">Suggested turnaround:</span> by {clock12(itinerary.turnaroundBy)} (estimate) so you finish in daylight.
        </p>
      ) : null}
      {itinerary.reminders ? (
        <p className="text-sm text-muted">
          General reminders (not medical advice): drink water about every {itinerary.reminders.hydrationEveryMin} min and check your pace about every{" "}
          {itinerary.reminders.paceCheckEveryMin} min.
        </p>
      ) : null}
      {itinerary.notes?.length ? (
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          {itinerary.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
