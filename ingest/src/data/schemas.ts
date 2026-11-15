/**
 * zod schemas for the hand-curated inputs, following ingest/DATA_FORMATS.md
 * (data/seed-research branch) field by field:
 *
 *   seeds/hikes/<slug>.yaml   identity of one hike
 *   curated/<slug>.yaml       facts read on official pages
 *
 * Objects are strict: an unknown key is an error, so a typo never drops data
 * silently. The only extra keys accepted are bookkeeping written by the
 * research tools (seed `discovery_notes`; curated `mechanical_check`), which
 * the pipeline ignores.
 *
 * Facts are validated one by one, so one bad fact does not sink its file.
 */
import { z } from "zod";
import { bannedHost, CURRENCY_MINOR_UNITS } from "./reference";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isHttpUrl(s: string): boolean {
  if (/\s/.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".");
  } catch {
    return false;
  }
}

function isCalendarDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** True when `n` has at most `places` decimal places. */
export function hasMaxDecimals(n: number, places: number): boolean {
  const scaled = n * 10 ** places;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

const slug = z.string().max(100).regex(SLUG_RE, "must be lowercase a-z, 0-9 and single hyphens");
const qid = z.string().regex(/^Q[1-9][0-9]*$/, "must be a Wikidata QID such as Q12345");
const httpUrl = z.string().refine(isHttpUrl, "must be an http(s) URL");
const isoDate = z.string().superRefine((s, ctx) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) ctx.addIssue({ code: "custom", message: "must be an ISO date (YYYY-MM-DD)" });
  else if (!isCalendarDate(s)) ctx.addIssue({ code: "custom", message: "is not a real calendar date" });
});
const nonEmpty = z.string().trim().min(1, "must not be empty");
/** Our own words: short paraphrases, never copied (DATA_FORMATS.md hard rule 3). */
const ownWords = z.string().trim().min(1, "must not be empty").max(300, "must be at most 300 characters");
const month = z.number().int().min(1).max(12);
const months = z
  .array(month)
  .min(1)
  .refine((ms) => new Set(ms).size === ms.length, "must not repeat a month");
const country = z.string().regex(/^[A-Z]{2}$/, "must be an ISO 3166-1 alpha-2 code");
const subdivision = z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/, "must be an ISO 3166-2 code");

export const REGION_GROUPS = [
  "north-central-america", "south-america", "europe", "africa", "asia-middle-east", "oceania",
] as const;
export const TRIP_TYPES = ["day", "overnight", "multi_day"] as const;
export const ACCESS_MODES = ["independent", "licensed_operator_required", "guide_recommended"] as const;
export const OPERATING_STATUSES = ["open", "seasonal", "partially_closed", "closed", "unknown"] as const;
export const DISTANCE_BASES = ["round_trip", "one_way", "loop"] as const;
export const ROUTE_TYPES = ["loop", "out_and_back", "point_to_point"] as const;
export const PERMIT_REQUIREMENTS = ["yes", "no", "seasonal", "conditional"] as const;
export const PERMIT_KINDS = [
  "day_use", "overnight", "lottery", "quota", "timed_entry", "vehicle_reservation", "parking",
  "trekking_card", "restricted_area", "other",
] as const;
export const FEE_UNITS = ["per_person", "per_vehicle", "per_group", "per_night", "per_day", "per_application", "per_trip"] as const;
export const FEE_AUDIENCES = ["all", "adult", "child", "resident", "non_resident", "senior", "student"] as const;
export const RULE_VALUES = ["allowed", "not_allowed", "restricted"] as const;
export const HAZARD_TYPES = [
  "heat", "cold", "altitude", "flash_flood", "river_crossing", "exposure", "rockfall", "avalanche",
  "lightning", "weather", "wildlife", "remoteness", "volcanic", "tides", "security_advisory", "other",
] as const;
export const CLOSURE_STATUSES = ["open", "seasonal", "partially_closed", "closed"] as const;

const FLAG_RE = /^(gr_route_geometry_withheld|operator_only|advisory|seasonal_access|fallback_for:[a-z0-9]+(-[a-z0-9]+)*)$/;

