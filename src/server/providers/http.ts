import "server-only";
import { env } from "@/config/env";
import { withSystem } from "@/server/db";
import { log } from "@/server/log";

/**
 * One HTTP client for every external data provider:
 *  - identifying User-Agent (required by OSM, Nominatim, MET Norway, NWS policies)
 *  - per-attempt timeout, bounded retries with backoff for retryable failures
 *  - optional global request spacing across all server instances (DB-backed;
 *    a slot is reserved only when the caller will wait for it, and an
 *    unused slot is given back when the caller aborts before sending)
 *  - `signal` aborts every wait (retry backoff, throttle slot) as well as
 *    the request itself
 *  - usage accounting per provider per UTC day (public.external_api_usage),
 *    shown in the admin "Data providers" view for cost control
 *
 * Callers own caching; this client never caches.
 */

export type ProviderKey = "overpass" | "nominatim" | "metno" | "nws" | "terrain_tiles" | "ridb";

export const PROVIDER_LABELS: Record<ProviderKey, string> = {
  overpass: "OpenStreetMap Overpass API",
  nominatim: "Nominatim (OpenStreetMap geocoding)",
  metno: "MET Norway Locationforecast",
  nws: "US National Weather Service",
  terrain_tiles: "AWS Terrain Tiles (elevation)",
  ridb: "Recreation.gov RIDB",
};

export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderKey,
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function providerUserAgent(): string {
  const e = env();
  return e.DATA_PROVIDER_USER_AGENT ?? e.WEATHER_USER_AGENT ?? `GhostGuide/0.1 (+${e.NEXT_PUBLIC_APP_URL})`;
}

export interface ProviderFetchOptions {
  provider: ProviderKey;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  /** Per-attempt timeout (default 20 s). */
  timeoutMs?: number;
  /** Extra attempts after the first for retryable failures (default 1). */
  retries?: number;
  /** Minimum spacing between requests to this provider across all instances. */
  minIntervalMs?: number;
  /**
   * Give up ("Provider is busy", retryable) instead of waiting longer than
   * this for a throttle slot (default 10 s, at most MAX_THROTTLE_WAIT_MS).
   * A request that gives up does not take a slot.
   */
  maxThrottleWaitMs?: number;
  /** Treat these HTTP statuses as successful responses (e.g. 304, 404). */
  okStatuses?: number[];
  /** Cancels waits and the request; throws a non-retryable "Request aborted" ProviderError. */
  signal?: AbortSignal;
  /**
   * On an error status, append up to this many characters of the response
   * body (tags stripped, whitespace collapsed) to the error message, so logs
   * and the admin usage view say WHY a provider refused (e.g. a rate-limit
   * or block page). Default 0: status only.
   */
  errorBodyChars?: number;
}

/** A short, single-line excerpt of an error response body (HTML tags stripped). */
export function errorBodyExcerpt(bytes: ArrayBuffer, maxChars: number): string {
  if (!(maxChars > 0) || bytes.byteLength === 0) return "";
  let text: string;
  try {
    text = new TextDecoder().decode(bytes.byteLength > 65_536 ? bytes.slice(0, 65_536) : bytes);
  } catch {
    return "";
  }
  return text
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.floor(maxChars));
}

export interface ProviderResponse {
  status: number;
  headers: Headers;
  bytes: ArrayBuffer;
  json<T = unknown>(): T;
  text(): string;
}

class AbortedWait extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedWait";
  }
}

/** Sleep `ms`; rejects with AbortedWait as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AbortedWait());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedWait());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Longest wait any caller may accept for a throttle slot (caps maxThrottleWaitMs). */
export const MAX_THROTTLE_WAIT_MS = 120_000;
/** Default for maxThrottleWaitMs. */
export const DEFAULT_THROTTLE_WAIT_MS = 10_000;

export interface ThrottleSlot {
  /** How long to wait before sending (ms). */
  waitMs: number;
  /** next_allowed_at after this reservation (DB text form), to give the slot back. */
  reservedUntil: string;
}

