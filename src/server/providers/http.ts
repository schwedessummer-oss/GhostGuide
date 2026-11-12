import "server-only";
import { env } from "@/config/env";
import { withSystem } from "@/server/db";
import { log } from "@/server/log";

/**
 * One HTTP client for every external data provider:
 *  - identifying User-Agent (required by OSM, Nominatim, MET Norway, NWS policies)
 *  - per-attempt timeout, bounded retries with backoff for retryable failures
 *  - optional global request spacing across all server instances (DB-backed)
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
  /** Give up instead of waiting longer than this for a throttle slot (default 10 s). */
  maxThrottleWaitMs?: number;
  /** Treat these HTTP statuses as successful responses (e.g. 304, 404). */
  okStatuses?: number[];
  signal?: AbortSignal;
}

export interface ProviderResponse {
  status: number;
  headers: Headers;
  bytes: ArrayBuffer;
  json<T = unknown>(): T;
  text(): string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reserve the next request slot for a provider; returns how long to wait. */
async function reserveSlot(provider: ProviderKey, minIntervalMs: number): Promise<number> {
  return withSystem(async (tx) => {
    await tx`insert into public.provider_throttle (provider) values (${provider}) on conflict (provider) do nothing`;
    const [row] = await tx<{ waitMs: number }[]>`
      update public.provider_throttle
         set next_allowed_at = greatest(next_allowed_at, now()) + make_interval(secs => ${minIntervalMs / 1000})
       where provider = ${provider}
       returning greatest(0, extract(epoch from (next_allowed_at - make_interval(secs => ${minIntervalMs / 1000}) - now())) * 1000)::float8 as "waitMs"`;
    return row?.waitMs ?? 0;
  });
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

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(Math.min(8_000, 750 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250));
    if (opts.minIntervalMs) {
      const wait = await reserveSlot(opts.provider, opts.minIntervalMs);
      if (wait > (opts.maxThrottleWaitMs ?? 10_000)) {
        throw new ProviderError(opts.provider, "Provider is busy (rate limit queue full)", null, true);
      }
      if (wait > 0) await sleep(wait);
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
      await recordProviderUsage(opts.provider, { ok, status: res.status, bytes: bytes.byteLength, error: ok ? undefined : `HTTP ${res.status}` });
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
      lastError = new ProviderError(opts.provider, `HTTP ${res.status}`, res.status, RETRYABLE_STATUS.has(res.status));
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
