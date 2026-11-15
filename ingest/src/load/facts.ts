/**
 * Pure fact logic shared by `check` and `load`: which verified facts become
 * current, the typed rows they produce, and the published values copied into
 * public.hikes. Nothing here touches the database.
 */
import type { CuratedFact, FactField } from "../data/schemas";

export type DistanceBasis = "round_trip" | "one_way" | "loop";

export interface FeeValue {
  name: string;
  amount: number;
  currency: string;
  unit: string;
  audience: string;
  valid_from?: string | null;
  valid_to?: string | null;
  note?: string;
}
export interface PriceValue {
  amount: number;
  currency: string;
  unit: string;
  audience: string;
  note?: string;
}
export interface PermitValue {
  name: string;
  kind: string;
  how_to_apply?: string;
  booking_window?: string;
  official_url?: string;
  price?: PriceValue;
  months?: number[];
}
export interface RuleValue {
  value: "allowed" | "not_allowed" | "restricted";
  max_group?: number;
  note?: string;
}
export interface DurationValue {
  min_hours?: number;
  max_hours?: number;
  min_days?: number;
  max_days?: number;
}

export const MULTI_VALUED: ReadonlySet<FactField> = new Set<FactField>(["permit", "fee", "hazard"]);

/** hike_facts.value_key: names each value of a multi-valued field. */
export function valueKeyOf(field: FactField, value: unknown): string | null {
  if (field === "permit") return (value as PermitValue).name;
  if (field === "fee") {
    const f = value as FeeValue;
    return `${f.name}|${f.audience}|${f.unit}`;
  }
  if (field === "hazard") return (value as { type: string }).type;
  return null;
}

/** JSON with sorted keys: equal values give equal strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/**
 * The part of a value that two facts for the same field must agree on. Text
 * written in our own words (parking, access, notes) from two official pages
 * complements rather than contradicts, so only the facts themselves count.
 */
function coreOf(fact: CuratedFact): string {
  const v = fact.value as Record<string, unknown>;
  switch (fact.field) {
    case "parking":
    case "trailhead_access":
    case "public_transport":
    case "season_note":
    case "hazard":
      return "";
    case "nearest_town":
      return canonicalJson(v.name);
    case "rule_dogs":
    case "rule_drones":
    case "rule_camping":
    case "rule_fires":
    case "rule_group_size":
      return canonicalJson({ value: v.value, max_group: v.max_group ?? null });
    case "permit":
      return canonicalJson({ kind: v.kind, price: v.price ?? null, months: v.months ?? null });
    case "fee":
      return canonicalJson({ amount: v.amount, currency: v.currency, from: v.valid_from ?? null, to: v.valid_to ?? null });
    case "closure":
      return canonicalJson(v.status);
    default:
      return canonicalJson({ value: fact.value, basis: fact.basis });
  }
}

export interface ResolvedFact extends CuratedFact {
  valueKey: string | null;
}

export interface FactConflict {
  field: FactField;
  valueKey: string | null;
  facts: CuratedFact[];
}

export interface FactResolution {
  /** One fact per (field, value key): what becomes current. */
  chosen: ResolvedFact[];
  /** Verified facts that contradict each other: none of them is loaded (never guess). */
  conflicts: FactConflict[];
  /** Agreeing extra facts for a key that already has one (first in the file wins). */
  extras: ResolvedFact[];
}

