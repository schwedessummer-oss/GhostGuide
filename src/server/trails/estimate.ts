import "server-only";
import type { Difficulty, DogPolicy, RouteType } from "@/domain/catalog";

/**
 * Derived trail estimates: moving time, difficulty, family suitability and a
 * data-completeness score. Pure and deterministic. Every output here is an
 * ESTIMATE computed from mapped data and must be labelled as such in the UI;
 * nothing in this module adds facts the source did not provide.
 */

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

/** Walking speed used when no elevation profile exists (km/h, flat-ground assumption). */
export const FLAT_SPEED_NO_PROFILE_KMH = 4.5;
/** Shortest duration ever reported, minutes. */
export const MIN_DURATION_MIN = 5;
/** Tobler slopes are clamped to ±50 % (beyond that people scramble, the model breaks down). */
const MAX_ABS_SLOPE = 0.5;
/** Profile smoothing: centred window of ±50 m along the route. */
const PROFILE_SMOOTH_HALF_WINDOW_M = 50;

export type Profile = readonly (readonly [number, number])[];

export interface DurationInput {
  /** One traversal of the route in the given direction, metres. */
  distanceM: number;
  /** [distance_m, elevation_m] in travel direction, or null when unknown. */
  profile: Profile | null;
  /** Multiplies the time: 1 = average hiker, 1.25 = 25 % slower, 0.8 = faster. */
  paceFactor?: number;
}

/**
 * Tobler's hiking function: walking speed in km/h on a slope (rise/run).
 * 6·exp(−3.5·|s + 0.05|): fastest (6 km/h) on a gentle 5 % descent,
 * ~5.04 km/h on the flat. Slopes are clamped to ±0.5.
 */
export function toblerSpeedKmh(slope: number): number {
  const s = Number.isFinite(slope) ? Math.max(-MAX_ABS_SLOPE, Math.min(MAX_ABS_SLOPE, slope)) : 0;
  return 6 * Math.exp(-3.5 * Math.abs(s + 0.05));
}

/** Keep only [finite, finite] pairs. */
function sanitizeProfile(profile: unknown): [number, number][] {
  if (!Array.isArray(profile)) return [];
  const out: [number, number][] = [];
  for (const p of profile) {
    if (Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) out.push([p[0], p[1]]);
  }
  return out;
}

/**
 * Split a profile into runs of strictly increasing distance. A repeated or
 * decreasing distance marks a discontinuity (e.g. the jump between two
 * disconnected lines), which must not be walked as a cliff.
 */
