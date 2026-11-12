import "server-only";
import type { Activity, CatalogLayer, DogPolicy, PoiCategory, WheelchairAccess } from "@/domain/catalog";

/**
 * OpenStreetMap tag rules and normalizers.
 *
 * The same declarative rules drive BOTH the Overpass query (query.ts renders
 * them as QL filters) and the parser (parse.ts evaluates them in JS), so what
 * we ask Overpass for and what we accept from its response cannot drift
 * apart. The parser re-checks every rule because a response may contain
 * elements fetched for another purpose (e.g. route member ways) and because
 * external data is never trusted.
 *
 * Normalizers never guess: a value we do not recognise becomes null /
 * "unknown", and aggregation across several ways only makes a positive
 * claim (e.g. "wheelchair: yes") when every way supports it.
 */

export type OsmTags = Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------
// Declarative tag conditions (shared with the query builder)
// ---------------------------------------------------------------------------

/**
 * One tag condition. Values are compared exactly (case-sensitive), like
 * Overpass `["k"="v"]` filters, so the parser mirrors the query.
 */
export type TagCondition =
  /** Tag present with any value: `["k"]`. */
  | { key: string; op: "exists" }
  /** Tag value is one of `values`: `["k"="v"]` / `["k"~"^(a|b)$"]`. */
  | { key: string; op: "in"; values: readonly string[] }
  /** Tag absent or not one of `values`: `["k"!="v"]` / `["k"!~"^(a|b)$"]`. */
  | { key: string; op: "not_in"; values: readonly string[] }
  /** Semicolon-separated list value containing one of `values` (e.g. sport=climbing;hiking). */
  | { key: string; op: "list_has"; values: readonly string[] };

export type OsmElementType = "node" | "way" | "relation";

export function matchesCondition(tags: OsmTags, c: TagCondition): boolean {
  const raw = Object.prototype.hasOwnProperty.call(tags, c.key) ? tags[c.key] : undefined;
  switch (c.op) {
    case "exists":
      return raw !== undefined;
    case "in":
      return raw !== undefined && c.values.includes(raw);
    case "not_in":
      return raw === undefined || !c.values.includes(raw);
    case "list_has":
      return raw !== undefined && raw.split(";").some((part) => c.values.includes(part.trim()));
  }
}

export const matchesAll = (tags: OsmTags, conditions: readonly TagCondition[]) =>
  conditions.every((c) => matchesCondition(tags, c));

// ---------------------------------------------------------------------------
// Trails
// ---------------------------------------------------------------------------

/** Route relation types treated as hiking/walking routes. */
export const ROUTE_RELATION_VALUES = ["hiking", "foot"] as const;

export function isRouteRelation(tags: OsmTags): boolean {
  return matchesCondition(tags, { key: "route", op: "in", values: ROUTE_RELATION_VALUES });
}

/**
 * Named ways that are good hiking candidates. A way qualifies when it
 * matches ANY candidate rule and NO exclusion rule.
 *
 * highway=track is only accepted with an explicit pedestrian signal
 * (foot=yes/designated, sac_scale or trail_visibility); otherwise every
 * named forest/farm road would flood the results.
 */
export const TRAIL_WAY_CANDIDATES: readonly (readonly TagCondition[])[] = [
  [
    { key: "highway", op: "in", values: ["path", "footway", "bridleway", "steps"] },
    { key: "name", op: "exists" },
  ],
  [
    { key: "highway", op: "in", values: ["track"] },
    { key: "name", op: "exists" },
    { key: "foot", op: "in", values: ["yes", "designated"] },
  ],
  [
    { key: "highway", op: "in", values: ["track"] },
    { key: "name", op: "exists" },
    { key: "sac_scale", op: "exists" },
  ],
  [
    { key: "highway", op: "in", values: ["track"] },
    { key: "name", op: "exists" },
    { key: "trail_visibility", op: "exists" },
  ],
];

/**
 * Exclusions for trail ways: urban sidewalk/crossing micro-mapping, areas,
 * indoor corridors, ways closed to pedestrians (foot=no/private), and
 * private/no-access ways unless pedestrians are explicitly allowed.
 */
