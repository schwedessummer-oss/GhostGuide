import "server-only";
import { env } from "@/config/env";
import type { AttributionDto, HourlyForecastDto } from "@/domain/catalog";
import { withSystem, type JsonValue } from "@/server/db";
import { log } from "@/server/log";
import { ProviderError, providerFetch, recordProviderCacheHit } from "@/server/providers/http";

/**
 * MET Norway Locationforecast 2.0 ("complete" variant), global point
 * forecasts under CC BY 4.0 (https://api.met.no/doc/License).
 *
 *   GET {METNO_URL}/locationforecast/2.0/complete?lat=..&lon=..&altitude=..
 *
 * TERMS OF SERVICE (https://api.met.no/doc/TermsOfService) and how they are met:
 *  - identifying User-Agent: providerFetch sends DATA_PROVIDER_USER_AGENT;
 *  - at most 4 decimals in coordinates: we round to 3 (≈ 100 m), which is
 *    also the cache key, so nearby trails share one forecast;
 *  - respect Expires: a cached forecast is served until its Expires time
 *    (TTL = Expires − Date of the response, applied to our clock so skew
 *    does not matter; clamped to [1 min, 6 h], 30 min when absent);
 *  - conditional requests: an expired entry is revalidated with
 *    If-Modified-Since = its stored Last-Modified; 304 extends the cached
 *    forecast without downloading it again;
 *  - 203 Non-Authoritative = "this product version is deprecated": the
 *    forecast is still valid and used, and a warning is logged;
 *  - 429 / 5xx / network errors / unparseable bodies → "unavailable" (never
 *    cached, never retried in a tight loop: one attempt per request).
 *
 * Cache: public.weather_cache (provider 'metno', cache_key "lat,lon[,altitude]"),
 * via withSystem (server-only table). The payload is the NORMALIZED series
 * (MetnoSeries, versioned), not the raw document. Cache hits are counted in
 * public.external_api_usage (recordProviderCacheHit('metno')).
 *
 * Stale-if-error: when revalidation fails and a cached forecast exists that
 * was last confirmed by MET Norway at most METNO_STALE_IF_ERROR_MS ago, that
 * real forecast is returned with source "stale" so callers can say it could
 * not be refreshed. Older data is never served: the result is "unavailable".
 *
 * Nothing is invented: every value comes from the provider document; fields
 * it does not contain are null. getMetnoForecast never throws.
 */

export const METNO_PROVIDER = "metno" as const;

export const METNO_ATTRIBUTION: AttributionDto = {
  name: "Weather data from MET Norway (The Norwegian Meteorological Institute)",
  url: "https://api.met.no/",
  license: "CC BY 4.0",
};

/** TTL when the response has no usable Expires header. */
export const METNO_DEFAULT_TTL_MS = 30 * 60_000;
/** Shortest TTL we store (an Expires in the past must not cause a request per page view). */
export const METNO_MIN_TTL_MS = 60_000;
/** Longest TTL we store, whatever Expires says. */
export const METNO_MAX_TTL_MS = 6 * 3_600_000;
/** A cached forecast confirmed by MET Norway within this window may be served when a refresh fails. */
export const METNO_STALE_IF_ERROR_MS = 3 * 3_600_000;
/** Per-request timeout. The conditions API waits on this, so it is short and not retried. */
export const METNO_TIMEOUT_MS = 8_000;
/** Version tag of the cached payload shape; any other version is a cache miss. */
export const METNO_PAYLOAD_VERSION = 1;
/** Hard cap on parsed time steps (MET publishes ~90). */
const MAX_STEPS = 400;

// ---------------------------------------------------------------------------
// Normalized forecast series
// ---------------------------------------------------------------------------

/** One forecast period that starts at a step (next_1_hours / next_6_hours). */
export interface MetnoPeriod {
  precipitationMm: number | null;
  /** probability_of_precipitation, % (published for some regions only). */
  probability: number | null;
  /** Provider symbol code, e.g. "lightrain" or "partlycloudy_day". */
  symbol: string | null;
}

export interface MetnoStep {
  /** ISO instant (UTC) of the step. */
  time: string;
  temperatureC: number | null;
  windSpeedMs: number | null;
  /** wind_speed_of_gust (published for some regions only). */
  windGustMs: number | null;
  next1h: MetnoPeriod | null;
  next6h: (MetnoPeriod & { minC: number | null; maxC: number | null }) | null;
}

