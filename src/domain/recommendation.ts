/**
 * Deterministic trail recommendation (pure; no I/O, never uses AI).
 *
 *  1. HARD FILTERS exclude a trail and record every reason (so the customer
 *     can see which constraint excluded which trail and what to relax).
 *  2. SCORING (0–100) ranks the remaining trails with a transparent
 *     per-factor breakdown. Ties break by trail name, then id.
 *
 * All durations and times are estimates; the latest-finish table is a
 * conservative planning value, not an exact sunset time.
 */
import type { Closure, Difficulty, RouteType, Trail, TripPreferences } from "./types";
import { clockToMinutes, computePaceFactor, estimateTripDurationMin } from "./itinerary";
import { formatDistance, formatDuration, formatElevation } from "./geo";
import { addMinutesToClock, zonedTimeToUtc } from "@/lib/time";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Questionnaire accessibility needs and the catalog feature that satisfies each one. */
export const ACCESS_NEED_FEATURE = {
  step_free: "step_free_start",
  firm_surface: "firm_surface",
  rest_stops: "benches",
  gentle_grade: "gentle_grade",
  avoid_exposure: "no_exposure",
  avoid_water_crossings: "no_water_crossings",
  accessible_restroom: "accessible_restroom",
  accessible_parking: "accessible_parking",
  shade: "shade",
} as const;
export type AccessNeed = keyof typeof ACCESS_NEED_FEATURE;
export const ACCESS_NEEDS = Object.keys(ACCESS_NEED_FEATURE) as AccessNeed[];

export const ACCESS_NEED_LABEL: Record<AccessNeed, string> = {
  step_free: "Step-free start",
  firm_surface: "Firm, even surface",
  rest_stops: "Rest stops / benches",
  gentle_grade: "Gentle grade",
  avoid_exposure: "Avoid exposed drop-offs",
  avoid_water_crossings: "Avoid water crossings",
  accessible_restroom: "Accessible restroom",
  accessible_parking: "Accessible parking",
  shade: "Shade",
};

export const EQUIPMENT_OPTIONS = [
  "trekking_poles",
  "headlamp",
  "water_filter",
  "satellite_communicator",
  "first_aid_kit",
  "map_and_compass",
  "microspikes",
] as const;
export type Equipment = (typeof EQUIPMENT_OPTIONS)[number];

export const EQUIPMENT_LABEL: Record<Equipment, string> = {
  trekking_poles: "Trekking poles",
  headlamp: "Headlamp",
  water_filter: "Water filter",
  satellite_communicator: "Satellite communicator",
  first_aid_kit: "First-aid kit",
  map_and_compass: "Map and compass",
  microspikes: "Microspikes / traction",
};

const DIFFICULTY_INDEX: Record<Difficulty, number> = { easy: 0, moderate: 1, hard: 2, strenuous: 3 };

/** Ideal difficulty index (0 easy … 3 strenuous) for an experience/fitness pair. */
const IDEAL_DIFFICULTY: Record<TripPreferences["experience"], Record<TripPreferences["fitness"], number>> = {
  new: { low: 0, moderate: 0, high: 0.5 },
  some: { low: 0.5, moderate: 1, high: 1.5 },
  regular: { low: 1, moderate: 1.5, high: 2 },
  expert: { low: 1, moderate: 2, high: 2.5 },
};

/** Distance-range tolerance applied to both bounds (stated to the customer). */
export const DISTANCE_TOLERANCE = 0.1;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Conservative "be off the trail by" times per month (region-local HH:MM)
 * for the demo region (~47.5°N, Pacific time): roughly the month's EARLIEST
 * sunset minus 30–45 minutes. A planning estimate — NOT an exact sunset.
 */
export const DEFAULT_LATEST_FINISH_BY_MONTH: Record<number, string> = {
  1: "15:45",
  2: "16:30",
  3: "17:15",
  4: "19:00",
  5: "19:45",
  6: "20:15",
  7: "20:00",
  8: "19:00",
  9: "18:15",
  10: "17:15",
  11: "15:45",
  12: "15:45",
};