/**
 * Reserve the next request slot for a provider, but ONLY when it starts
 * within `maxWaitMs`: a caller that would give up anyway never moves the
 * shared clock, so a burst above the provider's rate sheds only the excess
 * instead of pushing next_allowed_at ever further ahead (which would reject
 * every later request for as long as the backlog takes to drain). Returns
 * null when the slot would be too far away.
 *
 * A backlog longer than any caller may wait (left by an older version of
 * this function) is clamped first, so it can never lock the provider out.
 */
export async function reserveThrottleSlot(provider: ProviderKey, minIntervalMs: number, maxWaitMs: number): Promise<ThrottleSlot | null> {
  const intervalSec = Math.max(0, minIntervalMs) / 1000;
  const maxWaitSec = Math.min(MAX_THROTTLE_WAIT_MS, Math.max(0, maxWaitMs)) / 1000;
  const capSec = MAX_THROTTLE_WAIT_MS / 1000 + intervalSec;
  return withSystem(async (tx) => {
    await tx`insert into public.provider_throttle (provider) values (${provider}) on conflict (provider) do nothing`;
    const [row] = await tx<{ waitMs: number; reservedUntil: string }[]>`
      with cur as (
        select least(greatest(next_allowed_at, now()), now() + make_interval(secs => ${capSec}::float8)) as slot
          from public.provider_throttle
         where provider = ${provider}
           for update)
      update public.provider_throttle p
         set next_allowed_at = cur.slot + make_interval(secs => ${intervalSec}::float8)
        from cur
       where p.provider = ${provider}
         and cur.slot <= now() + make_interval(secs => ${maxWaitSec}::float8)
      returning greatest(0, extract(epoch from (cur.slot - now())) * 1000)::float8 as "waitMs",
                p.next_allowed_at::text as "reservedUntil"`;
    if (row) return { waitMs: row.waitMs, reservedUntil: row.reservedUntil };
    // Rejected: heal a legacy backlog beyond what any caller may wait (no-op otherwise).
    await tx`
      update public.provider_throttle set next_allowed_at = now() + make_interval(secs => ${capSec}::float8)
       where provider = ${provider} and next_allowed_at > now() + make_interval(secs => ${capSec}::float8)`;
    return null;
  });
}

/**
 * Give an unused slot back (the caller gave up before sending), but only
 * when nobody reserved after it: then the clock returns to where this slot
 * began. Never throws.
 */
