import "server-only";
import { env } from "@/config/env";
import type { AttributionDto, Bbox, GeocodeResponse, GeocodeResultDto } from "@/domain/catalog";
import { withSystem, type JsonValue } from "@/server/db";
import { log } from "@/server/log";
import { providerFetch, recordProviderCacheHit } from "@/server/providers/http";

/**
 * Place search (forward geocoding) and administrative names for a point
 * (reverse geocoding), backed by OpenStreetMap Nominatim (base URL
 * env().NOMINATIM_URL).
 *
 * NOMINATIM USAGE POLICY (https://operations.osmfoundation.org/policies/nominatim/)
 * The public instance is a shared, donated resource. Its policy requires:
 *   - at most ONE request per second for the whole application: every call
 *     goes through providerFetch with a DB-backed global spacing of 1.1 s
 *     (public.provider_throttle), so the limit holds across serverless
 *     instances;
 *   - an identifying User-Agent (providerFetch sends DATA_PROVIDER_USER_AGENT);
 *   - caching of results: forward results are cached 30 days in
 *     public.geocode_cache, reverse results 180 days in public.geo_admin_cache
 *     on a 0.1° grid;
 *   - NO autocomplete / search-as-you-type. This module deliberately offers no
 *     prefix or suggestion function; the UI geocodes a submitted query only;
 *   - visible attribution: "© OpenStreetMap contributors" (ODbL 1.0).
 * At scale, point NOMINATIM_URL at a self-hosted instance or swap this module
 * for a commercial geocoder behind the same functions.
 *
 * HONESTY
 *   - Nothing is invented: unknown fields are null; results come only from the
 *     provider (or our cache of the provider's answer).
 *   - Provider failures yield status "unavailable" (forward) or null (reverse)
 *     and are never cached, so the next request tries again.
 *   - Neither public function throws.
 */

export interface AdminArea {
  countryCode: string | null; // ISO 3166-1 alpha-2, lower case
  regionName: string | null; // state / province / prefecture
  nearestPlace: string | null; // city / town / village / hamlet
}

const PROVIDER = "nominatim" as const;
const SOURCE_LABEL = "OpenStreetMap Nominatim";
/** Global policy: max 1 request/second. Spaced slightly wider for clock jitter. */
const NOMINATIM_MIN_INTERVAL_MS = 1_100;
const NOMINATIM_TIMEOUT_MS = 10_000;
const FORWARD_LIMIT = 6;
const FORWARD_CACHE_DAYS = 30;
const REVERSE_CACHE_DAYS = 180;
/** Reverse zoom 10 ≈ "city" level: country, state/province, county, town. */
const REVERSE_ZOOM = 10;
/** Queries longer than this are cut before parsing (the API route allows ≤ 120). */
const MAX_QUERY_CHARS = 200;
/** Results with the same label closer than this are treated as one place. */
const DUPLICATE_RADIUS_M = 20_000;

export const NOMINATIM_ATTRIBUTION: AttributionDto[] = [
  { name: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright", license: "ODbL 1.0" },
  { name: "Nominatim", url: "https://nominatim.org", license: null },
];

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

/** Collapse whitespace, trim, drop wrapping quotes and trailing punctuation. */
function cleanText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[\s?!.,;:]+$/g, "")
    .replace(/^[\s,;:]+/g, "")
    .trim();
}

// Words describing the activity ("hikes", "hiking trails", "walks", ...).
const ACTIVITY_NOUN = String.raw`(?:(?:hiking|walking|nature|running|day)\s+)?(?:hikes?|hiking|trails?|walks?|walking|treks?|trekking|backpacking|routes?)(?:\s+(?:and|&)\s+(?:hikes?|hiking|trails?|walks?))?`;
// Leading qualifiers ("the 10 best", "easy", "dog-friendly", ...).
const QUALIFIERS = String.raw`(?:(?:the|some|any|\d{1,3}|best|top|good|great|nice|easy|moderate|hard|popular|scenic|beautiful|short|long|family|kid|dog|friendly|local)[\s-]+)*`;
const LEAD_IN = String.raw`(?:(?:find|show(?:\s+me)?|search(?:\s+for)?|where\s+(?:to|can\s+i)|what\s+are|list)\s+(?:the\s+)?)?`;
const PREPOSITION = String.raw`(?:near(?:\s+to)?|in|around|close\s+to|by|at|outside(?:\s+of)?|from|within|inside)`;
const NEAR_ME = String.raw`(?:near\s+me|nearby|near\s+by|around\s+me|close\s+to\s+me|close\s+by|near\s+here|around\s+here|near\s+my\s+location)`;