export const LATEST_FINISH_LABEL =
  "Conservative planning estimate (about 30–45 minutes before the month's earliest sunset), not an exact sunset time. Check an official source for real hikes.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CandidateTrailInfo = Pick<
  Trail,
  | "id"
  | "slug"
  | "name"
  | "status"
  | "isDemo"
  | "distanceKm"
  | "elevationGainM"
  | "difficulty"
  | "terrain"
  | "routeType"
  | "estimatedDurationMin"
  | "accessibilityFeatures"
  | "dogsAllowed"
  | "permitRequired"
  | "dailyCapacity"
  | "geometryValidatedAt"
> & { hasGeometry: boolean };

export interface CandidatePermit {
  name: string;
  leadTimeDays: number | null;
}

export interface CandidateTrail {
  trail: CandidateTrailInfo;
  /** Closures that overlap (or may overlap) the planned date. */
  closures: Pick<Closure, "severity" | "reason" | "startsAt" | "endsAt">[];
  permits: CandidatePermit[];
  /** All POIs on the route. */
  poiCount: number;
  /** POIs that become narration stops with dwell time (trailhead POIs excluded). */
  stopCount: number;
  /** Remaining party capacity for the planned date; null/undefined → trail daily capacity. */
  capacityRemaining?: number | null;
}

export interface RecommendationContext {
  /** Region-local "today" (YYYY-MM-DD). */
  today: string;
  regionTimezone: string;
  /** Month number (1–12) → conservative latest-finish HH:MM (estimate, not sunset). */
  latestFinishByMonth: Record<number, string>;
}

export interface ScoreFactor {
  factor: string;
  points: number;
  max: number;
  detail: string;
  /** true when no preference was given and a neutral midpoint score was used */
  neutral?: boolean;
}

export type ExclusionCode =
  | "status"
  | "geometry"
  | "closure"
  | "time"
  | "distance"
  | "elevation"
  | "accessibility"
  | "dogs"
  | "experience"
  | "permit"
  | "latest_finish"
  | "capacity";

export interface RankedTrail {
  trailId: string;
  score: number;
  breakdown: ScoreFactor[];
  reasons: string[];
  warnings: string[];
  estimatedDurationMin: number;
  estimatedFinishTime: string;
  paceFactor: number;
}

export interface ExcludedTrail {
  trailId: string;
  reasons: string[];
  codes: ExclusionCode[];
}

export interface RecommendationResult {
  ranked: RankedTrail[];
  excluded: ExcludedTrail[];
  noMatch: boolean;
  relaxSuggestions: string[];
  latestFinishTime: string;
  paceFactor: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const label = (s: string) => s.replace(/_/g, " ");
const dayIndex = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;

export function daysBetween(fromDate: string, toDate: string): number {
  return Math.round(dayIndex(toDate) - dayIndex(fromDate));
}

function nextDate(date: string): string {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + 1));
  return d.toISOString().slice(0, 10);
}

export function latestFinishFor(date: string, table: Record<number, string>): string {
  const month = +date.slice(5, 7);
  return table[month] ?? DEFAULT_LATEST_FINISH_BY_MONTH[month] ?? "16:00";
}

export function monthName(date: string): string {
  return MONTHS[+date.slice(5, 7) - 1] ?? "";
}

/** True if a closure window overlaps the region-local calendar day. */
export function closureOverlapsDay(c: Pick<Closure, "startsAt" | "endsAt">, date: string, timeZone: string): boolean {
  const dayStart = zonedTimeToUtc(date, "00:00", timeZone).getTime();
  const dayEnd = zonedTimeToUtc(nextDate(date), "00:00", timeZone).getTime();
  const starts = new Date(c.startsAt).getTime();
  const ends = c.endsAt ? new Date(c.endsAt).getTime() : Infinity;
  return starts < dayEnd && ends > dayStart;
}

