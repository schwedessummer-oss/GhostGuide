/**
 * Trail-discovery filters for /trails (GET form, works without JS).
 * Pure: parses search params with zod and filters an in-memory list.
 */
import { z } from "zod";
import { ACCESSIBILITY_FEATURES, TERRAIN_OPTIONS, type Closure, type Difficulty, type Trail } from "@/domain/types";
import { formatDistance, formatElevation } from "@/domain/geo";

export const DIFFICULTIES: Difficulty[] = ["easy", "moderate", "hard", "strenuous"];

export const ACCESSIBILITY_FEATURE_LABEL: Record<(typeof ACCESSIBILITY_FEATURES)[number], string> = {
  step_free_start: "Step-free start",
  firm_surface: "Firm surface",
  benches: "Benches / rest stops",
  accessible_restroom: "Accessible restroom",
  accessible_parking: "Accessible parking",
  gentle_grade: "Gentle grade",
  shade: "Shade",
  no_exposure: "No exposed drop-offs",
  no_water_crossings: "No water crossings",
};

export function featureLabel(f: string): string {
  return ACCESSIBILITY_FEATURE_LABEL[f as keyof typeof ACCESSIBILITY_FEATURE_LABEL] ?? f.replace(/_/g, " ");
}

export interface TrailFilters {
  view: "list" | "map";
  difficulty: Difficulty[];
  maxMi?: number;
  maxGainFt?: number;
  terrain: string[];
  access: string[];
  dogs: boolean;
}

type Raw = Record<string, string | string[] | undefined>;
const arr = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const optNum = (max: number) =>
  z
    .string()
    .optional()
    .transform((s) => {
      if (!s) return undefined;
      const n = Number(s);
      return Number.isFinite(n) && n > 0 && n <= max ? n : undefined;
    });

const schema = z.object({
  view: z.enum(["list", "map"]).catch("list"),
  difficulty: z.array(z.string()).transform((a) => a.filter((d): d is Difficulty => (DIFFICULTIES as string[]).includes(d))),
  maxMi: optNum(100),
  maxGainFt: optNum(20000),
  terrain: z.array(z.string()).transform((a) => a.filter((t) => (TERRAIN_OPTIONS as readonly string[]).includes(t))),
  access: z.array(z.string()).transform((a) => a.filter((t) => (ACCESSIBILITY_FEATURES as readonly string[]).includes(t))),
  dogs: z
    .string()
    .optional()
    .transform((v) => v === "yes"),
});

/** Lenient parsing: unknown or invalid values are ignored rather than erroring. */
export function parseTrailFilters(raw: Raw): TrailFilters {
  const r = schema.safeParse({
    view: one(raw.view) ?? "list",
    difficulty: arr(raw.difficulty).slice(0, 10),
    maxMi: one(raw.maxMi),
    maxGainFt: one(raw.maxGainFt),
    terrain: arr(raw.terrain).slice(0, 20),
    access: arr(raw.access).slice(0, 20),
    dogs: one(raw.dogs),
  });
  return r.success ? r.data : { view: "list", difficulty: [], terrain: [], access: [], dogs: false };
}

export function activeFilterCount(f: TrailFilters): number {
  return f.difficulty.length + (f.maxMi ? 1 : 0) + (f.maxGainFt ? 1 : 0) + f.terrain.length + f.access.length + (f.dogs ? 1 : 0);
}

export function describeFilters(f: TrailFilters): string[] {
  const out: string[] = [];
  if (f.difficulty.length) out.push(`Difficulty: ${f.difficulty.join(", ")}`);
  if (f.maxMi) out.push(`Up to ${formatDistance(f.maxMi * 1609.344)}`);
  if (f.maxGainFt) out.push(`Up to ${formatElevation(f.maxGainFt * 0.3048)} gain`);
  if (f.terrain.length) out.push(`Terrain: ${f.terrain.join(", ")}`);
  if (f.access.length) out.push(`Accessibility: ${f.access.map(featureLabel).join(", ")}`);
  if (f.dogs) out.push("Dogs allowed");
  return out;
}

type FilterableTrail = Pick<Trail, "difficulty" | "distanceKm" | "elevationGainM" | "terrain" | "accessibilityFeatures" | "dogsAllowed">;

export function filterTrails<T extends FilterableTrail>(trails: T[], f: TrailFilters): T[] {
  return trails.filter((t) => {
    if (f.difficulty.length && !f.difficulty.includes(t.difficulty)) return false;
    if (f.maxMi && t.distanceKm > f.maxMi * 1.609344) return false;
    if (f.maxGainFt && t.elevationGainM > f.maxGainFt * 0.3048) return false;
    if (f.terrain.length && !f.terrain.some((x) => t.terrain.includes(x))) return false;
    if (f.access.length && !f.access.every((x) => t.accessibilityFeatures.includes(x))) return false;
    if (f.dogs && t.dogsAllowed !== true) return false;
    return true;
  });
}

/** Most severe active closure, for card badges. */
export function worstClosure(closures: Pick<Closure, "severity">[]): "closed" | "partial" | "advisory" | null {
  if (closures.some((c) => c.severity === "closed")) return "closed";
  if (closures.some((c) => c.severity === "partial")) return "partial";
  if (closures.some((c) => c.severity === "advisory")) return "advisory";
  return null;
}

/** Query string that keeps current filters but changes the view (for the list/map toggle). */
export function filtersToQuery(f: TrailFilters, overrides: Partial<TrailFilters> = {}): string {
  const v = { ...f, ...overrides };
  const q = new URLSearchParams();
  if (v.view !== "list") q.set("view", v.view);
  for (const d of v.difficulty) q.append("difficulty", d);
  if (v.maxMi) q.set("maxMi", String(v.maxMi));
  if (v.maxGainFt) q.set("maxGainFt", String(v.maxGainFt));
  for (const t of v.terrain) q.append("terrain", t);
  for (const a of v.access) q.append("access", a);
  if (v.dogs) q.set("dogs", "yes");
  const s = q.toString();
  return s ? `?${s}` : "";
}