export const TRAIL_WAY_EXCLUSIONS: readonly (readonly TagCondition[])[] = [
  [{ key: "footway", op: "in", values: ["sidewalk", "crossing", "access_aisle", "traffic_island"] }],
  [{ key: "area", op: "in", values: ["yes"] }],
  [{ key: "indoor", op: "in", values: ["yes"] }],
  [{ key: "foot", op: "in", values: ["no", "private"] }],
  [
    { key: "access", op: "in", values: ["private", "no"] },
    { key: "foot", op: "not_in", values: ["yes", "designated", "permissive"] },
  ],
];

export function isTrailWayCandidate(tags: OsmTags): boolean {
  if (cleanName(tags.name) === null) return false;
  return TRAIL_WAY_CANDIDATES.some((rule) => matchesAll(tags, rule)) && !TRAIL_WAY_EXCLUSIONS.some((rule) => matchesAll(tags, rule));
}

// ---------------------------------------------------------------------------
// Points of interest
// ---------------------------------------------------------------------------

export interface PoiRule {
  category: PoiCategory;
  layer: CatalogLayer;
  /** Element types to query; nodes come back with lat/lon, ways/relations with a centre. */
  types: readonly OsmElementType[];
  conditions: readonly TagCondition[];
}

const ALL_TYPES = ["node", "way", "relation"] as const;
/** Excludes facilities the public cannot use. Not applied to natural features. */
const PUBLIC: TagCondition = { key: "access", op: "not_in", values: ["private", "no"] };

/**
 * POI rules, evaluated in order: the first matching rule decides the
 * category (e.g. a trailhead node that is also tagged amenity=parking is a
 * trailhead). Every rule maps onto OUTDOOR_POI_CATEGORIES /
 * SERVICE_POI_CATEGORIES.
 *
 * Deliberate choices (documented so they are not mistaken for bugs):
 *  - parking: no underground / multi-storey garages and no private, no-access
 *    or customers-only lots (store car parks are not trail parking).
 *  - drinking_water: amenity=drinking_water (unless drinking_water=no) and
 *    man_made=water_tap explicitly tagged drinking_water=yes. Untagged taps,
 *    wells and springs are NOT drinking water (springs are their own category).
 *  - shelter: amenity=shelter except bus-stop (public_transport) and livestock
 *    (field_shelter) shelters; wilderness and alpine huts also count.
 *  - lake: named natural=water with water=lake|reservoir|pond only, so the
 *    map is not filled with unnamed ponds.
 *  - outdoor_shop: shop=outdoor, or shop=sports whose sport list includes
 *    hiking, climbing or camping.
 *  - ev_charging: excludes stations explicitly closed to cars (motorcar=no).
 */