const km = (n: number) => formatDistance(n * 1000);
const hoursLabel = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(1)} h`;

// ---------------------------------------------------------------------------
// Hard filters
// ---------------------------------------------------------------------------

interface Exclusion {
  code: ExclusionCode;
  message: string;
}

function hardFilters(
  c: CandidateTrail,
  prefs: TripPreferences,
  ctx: RecommendationContext,
  durationMin: number,
  latestFinish: string,
): Exclusion[] {
  const t = c.trail;
  const out: Exclusion[] = [];
  const add = (code: ExclusionCode, message: string) => out.push({ code, message });

  if (t.status !== "published") add("status", `Not open for planning (catalog status: ${t.status}).`);
  if (!t.hasGeometry || !t.geometryValidatedAt) add("geometry", "Route geometry has not been validated yet.");

  for (const cl of c.closures) {
    if (cl.severity === "closed" && closureOverlapsDay(cl, prefs.plannedDate, ctx.regionTimezone)) {
      add("closure", `Fully closed on ${prefs.plannedDate}: ${cl.reason}`);
    }
  }

  const availableMin = Math.round(prefs.availableHours * 60);
  if (durationMin > availableMin) {
    add("time", `Estimated ${formatDuration(durationMin)} at your pace (est.) is longer than your available ${hoursLabel(prefs.availableHours)}.`);
  }

  if (prefs.distanceKmMin !== undefined && t.distanceKm < prefs.distanceKmMin * (1 - DISTANCE_TOLERANCE)) {
    add("distance", `${km(t.distanceKm)} is shorter than your minimum of ${km(prefs.distanceKmMin)} (10% tolerance).`);
  }
  if (prefs.distanceKmMax !== undefined && t.distanceKm > prefs.distanceKmMax * (1 + DISTANCE_TOLERANCE)) {
    add("distance", `${km(t.distanceKm)} is longer than your maximum of ${km(prefs.distanceKmMax)} (10% tolerance).`);
  }

  if (prefs.maxElevationGainM !== undefined && t.elevationGainM > prefs.maxElevationGainM) {
    add("elevation", `Elevation gain ${formatElevation(t.elevationGainM)} is above your maximum of ${formatElevation(prefs.maxElevationGainM)}.`);
  }

  for (const need of prefs.accessibilityNeeds) {
    const feature = ACCESS_NEED_FEATURE[need as AccessNeed];
    if (!feature) continue;
    if (!t.accessibilityFeatures.includes(feature)) {
      add("accessibility", `Accessibility need not met: ${ACCESS_NEED_LABEL[need as AccessNeed]} is not recorded for this trail.`);
    }
  }

  if (prefs.bringingDog) {
    if (t.dogsAllowed === false) add("dogs", "Dogs are not allowed on this trail.");
    else if (t.dogsAllowed === null) add("dogs", "Dog policy unverified, so we can't plan this hike with a dog.");
  }

  const d = t.difficulty;
  if (prefs.experience === "new" && (d === "hard" || d === "strenuous")) {
    add("experience", `Rated ${d}: for newer hikers we only suggest easy or moderate trails.`);
  }
  if (prefs.fitness === "low" && (d === "hard" || d === "strenuous")) {
    add("experience", `Rated ${d}: not suggested for a low fitness level.`);
  }
  if (d === "strenuous" && prefs.experience !== "new" && prefs.fitness !== "low") {
    if (!(prefs.experience === "regular" || prefs.experience === "expert") || prefs.fitness !== "high") {
      add("experience", "Rated strenuous: suggested only for regular or expert hikers with high fitness.");
    }
  }

  const daysUntil = daysBetween(ctx.today, prefs.plannedDate);
  for (const p of c.permits) {
    if (p.leadTimeDays !== null && daysUntil < p.leadTimeDays) {
      add(
        "permit",
        `${p.name} usually needs about ${p.leadTimeDays} days' lead time; your date is ${daysUntil} day${daysUntil === 1 ? "" : "s"} away.`,
      );
    }
  }

  const finishMin = clockToMinutes(prefs.startTime) + durationMin;
  if (finishMin > clockToMinutes(latestFinish)) {
    add(
      "latest_finish",
      `Estimated finish ${finishMin >= 1440 ? "after midnight" : addMinutesToClock(prefs.startTime, durationMin)} is after the latest-finish estimate of ${latestFinish} for ${monthName(prefs.plannedDate)} (a conservative estimate, not an exact sunset).`,
    );
  }

  const capacity = c.capacityRemaining ?? t.dailyCapacity;
  if (capacity <= 0) add("capacity", "No remaining capacity on that date.");
  else if (prefs.partySize > capacity) add("capacity", `Party of ${prefs.partySize} is larger than the remaining capacity (${capacity}) on that date.`);

  return out;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function distanceTarget(prefs: TripPreferences): number | null {
  const { distanceKmMin: min, distanceKmMax: max } = prefs;
  if (min !== undefined && max !== undefined) return (min + max) / 2;
  if (max !== undefined) return max * 0.75;
  if (min !== undefined) return min * 1.25;
  return null;
}

