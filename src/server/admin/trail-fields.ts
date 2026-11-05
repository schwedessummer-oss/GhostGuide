/**
 * Editable trail FACTS (each carries per-field provenance). Pure module shared
 * by the admin forms and the use-cases; the keys double as
 * trail_field_provenance.field values and as a whitelist of trail columns.
 */
import { z } from "zod";
import { ACCESSIBILITY_FEATURES, TERRAIN_OPTIONS } from "@/domain/types";

export const DIFFICULTIES = ["easy", "moderate", "hard", "strenuous"] as const;
export const ROUTE_TYPES = ["loop", "out_and_back", "point_to_point"] as const;
export const FACT_KINDS = ["verified", "estimate", "operator_note", "demo"] as const;

type FieldType = "number" | "int" | "enum" | "multi" | "tristate" | "boolean" | "text" | "location";

export interface FactFieldDef {
  label: string;
  type: FieldType;
  hint?: string;
  options?: readonly string[];
  /** trail columns written by this fact */
  columns: readonly string[];
}

export const FACT_FIELDS = {
  distance_km: { label: "Distance (km)", type: "number", columns: ["distance_km"], hint: "Route length. Route uploads are checked against this (±10%)." },
  elevation_gain_m: { label: "Elevation gain (m)", type: "int", columns: ["elevation_gain_m"] },
  max_elevation_m: { label: "Highest point (m)", type: "int", columns: ["max_elevation_m"], hint: "Leave empty if unknown." },
  difficulty: { label: "Difficulty", type: "enum", options: DIFFICULTIES, columns: ["difficulty"] },
  route_type: { label: "Route type", type: "enum", options: ROUTE_TYPES, columns: ["route_type"] },
  terrain: { label: "Terrain", type: "multi", options: TERRAIN_OPTIONS, columns: ["terrain"] },
  estimated_duration_min: { label: "Estimated duration (minutes)", type: "int", columns: ["estimated_duration_min"], hint: "An estimate, not a guarantee." },
  accessibility_features: { label: "Accessibility features", type: "multi", options: ACCESSIBILITY_FEATURES, columns: ["accessibility_features"] },
  dogs_allowed: { label: "Dogs allowed", type: "tristate", columns: ["dogs_allowed"] },
  permit_required: { label: "Permit required", type: "boolean", columns: ["permit_required"] },
  trailhead_location: { label: "Trailhead location", type: "location", columns: ["trailhead_lat", "trailhead_lng"] },
  parking_info: { label: "Parking", type: "text", columns: ["parking_info"] },
} as const satisfies Record<string, FactFieldDef>;

export type FactField = keyof typeof FACT_FIELDS;
export const FACT_FIELD_KEYS = Object.keys(FACT_FIELDS) as FactField[];

export function isFactField(v: unknown): v is FactField {
  return typeof v === "string" && Object.hasOwn(FACT_FIELDS, v);
}

/** Validated value(s) for a fact: column → value. */
export type FactValue = Record<string, string | number | boolean | string[] | null>;

const num = (min: number, max: number) => z.coerce.number().refine(Number.isFinite, "Enter a number").min(min).max(max);
const int = (min: number, max: number) => z.coerce.number().int("Enter a whole number").min(min).max(max);

/** Parse raw form input for one fact field into column values. */
export function parseFactValue(field: FactField, raw: { value?: unknown; values?: unknown; lat?: unknown; lng?: unknown }): { ok: true; value: FactValue } | { ok: false; error: string } {
  const def = FACT_FIELDS[field] as FactFieldDef;
  const one = typeof raw.value === "string" ? raw.value.trim() : raw.value;
  let r: z.ZodSafeParseResult<unknown>;
  switch (def.type) {
    case "number":
      r = num(0.01, 500).safeParse(one);
      break;
    case "int":
      if (field === "max_elevation_m" && (one === "" || one == null)) return { ok: true, value: { max_elevation_m: null } };
      r = field === "estimated_duration_min" ? int(1, 4320).safeParse(one) : field === "max_elevation_m" ? int(-500, 9000).safeParse(one) : int(0, 10000).safeParse(one);
      break;
    case "enum":
      r = z.enum(def.options as [string, ...string[]]).safeParse(one);
      break;
    case "multi": {
      const arr = Array.isArray(raw.values) ? raw.values : raw.values == null ? [] : [raw.values];
      r = z.array(z.enum(def.options as [string, ...string[]])).max(20).safeParse(arr);
      if (r.success) r = { success: true, data: [...new Set(r.data as string[])] } as z.ZodSafeParseResult<unknown>;
      break;
    }
    case "tristate":
      r = z.enum(["yes", "no", "unknown"]).safeParse(one);
      if (r.success) return { ok: true, value: { [def.columns[0]]: r.data === "unknown" ? null : r.data === "yes" } };
      break;
    case "boolean":
      r = z.enum(["yes", "no"]).safeParse(one);
      if (r.success) return { ok: true, value: { [def.columns[0]]: r.data === "yes" } };
      break;
    case "text":
      r = z.string().trim().max(1000).safeParse(one ?? "");
      if (r.success) return { ok: true, value: { [def.columns[0]]: (r.data as string) === "" ? null : (r.data as string) } };
      break;
    case "location": {
      const lat = num(-90, 90).safeParse(typeof raw.lat === "string" ? raw.lat.trim() : raw.lat);
      const lng = num(-180, 180).safeParse(typeof raw.lng === "string" ? raw.lng.trim() : raw.lng);
      if (!lat.success || !lng.success) return { ok: false, error: "Enter a latitude (−90…90) and longitude (−180…180)." };
      return { ok: true, value: { trailhead_lat: lat.data, trailhead_lng: lng.data } };
    }
  }
  if (!r.success) return { ok: false, error: `${def.label}: ${r.error.issues[0]?.message ?? "invalid value"}` };
  return { ok: true, value: { [def.columns[0]]: r.data as string | number | string[] } };
}