export const POI_RULES: readonly PoiRule[] = [
  // ---- outdoor
  { category: "trailhead", layer: "outdoor", types: ALL_TYPES, conditions: [{ key: "highway", op: "in", values: ["trailhead"] }] },
  {
    category: "parking",
    layer: "outdoor",
    types: ALL_TYPES,
    conditions: [
      { key: "amenity", op: "in", values: ["parking"] },
      { key: "parking", op: "not_in", values: ["underground", "multi-storey"] },
      { key: "access", op: "not_in", values: ["private", "no", "customers"] },
    ],
  },
  { category: "toilets", layer: "outdoor", types: ALL_TYPES, conditions: [{ key: "amenity", op: "in", values: ["toilets"] }, PUBLIC] },
  {
    category: "drinking_water",
    layer: "outdoor",
    types: ALL_TYPES,
    conditions: [{ key: "amenity", op: "in", values: ["drinking_water"] }, { key: "drinking_water", op: "not_in", values: ["no"] }, PUBLIC],
  },
  {
    category: "drinking_water",
    layer: "outdoor",
    types: ALL_TYPES,
    conditions: [{ key: "man_made", op: "in", values: ["water_tap"] }, { key: "drinking_water", op: "in", values: ["yes"] }, PUBLIC],
  },
  {
    category: "shelter",
    layer: "outdoor",
    types: ALL_TYPES,
    conditions: [
      { key: "amenity", op: "in", values: ["shelter"] },
      { key: "shelter_type", op: "not_in", values: ["public_transport", "field_shelter"] },
      PUBLIC,
    ],
  },
  {
    category: "shelter",
    layer: "outdoor",
    types: ALL_TYPES,
    conditions: [{ key: "tourism", op: "in", values: ["wilderness_hut", "alpine_hut"] }, PUBLIC],
  },
  { category: "campsite", layer: "outdoor", types: ALL_TYPES, conditions: [{ key: "tourism", op: "in", values: ["camp_site"] }, PUBLIC] },
  { category: "viewpoint", layer: "outdoor", types: ALL_TYPES, conditions: [{ key: "tourism", op: "in", values: ["viewpoint"] }, PUBLIC] },
  { category: "peak", layer: "outdoor", types: ["node"], conditions: [{ key: "natural", op: "in", values: ["peak", "volcano"] }] },
  { category: "waterfall", layer: "outdoor", types: ALL_TYPES, conditions: [{ key: "waterway", op: "in", values: ["waterfall"] }] },
  { category: "waterfall", layer: "outdoor", types: ALL_TYPES, conditions: [{ key: "natural", op: "in", values: ["waterfall"] }] },
  {
    category: "lake",
    layer: "outdoor",
    types: ["way", "relation"],
    conditions: [
      { key: "natural", op: "in", values: ["water"] },
      { key: "water", op: "in", values: ["lake", "reservoir", "pond"] },
      { key: "name", op: "exists" },
    ],
  },
  { category: "spring", layer: "outdoor", types: ["node"], conditions: [{ key: "natural", op: "in", values: ["spring"] }] },
  { category: "cave", layer: "outdoor", types: ["node"], conditions: [{ key: "natural", op: "in", values: ["cave_entrance"] }] },
  { category: "picnic_site", layer: "outdoor", types: ALL_TYPES, conditions: [{ key: "tourism", op: "in", values: ["picnic_site"] }, PUBLIC] },
  {
    category: "ranger_station",
    layer: "outdoor",
    types: ALL_TYPES,
    conditions: [{ key: "amenity", op: "in", values: ["ranger_station"] }, PUBLIC],
  },
  {
    category: "information",
    layer: "outdoor",
    types: ALL_TYPES,
    conditions: [
      { key: "tourism", op: "in", values: ["information"] },
      // "visitor_center" is a common US spelling of the documented "visitor_centre".
      { key: "information", op: "in", values: ["office", "visitor_centre", "visitor_center"] },
      PUBLIC,
    ],
  },
  // ---- services (requested on demand around trailheads)
  { category: "fuel", layer: "services", types: ALL_TYPES, conditions: [{ key: "amenity", op: "in", values: ["fuel"] }, PUBLIC] },
  {
    category: "ev_charging",
    layer: "services",
    types: ALL_TYPES,
    conditions: [{ key: "amenity", op: "in", values: ["charging_station"] }, { key: "motorcar", op: "not_in", values: ["no"] }, PUBLIC],
  },
  { category: "restaurant", layer: "services", types: ALL_TYPES, conditions: [{ key: "amenity", op: "in", values: ["restaurant"] }, PUBLIC] },
  { category: "fast_food", layer: "services", types: ALL_TYPES, conditions: [{ key: "amenity", op: "in", values: ["fast_food"] }, PUBLIC] },
  { category: "cafe", layer: "services", types: ALL_TYPES, conditions: [{ key: "amenity", op: "in", values: ["cafe"] }, PUBLIC] },
  {
    category: "lodging",
    layer: "services",
    types: ALL_TYPES,
    conditions: [{ key: "tourism", op: "in", values: ["hotel", "motel", "guest_house", "hostel", "chalet"] }, PUBLIC],
  },
  { category: "supermarket", layer: "services", types: ALL_TYPES, conditions: [{ key: "shop", op: "in", values: ["supermarket"] }, PUBLIC] },
  { category: "convenience", layer: "services", types: ALL_TYPES, conditions: [{ key: "shop", op: "in", values: ["convenience"] }, PUBLIC] },
  { category: "outdoor_shop", layer: "services", types: ALL_TYPES, conditions: [{ key: "shop", op: "in", values: ["outdoor"] }, PUBLIC] },
  {
    category: "outdoor_shop",
    layer: "services",
    types: ALL_TYPES,
    conditions: [{ key: "shop", op: "in", values: ["sports"] }, { key: "sport", op: "list_has", values: ["hiking", "climbing", "camping"] }, PUBLIC],
  },
  // All hospitals are included (emergency=yes is kept in tags so callers can prefer them).
  { category: "hospital", layer: "services", types: ALL_TYPES, conditions: [{ key: "amenity", op: "in", values: ["hospital"] }, PUBLIC] },
  { category: "clinic", layer: "services", types: ALL_TYPES, conditions: [{ key: "amenity", op: "in", values: ["clinic", "doctors"] }, PUBLIC] },
  { category: "pharmacy", layer: "services", types: ALL_TYPES, conditions: [{ key: "amenity", op: "in", values: ["pharmacy"] }, PUBLIC] },
];