function runsOf(points: [number, number][]): [number, number][][] {
  const runs: [number, number][][] = [];
  let current: [number, number][] = [];
  for (const p of points) {
    if (current.length > 0 && p[0] <= current[current.length - 1][0]) {
      runs.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Centred moving average by distance over a run (distances strictly
 * increasing). Point i averages the points within ±h of it, where
 * h = min(halfWindowM, distance to the run's start, distance to its end): the
 * window shrinks symmetrically near the ends, so endpoint elevations are kept
 * and a steady climb keeps its full height. Both window bounds only move
 * forward as i grows, so two pointers give O(n).
 */
function smoothByDistance(run: [number, number][], halfWindowM: number): number[] {
  const n = run.length;
  const first = run[0][0];
  const last = run[n - 1][0];
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + run[i][1];
  const out = new Array<number>(n);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const d = run[i][0];
    const h = Math.min(halfWindowM, d - first, last - d);
    while (run[lo][0] < d - h) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < n && run[hi + 1][0] <= d + h) hi++;
    out[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }
  return out;
}

/** Tobler moving time over a profile; null when it has no measurable length. */
function toblerMinutes(profile: Profile): { minutes: number; lengthM: number } | null {
  let minutes = 0;
  let lengthM = 0;
  for (const run of runsOf(sanitizeProfile(profile))) {
    if (run.length < 2) continue;
    const elev = smoothByDistance(run, PROFILE_SMOOTH_HALF_WINDOW_M);
    for (let i = 1; i < run.length; i++) {
      const h = run[i][0] - run[i - 1][0];
      const v = toblerSpeedKmh((elev[i] - elev[i - 1]) / h);
      minutes += (h / 1000 / v) * 60;
      lengthM += h;
    }
  }
  return lengthM > 0 ? { minutes, lengthM } : null;
}

function validPace(paceFactor: number | undefined): number {
  return paceFactor !== undefined && Number.isFinite(paceFactor) && paceFactor > 0 ? paceFactor : 1;
}

function assertDistance(distanceM: number): void {
  if (typeof distanceM !== "number" || !Number.isFinite(distanceM) || distanceM < 0) {
    throw new RangeError("distanceM must be a finite, non-negative number");
  }
}

/** Unrounded moving minutes for one traversal (see estimateDurationMin). */
function rawDurationMin(distanceM: number, profile: Profile | null): number {
  const tobler = profile ? toblerMinutes(profile) : null;
  if (tobler) {
    // The profile supplies the slope distribution; distanceM is authoritative for length.
    return tobler.minutes * (distanceM / tobler.lengthM);
  }
  return (distanceM / 1000 / FLAT_SPEED_NO_PROFILE_KMH) * 60;
}

/**
 * Moving-time estimate (minutes) for ONE traversal in the profile's direction.
 *
 * With a profile: the elevations are smoothed (centred ±50 m window, so DEM
 * noise does not turn into phantom slopes) and Tobler's hiking function is
 * applied per profile segment; the resulting time is scaled to `distanceM`.
 * Without a usable profile: distance at a flat 4.5 km/h, a deliberately
 * conservative pace for unknown terrain (Tobler's flat speed is ~5 km/h).
 * Breaks are not included. Rounded to whole minutes, at least 5.
 * Throws RangeError for a negative or non-finite distance.
 */
export function estimateDurationMin(input: DurationInput): number {
  assertDistance(input.distanceM);
  const minutes = rawDurationMin(input.distanceM, input.profile) * validPace(input.paceFactor);
  return Math.max(MIN_DURATION_MIN, Math.round(minutes));
}

/** The same profile walked in the opposite direction. */
export function reverseProfile(profile: Profile): [number, number][] {
  const points = sanitizeProfile(profile);
  if (points.length === 0) return [];
  const end = points.reduce((max, p) => Math.max(max, p[0]), -Infinity);
  return points.reverse().map(([d, e]) => [end - d, e] as [number, number]);
}

/**
 * Out-and-back moving time for a linear route: the one-way `distanceM` walked
 * forward along `profile` and back along the reversed profile (so a climb
 * out becomes a descent back). Unrounded legs are summed, then rounded once.
 */
export function estimateOutAndBackMin(distanceM: number, profile: Profile | null, paceFactor = 1): number {
  assertDistance(distanceM);
  const forward = rawDurationMin(distanceM, profile);
  const back = rawDurationMin(distanceM, profile ? reverseProfile(profile) : null);
  return Math.max(MIN_DURATION_MIN, Math.round((forward + back) * validPace(paceFactor)));
}

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

/** OSM sac_scale values in order of the SAC hiking scale grades T1…T6. */
export const SAC_SCALE_VALUES = [
  "hiking",
  "mountain_hiking",
  "demanding_mountain_hiking",
  "alpine_hiking",
  "demanding_alpine_hiking",
  "difficult_alpine_hiking",
] as const;

const SAC_TO_DIFFICULTY: readonly Difficulty[] = ["easy", "moderate", "hard", "expert", "expert", "expert"];
const DIFFICULTY_RANK: Record<Difficulty, number> = { unknown: -1, easy: 0, moderate: 1, hard: 2, expert: 3 };

/**
 * 0-based SAC grade (0 = hiking/T1 … 5 = difficult_alpine_hiking/T6) or null.
 * Accepts the OSM values case-insensitively, the equivalent "T1"…"T6", and
 * ";"-separated lists (the hardest grade wins). Any unrecognised part makes
 * the whole value unknown, so a typo is never read as an easy grade.
 */
export function sacScaleRank(sac: string | null | undefined): number | null {
  if (typeof sac !== "string") return null;
  const parts = sac
    .split(";")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;
  let rank = -1;
  for (const part of parts) {
    let r = (SAC_SCALE_VALUES as readonly string[]).indexOf(part);
    const t = /^t([1-6])$/.exec(part);
    if (r === -1 && t) r = Number(t[1]) - 1;
    if (r === -1) return null;
    rank = Math.max(rank, r);
  }
  return rank;
}

/**
 * Technical difficulty from the OSM sac_scale tag:
 * hiking → easy, mountain_hiking → moderate, demanding_mountain_hiking → hard,
 * alpine_hiking / demanding_alpine_hiking / difficult_alpine_hiking → expert.
 * Missing or unrecognised values → null.
 */
export function difficultyFromSacScale(sac: string | null | undefined): Difficulty | null {
  const rank = sacScaleRank(sac);
  return rank === null ? null : SAC_TO_DIFFICULTY[rank];
}

export interface EffortInput {
  /** Distance actually walked, metres. */
  distanceM: number;
  /** Total climb over that distance, metres; null when unknown. */
  gainM: number | null;
}

/**
 * Effort score in "flat-kilometre equivalents": km + gain_m / 100. This is the
 * Naismith-style equivalence (1 h per 5 km plus 1 h per 600 m of ascent puts
 * 100 m of climb at ~0.8 km; the common hiking rule of thumb rounds it to
 * 1 km). Null when the distance is invalid. Unknown/invalid gain counts as 0.
 */
export function effortScore(input: EffortInput): number | null {
  const { distanceM, gainM } = input;
  if (typeof distanceM !== "number" || !Number.isFinite(distanceM) || distanceM < 0) return null;
  const gain = typeof gainM === "number" && Number.isFinite(gainM) && gainM > 0 ? gainM : 0;
  return distanceM / 1000 + gain / 100;
}

/** Effort thresholds (score, exclusive upper bounds): easy < 6 ≤ moderate < 13 ≤ hard < 22 ≤ expert. */
export const EFFORT_THRESHOLDS = { easy: 6, moderate: 13, hard: 22 } as const;

/**
 * Physical-effort difficulty from distance and climb (see effortScore). When
 * gain is unknown, distance alone is scored with the same thresholds, which
 * can only under-rate a hilly route. "unknown" only for an invalid distance.
 */
export function effortDifficulty(input: EffortInput): Difficulty {
  const score = effortScore(input);
  if (score === null) return "unknown";
  if (score < EFFORT_THRESHOLDS.easy) return "easy";
  if (score < EFFORT_THRESHOLDS.moderate) return "moderate";
  if (score < EFFORT_THRESHOLDS.hard) return "hard";
  return "expert";
}

export interface RouteEffortInput {
  /** One traversal of the mapped geometry, metres. */
  distanceM: number;
  /** Climb over one traversal; null when unknown. */
  gainM: number | null;
  /**
   * Descent over one traversal (optional). For linear routes the walk back
   * climbs what the way out descended, so the round trip climbs gain + loss;
   * when loss is unknown only the outbound gain is counted (a lower bound).
   */
  lossM?: number | null;
  routeType: RouteType;
}

const nonNegative = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/** Distance and climb of the hike people actually do: out-and-back for linear routes. */
export function hikeEffortOf(input: RouteEffortInput): { distanceM: number; gainM: number | null } {
  const gain = nonNegative(input.gainM);
  if (input.routeType !== "linear") return { distanceM: input.distanceM, gainM: gain };
  return {
    distanceM: input.distanceM * 2,
    gainM: gain === null ? null : gain + (nonNegative(input.lossM) ?? 0),
  };
}

export interface ClassifyInput extends RouteEffortInput {
  sacScale: string | null;
}

export interface ClassifiedDifficulty {
  difficulty: Difficulty;
  /** "osm_sac_scale" only when the mapped SAC grade decided the result. */
  source: "osm_sac_scale" | "estimated";
}

/**
 * Overall difficulty = the harder of the technical grade (OSM sac_scale) and
 * the effort grade (effortDifficulty over the out-and-back hike for linear
 * routes, one traversal otherwise). On a tie the SAC grade is credited, since
 * mapped data alone supports the result. Without a usable SAC grade the
 * source is "estimated". (Only an invalid distance with no SAC grade yields
 * "unknown"; callers should store a null source in that case.)
 */
export function classifyDifficulty(input: ClassifyInput): ClassifiedDifficulty {
  const effort = effortDifficulty(hikeEffortOf(input));
  const technical = difficultyFromSacScale(input.sacScale);
  if (technical !== null && DIFFICULTY_RANK[technical] >= DIFFICULTY_RANK[effort]) {
    return { difficulty: technical, source: "osm_sac_scale" };
  }
  return { difficulty: effort, source: "estimated" };
}

export interface FamilyInput extends RouteEffortInput {
  difficulty: Difficulty;
  sacScale: string | null;
}

/** Family-friendly limits for the whole hike (out-and-back for linear routes). */
export const FAMILY_MAX_DISTANCE_M = 6_000;
export const FAMILY_MAX_GAIN_M = 250;

/**
 * Conservative family-friendly flag. All must hold:
 *  - overall difficulty is "easy";
 *  - no SAC grade, or a grade no harder than "hiking" (T1); an unrecognised
 *    grade fails;
 *  - the hike (out-and-back for linear routes) is at most 6 km;
 *  - its climb is KNOWN and at most 250 m (unknown climb fails: we do not
 *    call a route family friendly without elevation data).
 */
export function isFamilyFriendly(input: FamilyInput): boolean {
  if (input.difficulty !== "easy") return false;
  if (typeof input.sacScale === "string" && input.sacScale.trim() !== "") {
    const rank = sacScaleRank(input.sacScale);
    if (rank === null || rank > 0) return false;
  }
  if (typeof input.distanceM !== "number" || !Number.isFinite(input.distanceM) || input.distanceM < 0) return false;
  const hike = hikeEffortOf(input);
  if (hike.distanceM > FAMILY_MAX_DISTANCE_M) return false;
  return hike.gainM !== null && hike.gainM <= FAMILY_MAX_GAIN_M;
}

// ---------------------------------------------------------------------------
// Data quality
// ---------------------------------------------------------------------------

export type TrailheadSource = "osm_trailhead" | "parking" | "route_start" | "official";

/** Inputs to qualityScore; anything omitted counts as missing. */
export interface QualityFields {
  name?: string | null;
  /** True when the provider derived the name (e.g. from a ref) rather than a mapped name. */
  nameIsFallback?: boolean;
  /** Mapped geometry length, metres. */
  distanceM?: number | null;
  /** Non-null when DEM elevation was computed for the route. */
  elevationGainM?: number | null;
  sacScale?: string | null;
  surfaces?: readonly string[] | null;
  trailheadSource?: TrailheadSource | null;
  description?: string | null;
  website?: string | null;
  operator?: string | null;
  trailVisibility?: string | null;
  routeType?: RouteType | null;
  dogPolicy?: DogPolicy | null;
  feeRequired?: boolean | null;
}

/**
 * Weights of the completeness score (sum = 100). Name, usable geometry and
 * elevation dominate because search, maps and estimates depend on them.
 */
export const QUALITY_WEIGHTS = {
  name: 20, // a fallback name earns 5
  geometry: 15, // ≥ 1 km: 15; ≥ 300 m: 8; > 0: 3
  elevation: 15,
  trailhead: 10, // osm_trailhead/official 10, parking 7, route_start 3
  sacScale: 10, // recognised grade only
  description: 8,
  surface: 6,
  website: 4,
  operator: 3,
  trailVisibility: 3,
  routeType: 2, // loop, linear or network
  dogPolicy: 2, // anything but "unknown"
  fee: 2, // fee_required known (true or false)
} as const;

const hasText = (v: string | null | undefined) => typeof v === "string" && v.trim().length > 0;

/**
 * 0–100 completeness score of a catalog trail: how much of what hikers need
 * is actually known from the source. It measures data coverage, not trail
 * quality, and is used to rank otherwise comparable search results.
 */
export function qualityScore(fields: QualityFields): number {
  const w = QUALITY_WEIGHTS;
  let score = 0;

  if (hasText(fields.name)) score += fields.nameIsFallback ? 5 : w.name;

  const d = fields.distanceM;
  if (typeof d === "number" && Number.isFinite(d) && d > 0) score += d >= 1000 ? w.geometry : d >= 300 ? 8 : 3;

  if (typeof fields.elevationGainM === "number" && Number.isFinite(fields.elevationGainM)) score += w.elevation;

  switch (fields.trailheadSource) {
    case "osm_trailhead":
    case "official":
      score += w.trailhead;
      break;
    case "parking":
      score += 7;
      break;
    case "route_start":
      score += 3;
      break;
    default:
      break;
  }

  if (sacScaleRank(fields.sacScale) !== null) score += w.sacScale;
  if (hasText(fields.description)) score += w.description;
  if (Array.isArray(fields.surfaces) && fields.surfaces.some((s) => hasText(s))) score += w.surface;
  if (typeof fields.website === "string" && /^https?:\/\/\S+$/i.test(fields.website.trim())) score += w.website;
  if (hasText(fields.operator)) score += w.operator;
  if (hasText(fields.trailVisibility)) score += w.trailVisibility;
  if (fields.routeType === "loop" || fields.routeType === "linear" || fields.routeType === "network") score += w.routeType;
  if (fields.dogPolicy && fields.dogPolicy !== "unknown") score += w.dogPolicy;
  if (typeof fields.feeRequired === "boolean") score += w.fee;

  return Math.max(0, Math.min(100, Math.round(score)));
}