/** "best hikes near Denver", "trails in Yosemite", "where to hike around Banff". */
const LEADING_INTENT_RE = new RegExp(String.raw`^${LEAD_IN}${QUALIFIERS}${ACTIVITY_NOUN}\s+${PREPOSITION}\s+(.+)$`, "i");
/**
 * "Banff hikes", "Denver trails", "Asheville hiking trails". Only plural nouns
 * (and "hiking"): a trailing singular "Trail" is usually part of a name
 * ("Appalachian Trail") and must be kept.
 */
const TRAILING_INTENT_RE = new RegExp(
  String.raw`^(.+?)\s+${QUALIFIERS}(?:(?:hiking|walking|nature|day)\s+)?(?:hikes|trails|walks|hiking|treks|trekking)$`,
  "i",
);
/** "near Denver", "around Banff". */
const BARE_PREPOSITION_RE = /^(?:near(?:\s+to)?|around|close\s+to)\s+(.+)$/i;
/** "near me", "hikes nearby", "best trails around me", "nearby hikes". */
const NEAR_ME_RE = new RegExp(
  String.raw`^(?:${LEAD_IN}${QUALIFIERS}${ACTIVITY_NOUN}\s+)?${NEAR_ME}$|^${NEAR_ME}\s+${QUALIFIERS}${ACTIVITY_NOUN}$`,
  "i",
);
/** Remainders made only of activity words ("hiking trails") carry no place. */
const ONLY_INTENT_RE = new RegExp(String.raw`^${LEAD_IN}${QUALIFIERS}(?:${ACTIVITY_NOUN})?$`, "i");

/**
 * Split a search-box query into its place part and a "near me" flag.
 *
 *   "trails near Denver"       → { placeQuery: "Denver", nearMe: false }
 *   "Best hikes around Banff"  → { placeQuery: "Banff", nearMe: false }
 *   "Banff hikes"              → { placeQuery: "Banff", nearMe: false }
 *   "hikes near me" / "nearby" → { placeQuery: "", nearMe: true }
 *   "Appalachian Trail"        → { placeQuery: "Appalachian Trail", nearMe: false }
 *
 * Case-insensitive; whitespace is collapsed. A query made only of activity
 * words ("hiking trails") has no place: placeQuery "" and nearMe false.
 */
export function parsePlaceQuery(q: string): { placeQuery: string; nearMe: boolean } {
  let s = cleanText(typeof q === "string" ? q.slice(0, MAX_QUERY_CHARS) : "");
  if (!s) return { placeQuery: "", nearMe: false };
  if (NEAR_ME_RE.test(s)) return { placeQuery: "", nearMe: true };
  if (ONLY_INTENT_RE.test(s)) return { placeQuery: "", nearMe: false };

  const lead = LEADING_INTENT_RE.exec(s);
  const trail = lead ? null : TRAILING_INTENT_RE.exec(s);
  const bare = lead || trail ? null : BARE_PREPOSITION_RE.exec(s);
  const rest = lead?.[1] ?? trail?.[1] ?? bare?.[1];
  if (rest !== undefined) s = cleanText(rest);

  if (/^me$/i.test(s) || NEAR_ME_RE.test(s)) return { placeQuery: "", nearMe: true };
  if (ONLY_INTENT_RE.test(s)) return { placeQuery: "", nearMe: false };
  return { placeQuery: s, nearMe: false };
}

/** Cache key for a place query: NFKC, trimmed, whitespace collapsed, lower case. */
export function geocodeCacheKey(placeQuery: string): string {
  return placeQuery.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Result mapping (pure; exported for tests)
// ---------------------------------------------------------------------------

/** OSM / Nominatim classification values → our `kind` vocabulary. */
const KIND_BY_OSM_VALUE: Record<string, string> = {
  city: "city",
  town: "town",
  village: "village",
  hamlet: "hamlet",
  suburb: "locality",
  neighbourhood: "locality",
  quarter: "locality",
  borough: "locality",
  city_district: "locality",
  locality: "locality",
  isolated_dwelling: "locality",
  municipality: "municipality",
  county: "county",
  state_district: "county",
  district: "county",
  state: "region",
  province: "region",
  region: "region",
  country: "country",
  national_park: "national_park",
  protected_area: "protected_area",
  nature_reserve: "nature_reserve",
  park: "park",
  peak: "peak",
  volcano: "volcano",
  mountain_range: "mountain_range",
  ridge: "ridge",
  hill: "hill",
  valley: "valley",
  glacier: "glacier",
  water: "lake",
  lake: "lake",
  waterfall: "waterfall",
  island: "island",
  beach: "beach",
  path: "trail",
  footway: "trail",
  track: "trail",
  bridleway: "trail",
  hiking: "trail",
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 200) : null;
};
const numberFrom = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const countryCodeFrom = (v: unknown): string | null => {
  const c = str(v)?.toLowerCase() ?? null;
  return c && /^[a-z]{2}$/.test(c) ? c : null;
};

