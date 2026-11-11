/**
 * Deterministic itinerary builder (pure; no I/O). Every number produced here
 * is an ESTIMATE derived from the catalog's duration estimate and documented
 * multipliers — never a guarantee. The same helpers are used by the
 * recommendation engine so scores, filters and the saved itinerary agree.
 */
import { cumulativeDistancesM, lineLengthM, projectOntoLine, type LineStringGeometry, type Position } from "./geo";
import type { Itinerary, Poi, Trail, TripPreferences } from "./types";
import { addMinutesToClock } from "@/lib/time";

// ---------------------------------------------------------------------------
// Pace factor (documented estimate)
// ---------------------------------------------------------------------------

/** Multiplier on the catalog duration for the hiker's preferred pace. */
export const PACE_MULTIPLIER: Record<TripPreferences["pace"], number> = { leisurely: 1.25, steady: 1, brisk: 0.85 };
/** Multiplier for self-reported fitness. */
export const FITNESS_MULTIPLIER: Record<TripPreferences["fitness"], number> = { low: 1.15, moderate: 1, high: 0.92 };
/** Larger groups move at the pace of the slowest member and stop more often. */
export function partyMultiplier(partySize: number): number {
  if (partySize >= 9) return 1.15;
  if (partySize >= 6) return 1.1;
  if (partySize >= 3) return 1.05;
  return 1;
}
export const PACE_FACTOR_MIN = 0.75;
export const PACE_FACTOR_MAX = 1.8;
/** Minutes allowed at each narration stop (trailhead POIs excluded). */
export const STOP_DWELL_MIN = 5;
/** Margin kept between the turnaround time and the latest-finish estimate. */
export const TURNAROUND_MARGIN_MIN = 30;
/** Allowance after the expected halfway time before you should turn around. */
export const TURNAROUND_SLACK_MIN = 30;

export const PACE_FACTOR_METHOD =
  "Pace factor = pace (leisurely ×1.25, steady ×1.0, brisk ×0.85) × fitness (low ×1.15, moderate ×1.0, high ×0.92) × group size (1–2 ×1.0, 3–5 ×1.05, 6–8 ×1.10, 9–12 ×1.15), limited to 0.75–1.8.";

export function computePaceFactor(prefs: Pick<TripPreferences, "pace" | "fitness" | "partySize">): number {
  const raw = PACE_MULTIPLIER[prefs.pace] * FITNESS_MULTIPLIER[prefs.fitness] * partyMultiplier(prefs.partySize);
  const clamped = Math.min(PACE_FACTOR_MAX, Math.max(PACE_FACTOR_MIN, raw));
  return Math.round(clamped * 100) / 100;
}

/** Moving time (min): catalog estimate × pace factor. */
export function movingDurationMin(catalogEstimateMin: number, paceFactor: number): number {
  return Math.round(catalogEstimateMin * paceFactor);
}

/** Total trip estimate (min): moving time plus a fixed dwell per narration stop. */
export function estimateTripDurationMin(catalogEstimateMin: number, paceFactor: number, stopCount: number): number {
  return movingDurationMin(catalogEstimateMin, paceFactor) + STOP_DWELL_MIN * Math.max(0, stopCount);
}

/** Minutes since midnight for "HH:MM" (or "HH:MM:SS"). */
export function clockToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** Hydration / pace-check cadence. General reminders, not medical advice. */
export function reminderCadence(
  estimatedDurationMin: number,
  trail: Pick<Trail, "terrain" | "elevationGainM">,
): Itinerary["reminders"] {
  const exposed = trail.terrain.some((t) => ["ridge", "rocky", "canyon", "meadow", "coastal"].includes(t));
  const hydrationEveryMin = estimatedDurationMin >= 240 || exposed || trail.elevationGainM >= 600 ? 30 : estimatedDurationMin >= 120 ? 40 : 45;
  const paceCheckEveryMin = estimatedDurationMin < 120 ? 30 : estimatedDurationMin < 300 ? 45 : 60;
  return { hydrationEveryMin, paceCheckEveryMin };
}

export type ItineraryTrail = Pick<
  Trail,
  "id" | "name" | "distanceKm" | "elevationGainM" | "terrain" | "routeType" | "estimatedDurationMin" | "permitRequired"
> & { geometry: LineStringGeometry | null };