export const poiRulesForLayer = (layer: CatalogLayer) => POI_RULES.filter((r) => r.layer === layer);

/** Category of an element for a layer, or null when it is not a POI we keep. */
export function classifyPoi(layer: CatalogLayer, type: OsmElementType, tags: OsmTags): PoiCategory | null {
  for (const rule of POI_RULES) {
    if (rule.layer === layer && rule.types.includes(type) && matchesAll(tags, rule.conditions)) return rule.category;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

// Control characters other than tab/newline (C0, DEL, C1).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Truncate to at most `max` Unicode code points (never splits a surrogate pair). */
export function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join("");
}

/** Single-line text: control chars removed, whitespace collapsed, trimmed, capped. Empty → null. */
export function cleanLine(value: string | undefined | null, max = 300): string | null {
  if (typeof value !== "string") return null;
  const s = value.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();
  return s ? truncate(s, max) : null;
}

/** Name as shown to users (DB limit 300 chars). */
export const cleanName = (value: string | undefined | null) => cleanLine(value, 300);

/**
 * Grouping key for names: case-, whitespace- and Unicode-compatibility-
 * insensitive ("Table  Rock trail" ≡ "table rock Trail").
 */
export function nameKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** name / name:en; nameEn only when it differs (ignoring case/whitespace) from name. */
export function namesFromTags(tags: OsmTags): { name: string | null; nameEn: string | null } {
  const name = cleanName(tags.name);
  const en = cleanName(tags["name:en"]);
  return { name, nameEn: en && (!name || nameKey(en) !== nameKey(name)) ? en : null };
}

/** Provider description (trimmed, at most 2000 characters). Never generated. */
export function descriptionFromTags(tags: OsmTags): string | null {
  const raw = tags.description;
  if (typeof raw !== "string") return null;
  const s = raw.replace(CONTROL_CHARS, "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  return s ? truncate(s, 2000) : null;
}

/**
 * Website from website / contact:website / url. Only http(s) URLs are kept
 * (these values end up in links: javascript:, data:, mailto: ... are dropped).
 * A bare domain such as "www.example.org/park" gets an "http://" prefix:
 * http is the scheme that works for both http-only and https sites.
 */
export function websiteFromTags(tags: OsmTags): string | null {
  for (const key of ["website", "contact:website", "url"]) {
    const url = sanitizeUrl(tags[key]);
    if (url) return url;
  }
  return null;
}

export function sanitizeUrl(value: string | undefined): string | null {
  // Several URLs separated by ";" are common: take the first.
  const first = cleanLine(value?.split(";")[0], 500);
  if (!first || /\s/.test(first)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(first)
    ? first
    : /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(first)
      ? `http://${first}`
      : null;
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".") || u.username || u.password) return null;
    return candidate;
  } catch {
    return null;
  }
}