/** Kind from addresstype, then type, then category (first known value wins). */
function kindOf(r: Obj): string {
  const candidates = [r.addresstype, r.type, r.category ?? r.class].map((v) => str(v)?.toLowerCase() ?? "");
  for (const c of candidates) {
    const k = KIND_BY_OSM_VALUE[c];
    if (k) return k;
  }
  // boundary=administrative without a recognised addresstype is still an admin area.
  if (candidates[1] === "administrative") return "region";
  return "place";
}

/** Nominatim boundingbox [south, north, west, east] (strings) → [w, s, e, n]; null when invalid. */
export function nominatimBbox(value: unknown): Bbox | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [s, n, w, e] = value.map(numberFrom);
  if (s === null || n === null || w === null || e === null) return null;
  if (s < -90 || n > 90 || w < -180 || e > 180 || s > n || w > e) return null;
  return [w, s, e, n];
}

/** Region-level name from a Nominatim address object. */
function regionFrom(address: Obj): string | null {
  return str(address.state) ?? str(address.province) ?? str(address.region) ?? str(address.state_district) ?? str(address.county);
}

/** Short readable label: name, region, country (repeats dropped). */
function labelOf(name: string, kind: string, address: Obj): string {
  const parts = [name];
  if (kind !== "country") {
    const region = regionFrom(address);
    if (region) parts.push(region);
    const country = str(address.country);
    if (country) parts.push(country);
  }
  const seen = new Set<string>();
  return parts
    .filter((p) => {
      const k = p.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join(", ");
}

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Map one Nominatim jsonv2 search result; null when it lacks a name or a valid position. */
export function mapNominatimResult(raw: unknown): GeocodeResultDto | null {
  if (!isObj(raw)) return null;
  const lat = numberFrom(raw.lat);
  const lng = numberFrom(raw.lon);
  if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const address = isObj(raw.address) ? raw.address : {};
  const name = str(raw.name) ?? str(typeof raw.display_name === "string" ? raw.display_name.split(",")[0] : null);
  if (!name) return null;
  const kind = kindOf(raw);
  const osmType = str(raw.osm_type)?.toLowerCase();
  const osmId = numberFrom(raw.osm_id);
  const placeId = numberFrom(raw.place_id);
  const id =
    osmType && /^(node|way|relation)$/.test(osmType) && osmId !== null && Number.isInteger(osmId)
      ? `osm:${osmType}/${osmId}`
      : placeId !== null && Number.isInteger(placeId)
        ? `nominatim:${placeId}`
        : `nominatim:${lat.toFixed(5)},${lng.toFixed(5)}`;
  return {
    id,
    label: labelOf(name, kind, address),
    kind,
    lng,
    lat,
    bbox: nominatimBbox(raw.boundingbox),
    countryCode: countryCodeFrom(address.country_code),
    source: SOURCE_LABEL,
  };
}

/**
 * Map a Nominatim jsonv2 /search response (an array). Invalid entries are
 * skipped; near-identical results (same OSM object, or the same label within
 * 20 km, e.g. a city's boundary relation and its place node) collapse into
 * the first one, which Nominatim ranks higher. At most 6 results.
 */
export function mapNominatimResults(raw: unknown): GeocodeResultDto[] {
  if (!Array.isArray(raw)) return [];
  const out: GeocodeResultDto[] = [];
  for (const item of raw) {
    const r = mapNominatimResult(item);
    if (!r) continue;
    const dup = out.some(
      (o) => o.id === r.id || (o.label.toLowerCase() === r.label.toLowerCase() && haversineM(o, r) < DUPLICATE_RADIUS_M),
    );
    if (!dup) out.push(r);
    if (out.length >= FORWARD_LIMIT) break;
  }
  return out;
}

/**
 * Map a Nominatim jsonv2 /reverse response. Null for anything that is not a
 * reverse answer; an all-null AdminArea when Nominatim answers that the point
 * has no address (open sea: `{"error":"Unable to geocode"}`).
 *
 * countryCode ← address.country_code; regionName ← state | province | region
 * | state_district | county; nearestPlace ← city | town | village | hamlet |
 * municipality | suburb.
 */
export function mapNominatimReverse(raw: unknown): AdminArea | null {
  if (!isObj(raw)) return null;
  if (!isObj(raw.address)) {
    if (typeof raw.error === "string") return { countryCode: null, regionName: null, nearestPlace: null };
    return null;
  }
  const a = raw.address;
  return {
    countryCode: countryCodeFrom(a.country_code),
    regionName: regionFrom(a),
    nearestPlace: str(a.city) ?? str(a.town) ?? str(a.village) ?? str(a.hamlet) ?? str(a.municipality) ?? str(a.suburb),
  };
}

/** Cache cell for reverse lookups on a 0.1° grid: (35.04, -82.71) → "350/-827". */
export function adminCellKey(lat: number, lng: number): string {
  // Math.round(-0.4) is -0, and `${-0}` prints "0": one key per cell around 0°.
  return `${Math.round(lat * 10)}/${Math.round(lng * 10)}`;
}

function isGeocodeResultDto(v: unknown): v is GeocodeResultDto {
  if (!isObj(v)) return false;
  return (
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    typeof v.kind === "string" &&
    typeof v.lng === "number" &&
    typeof v.lat === "number" &&
    (v.bbox === null || (Array.isArray(v.bbox) && v.bbox.length === 4 && v.bbox.every((n) => typeof n === "number"))) &&
    (v.countryCode === null || typeof v.countryCode === "string") &&
    typeof v.source === "string"
  );
}

function nominatimUrl(path: "search" | "reverse", params: Record<string, string>): string {
  const base = env().NOMINATIM_URL.replace(/\/+$/, "");
  return `${base}/${path}?${new URLSearchParams(params).toString()}`;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// Forward geocoding
// ---------------------------------------------------------------------------

async function readForwardCache(key: string): Promise<GeocodeResultDto[] | null> {
  const [row] = await withSystem(
    (tx) => tx<{ results: unknown }[]>`
      select results from public.geocode_cache
       where provider = ${PROVIDER} and query_key = ${key} and expires_at > now()`,
  );
  if (!row) return null;
  // A malformed row (older shape, manual edit) is a cache miss, never an error.
  if (!Array.isArray(row.results) || !row.results.every(isGeocodeResultDto)) return null;
  return row.results;
}

async function writeForwardCache(key: string, results: GeocodeResultDto[]): Promise<void> {
  await withSystem(
    (tx) => tx`
      insert into public.geocode_cache (provider, query_key, results, created_at, expires_at)
      values (${PROVIDER}, ${key}, ${tx.json(results as unknown as JsonValue)}, now(),
              now() + make_interval(days => ${FORWARD_CACHE_DAYS}))
      on conflict (provider, query_key) do update
        set results = excluded.results, created_at = excluded.created_at, expires_at = excluded.expires_at`,
  );
}

/**
 * Forward geocoding for a free-text query ("Banff", "trails near Denver"). Cached; never throws.
 *
 * The intent words are stripped first (parsePlaceQuery); a query without a
 * place ("near me", "hiking trails") returns status "no_results" without
 * calling the provider. Answers, including empty ones, are cached 30 days
 * under the normalized place query; provider failures return "unavailable"
 * and are not cached.
 */
export async function geocodePlaces(query: string): Promise<GeocodeResponse> {
  const cleaned = typeof query === "string" ? query.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS) : "";
  const { placeQuery } = parsePlaceQuery(cleaned);
  const base = { query: cleaned, placeQuery, attribution: NOMINATIM_ATTRIBUTION };
  if (!placeQuery) return { ...base, results: [], status: "no_results" };

  const key = geocodeCacheKey(placeQuery);
  try {
    const cached = await readForwardCache(key);
    if (cached) {
      await recordProviderCacheHit(PROVIDER);
      return { ...base, results: cached, status: cached.length ? "ok" : "no_results" };
    }
  } catch (err) {
    // Cache trouble must not block search: fall through to the provider.
    log.warn("geocode.cache_read_failed", { error: errorMessage(err) });
  }

  let raw: unknown;
  try {
    const res = await providerFetch({
      provider: PROVIDER,
      url: nominatimUrl("search", {
        format: "jsonv2",
        q: placeQuery,
        limit: String(FORWARD_LIMIT),
        addressdetails: "1",
        "accept-language": "en",
      }),
      minIntervalMs: NOMINATIM_MIN_INTERVAL_MS,
      timeoutMs: NOMINATIM_TIMEOUT_MS,
      retries: 1,
    });
    raw = res.json();
  } catch (err) {
    log.warn("geocode.unavailable", { error: errorMessage(err) });
    return { ...base, results: [], status: "unavailable" };
  }
  if (!Array.isArray(raw)) {
    // Not a search answer (an error object, ...): report unavailable, do not cache.
    log.warn("geocode.unexpected_response", { type: typeof raw });
    return { ...base, results: [], status: "unavailable" };
  }

  const results = mapNominatimResults(raw);
  try {
    await writeForwardCache(key, results);
  } catch (err) {
    log.warn("geocode.cache_write_failed", { error: errorMessage(err) });
  }
  return { ...base, results, status: results.length ? "ok" : "no_results" };
}

// ---------------------------------------------------------------------------
// Reverse geocoding (administrative names)
// ---------------------------------------------------------------------------

/** Administrative string fields kept as provenance in geo_admin_cache.payload. */
function adminAddressPayload(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(raw) || !isObj(raw.address)) return out;
  for (const [k, v] of Object.entries(raw.address)) {
    const s = str(v);
    // Zoom 10 answers are admin-level; drop street-level keys defensively anyway.
    if (s && /^[A-Za-z0-9_:-]{1,40}$/.test(k) && !/^(house_number|house_name|road|postcode)$/.test(k)) out[k] = s;
  }
  return out;
}

/**
 * Administrative names for a point (cached on a ~0.1° grid). Null when unavailable; never throws.
 *
 * The provider is asked about the CENTRE of the point's 0.1° cell (≈ 11 km),
 * so every point in a cell shares one cacheable answer (180 days). Names are
 * therefore approximate near borders: they label trails, they are not
 * addresses. A point with no address (open sea) yields an all-null AdminArea,
 * which is cached; provider failures yield null and are not cached.
 */
export async function reverseAdminArea(lat: number, lng: number): Promise<AdminArea | null> {
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const cellKey = adminCellKey(lat, lng);
  const cellLat = Math.round(lat * 10) / 10;
  const cellLng = Math.round(lng * 10) / 10;

  try {
    const [row] = await withSystem(
      (tx) => tx<{ countryCode: string | null; regionName: string | null; nearestPlace: string | null }[]>`
        select country_code, region_name, nearest_place from public.geo_admin_cache
         where provider = ${PROVIDER} and cell_key = ${cellKey} and expires_at > now()`,
    );
    if (row) {
      await recordProviderCacheHit(PROVIDER);
      return { countryCode: row.countryCode, regionName: row.regionName, nearestPlace: row.nearestPlace };
    }
  } catch (err) {
    log.warn("geocode.reverse_cache_read_failed", { error: errorMessage(err) });
  }

  let raw: unknown;
  try {
    const res = await providerFetch({
      provider: PROVIDER,
      url: nominatimUrl("reverse", {
        format: "jsonv2",
        lat: cellLat.toFixed(1),
        lon: cellLng.toFixed(1),
        zoom: String(REVERSE_ZOOM),
        addressdetails: "1",
        "accept-language": "en",
      }),
      minIntervalMs: NOMINATIM_MIN_INTERVAL_MS,
      timeoutMs: NOMINATIM_TIMEOUT_MS,
      retries: 1,
    });
    raw = res.json();
  } catch (err) {
    log.warn("geocode.reverse_unavailable", { error: errorMessage(err) });
    return null;
  }
  const area = mapNominatimReverse(raw);
  if (!area) {
    log.warn("geocode.reverse_unexpected_response", { type: typeof raw });
    return null;
  }

  try {
    await withSystem(
      (tx) => tx`
        insert into public.geo_admin_cache
          (provider, cell_key, country_code, region_name, nearest_place, payload, fetched_at, expires_at)
        values (${PROVIDER}, ${cellKey}, ${area.countryCode}, ${area.regionName}, ${area.nearestPlace},
                ${tx.json({ address: adminAddressPayload(raw) } as unknown as JsonValue)}, now(),
                now() + make_interval(days => ${REVERSE_CACHE_DAYS}))
        on conflict (provider, cell_key) do update set
          country_code = excluded.country_code, region_name = excluded.region_name,
          nearest_place = excluded.nearest_place, payload = excluded.payload,
          fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
    );
  } catch (err) {
    log.warn("geocode.reverse_cache_write_failed", { error: errorMessage(err) });
  }
  return area;
}