function scoreTrail(
  c: CandidateTrail,
  prefs: TripPreferences,
  durationMin: number,
  latestFinish: string,
): { breakdown: ScoreFactor[]; reasons: string[]; warnings: string[]; score: number } {
  const t = c.trail;
  const breakdown: ScoreFactor[] = [];
  const reasons: string[] = [];
  const warnings: string[] = [];

  // Terrain overlap (20)
  if (prefs.preferredTerrain.length) {
    const matched = prefs.preferredTerrain.filter((p) => t.terrain.includes(p));
    const points = Math.round((20 * matched.length) / prefs.preferredTerrain.length);
    breakdown.push({
      factor: "Terrain match",
      points,
      max: 20,
      detail: matched.length ? `Matches ${matched.length} of ${prefs.preferredTerrain.length} preferred terrain types (${matched.map(label).join(", ")}).` : "None of your preferred terrain types.",
    });
    if (matched.length) reasons.push(`Terrain you like: ${matched.map(label).join(", ")}.`);
  } else {
    breakdown.push({ factor: "Terrain match", points: 10, max: 20, detail: "No terrain preference given (neutral score).", neutral: true });
  }

  // Distance fit (20)
  const target = distanceTarget(prefs);
  if (target !== null) {
    const deviation = Math.abs(t.distanceKm - target) / Math.max(target, 0.5);
    const points = Math.round(20 * Math.max(0, 1 - deviation));
    breakdown.push({ factor: "Distance fit", points, max: 20, detail: `${km(t.distanceKm)} vs. your target of about ${km(target)}.` });
    if (points >= 14) reasons.push(`Distance (${km(t.distanceKm)}) is close to what you asked for.`);
  } else {
    breakdown.push({ factor: "Distance fit", points: 10, max: 20, detail: "No distance preference given (neutral score).", neutral: true });
  }

  // Elevation preference (10)
  if (prefs.maxElevationGainM !== undefined && prefs.maxElevationGainM > 0) {
    const ratio = t.elevationGainM / prefs.maxElevationGainM;
    const points = Math.round(ratio <= 0.8 ? 10 : 10 * (1 - ((ratio - 0.8) / 0.2) * 0.5));
    breakdown.push({
      factor: "Elevation fit",
      points,
      max: 10,
      detail: `${formatElevation(t.elevationGainM)} gain vs. your maximum of ${formatElevation(prefs.maxElevationGainM)}.`,
    });
  } else {
    breakdown.push({ factor: "Elevation fit", points: 5, max: 10, detail: "No elevation limit given (neutral score).", neutral: true });
  }

  // Difficulty fit (20)
  const ideal = IDEAL_DIFFICULTY[prefs.experience][prefs.fitness];
  const diff = Math.abs(DIFFICULTY_INDEX[t.difficulty] - ideal);
  const diffPoints = Math.max(0, Math.round(20 - 10 * diff));
  breakdown.push({
    factor: "Difficulty fit",
    points: diffPoints,
    max: 20,
    detail: `Rated ${t.difficulty}; for your experience (${prefs.experience}) and fitness (${prefs.fitness}) we aim for ${ideal <= 0.25 ? "easy" : ideal <= 1.25 ? "moderate" : ideal <= 2.25 ? "hard" : "hard to strenuous"} trails.`,
  });
  if (diffPoints >= 15) reasons.push(`Difficulty (${t.difficulty}) suits your experience and fitness.`);

  // Time buffer (15)
  const availableBuffer = Math.round(prefs.availableHours * 60) - durationMin;
  const daylightBuffer = clockToMinutes(latestFinish) - (clockToMinutes(prefs.startTime) + durationMin);
  const buffer = Math.min(availableBuffer, daylightBuffer);
  const bufferPoints = Math.round(15 * Math.min(1, Math.max(0, buffer / 90)));
  breakdown.push({
    factor: "Time buffer",
    points: bufferPoints,
    max: 15,
    detail: `About ${formatDuration(Math.max(0, buffer))} to spare before your time limit or the latest-finish estimate (est.).`,
  });
  if (buffer >= 60) reasons.push(`Leaves about ${formatDuration(buffer)} of spare time (est.).`);
  if (buffer < 30) warnings.push(`Tight schedule: less than 30 minutes of spare time (est.). Start earlier or allow more time.`);

  // Closure / advisory penalty (up to −15)
  let penalty = 0;
  for (const cl of c.closures) {
    if (cl.severity === "partial") {
      penalty += 10;
      warnings.push(`Partial closure: ${cl.reason}`);
    } else if (cl.severity === "advisory") {
      penalty += 4;
      warnings.push(`Advisory: ${cl.reason}`);
    }
  }
  penalty = Math.min(15, penalty);
  breakdown.push({
    factor: "Closures & advisories",
    points: -penalty,
    max: 0,
    detail: penalty ? "Penalty for partial closures or advisories in effect on your date." : "No partial closures or advisories on your date.",
  });

  // Accessibility bonus (5)
  if (prefs.accessibilityNeeds.length) {
    breakdown.push({
      factor: "Accessibility",
      points: 5,
      max: 5,
      detail:
        prefs.accessibilityNeeds.length === 1
          ? "Your accessibility need is recorded in the catalog (verify on site)."
          : `All ${prefs.accessibilityNeeds.length} accessibility needs are recorded in the catalog (verify on site).`,
    });
    reasons.push("Meets every accessibility need you selected (per catalog data; verify on site).");
  } else {
    const pts = Math.min(5, Math.round(t.accessibilityFeatures.length * 0.5));
    const n = t.accessibilityFeatures.length;
    breakdown.push({
      factor: "Accessibility",
      points: pts,
      max: 5,
      detail: n ? `${n} accessibility feature${n === 1 ? "" : "s"} recorded (small bonus; you selected no needs).` : "No accessibility features recorded.",
    });
  }

  // POI richness (10)
  const poiPoints = Math.min(10, Math.round(c.stopCount * 2.5));
  breakdown.push({ factor: "Narration stops", points: poiPoints, max: 10, detail: `${c.stopCount} narration stops along the route.` });
  if (c.stopCount >= 3) reasons.push(`${c.stopCount} narration stops along the way.`);

  // Permit + equipment notes (warnings, never decisive)
  for (const p of c.permits) {
    warnings.push(`Permit required: ${p.name}${p.leadTimeDays !== null ? ` (allow about ${p.leadTimeDays} days)` : ""}. Apply through the official link on the trail page.`);
  }
  if (t.permitRequired && !c.permits.length) warnings.push("Permit required: details unavailable. Check with the land manager before you go.");
  if (t.routeType === "point_to_point") warnings.push("Point-to-point route: arrange a shuttle or second car.");
  const has = (e: Equipment) => prefs.equipment.includes(e);
  if (!has("headlamp") && daylightBuffer < 60) warnings.push("Your estimated finish is within an hour of the latest-finish estimate: bring a headlamp.");
  if (!has("map_and_compass") && (t.routeType === "point_to_point" || t.distanceKm >= 12 || DIFFICULTY_INDEX[t.difficulty] >= 2)) {
    warnings.push("Carry a navigation backup such as a map and compass; don't rely on a phone alone.");
  }
  if (!has("satellite_communicator") && (DIFFICULTY_INDEX[t.difficulty] >= 2 || t.distanceKm >= 12)) {
    warnings.push("Mobile coverage may be unreliable. Ghost Guide cannot call for help for you; consider carrying a satellite communicator.");
  }
  if (!has("trekking_poles") && t.elevationGainM >= 600) warnings.push("Long descents: trekking poles can make them easier on your knees.");
  if (!has("first_aid_kit")) warnings.push("Pack a basic first-aid kit.");

  const raw = breakdown.reduce((s, f) => s + f.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return { breakdown, reasons, warnings, score };
}

// ---------------------------------------------------------------------------
// Relax suggestions
// ---------------------------------------------------------------------------

function relaxSuggestions(
  excluded: { c: CandidateTrail; exclusions: Exclusion[]; durationMin: number }[],
  prefs: TripPreferences,
  latestFinish: string,
): string[] {
  const out: string[] = [];
  const by = (code: ExclusionCode) => excluded.filter((e) => e.exclusions.some((x) => x.code === code));
  // Trails blocked by ONLY this constraint are the most useful to mention.
  const onlyBy = (code: ExclusionCode) => excluded.filter((e) => e.exclusions.length && e.exclusions.every((x) => x.code === code));
  const names = (list: { c: CandidateTrail }[]) => list.map((e) => e.c.trail.name).join(", ");

  const time = by("time");
  if (time.length) {
    const need = Math.min(...time.map((e) => e.durationMin));
    const hours = Math.ceil((need / 60) * 2) / 2;
    const closest = time.find((e) => e.durationMin === need)!;
    out.push(`Allow at least ${hoursLabel(hours)} to include ${closest.c.trail.name} (${time.length} trail${time.length > 1 ? "s" : ""} need more than ${hoursLabel(prefs.availableHours)}).`);
  }
  const dist = by("distance");
  if (dist.length) {
    const ds = dist.map((e) => e.c.trail.distanceKm);
    const shortest = Math.min(...ds);
    const longest = Math.max(...ds);
    out.push(
      `Widen your distance range: ${names(dist)} ${dist.length > 1 ? "are" : "is"} between ${km(shortest)} and ${km(longest)}.`,
    );
  }
  const elev = by("elevation");
  if (elev.length) {
    const lowest = Math.min(...elev.map((e) => e.c.trail.elevationGainM));
    out.push(`Raise your maximum elevation gain to ${formatElevation(lowest)} to include ${elev.find((e) => e.c.trail.elevationGainM === lowest)!.c.trail.name}.`);
  }
  const lf = by("latest_finish");
  if (lf.length) {
    const shortest = Math.min(...lf.map((e) => e.durationMin));
    const name = lf.find((e) => e.durationMin === shortest)!.c.trail.name;
    if (shortest < clockToMinutes(latestFinish)) {
      const startBy = addMinutesToClock(latestFinish, -shortest);
      out.push(`Start earlier, by ${startBy} at the latest, to finish ${name} before the latest-finish estimate (${latestFinish}), or pick a month with more daylight.`);
    } else {
      out.push(`${name} takes longer (est.) than the hours before this month's latest-finish estimate (${latestFinish}); pick a month with more daylight.`);
    }
  }
  const permit = by("permit");
  if (permit.length) {
    const lead = Math.max(...permit.flatMap((e) => e.c.permits.map((p) => p.leadTimeDays ?? 0)));
    out.push(`Choose a date at least ${lead} days from today to allow permit lead time for ${names(permit)}.`);
  }
  const closure = by("closure");
  if (closure.length) out.push(`${names(closure)} ${closure.length > 1 ? "are" : "is"} fully closed on your date: choose a different date.`);
  const access = by("accessibility");
  if (access.length) {
    out.push(
      `${access.length} trail${access.length > 1 ? "s" : ""} don't list every accessibility feature you need. We won't suggest a trail that doesn't meet your needs; only remove a need if it is genuinely optional for you.`,
    );
  }
  const dogs = by("dogs");
  if (dogs.length) out.push(`Plan without a dog to include ${names(dogs)} (dogs not allowed or policy unverified).`);
  const exp = onlyBy("experience");
  if (exp.length) out.push(`${names(exp)} ${exp.length > 1 ? "are" : "is"} rated above what we suggest for your experience and fitness. Building up with easier hikes first is the best way to get there.`);
  const cap = by("capacity");
  if (cap.length) out.push(`Choose another date or a smaller group: ${names(cap)} ${cap.length > 1 ? "have" : "has"} no room for your party.`);
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function recommendTrails(prefs: TripPreferences, candidates: CandidateTrail[], ctx: RecommendationContext): RecommendationResult {
  const paceFactor = computePaceFactor(prefs);
  const latestFinish = latestFinishFor(prefs.plannedDate, ctx.latestFinishByMonth);
  const ranked: RankedTrail[] = [];
  const excludedRaw: { c: CandidateTrail; exclusions: Exclusion[]; durationMin: number }[] = [];

  for (const c of candidates) {
    // Only closures relevant to the planned day count toward filters and penalties.
    const relevant: CandidateTrail = { ...c, closures: c.closures.filter((cl) => closureOverlapsDay(cl, prefs.plannedDate, ctx.regionTimezone)) };
    const durationMin = estimateTripDurationMin(c.trail.estimatedDurationMin, paceFactor, c.stopCount);
    const exclusions = hardFilters(relevant, prefs, ctx, durationMin, latestFinish);
    if (exclusions.length) {
      excludedRaw.push({ c: relevant, exclusions, durationMin });
      continue;
    }
    const s = scoreTrail(relevant, prefs, durationMin, latestFinish);
    ranked.push({
      trailId: c.trail.id,
      score: s.score,
      breakdown: s.breakdown,
      reasons: s.reasons,
      warnings: s.warnings,
      estimatedDurationMin: durationMin,
      estimatedFinishTime: addMinutesToClock(prefs.startTime, durationMin),
      paceFactor,
    });
  }

  const nameOf = new Map(candidates.map((c) => [c.trail.id, c.trail.name]));
  const byName = (a: string, b: string) => (nameOf.get(a) ?? "").localeCompare(nameOf.get(b) ?? "", "en") || a.localeCompare(b);
  ranked.sort((a, b) => b.score - a.score || byName(a.trailId, b.trailId));
  excludedRaw.sort((a, b) => byName(a.c.trail.id, b.c.trail.id));

  const excluded: ExcludedTrail[] = excludedRaw.map((e) => ({
    trailId: e.c.trail.id,
    reasons: e.exclusions.map((x) => x.message),
    codes: [...new Set(e.exclusions.map((x) => x.code))],
  }));
  const noMatch = ranked.length === 0;
  return {
    ranked,
    excluded,
    noMatch,
    relaxSuggestions: noMatch || ranked.length < 2 ? relaxSuggestions(excludedRaw, prefs, latestFinish) : [],
    latestFinishTime: latestFinish,
    paceFactor,
  };
}

/** Exposed for display: route-type label. */
export function routeTypeLabel(rt: RouteType): string {
  return rt === "out_and_back" ? "Out and back" : rt === "point_to_point" ? "Point to point" : "Loop";
}
