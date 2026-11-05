/**
 * Questionnaire validation (zod) and URL (de)serialization.
 *
 * The questionnaire is a GET form so results are shareable and reloadable
 * without database writes. The form uses imperial units (miles / feet); the
 * validated TripPreferences use metric (km / m) as stored on trips.preferences.
 *
 * No `server-only` import: pure validation, also used by unit tests.
 */
import { z } from "zod";
import { TERRAIN_OPTIONS, type TripPreferences } from "@/domain/types";
import { ACCESS_NEEDS, EQUIPMENT_OPTIONS } from "@/domain/recommendation";
import { localDateInZone, localTimeInZone } from "@/lib/time";

export const EXPERIENCE_LEVELS = ["new", "some", "regular", "expert"] as const;
export const FITNESS_LEVELS = ["low", "moderate", "high"] as const;
export const PACES = ["leisurely", "steady", "brisk"] as const;

const KM_PER_MI = 1.609344;
const M_PER_FT = 0.3048;
export const miToKm = (mi: number) => Math.round(mi * KM_PER_MI * 1000) / 1000;
export const kmToMi = (km: number) => Math.round((km / KM_PER_MI) * 100) / 100;
export const ftToM = (ft: number) => Math.round(ft * M_PER_FT * 10) / 10;
export const mToFt = (m: number) => Math.round(m / M_PER_FT);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function isRealDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const unique = <T,>(arr: T[]) => [...new Set(arr)];

// ---------------------------------------------------------------------------
// Validated preferences (metric) — the shape saved on trips.preferences
// ---------------------------------------------------------------------------
export const tripPreferencesSchema = z
  .object({
    experience: z.enum(EXPERIENCE_LEVELS),
    fitness: z.enum(FITNESS_LEVELS),
    preferredTerrain: z.array(z.enum(TERRAIN_OPTIONS)).max(TERRAIN_OPTIONS.length).transform(unique),
    pace: z.enum(PACES),
    availableHours: z.number().min(1).max(14),
    distanceKmMin: z.number().min(0).max(80).optional(),
    distanceKmMax: z.number().min(0.5).max(80).optional(),
    maxElevationGainM: z.number().min(0).max(4000).optional(),
    plannedDate: z.string().refine(isRealDate, "Use a valid date (YYYY-MM-DD)."),
    startTime: z.string().regex(HHMM, "Use a 24-hour time like 08:30."),
    accessibilityNeeds: z.array(z.enum(ACCESS_NEEDS)).max(ACCESS_NEEDS.length).transform(unique),
    partySize: z.number().int().min(1).max(12),
    equipment: z.array(z.enum(EQUIPMENT_OPTIONS)).max(EQUIPMENT_OPTIONS.length).transform(unique),
    bringingDog: z.boolean().optional(),
  })
  .refine((p) => p.distanceKmMin === undefined || p.distanceKmMax === undefined || p.distanceKmMin <= p.distanceKmMax, {
    message: "Minimum distance must not be more than the maximum.",
    path: ["distanceKmMax"],
  });

export function parseTripPreferences(input: unknown): { ok: true; prefs: TripPreferences } | { ok: false; error: string } {
  const r = tripPreferencesSchema.safeParse(input);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  return { ok: true, prefs: r.data };
}

// ---------------------------------------------------------------------------
// Questionnaire form / query string (imperial)
// ---------------------------------------------------------------------------
export type RawParams = Record<string, string | string[] | undefined>;

/** Form field names, used by the form, the query string and error messages. */
export const PLAN_FIELDS = [
  "experience",
  "fitness",
  "terrain",
  "pace",
  "hours",
  "minMi",
  "maxMi",
  "maxGainFt",
  "date",
  "start",
  "needs",
  "party",
  "gear",
  "dog",
  "trail",
] as const;
export type PlanField = (typeof PLAN_FIELDS)[number];
const MULTI_FIELDS = new Set<PlanField>(["terrain", "needs", "gear"]);

