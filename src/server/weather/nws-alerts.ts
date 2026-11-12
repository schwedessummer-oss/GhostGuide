import "server-only";
import { env } from "@/config/env";
import type { AttributionDto, WeatherAlertDto } from "@/domain/catalog";
import { withSystem, type JsonValue } from "@/server/db";
import { log } from "@/server/log";
import { ProviderError, providerFetch, recordProviderCacheHit } from "@/server/providers/http";

/**
 * Official watches, warnings and advisories from the US National Weather
 * Service (api.weather.gov, public domain), for a point:
 *
 *   GET {NWS_URL}/alerts/active?point=<lat>,<lng>   Accept: application/geo+json
 *
 * Coverage: the United States and its territories only. A trail qualifies by
 * its country code (us, pr, vi, gu, as, mp); when the code is unknown
 * ("xx"/null) a coarse bounding-box check stands in, and api.weather.gov's own
 * answer settles it: HTTP 400 "out of bounds" means the point is outside NWS
 * coverage, which is reported as "not_supported" (and cached for a week).
 *
 * Results (including "no active alerts") are cached 5 minutes in
 * public.weather_cache (provider 'nws_alerts', key "lat,lng" at 3 decimals);
 * cache hits are counted for the 'nws' provider. Failures (network, 5xx,
 * 429, unexpected bodies) yield "unavailable" and are never cached.
 *
 * Nothing is invented: alerts come only from the NWS document. Test and
 * draft messages, cancellations and alerts already expired are dropped.
 * getNwsAlerts never throws.
 */

export const NWS_ALERTS_CACHE_PROVIDER = "nws_alerts" as const;
const USAGE_PROVIDER = "nws" as const;

export const NWS_ATTRIBUTION: AttributionDto = {
  name: "Weather alerts from the US National Weather Service (NOAA)",
  url: "https://www.weather.gov/",
  license: "US Government work (public domain)",
};
export const NWS_SOURCE_LABEL = "National Weather Service";

/** Cache lifetime of an alerts answer (alerts change quickly). */
export const NWS_ALERTS_TTL_MS = 5 * 60_000;
/** Cache lifetime of an "out of bounds" answer (coverage does not change). */
export const NWS_OUT_OF_BOUNDS_TTL_MS = 7 * 86_400_000;
export const NWS_TIMEOUT_MS = 8_000;
export const NWS_PAYLOAD_VERSION = 1;
export const NWS_TEXT_MAX = 2_000;
const MAX_FEATURES = 200;

/** ISO 3166-1 codes of places NWS issues alerts for. */
export const NWS_COUNTRY_CODES: ReadonlySet<string> = new Set(["us", "pr", "vi", "gu", "as", "mp"]);

/**
 * Generous boxes around NWS coverage, used only when a trail's country is
 * unknown. They also include bits of Canada and Mexico; NWS answers 400
 * "out of bounds" there, which becomes "not_supported".
 */
const NWS_BOXES: readonly { s: number; n: number; w: number; e: number; name: string }[] = [
  { name: "contiguous US", s: 24.3, n: 49.5, w: -125.0, e: -66.8 },
  { name: "Alaska", s: 51.0, n: 71.6, w: -180.0, e: -129.8 },
  { name: "Aleutians west of 180°", s: 51.0, n: 53.1, w: 172.0, e: 180.0 },
  { name: "Hawaii", s: 18.8, n: 22.4, w: -160.7, e: -154.7 },
  { name: "Puerto Rico and US Virgin Islands", s: 17.6, n: 18.6, w: -68.0, e: -64.5 },
  { name: "Guam and Northern Mariana Islands", s: 13.2, n: 20.6, w: 144.6, e: 146.1 },
  { name: "American Samoa", s: -14.6, n: -11.0, w: -171.2, e: -168.1 },
];

/** True when the point lies in one of the coarse NWS coverage boxes. */
export function isInNwsArea(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return NWS_BOXES.some((b) => lat >= b.s && lat <= b.n && lng >= b.w && lng <= b.e);
}

/** Normalized ISO country code, or null when unknown ("xx", empty, malformed). */
function knownCountry(code: string | null | undefined): string | null {
  if (typeof code !== "string") return null;
  const c = code.trim().toLowerCase();
  return /^[a-z]{2}$/.test(c) && c !== "xx" ? c : null;
}

/**
 * Whether to ask NWS for this trail: by country code when known, else by the
 * coarse coverage boxes.
 */