export type ItineraryPoi = Pick<Poi, "id" | "name" | "kind" | "lat" | "lng" | "seq">;

export interface ItineraryOptions {
  /** Conservative latest-finish estimate for the planned date (HH:MM), used for the turnaround time. */
  latestFinishTime?: string | null;
  /**
   * Reasons of the PARTIAL closures in effect on the planned (region-local)
   * day. The catalog does not record where on the route a partial closure
   * starts, so the schedule stays a full-route estimate; the notes tell the
   * hiker to follow the closure notice and never imply continuing into it.
   */
  partialClosures?: string[];
  /** Extra notes (e.g. permit names) to append. */
  extraNotes?: string[];
}

const stripTrailingPeriod = (s: string) => s.trim().replace(/[.\s]+$/, "");

/** "June" for "2027-06-15" (the calendar month of a YYYY-MM-DD date). */
function monthOf(date: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(`${date.slice(0, 10)}T12:00:00Z`));
}

/** Itinerary note for a partial closure on the planned day (stored on trips.itinerary.notes). */
export function partialClosureNote(reason: string): string {
  return `Partial closure on your date: ${stripTrailingPeriod(reason)}. Follow the closure, even if that means turning around earlier than this itinerary shows; the times here are estimates for the full route.`;
}

interface PlacedStop {
  poi: ItineraryPoi;
  alongM: number;
  dwell: boolean;
}

/** Two projections closer than this (m) are treated as equally near the route. */
const SAME_PLACE_TOLERANCE_M = 15;

/**
 * Distance along the route for a POI, preferring the EARLIEST position at or
 * after `minAlongM` among all route positions (nearly) as close as the best
 * one. Out-and-back legs overlap, so a stop passed on the way out must not be
 * placed on the return leg; the order follows forward progress along the route.
 */
export function forwardAlongM(point: { lat: number; lng: number }, coords: Position[], cum: number[], minAlongM: number): number {
  const candidates: { along: number; dist: number }[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const segLen = cum[i + 1] - cum[i];
    const p = projectOntoLine(point, [coords[i], coords[i + 1]], [0, segLen]);
    candidates.push({ along: cum[i] + p.alongM, dist: p.distanceFromRouteM });
  }
  const best = Math.min(...candidates.map((c) => c.dist));
  const near = candidates.filter((c) => c.dist <= best + SAME_PLACE_TOLERANCE_M);
  const forward = near.filter((c) => c.along >= minAlongM - 5);
  const pool = forward.length ? forward : near;
  return Math.min(...pool.map((c) => c.along));
}

/** Place POIs (in seq order) along the route with forward progress. */
function placeStops(trail: ItineraryTrail, pois: ItineraryPoi[]): { stops: PlacedStop[]; totalM: number } {
  const ordered = [...pois].sort((a, b) => a.seq - b.seq);
  const coords = trail.geometry?.coordinates ?? [];
  if (coords.length >= 2) {
    const cum = cumulativeDistancesM(coords);
    const totalM = lineLengthM(coords);
    let progress = 0;
    const stops = ordered.map((poi) => {
      const along = forwardAlongM({ lat: poi.lat, lng: poi.lng }, coords, cum, progress);
      progress = Math.max(progress, along);
      return { poi, alongM: Math.round(along), dwell: poi.kind !== "trailhead" };
    });
    // Stable sort by distance along the route (ties keep seq order).
    stops.sort((a, b) => a.alongM - b.alongM || a.poi.seq - b.poi.seq);
    return { stops, totalM };
  }
  // No validated geometry: spread stops evenly by sequence (clearly an approximation).
  const totalM = trail.distanceKm * 1000;
  const stops = ordered.map((poi, i) => ({
    poi,
    alongM: Math.round(((i + 1) / (ordered.length + 1)) * totalM),
    dwell: poi.kind !== "trailhead",
  }));
  return { stops, totalM };
}

/**
 * Build the deterministic itinerary stored on trips.itinerary.
 * `now` only stamps generatedAt; it never changes the schedule.
 */