export async function releaseThrottleSlot(provider: ProviderKey, minIntervalMs: number, slot: ThrottleSlot): Promise<boolean> {
  try {
    const rows = await withSystem(
      (tx) => tx`
        update public.provider_throttle
           set next_allowed_at = greatest(now(), next_allowed_at - make_interval(secs => ${Math.max(0, minIntervalMs) / 1000}::float8))
         where provider = ${provider} and next_allowed_at = ${slot.reservedUntil}::timestamptz
        returning 1`,
    );
    return rows.length > 0;
  } catch (err) {
    log.warn("provider.throttle_release_failed", { provider, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Record one request outcome; never throws. */
export async function recordProviderUsage(
  provider: ProviderKey,
  outcome: { ok: boolean; status: number | null; bytes?: number; error?: string },
): Promise<void> {
  try {
    await withSystem(
      (tx) => tx`
        insert into public.external_api_usage as u
          (provider, day, requests, errors, bytes, last_status, last_error, last_request_at, last_success_at)
        values (${provider}, (now() at time zone 'utc')::date, 1, ${outcome.ok ? 0 : 1}, ${outcome.bytes ?? 0},
                ${outcome.status}, ${outcome.ok ? null : (outcome.error ?? "error").slice(0, 300)}, now(),
                ${outcome.ok ? new Date() : null}::timestamptz)
        on conflict (provider, day) do update set
          requests = u.requests + 1,
          errors = u.errors + excluded.errors,
          bytes = u.bytes + excluded.bytes,
          last_status = excluded.last_status,
          last_error = coalesce(excluded.last_error, u.last_error),
          last_request_at = excluded.last_request_at,
          last_success_at = coalesce(excluded.last_success_at, u.last_success_at)`,
    );
  } catch (err) {
    log.warn("provider.usage_record_failed", { provider, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Count a request served from our cache instead of the provider; never throws. */
export async function recordProviderCacheHit(provider: ProviderKey): Promise<void> {
  try {
    await withSystem(
      (tx) => tx`
        insert into public.external_api_usage as u (provider, day, cache_hits)
        values (${provider}, (now() at time zone 'utc')::date, 1)
        on conflict (provider, day) do update set cache_hits = u.cache_hits + 1`,
    );
  } catch {
    /* accounting only */
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function providerFetch(opts: ProviderFetchOptions): Promise<ProviderResponse> {
  const attempts = 1 + Math.max(0, opts.retries ?? 1);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let lastError: ProviderError | null = null;

  const abortedError = () => new ProviderError(opts.provider, "Request aborted", null, false);

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) throw abortedError();
    let slot: ThrottleSlot | null = null;
    try {
      if (attempt > 0) await sleep(Math.min(8_000, 750 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250), opts.signal);
      if (opts.minIntervalMs) {
        slot = await reserveThrottleSlot(opts.provider, opts.minIntervalMs, opts.maxThrottleWaitMs ?? DEFAULT_THROTTLE_WAIT_MS);
        if (!slot) throw new ProviderError(opts.provider, "Provider is busy (rate limit queue full)", null, true);
        if (slot.waitMs > 0) await sleep(slot.waitMs, opts.signal);
      }
      if (opts.signal?.aborted) throw new AbortedWait();
    } catch (err) {
      if (err instanceof AbortedWait) {
        // Gave up before sending: give the slot back so it is not wasted.
        if (slot && opts.minIntervalMs) await releaseThrottleSlot(opts.provider, opts.minIntervalMs, slot);
        throw abortedError();
      }
      throw err;
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(opts.url, {
        method: opts.method ?? "GET",
        headers: { "User-Agent": providerUserAgent(), Accept: "application/json", ...opts.headers },
        body: opts.body,
        signal: controller.signal,
        cache: "no-store",
      });
      const bytes = await res.arrayBuffer();
      const ok = res.ok || (opts.okStatuses ?? []).includes(res.status);
      const excerpt = ok ? "" : errorBodyExcerpt(bytes, opts.errorBodyChars ?? 0);
      const failure = excerpt ? `HTTP ${res.status}: ${excerpt}` : `HTTP ${res.status}`;
      await recordProviderUsage(opts.provider, { ok, status: res.status, bytes: bytes.byteLength, error: ok ? undefined : failure });
      if (ok) {
        const decoded = () => new TextDecoder().decode(bytes);
        return {
          status: res.status,
          headers: res.headers,
          bytes,
          text: decoded,
          json: <T,>() => JSON.parse(decoded()) as T,
        };
      }
      lastError = new ProviderError(opts.provider, failure, res.status, RETRYABLE_STATUS.has(res.status));
      if (!lastError.retryable) throw lastError;
    } catch (err) {
      if (err instanceof ProviderError && !err.retryable) throw err;
      if (err instanceof ProviderError) {
        lastError = err;
      } else {
        const aborted = controller.signal.aborted && !opts.signal?.aborted;
        const message = aborted ? `Timed out after ${timeoutMs} ms` : err instanceof Error ? err.message : String(err);
        await recordProviderUsage(opts.provider, { ok: false, status: null, error: message });
        lastError = new ProviderError(opts.provider, message, null, !opts.signal?.aborted);
        if (opts.signal?.aborted) throw lastError;
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastError ?? new ProviderError(opts.provider, "Request failed", null, true);
}