// ---------------------------------------------------------------------------
// Seed file
// ---------------------------------------------------------------------------
export const seedSchema = z
  .strictObject({
    seed_no: z.number().int().positive(),
    slug,
    name: nonEmpty.max(200),
    alt_names: z.array(nonEmpty).optional(),
    route_variant: nonEmpty.nullable().optional(),
    region_group: z.enum(REGION_GROUPS),
    countries: z.array(country).min(1, "must list at least one country"),
    subdivisions: z.array(subdivision),
    area: z.strictObject({
      name: nonEmpty,
      wikidata: qid.nullable(),
      official_url: httpUrl.nullable(),
    }),
    agency: z.strictObject({
      name: nonEmpty,
      wikidata: qid.nullable(),
    }),
    hike_wikidata: qid.nullable(),
    official_url: httpUrl,
    // Approximate start point used only to search OSM; null until researched.
    anchor: z
      .strictObject({
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        source: z.enum(["wikidata", "official", "nominatim"]),
      })
      .nullable(),
    osm: z.strictObject({
      relation_ids: z.array(z.number().int().positive()),
      way_ids: z.array(z.number().int().positive()),
      candidates: z.array(
        z.strictObject({
          osm_type: z.enum(["node", "way", "relation"]),
          osm_id: z.number().int().positive(),
          name: z.string().optional(),
          via: nonEmpty,
        }),
      ),
      confidence: z.enum(["confirmed", "probable", "unknown"]),
      notes: z.string(),
    }),
    trip_type: z.enum(TRIP_TYPES),
    typical_days: z.number().int().min(1).max(60).nullable(),
    access_mode: z.enum(ACCESS_MODES),
    flags: z.array(z.string().regex(FLAG_RE, "is not a known flag")),
    status: z.strictObject({
      value: z.enum(OPERATING_STATUSES),
      note: z.string(),
      source_url: httpUrl.nullable(),
      checked_at: isoDate,
    }),
    replacement: z
      .strictObject({
        condition: z.string(),
        fallback_slug: z.union([z.literal(""), slug]),
        recommendation: z.enum(["keep", "use_fallback", "undecided"]),
        reason: z.string(),
      })
      .optional(),
    // Research-tool bookkeeping; ignored by the pipeline.
    discovery_notes: z.string().optional(),
  })
  .superRefine((seed, ctx) => {
    seed.subdivisions.forEach((sub, i) => {
      if (!seed.countries.includes(sub.slice(0, 2))) {
        ctx.addIssue({ code: "custom", path: ["subdivisions", i], message: `${sub} is not in a listed country` });
      }
    });
    if (new Set(seed.countries).size !== seed.countries.length) {
      ctx.addIssue({ code: "custom", path: ["countries"], message: "must not repeat a country" });
    }
    const banned = bannedHost(seed.official_url);
    if (banned) ctx.addIssue({ code: "custom", path: ["official_url"], message: `${banned} is not an official source` });
  });

export type Seed = z.infer<typeof seedSchema>;

// ---------------------------------------------------------------------------
// Curated facts
// ---------------------------------------------------------------------------
export const FACT_FIELDS = [
  "distance_km", "elevation_gain_m", "high_point_m", "duration", "route_type", "difficulty_official",
  "best_months", "season_note", "permit_required", "permit", "fee", "entry_fee_none", "parking",
  "trailhead_access", "public_transport", "rule_dogs", "rule_drones", "rule_camping", "rule_fires",
  "rule_group_size", "hazard", "nearest_town", "access_mode", "licensed_operator_list_url", "closure",
  "official_url",
] as const;
export type FactField = (typeof FACT_FIELDS)[number];

const currency = z
  .string()
  .regex(/^[A-Z]{3}$/, "must be an ISO 4217 code")
  .refine((c) => c in CURRENCY_MINOR_UNITS, "is not in the currencies table");
const amount = z.number().nonnegative().finite();

function checkAmountPrecision(value: { amount: number; currency: string }, ctx: z.RefinementCtx, at: (string | number)[]) {
  const places = CURRENCY_MINOR_UNITS[value.currency];
  if (places !== undefined && !hasMaxDecimals(value.amount, places)) {
    ctx.addIssue({ code: "custom", path: [...at, "amount"], message: `has more decimals than ${value.currency} allows (${places})` });
  }
}

const durationValue = z
  .strictObject({
    min_hours: z.number().positive().optional(),
    max_hours: z.number().positive().optional(),
    min_days: z.number().int().positive().optional(),
    max_days: z.number().int().positive().optional(),
  })
  .superRefine((d, ctx) => {
    const hours = d.min_hours !== undefined || d.max_hours !== undefined;
    const days = d.min_days !== undefined || d.max_days !== undefined;
    if (hours === days) {
      ctx.addIssue({ code: "custom", message: "give min_hours/max_hours or min_days/max_days (one pair)" });
    }
    if (d.min_hours !== undefined && d.max_hours !== undefined && d.min_hours > d.max_hours) {
      ctx.addIssue({ code: "custom", message: "min_hours is greater than max_hours" });
    }
    if (d.min_days !== undefined && d.max_days !== undefined && d.min_days > d.max_days) {
      ctx.addIssue({ code: "custom", message: "min_days is greater than max_days" });
    }
  });

const priceValue = z
  .strictObject({
    amount,
    currency,
    unit: z.enum(FEE_UNITS),
    audience: z.enum(FEE_AUDIENCES),
    note: ownWords.optional(),
  })
  .superRefine((p, ctx) => checkAmountPrecision(p, ctx, []));

const permitValue = z.strictObject({
  name: nonEmpty.max(200),
  kind: z.enum(PERMIT_KINDS),
  how_to_apply: ownWords.optional(),
  booking_window: nonEmpty.max(300).optional(),
  official_url: httpUrl.optional(),
  price: priceValue.optional(),
  months: months.optional(),
});