export interface MetnoSeries {
  /** properties.meta.updated_at: when MET Norway last updated the forecast (ISO). */
  updatedAt: string | null;
  /** Steps sorted by time, unique times. Hourly first (~2.5 days), then 6-hourly. */
  steps: MetnoStep[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Finite number within [min, max], else null (implausible values are treated as missing). */
function bounded(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
}
const temperature = (v: unknown) => bounded(v, -100, 70);
const wind = (v: unknown) => bounded(v, 0, 150);
const precipitation = (v: unknown) => bounded(v, 0, 1_000);
const percent = (v: unknown) => bounded(v, 0, 100);
/** MET symbol codes are lower-case words with optional _day/_night/_polartwilight. */
const symbolCode = (v: unknown): string | null => (typeof v === "string" && /^[a-z]{2,40}(_[a-z]{2,20})?$/.test(v) ? v : null);

function isoInstant(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function period(v: unknown): MetnoPeriod | null {
  if (!isObj(v)) return null;
  const details = isObj(v.details) ? v.details : {};
  const summary = isObj(v.summary) ? v.summary : {};
  const p: MetnoPeriod = {
    precipitationMm: precipitation(details.precipitation_amount),
    probability: percent(details.probability_of_precipitation),
    symbol: symbolCode(summary.symbol_code),
  };
  return p.precipitationMm === null && p.probability === null && p.symbol === null ? null : p;
}

function sixHourPeriod(v: unknown): MetnoStep["next6h"] {
  const base = period(v);
  const details = isObj(v) && isObj(v.details) ? v.details : {};
  const minC = temperature(details.air_temperature_min);
  const maxC = temperature(details.air_temperature_max);
  if (!base && minC === null && maxC === null) return null;
  return {
    ...(base ?? { precipitationMm: null, probability: null, symbol: null }),
    minC: minC !== null && maxC !== null && minC > maxC ? null : minC,
    maxC: minC !== null && maxC !== null && minC > maxC ? null : maxC,
  };
}

function step(entry: unknown): MetnoStep | null {
  if (!isObj(entry)) return null;
  const time = isoInstant(entry.time);
  if (!time || !isObj(entry.data)) return null;
  const data = entry.data;
  const instant = isObj(data.instant) && isObj(data.instant.details) ? data.instant.details : {};
  return {
    time,
    temperatureC: temperature(instant.air_temperature),
    windSpeedMs: wind(instant.wind_speed),
    windGustMs: wind(instant.wind_speed_of_gust),
    next1h: period(data.next_1_hours),
    next6h: sixHourPeriod(data.next_6_hours),
  };
}

function sortUnique(steps: MetnoStep[]): MetnoStep[] {
  const byTime = new Map<string, MetnoStep>();
  for (const s of steps) if (!byTime.has(s.time)) byTime.set(s.time, s);
  return [...byTime.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).slice(0, MAX_STEPS);
}

/**
 * Parse a Locationforecast 2.0 document (compact or complete) into a
 * MetnoSeries. Null when the value is not such a document (no
 * properties.timeseries array). Malformed steps are skipped; implausible
 * numbers become null; duplicate times keep the first occurrence.
 */
export function parseMetnoResponse(raw: unknown): MetnoSeries | null {
  if (!isObj(raw) || !isObj(raw.properties) || !Array.isArray(raw.properties.timeseries)) return null;
  const meta = isObj(raw.properties.meta) ? raw.properties.meta : {};
  const steps: MetnoStep[] = [];
  for (const entry of raw.properties.timeseries.slice(0, MAX_STEPS * 2)) {
    const s = step(entry);
    if (s) steps.push(s);
  }
  return { updatedAt: isoInstant(meta.updated_at), steps: sortUnique(steps) };
}

/** Step → public hourly DTO (precipitation and probability of the hour that starts at `time`). */
export function toHourlyDto(s: MetnoStep): HourlyForecastDto {
  return {
    time: s.time,
    temperatureC: s.temperatureC,
    precipitationMm: s.next1h?.precipitationMm ?? null,
    precipitationProbability: s.next1h?.probability ?? null,
    windSpeedMs: s.windSpeedMs,
    windGustMs: s.windGustMs,
    symbol: s.next1h?.symbol ?? s.next6h?.symbol ?? null,
  };
}

// ---------------------------------------------------------------------------
// Cached payload (de)serialization
// ---------------------------------------------------------------------------

/** Shape stored in weather_cache.payload. */
export interface MetnoCachePayload {
  v: number;
  updatedAt: string | null;
  steps: MetnoStep[];
}

export function toCachePayload(series: MetnoSeries): MetnoCachePayload {
  return { v: METNO_PAYLOAD_VERSION, updatedAt: series.updatedAt, steps: series.steps };
}

function sameNullableNumber(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

function validPeriod(v: unknown, six: boolean): boolean {
  if (v === null) return true;
  if (!isObj(v)) return false;
  const ok =
    sameNullableNumber(v.precipitationMm) &&
    sameNullableNumber(v.probability) &&
    (v.symbol === null || symbolCode(v.symbol) !== null);
  return six ? ok && sameNullableNumber(v.minC) && sameNullableNumber(v.maxC) : ok;
}

/**
 * Stored payload → series; null (a cache miss) for another version or any
 * malformed step, so an old or hand-edited row can never break a page.
 */
export function seriesFromCachePayload(payload: unknown): MetnoSeries | null {
  if (!isObj(payload) || payload.v !== METNO_PAYLOAD_VERSION || !Array.isArray(payload.steps)) return null;
  if (payload.updatedAt !== null && isoInstant(payload.updatedAt) === null) return null;
  const steps: MetnoStep[] = [];
  for (const s of payload.steps) {
    if (
      !isObj(s) ||
      isoInstant(s.time) === null ||
      !sameNullableNumber(s.temperatureC) ||
      !sameNullableNumber(s.windSpeedMs) ||
      !sameNullableNumber(s.windGustMs) ||
      !validPeriod(s.next1h ?? null, false) ||
      !validPeriod(s.next6h ?? null, true)
    ) {
      return null;
    }
    const n1 = (s.next1h ?? null) as MetnoPeriod | null;
    const n6 = (s.next6h ?? null) as MetnoStep["next6h"];
    steps.push({
      time: isoInstant(s.time) as string,
      temperatureC: s.temperatureC as number | null,
      windSpeedMs: s.windSpeedMs as number | null,
      windGustMs: s.windGustMs as number | null,
      next1h: n1 && { precipitationMm: n1.precipitationMm, probability: n1.probability, symbol: n1.symbol },
      next6h: n6 && { precipitationMm: n6.precipitationMm, probability: n6.probability, symbol: n6.symbol, minC: n6.minC, maxC: n6.maxC },
    });
  }
  return { updatedAt: (payload.updatedAt as string | null) ?? null, steps: sortUnique(steps) };
}

// ---------------------------------------------------------------------------
// Request shaping
// ---------------------------------------------------------------------------

export interface MetnoQuery {
  lat: number;
  lon: number;
  /** Whole metres (rounded to 10 m) or null to let MET Norway use its model terrain. */
  altitude: number | null;
  cacheKey: string;
}

/** Round to 3 decimals; -0 becomes 0 so both sides of 0° share one key. */
const round3 = (n: number) => Math.round(n * 1000) / 1000 + 0;

/**
 * Coordinates rounded to 3 decimals (≈ 100 m; MET allows at most 4) and the
 * altitude rounded to 10 m (≈ 0.07 °C of lapse rate), so the request is
 * exactly what the cache key describes. Throws RangeError for invalid
 * coordinates. Altitudes outside −500…9000 m are dropped.
 */
export function metnoQuery(lat: number, lng: number, altitudeM?: number | null): MetnoQuery {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new RangeError("lat/lng out of range");
  }
  const rl = round3(lat);
  const rn = round3(lng);
  const alt =
    typeof altitudeM === "number" && Number.isFinite(altitudeM) && altitudeM >= -500 && altitudeM <= 9_000
      ? Math.round(altitudeM / 10) * 10 + 0
      : null;
  const cacheKey = `${rl.toFixed(3)},${rn.toFixed(3)}${alt === null ? "" : `,${alt}`}`;
  return { lat: rl, lon: rn, altitude: alt, cacheKey };
}

export function metnoUrl(q: MetnoQuery): string {
  const base = env().METNO_URL.replace(/\/+$/, "");
  const params = new URLSearchParams({ lat: String(q.lat), lon: String(q.lon) });
  if (q.altitude !== null) params.set("altitude", String(q.altitude));
  return `${base}/locationforecast/2.0/complete?${params.toString()}`;
}

/** HTTP-date (RFC 9110) → Date; null when absent or unparseable. */
export function parseHttpDate(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 100) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * When a response stops being fresh, on OUR clock: (Expires − Date) after
 * `nowMs` when both headers parse (robust to clock skew), else the absolute
 * Expires, else METNO_DEFAULT_TTL_MS. Clamped to [METNO_MIN_TTL_MS, METNO_MAX_TTL_MS].
 */
export function expiresAtFrom(headers: Headers, nowMs = Date.now()): Date {
  const expires = parseHttpDate(headers.get("expires"));
  const date = parseHttpDate(headers.get("date"));
  let ttl: number;
  if (expires && date) ttl = expires.getTime() - date.getTime();
  else if (expires) ttl = expires.getTime() - nowMs;
  else ttl = METNO_DEFAULT_TTL_MS;
  ttl = Math.min(METNO_MAX_TTL_MS, Math.max(METNO_MIN_TTL_MS, ttl));
  return new Date(nowMs + ttl);
}

/** Last-Modified header kept verbatim for If-Modified-Since, when it is a valid HTTP-date. */
function lastModifiedFrom(headers: Headers): string | null {
  const v = headers.get("last-modified");
  return v && parseHttpDate(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type MetnoSource =
  | "cache" // fresh cache entry, no request
  | "provider" // downloaded now (200/203)
  | "revalidated" // 304: cached forecast confirmed current
  | "stale"; // refresh failed; cached forecast confirmed within METNO_STALE_IF_ERROR_MS

export type MetnoForecastResult =
  | {
      status: "ok";
      series: MetnoSeries;
      source: MetnoSource;
      /** Last time MET Norway delivered or confirmed this forecast. */
      fetchedAt: Date;
      expiresAt: Date;
      /** True when MET answered 203 (the API version is deprecated). */
      deprecated: boolean;
    }
  | { status: "unavailable"; message: string };

export const METNO_UNAVAILABLE_MESSAGE = "The weather forecast from MET Norway is unavailable right now.";

interface CacheRow {
  payload: unknown;
  fetchedAt: Date;
  expiresAt: Date;
  lastModified: string | null;
  fresh: boolean;
  staleUsable: boolean;
}

async function readCache(key: string): Promise<CacheRow | null> {
  const [row] = await withSystem(
    (tx) => tx<CacheRow[]>`
      select payload, fetched_at, expires_at, last_modified,
             expires_at > now() as fresh,
             fetched_at > now() - make_interval(secs => ${METNO_STALE_IF_ERROR_MS / 1000}) as stale_usable
        from public.weather_cache
       where provider = ${METNO_PROVIDER} and cache_key = ${key}`,
  );
  return row ?? null;
}

/** Upsert a downloaded forecast. A concurrent writer's newer row is never overwritten. */
async function writeCache(key: string, series: MetnoSeries, expiresAt: Date, lastModified: string | null): Promise<Date> {
  const [row] = await withSystem(
    (tx) => tx<{ fetchedAt: Date }[]>`
      insert into public.weather_cache as c (provider, cache_key, payload, fetched_at, expires_at, last_modified)
      values (${METNO_PROVIDER}, ${key}, ${tx.json(toCachePayload(series) as unknown as JsonValue)}, now(),
              ${expiresAt}::timestamptz, ${lastModified})
      on conflict (provider, cache_key) do update set
        payload = excluded.payload, fetched_at = excluded.fetched_at,
        expires_at = excluded.expires_at, last_modified = excluded.last_modified
       where c.fetched_at <= excluded.fetched_at
      returning fetched_at`,
  );
  return row?.fetchedAt ?? new Date();
}

/**
 * 304: extend the cached forecast. Only the row we revalidated is extended:
 * if another request replaced it meanwhile (different Last-Modified), that
 * newer row is left alone.
 */
async function extendCache(key: string, sentLastModified: string, expiresAt: Date): Promise<void> {
  await withSystem(
    (tx) => tx`
      update public.weather_cache
         set fetched_at = now(), expires_at = ${expiresAt}::timestamptz
       where provider = ${METNO_PROVIDER} and cache_key = ${key}
         and last_modified = ${sentLastModified}`,
  );
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface MetnoForecastOptions {
  /** Elevation of the forecast point (m); improves temperatures in mountains. */
  altitudeM?: number | null;
  signal?: AbortSignal;
}

/**
 * Point forecast for (lat, lng), served from cache while fresh (see module
 * header). Never throws: invalid coordinates and every provider or database
 * failure yield { status: "unavailable" } (a database failure while reading
 * the cache falls through to the provider).
 */
export async function getMetnoForecast(lat: number, lng: number, opts: MetnoForecastOptions = {}): Promise<MetnoForecastResult> {
  let q: MetnoQuery;
  try {
    q = metnoQuery(lat, lng, opts.altitudeM);
  } catch {
    return { status: "unavailable", message: METNO_UNAVAILABLE_MESSAGE };
  }

  let cached: CacheRow | null = null;
  let cachedSeries: MetnoSeries | null = null;
  try {
    cached = await readCache(q.cacheKey);
    cachedSeries = cached ? seriesFromCachePayload(cached.payload) : null;
  } catch (err) {
    log.warn("metno.cache_read_failed", { error: errorMessage(err) });
  }

  if (cached && cachedSeries && cached.fresh) {
    await recordProviderCacheHit(METNO_PROVIDER);
    return {
      status: "ok",
      series: cachedSeries,
      source: "cache",
      fetchedAt: new Date(cached.fetchedAt),
      expiresAt: new Date(cached.expiresAt),
      deprecated: false,
    };
  }

  // Revalidate only an entry we can actually serve on 304.
  const ifModifiedSince = cached && cachedSeries && cached.lastModified ? cached.lastModified : null;
  const staleFallback = (reason: string): MetnoForecastResult => {
    if (cached && cachedSeries && cached.staleUsable) {
      log.warn("metno.serving_stale", { reason });
      return {
        status: "ok",
        series: cachedSeries,
        source: "stale",
        fetchedAt: new Date(cached.fetchedAt),
        expiresAt: new Date(cached.expiresAt),
        deprecated: false,
      };
    }
    log.warn("metno.unavailable", { reason });
    return { status: "unavailable", message: METNO_UNAVAILABLE_MESSAGE };
  };

  let res: Awaited<ReturnType<typeof providerFetch>>;
  try {
    res = await providerFetch({
      provider: METNO_PROVIDER,
      url: metnoUrl(q),
      headers: ifModifiedSince ? { "If-Modified-Since": ifModifiedSince } : undefined,
      okStatuses: [304],
      timeoutMs: METNO_TIMEOUT_MS,
      retries: 0,
      signal: opts.signal,
    });
  } catch (err) {
    const status = err instanceof ProviderError ? err.status : null;
    return staleFallback(status ? `HTTP ${status}` : errorMessage(err));
  }

  const expiresAt = expiresAtFrom(res.headers);

  if (res.status === 304) {
    if (!cached || !cachedSeries || !ifModifiedSince) return staleFallback("unexpected 304");
    try {
      await extendCache(q.cacheKey, ifModifiedSince, expiresAt);
    } catch (err) {
      log.warn("metno.cache_extend_failed", { error: errorMessage(err) });
    }
    return { status: "ok", series: cachedSeries, source: "revalidated", fetchedAt: new Date(), expiresAt, deprecated: false };
  }

  if (res.status < 200 || res.status > 299) return staleFallback(`HTTP ${res.status}`);
  const deprecated = res.status === 203;
  if (deprecated) {
    log.warn("metno.deprecated_version", { status: 203, message: "Locationforecast 2.0 is marked deprecated; plan an upgrade." });
  }

  let raw: unknown;
  try {
    raw = res.json();
  } catch {
    return staleFallback("invalid JSON");
  }
  const series = parseMetnoResponse(raw);
  if (!series || series.steps.length === 0) return staleFallback("not a forecast document");

  let fetchedAt = new Date();
  try {
    fetchedAt = await writeCache(q.cacheKey, series, expiresAt, lastModifiedFrom(res.headers));
  } catch (err) {
    log.warn("metno.cache_write_failed", { error: errorMessage(err) });
  }
  return { status: "ok", series, source: "provider", fetchedAt: new Date(fetchedAt), expiresAt, deprecated };
}
