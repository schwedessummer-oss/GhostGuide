/**
 * Explore URL state: /explore?q=&bbox=&<filters>. Pure and isomorphic.
 *
 * Filter keys and values are the ones GET /api/trails/search accepts
 * (trailSearchQuerySchema), so the URL, the server render and the API call
 * describe the same query. Parsing is forgiving (unknown or out-of-range
 * values are dropped, never an error page) and serializing is canonical
 * (stable key order, defaults omitted) so URLs are shareable and comparable.
 */
import {
  ACTIVITIES,
  formatBbox,
  parseBbox,
  type Activity,
  type Bbox,
  type Difficulty,
  type RouteType,
  type TrailFeature,
} from "@/domain/catalog";

export const FILTER_DIFFICULTIES = ["easy", "moderate", "hard", "expert"] as const satisfies readonly Difficulty[];
export const FILTER_ROUTE_TYPES = ["loop", "linear", "network"] as const satisfies readonly RouteType[];
export const FILTER_FEATURES = ["waterfall", "lake", "viewpoint", "peak"] as const satisfies readonly TrailFeature[];
export const SORTS = ["relevance", "length", "gain", "name"] as const;
export type Sort = (typeof SORTS)[number];

export type FilterDifficulty = (typeof FILTER_DIFFICULTIES)[number];
export type FilterRouteType = (typeof FILTER_ROUTE_TYPES)[number];
export type FilterFeature = (typeof FILTER_FEATURES)[number];

export interface ExploreFilters {
  difficulty: FilterDifficulty[];
  routeType: FilterRouteType[];
  features: FilterFeature[];
  activity: Activity | null;
  minDistanceKm: number | null;
  maxDistanceKm: number | null;
  maxGainM: number | null;
  maxDurationMin: number | null;
  dogFriendly: boolean;
  familyFriendly: boolean;
  parking: boolean;
  toilets: boolean;
  camping: boolean;
  fee: "free" | "paid" | null;
  permit: "required" | "not_required" | null;
  sort: Sort;
}

export const EMPTY_FILTERS: ExploreFilters = Object.freeze({
  difficulty: [],
  routeType: [],
  features: [],
  activity: null,
  minDistanceKm: null,
  maxDistanceKm: null,
  maxGainM: null,
  maxDurationMin: null,
  dogFriendly: false,
  familyFriendly: false,
  parking: false,
  toilets: false,
  camping: false,
  fee: null,
  permit: null,
  sort: "relevance",
}) as ExploreFilters;

export interface ExploreUrlState {
  /** The text typed in the search box (a place, or "trails near Denver"). */
  q: string;
  /** The searched area. */
  bbox: Bbox | null;
  filters: ExploreFilters;
}

/** Search-box text limit (same as GET /api/geocode). */
export const MAX_QUERY_LENGTH = 120;

/** Accepts URLSearchParams or Next.js `searchParams` objects. */
export type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function reader(src: ParamSource) {
  if (src instanceof URLSearchParams) {
    return {
      one: (k: string) => src.get(k) ?? undefined,
      all: (k: string) => src.getAll(k),
    };
  }
  return {
    one: (k: string) => {
      const v = src[k];
      return Array.isArray(v) ? v[0] : v;
    },
    all: (k: string) => {
      const v = src[k];
      return v === undefined ? [] : Array.isArray(v) ? v : [v];
    },
  };
}