export function buildItinerary(
  trail: ItineraryTrail,
  pois: ItineraryPoi[],
  prefs: TripPreferences,
  now: Date,
  opts: ItineraryOptions = {},
): Itinerary {
  const paceFactor = computePaceFactor(prefs);
  const movingMin = movingDurationMin(trail.estimatedDurationMin, paceFactor);
  const { stops: placed, totalM } = placeStops(trail, pois);
  const dwellCount = placed.filter((s) => s.dwell).length;
  const estimatedDurationMin = movingMin + STOP_DWELL_MIN * dwellCount;

  let priorDwell = 0;
  const stops = placed.map((s) => {
    const fraction = totalM > 0 ? Math.min(1, s.alongM / totalM) : 0;
    const etaOffsetMin = Math.round(fraction * movingMin) + priorDwell * STOP_DWELL_MIN;
    if (s.dwell) priorDwell++;
    return { poiId: s.poi.id, name: s.poi.name, alongM: s.alongM, etaOffsetMin };
  });

  const estimatedFinishTime = addMinutesToClock(prefs.startTime, estimatedDurationMin);
  const startMin = clockToMinutes(prefs.startTime);

  let turnaroundBy: string | undefined;
  const partialClosures = (opts.partialClosures ?? []).map((r) => r.trim()).filter(Boolean);
  const notes: string[] = [
    `Estimates only: ${trail.estimatedDurationMin} min catalog estimate × your pace factor ${paceFactor.toFixed(2)}, plus about ${STOP_DWELL_MIN} min at each narration stop. Real times vary with conditions, breaks and route finding.`,
    // Closures come right after the estimate caveat: they override the schedule below.
    ...partialClosures.map(partialClosureNote),
  ];

  if (trail.routeType === "out_and_back") {
    const halfM = totalM / 2;
    // alongM is rounded to whole metres: allow 1 m so a stop at the turnaround point counts as outbound.
    const dwellBeforeHalf = placed.filter((s) => s.dwell && s.alongM <= halfM + 1).length;
    const halfwayEtaMin = Math.round(movingMin / 2) + dwellBeforeHalf * STOP_DWELL_MIN;
    const returnLegMin = estimatedDurationMin - halfwayEtaMin;
    let turnaroundMin = startMin + halfwayEtaMin + TURNAROUND_SLACK_MIN;
    if (opts.latestFinishTime) {
      const cutoff = clockToMinutes(opts.latestFinishTime) - returnLegMin - TURNAROUND_MARGIN_MIN;
      turnaroundMin = Math.min(turnaroundMin, cutoff);
    }
    turnaroundBy = addMinutesToClock("00:00", Math.max(0, turnaroundMin));
    notes.push(
      partialClosures.length
        ? `Out-and-back: on the full route you would reach the halfway point around ${addMinutesToClock(prefs.startTime, halfwayEtaMin)} (est.), but part of the route is closed on your date. Turn around where the closure notice says, and by ${turnaroundBy} at the latest, so you can return with a ${TURNAROUND_MARGIN_MIN}-minute margin.`
        : `Out-and-back: you should reach the halfway point around ${addMinutesToClock(prefs.startTime, halfwayEtaMin)} (est.). Turn around by ${turnaroundBy} even if you have not reached it, so you can return with a ${TURNAROUND_MARGIN_MIN}-minute margin.`,
    );
    if (turnaroundMin < startMin + halfwayEtaMin) {
      notes.push("Your turnaround time comes before the estimated halfway point: you may not reach the far end. Consider starting earlier.");
    }
  }
  if (trail.routeType === "point_to_point") {
    notes.push("Point-to-point route: it finishes at a different trailhead. Arrange a shuttle or a second car before you start.");
  }
  if (trail.permitRequired) {
    notes.push("A permit is required for this trail. Apply through the official link on the trail page; Ghost Guide does not obtain permits for you.");
  }
  if (opts.latestFinishTime) {
    notes.push(`Plan to be off the trail by ${opts.latestFinishTime}: a conservative planning estimate for ${monthOf(prefs.plannedDate)}, not an exact sunset time.`);
  }
  notes.push("Hydration and pace reminders are general prompts, not personalized medical advice.");
  if (opts.extraNotes?.length) notes.push(...opts.extraNotes);

  return {
    version: 1,
    trailId: trail.id,
    plannedDate: prefs.plannedDate,
    startTime: prefs.startTime,
    paceFactor,
    estimatedDurationMin,
    estimatedFinishTime,
    ...(turnaroundBy ? { turnaroundBy } : {}),
    stops,
    reminders: reminderCadence(estimatedDurationMin, trail),
    notes,
    generatedAt: now.toISOString(),
  };
}