/** Pick the current fact per (field, value key) from verified facts, in file order. */
export function resolveFacts(facts: CuratedFact[]): FactResolution {
  const groups = new Map<string, ResolvedFact[]>();
  for (const fact of facts) {
    const valueKey = valueKeyOf(fact.field, fact.value);
    const key = `${fact.field}\u0000${valueKey ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), { ...fact, valueKey }]);
  }
  const chosen: ResolvedFact[] = [];
  const conflicts: FactConflict[] = [];
  const extras: ResolvedFact[] = [];
  for (const group of groups.values()) {
    const cores = new Set(group.map(coreOf));
    if (cores.size > 1) {
      conflicts.push({ field: group[0].field, valueKey: group[0].valueKey, facts: group });
      continue;
    }
    chosen.push(group[0]);
    extras.push(...group.slice(1));
  }
  return { chosen, conflicts, extras };
}

/** Amount in minor units (cents, or yen for JPY). Throws when the amount is finer than the currency allows. */
export function toMinorUnits(amount: number, minorUnit: number): number {
  const scaled = amount * 10 ** minorUnit;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) throw new Error(`${amount} has more than ${minorUnit} decimals`);
  if (rounded < 0 || !Number.isSafeInteger(rounded)) throw new Error(`${amount} is out of range`);
  return rounded;
}

/** A current verified fact as stored in hike_facts (any method). */
export interface CurrentFact {
  field: FactField;
  value: unknown;
  basis: DistanceBasis | null;
  checkedAt: Date | string | null;
}

export interface PublishedColumns {
  distance_km: number | null;
  distance_basis: DistanceBasis | null;
  elevation_gain_m: number | null;
  high_point_m: number | null;
  duration_min_minutes: number | null;
  duration_max_minutes: number | null;
  duration_min_days: number | null;
  duration_max_days: number | null;
  route_type: string | null;
  difficulty_official: Record<string, unknown> | null;
  best_months: number[] | null;
  season_note: string | null;
  permit_required: string | null;
  parking: string | null;
  trailhead_access: string | null;
  public_transport: string | null;
  nearest_town: string | null;
  official_url: string;
  access_mode: string;
  operating_status: string;
  last_verified_at: string | null;
}

const hoursToMinutes = (h: number | undefined) => (h === undefined ? null : Math.round(h * 60));

/**
 * The published value of every non-OSM fact column of a hike, from its current
 * verified facts (the single writer of these columns). A field without a
 * current verified fact is null. Identity defaults from the seed apply where
 * a hike always has a value (official URL, access mode).
 */
export function publishedColumns(
  facts: CurrentFact[],
  defaults: { officialUrl: string; accessMode: string },
): PublishedColumns {
  const one = new Map<FactField, CurrentFact>();
  for (const f of facts) if (!MULTI_VALUED.has(f.field)) one.set(f.field, f);
  const val = <T>(field: FactField): T | null => (one.has(field) ? (one.get(field)!.value as T) : null);
  const duration = val<DurationValue>("duration");
  const distance = one.get("distance_km");
  let lastVerified: string | null = null;
  for (const f of facts) {
    if (!f.checkedAt) continue;
    const iso = new Date(f.checkedAt).toISOString();
    if (!lastVerified || iso > lastVerified) lastVerified = iso;
  }
  return {
    distance_km: distance ? (distance.value as number) : null,
    distance_basis: distance ? distance.basis : null,
    elevation_gain_m: val<number>("elevation_gain_m"),
    high_point_m: val<number>("high_point_m"),
    duration_min_minutes: duration ? hoursToMinutes(duration.min_hours) : null,
    duration_max_minutes: duration ? hoursToMinutes(duration.max_hours) : null,
    duration_min_days: duration?.min_days ?? null,
    duration_max_days: duration?.max_days ?? null,
    route_type: val<string>("route_type"),
    difficulty_official: val<Record<string, unknown>>("difficulty_official"),
    best_months: val<number[]>("best_months"),
    season_note: val<string>("season_note"),
    permit_required: val<string>("permit_required"),
    parking: val<string>("parking"),
    trailhead_access: val<string>("trailhead_access"),
    public_transport: val<string>("public_transport"),
    nearest_town: val<{ name: string }>("nearest_town")?.name ?? null,
    official_url: val<string>("official_url") ?? defaults.officialUrl,
    access_mode: val<string>("access_mode") ?? defaults.accessMode,
    operating_status: val<{ status: string }>("closure")?.status ?? "unknown",
    last_verified_at: lastVerified,
  };
}

/** hike_rules.rule for a rule_* field. */
export function ruleKindOf(field: FactField): string | null {
  return field.startsWith("rule_") ? field.slice("rule_".length) : null;
}