export function cleanQuery(value: string | undefined | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

/** Values of a list param, from "a,b" and/or repeated keys; only allowed values, canonical order. */
function list<T extends string>(values: string[], allowed: readonly T[]): T[] {
  const picked = new Set(
    values
      .flatMap((v) => v.split(","))
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return allowed.filter((a) => picked.has(a));
}

function number(value: string | undefined, min: number, max: number): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

const flag = (value: string | undefined) => value === "1" || value === "true";

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | null {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export function parseFilters(src: ParamSource): ExploreFilters {
  const r = reader(src);
  let minDistanceKm = number(r.one("minDistanceKm"), 0, 500);
  const maxDistanceKm = number(r.one("maxDistanceKm"), 0, 500);
  if (minDistanceKm !== null && maxDistanceKm !== null && minDistanceKm > maxDistanceKm) minDistanceKm = null;
  return {
    difficulty: list(r.all("difficulty"), FILTER_DIFFICULTIES),
    routeType: list(r.all("routeType"), FILTER_ROUTE_TYPES),
    features: list(r.all("features"), FILTER_FEATURES),
    activity: oneOf(r.one("activity"), ACTIVITIES),
    minDistanceKm,
    maxDistanceKm,
    maxGainM: number(r.one("maxGainM"), 0, 10_000),
    maxDurationMin: number(r.one("maxDurationMin"), 0, 10_000),
    dogFriendly: flag(r.one("dogFriendly")),
    familyFriendly: flag(r.one("familyFriendly")),
    parking: flag(r.one("parking")),
    toilets: flag(r.one("toilets")),
    camping: flag(r.one("camping")),
    fee: oneOf(r.one("fee"), ["free", "paid"] as const),
    permit: oneOf(r.one("permit"), ["required", "not_required"] as const),
    sort: oneOf(r.one("sort"), SORTS) ?? "relevance",
  };
}

export function parseExploreParams(src: ParamSource): ExploreUrlState {
  const r = reader(src);
  return { q: cleanQuery(r.one("q")), bbox: parseBbox(r.one("bbox")), filters: parseFilters(src) };
}

const num = (n: number, digits: number) => String(Number(n.toFixed(digits)));

/** Filter entries in canonical order, with API names and values; defaults omitted. */
export function filterEntries(f: ExploreFilters): [string, string][] {
  const out: [string, string][] = [];
  if (f.difficulty.length) out.push(["difficulty", list(f.difficulty, FILTER_DIFFICULTIES).join(",")]);
  if (f.routeType.length) out.push(["routeType", list(f.routeType, FILTER_ROUTE_TYPES).join(",")]);
  if (f.features.length) out.push(["features", list(f.features, FILTER_FEATURES).join(",")]);
  if (f.activity) out.push(["activity", f.activity]);
  if (f.minDistanceKm !== null) out.push(["minDistanceKm", num(f.minDistanceKm, 3)]);
  if (f.maxDistanceKm !== null) out.push(["maxDistanceKm", num(f.maxDistanceKm, 3)]);
  if (f.maxGainM !== null) out.push(["maxGainM", num(f.maxGainM, 1)]);
  if (f.maxDurationMin !== null) out.push(["maxDurationMin", num(f.maxDurationMin, 0)]);
  if (f.dogFriendly) out.push(["dogFriendly", "1"]);
  if (f.familyFriendly) out.push(["familyFriendly", "1"]);
  if (f.parking) out.push(["parking", "1"]);
  if (f.toilets) out.push(["toilets", "1"]);
  if (f.camping) out.push(["camping", "1"]);
  if (f.fee) out.push(["fee", f.fee]);
  if (f.permit) out.push(["permit", f.permit]);
  if (f.sort !== "relevance") out.push(["sort", f.sort]);
  return out;
}

/** Canonical query string for /explore (no leading "?"; "" when empty). */
export function serializeExploreParams(state: ExploreUrlState): string {
  const p = new URLSearchParams();
  const q = cleanQuery(state.q);
  if (q) p.set("q", q);
  if (state.bbox) p.set("bbox", formatBbox(state.bbox));
  for (const [k, v] of filterEntries(state.filters)) p.set(k, v);
  return p.toString();
}

export const explorePath = (state: ExploreUrlState) => {
  const qs = serializeExploreParams(state);
  return qs ? `/explore?${qs}` : "/explore";
};

/** Query string for GET /api/trails/search (the explore `q` is a place, never a trail-name filter). */
export function searchApiQuery(bbox: Bbox, f: ExploreFilters): string {
  const p = new URLSearchParams();
  p.set("bbox", formatBbox(bbox));
  for (const [k, v] of filterEntries(f)) p.set(k, v);
  return p.toString();
}

/** Number of active filter choices (each chip / field counts once; sort does not count). */
export function countActiveFilters(f: ExploreFilters): number {
  return (
    f.difficulty.length +
    f.routeType.length +
    f.features.length +
    [f.activity, f.minDistanceKm, f.maxDistanceKm, f.maxGainM, f.maxDurationMin, f.fee, f.permit].filter((v) => v !== null).length +
    [f.dogFriendly, f.familyFriendly, f.parking, f.toilets, f.camping].filter(Boolean).length
  );
}

/** Same filters without any choice (keeps the sort order). */
export const clearedFilters = (f: ExploreFilters): ExploreFilters => ({ ...EMPTY_FILTERS, sort: f.sort });

export function filtersEqual(a: ExploreFilters, b: ExploreFilters): boolean {
  const ea = filterEntries(a);
  const eb = filterEntries(b);
  return ea.length === eb.length && ea.every(([k, v], i) => eb[i][0] === k && eb[i][1] === v);
}
