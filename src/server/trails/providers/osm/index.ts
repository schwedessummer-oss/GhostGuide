import "server-only";
import { env } from "@/config/env";
import type { Bbox, CatalogLayer } from "@/domain/catalog";
import { log } from "@/server/log";
import { ProviderError, providerFetch } from "@/server/providers/http";
import type { ProviderAreaResult, TrailDataProvider } from "@/server/trails/types";
import { OSM_SOURCE_LICENSE, OverpassResponseError, overpassRuntimeError, parseOverpassResponse } from "./parse";
import { DEFAULT_OVERPASS_TIMEOUT_SEC, buildOverpassQuery } from "./query";

/**
 * OpenStreetMap trail data via the Overpass API (global coverage, ODbL).
 *
 * One POST per tile and layer. Endpoints come from OVERPASS_URLS (comma-
 * separated, tried in order). Failure handling:
 *
 *   - retryable failures move on to the next endpoint: network errors,
 *     timeouts, HTTP 429/5xx, invalid JSON, a response without `elements`,
 *     and HTTP 200 responses whose `remark` reports a runtime error (Overpass
 *     reports query timeouts and out-of-memory that way, with incomplete
 *     elements that must never be ingested);
 *   - the same endpoint is retried once, after a short pause, only for a
 *     network-level failure that happened quickly (connection reset, DNS,
 *     TLS): a timed-out query or a 429 is not repeated against a server that
 *     is already struggling;
 *   - non-retryable failures (e.g. HTTP 400 for a bad query) and caller
 *     aborts are thrown immediately;
 *   - when every endpoint fails, the last error is thrown, still marked
 *     retryable, so the job queue can try again later. Nothing is ever
 *     substituted for the missing data.
 *
 * Timeouts: Overpass gets `[timeout:90]`; the client waits that long plus a
 * margin for queueing and transfer (105 s per attempt). Callers with a
 * tighter budget (e.g. a serverless function limit) pass an AbortSignal.
 */

export { buildOverpassQuery } from "./query";
export { parseOverpassResponse } from "./parse";

/** Client-side budget on top of Overpass's own [timeout:N] (queueing, transfer). */
export const CLIENT_TIMEOUT_MARGIN_SEC = 15;
/** A network failure (no HTTP status) faster than this is retried once on the same endpoint. */
export const QUICK_FAILURE_MS = 10_000;
/** Pause before that same-endpoint retry. */
export const QUICK_RETRY_DELAY_MS = 1_000;

/** Valid http(s) endpoints from a comma-separated list, in order, without duplicates. */
export function parseOverpassEndpoints(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const candidate = part.trim();
    if (!candidate) continue;
    try {
      const u = new URL(candidate);
      if ((u.protocol === "https:" || u.protocol === "http:") && !out.includes(u.toString())) out.push(u.toString());
    } catch {
      // Ignore malformed entries; the remaining endpoints still work.
    }
  }
  return out;
}

const endpointHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
};

const abortedError = () => new ProviderError("overpass", "Request aborted", null, false);

/** Wait `ms`, returning early when the signal aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** One request to one endpoint; every failure is a ProviderError (or a caller abort). */
async function requestOnce(url: string, layer: CatalogLayer, query: string, timeoutSec: number, signal?: AbortSignal) {
  const res = await providerFetch({
    provider: "overpass",
    url,
    method: "POST",
    body: new URLSearchParams({ data: query }),
    timeoutMs: (timeoutSec + CLIENT_TIMEOUT_MARGIN_SEC) * 1000,
    // Retries are decided by fetchArea (see the module comment), not by the HTTP client.
    retries: 0,
    signal,
  });
  let json: unknown;
  try {
    json = res.json();
  } catch {
    throw new ProviderError("overpass", "Overpass returned a response that is not valid JSON", res.status, true);
  }
  const runtimeError = overpassRuntimeError(json);
  if (runtimeError) {
    throw new ProviderError("overpass", `Overpass runtime error: ${runtimeError.slice(0, 200)}`, res.status, true);
  }
  try {
    return parseOverpassResponse(layer, json);
  } catch (err) {
    if (err instanceof OverpassResponseError) throw new ProviderError("overpass", err.message, res.status, true);
    throw err;
  }
}

async function fetchArea(layer: CatalogLayer, bbox: Bbox, opts: { signal?: AbortSignal } = {}): Promise<ProviderAreaResult> {
  const timeoutSec = DEFAULT_OVERPASS_TIMEOUT_SEC;
  // Validates the layer and bbox (RangeError) before any request.
  const query = buildOverpassQuery(layer, bbox, { timeoutSec });
  const endpoints = parseOverpassEndpoints(env().OVERPASS_URLS);
  if (endpoints.length === 0) {
    throw new ProviderError("overpass", "No valid Overpass endpoint configured (OVERPASS_URLS)", null, false);
  }

  let lastError: ProviderError | null = null;
  for (const url of endpoints) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (opts.signal?.aborted) throw abortedError();
      const startedAt = Date.now();
      try {
        return await requestOnce(url, layer, query, timeoutSec, opts.signal);
      } catch (err) {
        if (!(err instanceof ProviderError) || !err.retryable || opts.signal?.aborted) throw err;
        lastError = err;
        const retrySameEndpoint = attempt === 1 && err.status === null && Date.now() - startedAt < QUICK_FAILURE_MS;
        log.warn("overpass.endpoint_failed", {
          endpoint: endpointHost(url),
          status: err.status,
          error: err.message,
          layer,
          attempt,
          retrySameEndpoint,
        });
        if (!retrySameEndpoint) break;
        await pause(QUICK_RETRY_DELAY_MS, opts.signal);
      }
    }
  }
  throw lastError ?? new ProviderError("overpass", "Overpass request failed", null, true);
}

export const osmProvider: TrailDataProvider = {
  id: "osm",
  label: "OpenStreetMap",
  homepage: "https://www.openstreetmap.org",
  license: OSM_SOURCE_LICENSE,
  attribution: "© OpenStreetMap contributors",
  layers: ["outdoor", "services"],
  isEnabled: () => true,
  // OpenStreetMap is global; data density varies by country.
  covers: () => true,
  fetchArea,
};