/** phone / contact:phone, as mapped (business numbers, not personal data). */
export function phoneFromTags(tags: OsmTags): string | null {
  const raw = cleanLine(tags.phone ?? tags["contact:phone"], 100);
  return raw && /\d/.test(raw) ? raw : null;
}

export const openingHoursFromTags = (tags: OsmTags) => cleanLine(tags.opening_hours, 500);

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

const FEET_TO_M = 0.3048;
/** Plausible elevation range on Earth (Dead Sea shore ≈ −430 m, Everest ≈ 8849 m). */
const MIN_ELEVATION_M = -500;
const MAX_ELEVATION_M = 9000;

/**
 * Parse an OSM `ele` value to whole metres. OSM defaults to metres;
 * accepted forms: "1234", "1234.5", "1234,5", "1234 m", "1,234 m",
 * "4000 ft", "4000'", "4000 feet". Anything else (ranges, "approx.",
 * implausible values) → null.
 */
export function parseElevationM(raw: string | undefined | null): number | null {
  if (typeof raw !== "string") return null;
  const m = raw
    .trim()
    .toLowerCase()
    .match(/^([+-]?)(\d{1,3}(?:,\d{3})+|\d+(?:[.,]\d+)?|[.,]\d+)\s*(m|meters?|metres?|ft|feet|foot|')?$/);
  if (!m) return null;
  const [, sign, digits, unit] = m;
  // "1,234" (comma + exactly three digits, possibly repeated) = thousands separators;
  // otherwise a single comma is a decimal separator ("1234,5").
  const normalized = /^\d{1,3}(?:,\d{3})+$/.test(digits) ? digits.replace(/,/g, "") : digits.replace(",", ".");
  let value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  if (sign === "-") value = -value;
  if (unit === "ft" || unit === "feet" || unit === "foot" || unit === "'") value *= FEET_TO_M;
  if (value < MIN_ELEVATION_M || value > MAX_ELEVATION_M) return null;
  return Math.round(value);
}

// ---------------------------------------------------------------------------
// Difficulty-related scales
// ---------------------------------------------------------------------------

/** SAC hiking scale, easiest → hardest (T1 … T6). */
export const SAC_SCALE_ORDER = [
  "hiking",
  "mountain_hiking",
  "demanding_mountain_hiking",
  "alpine_hiking",
  "demanding_alpine_hiking",
  "difficult_alpine_hiking",
] as const;

/** trail_visibility, best → worst. */
export const TRAIL_VISIBILITY_ORDER = ["excellent", "good", "intermediate", "bad", "horrible", "no"] as const;

function rankedExtreme(values: Iterable<string | undefined>, order: readonly string[]): string | null {
  let best = -1;
  for (const v of values) {
    const i = typeof v === "string" ? order.indexOf(v.trim().toLowerCase()) : -1;
    if (i > best) best = i;
  }
  return best >= 0 ? order[best] : null;
}

/** Hardest recognised sac_scale among the given tag sets (unknown values ignored). */
export const highestSacScale = (tagSets: readonly OsmTags[]) => rankedExtreme(tagSets.map((t) => t.sac_scale), SAC_SCALE_ORDER);

/** Worst recognised trail_visibility among the given tag sets. */
export const worstTrailVisibility = (tagSets: readonly OsmTags[]) =>
  rankedExtreme(tagSets.map((t) => t.trail_visibility), TRAIL_VISIBILITY_ORDER);

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/** Surface values of one tag set ("gravel;dirt" → ["gravel", "dirt"]). */
export function surfacesFromTags(tags: OsmTags): string[] {
  const raw = tags.surface;
  if (typeof raw !== "string") return [];
  return [
    ...new Set(
      raw
        .split(";")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^[a-z0-9_:-]{1,40}$/.test(s)),
    ),
  ];
}

/**
 * Unique surfaces across weighted members (weight = mapped length in m),
 * most extensive first; ties alphabetical. Deterministic.
 */
export function aggregateSurfaces(items: readonly { tags: OsmTags; weight: number }[]): string[] {
  const totals = new Map<string, number>();
  for (const { tags, weight } of items) {
    const w = Number.isFinite(weight) && weight > 0 ? weight : 0;
    for (const s of surfacesFromTags(tags)) totals.set(s, (totals.get(s) ?? 0) + w);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
}

// ---------------------------------------------------------------------------
// Policies (dogs, wheelchair, fee, permit) — conservative aggregation
// ---------------------------------------------------------------------------

const lower = (v: string | undefined) => (typeof v === "string" ? v.trim().toLowerCase() : undefined);

export function dogPolicyFromTags(tags: OsmTags): DogPolicy {
  switch (lower(tags.dog)) {
    case "yes":
    case "unleashed":
      return "allowed";
    case "leashed":
      return "leashed";
    case "no":
      return "not_allowed";
    default:
      return "unknown";
  }
}

export function wheelchairFromTags(tags: OsmTags): WheelchairAccess {
  const v = lower(tags.wheelchair);
  return v === "yes" || v === "limited" || v === "no" ? v : "unknown";
}

/** fee=yes → true, fee=no → false, anything else → null. */
export function feeFromTags(tags: OsmTags): boolean | null {
  const v = lower(tags.fee);
  return v === "yes" ? true : v === "no" ? false : null;
}

/**
 * True only for explicit permit tags (permit=yes|required, access=permit,
 * foot=permit). Absence of a tag does not mean "no permit needed", so this
 * never returns false.
 */
export function permitFromTags(tags: OsmTags): true | null {
  const permit = lower(tags.permit);
  if (permit === "yes" || permit === "required") return true;
  if (lower(tags.access) === "permit" || lower(tags.foot) === "permit") return true;
  return null;
}

/**
 * Aggregate a policy over a trail: the route's own tag wins when known;
 * otherwise members are combined conservatively —
 *   any restrictive value wins (most restrictive first in `restrictive`),
 *   the permissive value only when EVERY member states it,
 *   else "unknown".
 */
function aggregatePolicy<T extends string>(
  primary: T | null,
  members: readonly T[],
  restrictive: readonly T[],
  permissive: T,
  unknown: T,
): T {
  if (primary !== null && primary !== unknown) return primary;
  for (const r of restrictive) if (members.includes(r)) return r;
  return members.length > 0 && members.every((m) => m === permissive) ? permissive : unknown;
}

export function aggregateDogPolicy(primary: OsmTags | null, members: readonly OsmTags[]): DogPolicy {
  return aggregatePolicy<DogPolicy>(
    primary ? dogPolicyFromTags(primary) : null,
    members.map(dogPolicyFromTags),
    ["not_allowed", "leashed"],
    "allowed",
    "unknown",
  );
}

export function aggregateWheelchair(primary: OsmTags | null, members: readonly OsmTags[]): WheelchairAccess {
  return aggregatePolicy<WheelchairAccess>(
    primary ? wheelchairFromTags(primary) : null,
    members.map(wheelchairFromTags),
    ["no", "limited"],
    "yes",
    "unknown",
  );
}

/** Fee: route tag when known; else true if any member charges, false only if every member says fee=no. */
export function aggregateFee(primary: OsmTags | null, members: readonly OsmTags[]): boolean | null {
  const own = primary ? feeFromTags(primary) : null;
  if (own !== null) return own;
  const values = members.map(feeFromTags);
  if (values.includes(true)) return true;
  return values.length > 0 && values.every((v) => v === false) ? false : null;
}

/** Permit: true when the route or any member explicitly requires one; otherwise null. */
export function aggregatePermit(primary: OsmTags | null, members: readonly OsmTags[]): true | null {
  return [primary, ...members].some((t) => t !== null && permitFromTags(t) === true) ? true : null;
}

/**
 * Text attribute: the route's own value when present; otherwise the value the
 * members agree on (members without the tag are ignored; disagreement → null).
 */
export function consensus(primary: string | null, members: readonly (string | null)[]): string | null {
  if (primary !== null) return primary;
  const distinct = new Set(members.filter((m): m is string => m !== null));
  return distinct.size === 1 ? [...distinct][0] : null;
}

/** seasonal / opening_hours on a trail ("seasonal=no" and "24/7" mean not seasonal). */
export function seasonalityFromTags(tags: OsmTags): string | null {
  const hours = cleanLine(tags.opening_hours, 300);
  if (hours && hours !== "24/7") return hours;
  const seasonal = cleanLine(tags.seasonal, 100);
  return seasonal && seasonal.toLowerCase() !== "no" ? seasonal : null;
}

export const accessFromTags = (tags: OsmTags) => cleanLine(tags.access, 100);
export const operatorFromTags = (tags: OsmTags) => cleanLine(tags.operator, 200);

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

const ACTIVITY_ORDER: readonly Activity[] = ["hiking", "walking", "running", "biking", "horse_riding"];

/**
 * Activities a trail supports, from route/highway/foot/bicycle/horse tags.
 *
 *  hiking       route=hiking, or any member is highway=path with a sac_scale
 *  walking      route=foot, or any member is highway=footway or foot=designated
 *  biking       bicycle=designated on the route, or on EVERY member way
 *  horse_riding horse=designated on the route, or EVERY member way is
 *               horse=designated or highway=bridleway
 *
 * Pedestrian activities apply when any part qualifies (every catalog trail is
 * walkable); biking and riding are permissions, so they must hold along the
 * whole trail before we advertise them. "running" has no OSM tag and is never
 * derived.
 */
export function aggregateActivities(primary: OsmTags | null, members: readonly OsmTags[]): Activity[] {
  const all = primary ? [primary, ...members] : [...members];
  const out = new Set<Activity>();
  if (primary?.route === "hiking" || all.some((t) => t.highway === "path" && t.sac_scale !== undefined)) out.add("hiking");
  if (primary?.route === "foot" || all.some((t) => t.highway === "footway" || t.foot === "designated")) out.add("walking");
  if (primary?.bicycle === "designated" || (members.length > 0 && members.every((t) => t.bicycle === "designated"))) {
    out.add("biking");
  }
  if (
    primary?.horse === "designated" ||
    (members.length > 0 && members.every((t) => t.horse === "designated" || t.highway === "bridleway"))
  ) {
    out.add("horse_riding");
  }
  return ACTIVITY_ORDER.filter((a) => out.has(a));
}

// ---------------------------------------------------------------------------
// Provenance tags (whitelists: never copy every tag)
// ---------------------------------------------------------------------------

export const TRAIL_PROVENANCE_KEYS = [
  "name",
  "name:en",
  "ref",
  "route",
  "highway",
  "network",
  "operator",
  "sac_scale",
  "trail_visibility",
  "surface",
  "roundtrip",
  "distance",
  "osmc:symbol",
  "colour",
  "from",
  "to",
  "wikidata",
  "wikipedia",
] as const;

export const POI_PROVENANCE_KEYS = [
  "name",
  "name:en",
  "amenity",
  "tourism",
  "natural",
  "highway",
  "waterway",
  "water",
  "man_made",
  "shop",
  "sport",
  "shelter_type",
  "information",
  "parking",
  "capacity",
  "fee",
  "access",
  "drinking_water",
  "seasonal",
  "emergency",
  "healthcare",
  "operator",
  "brand",
  "cuisine",
  "ele",
  "wheelchair",
  "wikidata",
  "wikipedia",
] as const;

const MAX_TAG_VALUE = 255;

/** Whitelisted tags of one element, values cleaned and capped. */
export function pickTags(tags: OsmTags, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const v = cleanLine(Object.prototype.hasOwnProperty.call(tags, key) ? tags[key] : undefined, MAX_TAG_VALUE);
    if (v !== null) out[key] = v;
  }
  return out;
}

/**
 * Whitelisted tags shared by a group of ways: a key is kept when every way
 * that carries it has the same value (ways without the key are ignored).
 */
export function pickConsensusTags(tagSets: readonly OsmTags[], keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const v = consensus(
      null,
      tagSets.map((t) => cleanLine(Object.prototype.hasOwnProperty.call(t, key) ? t[key] : undefined, MAX_TAG_VALUE)),
    );
    if (v !== null) out[key] = v;
  }
  return out;
}