const feeValue = z
  .strictObject({
    name: nonEmpty.max(200),
    amount,
    currency,
    unit: z.enum(FEE_UNITS),
    audience: z.enum(FEE_AUDIENCES),
    valid_from: isoDate.nullable().optional(),
    valid_to: isoDate.nullable().optional(),
    note: ownWords.optional(),
  })
  .superRefine((f, ctx) => {
    checkAmountPrecision(f, ctx, []);
    if (f.valid_from && f.valid_to && f.valid_from > f.valid_to) {
      ctx.addIssue({ code: "custom", path: ["valid_to"], message: "is before valid_from" });
    }
  });

function ruleValue(groupSize: boolean) {
  return z
    .strictObject({
      value: z.enum(RULE_VALUES),
      max_group: z.number().int().positive().optional(),
      note: ownWords.optional(),
    })
    .superRefine((r, ctx) => {
      if (r.value === "restricted" && !r.note) ctx.addIssue({ code: "custom", path: ["note"], message: "is required when value is restricted" });
      if (!groupSize && r.max_group !== undefined) {
        ctx.addIssue({ code: "custom", path: ["max_group"], message: "only applies to rule_group_size" });
      }
    });
}

export const VALUE_SCHEMAS: Record<FactField, z.ZodType> = {
  distance_km: z
    .number()
    .positive()
    .max(10_000)
    .refine((n) => hasMaxDecimals(n, 2), "must have at most 2 decimals"),
  elevation_gain_m: z.number().int("must be whole metres").nonnegative().max(10_000),
  high_point_m: z.number().int("must be whole metres").min(-500).max(9000),
  duration: durationValue,
  route_type: z.enum(ROUTE_TYPES),
  difficulty_official: z.strictObject({ label: nonEmpty.max(100), scale: nonEmpty.max(100) }),
  best_months: months,
  season_note: nonEmpty,
  permit_required: z.enum(PERMIT_REQUIREMENTS),
  permit: permitValue,
  fee: feeValue,
  entry_fee_none: z.literal(true),
  parking: ownWords,
  trailhead_access: ownWords,
  public_transport: ownWords,
  rule_dogs: ruleValue(false),
  rule_drones: ruleValue(false),
  rule_camping: ruleValue(false),
  rule_fires: ruleValue(false),
  rule_group_size: ruleValue(true),
  hazard: z.strictObject({ type: z.enum(HAZARD_TYPES), note: ownWords }),
  nearest_town: z.strictObject({ name: nonEmpty.max(200), note: ownWords.optional() }),
  access_mode: z.enum(ACCESS_MODES),
  licensed_operator_list_url: httpUrl,
  closure: z.strictObject({ status: z.enum(CLOSURE_STATUSES), note: ownWords, as_of: isoDate.optional() }),
  official_url: httpUrl,
};

export const factEnvelopeSchema = z
  .strictObject({
    field: z.enum(FACT_FIELDS),
    value: z.unknown(),
    basis: z.enum(DISTANCE_BASES).optional(),
    note: z.string().trim().max(300, "must be at most 300 characters").optional(),
    source_url: httpUrl,
    source_title: nonEmpty.max(500),
    publisher: nonEmpty.max(200),
    checked_at: isoDate,
    evidence_heading: nonEmpty.optional(),
    // INTERNAL ONLY: the quote is used by the verifier and never stored by the pipeline.
    evidence: z.strictObject({
      page: nonEmpty,
      quote: nonEmpty.max(300, "must be at most 300 characters"),
    }),
    verified: z.boolean().optional(),
    verify_reason: z.string().optional(),
  })
  .superRefine((fact, ctx) => {
    if (!("value" in fact) || fact.value === undefined || fact.value === null) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "is required" });
    }
    if (fact.field === "distance_km" && !fact.basis) {
      ctx.addIssue({ code: "custom", path: ["basis"], message: "is required for distance_km (round_trip, one_way or loop)" });
    }
    if (fact.field !== "distance_km" && fact.basis) {
      ctx.addIssue({ code: "custom", path: ["basis"], message: "only applies to distance_km" });
    }
    const banned = bannedHost(fact.source_url);
    if (banned) ctx.addIssue({ code: "custom", path: ["source_url"], message: `${banned} is not an official source` });
  });

export interface CuratedFact {
  field: FactField;
  value: unknown;
  basis: (typeof DISTANCE_BASES)[number] | null;
  note: string | null;
  sourceUrl: string;
  sourceTitle: string;
  publisher: string;
  checkedAt: string;
  evidenceHeading: string | null;
  verified: boolean;
  verifyReason: string | null;
}

export const curatedFileSchema = z.strictObject({
  slug,
  researched_at: isoDate,
  facts: z.array(z.unknown()),
  // Filled by the verification pass; null until then.
  verifier: z.union([z.string(), z.record(z.string(), z.unknown())]).nullable().optional(),
  // Research-tool bookkeeping; ignored by the pipeline.
  mechanical_check: z.record(z.string(), z.unknown()).optional(),
});

export type CuratedFile = z.infer<typeof curatedFileSchema>;