export function nwsAlertsSupported(countryCode: string | null | undefined, lat: number, lng: number): boolean {
  const c = knownCountry(countryCode);
  return c !== null ? NWS_COUNTRY_CODES.has(c) : isInNwsArea(lat, lng);
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Single-line text, trimmed and length-limited; null when empty. */
function line(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Multi-line text (NWS hard-wraps descriptions): newlines kept, other control characters dropped. */
function block(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function iso(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Only links to NWS/NOAA pages are passed on (the UI renders them as links). */
function nwsUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 500) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return /(^|\.)(weather\.gov|noaa\.gov)$/i.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

const SEVERITY_RANK: Record<string, number> = { extreme: 4, severe: 3, moderate: 2, minor: 1 };
const severityRank = (s: string) => SEVERITY_RANK[s.toLowerCase()] ?? 0;

/** Sort: most severe first, then earliest onset, then event name. */
export function sortAlerts(alerts: WeatherAlertDto[]): WeatherAlertDto[] {
  return [...alerts].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      (a.onset ? Date.parse(a.onset) : Infinity) - (b.onset ? Date.parse(b.onset) : Infinity) ||
      a.event.localeCompare(b.event) ||
      a.id.localeCompare(b.id),
  );
}

/** False for alerts whose message expired or whose hazard ended before `now`. */
function inForce(a: { ends: string | null }, expires: string | null, now: Date): boolean {
  const t = now.getTime();
  if (expires && Date.parse(expires) <= t) return false;
  if (a.ends && Date.parse(a.ends) <= t) return false;
  return true;
}

/**
 * NWS alerts GeoJSON FeatureCollection → WeatherAlertDto[] (sorted, see
 * sortAlerts). Null when the value is not a FeatureCollection.
 *
 *   id          properties.id (CAP identifier), else the feature id
 *   onset       properties.onset, else effective
 *   ends        properties.ends, else expires
 *   url         properties["@id"], else the feature id, else properties.uri
 *               (NWS/NOAA hosts only)
 *   text        description / instruction: trimmed, at most 2000 characters
 *
 * Dropped: status other than "Actual" (Test/Exercise/System/Draft),
 * messageType "Cancel", alerts expired or ended at `now`, features without
 * an event name or id, duplicate ids.
 */
export function mapNwsAlerts(raw: unknown, now: Date = new Date()): WeatherAlertDto[] | null {
  if (!isObj(raw) || !Array.isArray(raw.features)) return null;
  const out: WeatherAlertDto[] = [];
  const seen = new Set<string>();
  for (const f of raw.features.slice(0, MAX_FEATURES)) {
    if (!isObj(f) || !isObj(f.properties)) continue;
    const p = f.properties;
    if (p.status !== undefined && p.status !== null && p.status !== "Actual") continue;
    if (p.messageType === "Cancel") continue;
    const event = line(p.event, 200);
    const id = line(p.id, 300) ?? line(f.id, 300);
    if (!event || !id || seen.has(id)) continue;
    const expires = iso(p.expires);
    const alert: WeatherAlertDto = {
      id,
      event,
      severity: line(p.severity, 40) ?? "Unknown",
      headline: line(p.headline, 500),
      description: block(p.description, NWS_TEXT_MAX),
      instruction: block(p.instruction, NWS_TEXT_MAX),
      onset: iso(p.onset) ?? iso(p.effective),
      ends: iso(p.ends) ?? expires,
      source: NWS_SOURCE_LABEL,
      url: nwsUrl(p["@id"]) ?? nwsUrl(f.id) ?? nwsUrl(p.uri),
    };
    if (!inForce(alert, expires, now)) continue;
    seen.add(id);
    out.push(alert);
  }
  return sortAlerts(out);
}

/** True for the api.weather.gov problem document returned for points outside NWS coverage. */
export function isOutOfBoundsProblem(raw: unknown): boolean {
  return isObj(raw) && typeof raw.detail === "string" && /out of bounds/i.test(raw.detail);
}

// ---------------------------------------------------------------------------
// Cache payload
// ---------------------------------------------------------------------------

type NwsCachePayload =
  | { v: number; kind: "alerts"; alerts: WeatherAlertDto[] }
  | { v: number; kind: "out_of_bounds" };

const nullableString = (v: unknown) => v === null || typeof v === "string";

function isAlertDto(v: unknown): v is WeatherAlertDto {
  return (
    isObj(v) &&
    typeof v.id === "string" &&
    typeof v.event === "string" &&
    typeof v.severity === "string" &&
    typeof v.source === "string" &&
    ["headline", "description", "instruction", "onset", "ends", "url"].every((k) => nullableString(v[k]))
  );
}

function parseCachePayload(v: unknown): NwsCachePayload | null {
  if (!isObj(v) || v.v !== NWS_PAYLOAD_VERSION) return null;
  if (v.kind === "out_of_bounds") return { v: NWS_PAYLOAD_VERSION, kind: "out_of_bounds" };
  if (v.kind === "alerts" && Array.isArray(v.alerts) && v.alerts.every(isAlertDto)) {
    return { v: NWS_PAYLOAD_VERSION, kind: "alerts", alerts: v.alerts };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type NwsAlertsResult =
  | { status: "ok"; alerts: WeatherAlertDto[]; fromCache: boolean }
  | { status: "unavailable" | "not_supported"; alerts: []; message: string };

export const NWS_NOT_SUPPORTED_MESSAGE = "Official weather alerts are not available for this region in Ghost Guide.";
export const NWS_UNAVAILABLE_MESSAGE = "Official weather alerts from the National Weather Service could not be loaded right now.";

const round3 = (n: number) => Math.round(n * 1000) / 1000 + 0;

/** "lat,lng" rounded to 3 decimals (≈ 100 m; alerts are issued per zone/county). */
export function nwsCacheKey(lat: number, lng: number): string {
  return `${round3(lat).toFixed(3)},${round3(lng).toFixed(3)}`;
}

export function nwsAlertsUrl(lat: number, lng: number): string {
  const base = env().NWS_URL.replace(/\/+$/, "");
  // Numbers only; NWS accepts at most 4 decimals, so the comma is sent literally.
  return `${base}/alerts/active?point=${round3(lat)},${round3(lng)}`;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function writeCache(key: string, payload: NwsCachePayload, ttlMs: number): Promise<void> {
  try {
    await withSystem(
      (tx) => tx`
        insert into public.weather_cache (provider, cache_key, payload, fetched_at, expires_at, last_modified)
        values (${NWS_ALERTS_CACHE_PROVIDER}, ${key}, ${tx.json(payload as unknown as JsonValue)}, now(),
                now() + make_interval(secs => ${ttlMs / 1000}), null)
        on conflict (provider, cache_key) do update set
          payload = excluded.payload, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
    );
  } catch (err) {
    log.warn("nws_alerts.cache_write_failed", { error: errorMessage(err) });
  }
}

export interface NwsAlertsOptions {
  /** The trail's ISO country code ("xx"/null when unknown). */
  countryCode?: string | null;
  /** Reference time for dropping expired alerts (default: now). */
  now?: Date;
  signal?: AbortSignal;
}

/**
 * Active NWS alerts for a point. "not_supported" outside NWS coverage
 * (without a request when the country says so), "unavailable" on any failure,
 * otherwise "ok" with zero or more alerts. Never throws.
 */
export async function getNwsAlerts(lat: number, lng: number, opts: NwsAlertsOptions = {}): Promise<NwsAlertsResult> {
  const now = opts.now ?? new Date();
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { status: "unavailable", alerts: [], message: NWS_UNAVAILABLE_MESSAGE };
  }
  if (!nwsAlertsSupported(opts.countryCode, lat, lng)) {
    return { status: "not_supported", alerts: [], message: NWS_NOT_SUPPORTED_MESSAGE };
  }
  const key = nwsCacheKey(lat, lng);

  try {
    const [row] = await withSystem(
      (tx) => tx<{ payload: unknown }[]>`
        select payload from public.weather_cache
         where provider = ${NWS_ALERTS_CACHE_PROVIDER} and cache_key = ${key} and expires_at > now()`,
    );
    const cached = row ? parseCachePayload(row.payload) : null;
    if (cached) {
      await recordProviderCacheHit(USAGE_PROVIDER);
      if (cached.kind === "out_of_bounds") return { status: "not_supported", alerts: [], message: NWS_NOT_SUPPORTED_MESSAGE };
      // Re-apply the expiry filter: the entry may be up to 5 minutes old.
      const alerts = cached.alerts.filter((a) => !a.ends || Date.parse(a.ends) > now.getTime());
      return { status: "ok", alerts, fromCache: true };
    }
  } catch (err) {
    log.warn("nws_alerts.cache_read_failed", { error: errorMessage(err) });
  }

  let raw: unknown;
  let status: number;
  try {
    const res = await providerFetch({
      provider: USAGE_PROVIDER,
      url: nwsAlertsUrl(lat, lng),
      headers: { Accept: "application/geo+json" },
      // 400 carries the "out of bounds" problem document we need to read.
      okStatuses: [400],
      timeoutMs: NWS_TIMEOUT_MS,
      retries: 0,
      signal: opts.signal,
    });
    status = res.status;
    raw = res.json();
  } catch (err) {
    const httpStatus = err instanceof ProviderError ? err.status : null;
    log.warn("nws_alerts.unavailable", { reason: httpStatus ? `HTTP ${httpStatus}` : errorMessage(err) });
    return { status: "unavailable", alerts: [], message: NWS_UNAVAILABLE_MESSAGE };
  }

  if (status === 400) {
    if (isOutOfBoundsProblem(raw)) {
      await writeCache(key, { v: NWS_PAYLOAD_VERSION, kind: "out_of_bounds" }, NWS_OUT_OF_BOUNDS_TTL_MS);
      return { status: "not_supported", alerts: [], message: NWS_NOT_SUPPORTED_MESSAGE };
    }
    // Any other 400 means our request is wrong: surface it in logs, tell the user the truth.
    log.error("nws_alerts.bad_request", { status });
    return { status: "unavailable", alerts: [], message: NWS_UNAVAILABLE_MESSAGE };
  }

  const alerts = mapNwsAlerts(raw, now);
  if (!alerts) {
    log.warn("nws_alerts.unexpected_response", { status });
    return { status: "unavailable", alerts: [], message: NWS_UNAVAILABLE_MESSAGE };
  }
  await writeCache(key, { v: NWS_PAYLOAD_VERSION, kind: "alerts", alerts }, NWS_ALERTS_TTL_MS);
  return { status: "ok", alerts, fromCache: false };
}