export function toRawParams(input: URLSearchParams | RawParams): RawParams {
  if (!(input instanceof URLSearchParams)) return input;
  const out: RawParams = {};
  for (const key of new Set(input.keys())) {
    const all = input.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const all = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const optionalNumber = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .max(12)
    .optional()
    .transform((s, ctx) => {
      if (s === undefined || s === "") return undefined;
      const n = Number(s);
      if (!Number.isFinite(n) || n < min || n > max) {
        ctx.addIssue({ code: "custom", message: `${label} must be between ${min} and ${max}.` });
        return z.NEVER;
      }
      return n;
    });

const formSchema = z.object({
  experience: z.enum(EXPERIENCE_LEVELS, { error: "Choose your hiking experience." }),
  fitness: z.enum(FITNESS_LEVELS, { error: "Choose your fitness level." }),
  terrain: z.array(z.enum(TERRAIN_OPTIONS, { error: "Unknown terrain option." })).max(TERRAIN_OPTIONS.length),
  pace: z.enum(PACES, { error: "Choose a preferred pace." }),
  hours: z
    .string({ error: "Enter the hours you have available." })
    .trim()
    .min(1, "Enter the hours you have available.")
    .transform((s) => Number(s))
    .pipe(z.number({ error: "Enter a number of hours." }).min(1, "Allow at least 1 hour.").max(14, "Plan at most 14 hours for a day hike.")),
  minMi: optionalNumber(0, 50, "Minimum distance"),
  maxMi: optionalNumber(0.5, 50, "Maximum distance"),
  maxGainFt: optionalNumber(0, 13000, "Maximum elevation gain"),
  date: z.string({ error: "Choose a date." }).refine(isRealDate, "Choose a valid date."),
  start: z
    .string({ error: "Choose a start time." })
    .transform((s) => s.slice(0, 5))
    .pipe(z.string().regex(HHMM, "Use a time like 08:30.")),
  needs: z.array(z.enum(ACCESS_NEEDS, { error: "Unknown accessibility option." })).max(ACCESS_NEEDS.length),
  party: z
    .string({ error: "Enter your group size." })
    .trim()
    .transform((s) => Number(s))
    .pipe(z.number().int("Group size must be a whole number.").min(1, "Group size is 1 to 12.").max(12, "Group size is 1 to 12.")),
  gear: z.array(z.enum(EQUIPMENT_OPTIONS, { error: "Unknown equipment option." })).max(EQUIPMENT_OPTIONS.length),
  dog: z.enum(["yes"]).optional(),
  trail: z
    .string()
    .regex(/^[a-z0-9-]{1,80}$/, "Unknown trail.")
    .optional(),
});

export type PlanErrors = Partial<Record<PlanField, string>>;

export type PlanParseResult =
  | { ok: true; prefs: TripPreferences; trailSlug?: string }
  | { ok: false; errors: PlanErrors; hasInput: boolean };

/** True when the params contain any questionnaire answer (vs. a first visit). */
export function hasPlanInput(raw: RawParams): boolean {
  return PLAN_FIELDS.some((f) => f !== "trail" && raw[f] !== undefined);
}

export function parsePlanQuery(input: URLSearchParams | RawParams): PlanParseResult {
  const raw = toRawParams(input);
  const shaped: Record<string, unknown> = {};
  for (const f of PLAN_FIELDS) {
    shaped[f] = MULTI_FIELDS.has(f) ? all(raw[f]) : first(raw[f]);
    if (!MULTI_FIELDS.has(f) && shaped[f] === "" && (f === "trail" || f === "dog")) shaped[f] = undefined;
  }
  const r = formSchema.safeParse(shaped);
  if (!r.success) {
    const errors: PlanErrors = {};
    for (const issue of r.error.issues) {
      const field = issue.path[0] as PlanField;
      if (field && !errors[field]) errors[field] = issue.message;
    }
    return { ok: false, errors, hasInput: hasPlanInput(raw) };
  }
  const v = r.data;
  const prefsCandidate = {
    experience: v.experience,
    fitness: v.fitness,
    preferredTerrain: v.terrain,
    pace: v.pace,
    availableHours: v.hours,
    distanceKmMin: v.minMi === undefined ? undefined : miToKm(v.minMi),
    distanceKmMax: v.maxMi === undefined ? undefined : miToKm(v.maxMi),
    maxElevationGainM: v.maxGainFt === undefined ? undefined : ftToM(v.maxGainFt),
    plannedDate: v.date,
    startTime: v.start,
    accessibilityNeeds: v.needs,
    partySize: v.party,
    equipment: v.gear,
    bringingDog: v.dog === "yes",
  };
  const checked = tripPreferencesSchema.safeParse(prefsCandidate);
  if (!checked.success) {
    const errors: PlanErrors = {};
    for (const issue of checked.error.issues) {
      const key = issue.path[0];
      const field: PlanField = key === "distanceKmMax" || key === "distanceKmMin" ? "maxMi" : "date";
      if (!errors[field]) errors[field] = issue.message;
    }
    return { ok: false, errors, hasInput: true };
  }
  return { ok: true, prefs: checked.data, ...(v.trail ? { trailSlug: v.trail } : {}) };
}

/** Date/time rules relative to the region's current local time. */
export function validatePlanTiming(prefs: Pick<TripPreferences, "plannedDate" | "startTime">, now: Date, timeZone: string): PlanErrors {
  const errors: PlanErrors = {};
  const today = localDateInZone(now, timeZone);
  if (prefs.plannedDate < today) errors.date = "Choose today or a later date.";
  const maxDate = localDateInZone(new Date(now.getTime() + 366 * 86_400_000), timeZone);
  if (prefs.plannedDate > maxDate) errors.date = "Choose a date within the next year.";
  if (prefs.plannedDate === today && prefs.startTime <= localTimeInZone(now, timeZone)) {
    errors.start = "That start time has already passed today. Choose a later time or another day.";
  }
  return errors;
}

/** Canonical query string for validated preferences (shareable results URL). */
export function toPlanQuery(prefs: TripPreferences, trailSlug?: string): string {
  const q = new URLSearchParams();
  q.set("experience", prefs.experience);
  q.set("fitness", prefs.fitness);
  for (const t of prefs.preferredTerrain) q.append("terrain", t);
  q.set("pace", prefs.pace);
  q.set("hours", String(prefs.availableHours));
  if (prefs.distanceKmMin !== undefined) q.set("minMi", String(kmToMi(prefs.distanceKmMin)));
  if (prefs.distanceKmMax !== undefined) q.set("maxMi", String(kmToMi(prefs.distanceKmMax)));
  if (prefs.maxElevationGainM !== undefined) q.set("maxGainFt", String(mToFt(prefs.maxElevationGainM)));
  q.set("date", prefs.plannedDate);
  q.set("start", prefs.startTime);
  for (const n of prefs.accessibilityNeeds) q.append("needs", n);
  q.set("party", String(prefs.partySize));
  for (const g of prefs.equipment) q.append("gear", g);
  if (prefs.bringingDog) q.set("dog", "yes");
  if (trailSlug) q.set("trail", trailSlug);
  return q.toString();
}

/** Default questionnaire date: the next Saturday after today (region-local). */
export function defaultPlanDate(today: string): string {
  const d = new Date(`${today}T12:00:00Z`);
  const dow = d.getUTCDay();
  const add = dow === 6 ? 7 : 6 - dow;
  return new Date(d.getTime() + add * 86_400_000).toISOString().slice(0, 10);
}

/** Initial form values for a first visit. */
export function defaultPlanValues(today: string): RawParams {
  return {
    experience: "some",
    fitness: "moderate",
    pace: "steady",
    hours: "4",
    date: defaultPlanDate(today),
    start: "08:30",
    party: "2",
  };
}

/** Same-site results URL used for login `next` and redirects. */
export function resultsPath(prefs: TripPreferences, trailSlug?: string): string {
  return `/plan/results?${toPlanQuery(prefs, trailSlug)}`;
}
