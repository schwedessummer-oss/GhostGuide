import "server-only";
import { env } from "@/config/env";
import type { Bbox, CatalogLayer } from "@/domain/catalog";
import { haversineM } from "@/domain/geo";
import { log } from "@/server/log";
import { ProviderError, providerFetch } from "@/server/providers/http";
import type { ProviderAreaResult, TrailDataProvider } from "@/server/trails/types";
import { coversUs } from "./coverage";
import { RIDB_SOURCE_LICENSE, RIDB_SOURCE_NAME, RidbResponseError, facilitiesToPois, parseFacilitiesPage } from "./parse";

/**
 * Recreation.gov RIDB (Recreation Information Database): official US federal
 * recreation facilities — campgrounds, trailheads, visitor centers and
 * ranger stations — as outdoor-layer POIs. RIDB has no trail geometry, so
 * fetchArea never returns trails.
 *
 * Enabled only when RIDB_API_KEY is set (free key from ridb.recreation.gov;
 * sent in the `apikey` header, never in the URL). Coverage: the United
 * States incl. Alaska, Hawaii and the territories (./coverage.ts).
 *
 * One tile = one radius search around the tile centre
 *   GET {RIDB_URL}/facilities?latitude=&longitude=&radius=<miles>&limit=50&offset=
 * The radius reaches the tile's farthest corner (the API allows at most 25
 * miles; a 0.25° tile needs ~12). Results are paged 50 at a time, at most
 * RIDB_MAX_PAGES pages, then filtered to the tile itself.
 *
 * Failure handling: HTTP errors, timeouts and malformed bodies throw a
 * ProviderError (retryable unless the request itself is wrong, e.g. a
 * rejected key), so the tile is marked failed and nothing is substituted.
 * When the area has more facilities than the page bound allows, the fetch
 * fails (not retryable) instead of returning a partial list: ingestion
 * deletes the tile's stored POIs that a sync did not return, so a silently
 * truncated list would wipe real data.
 */

export const RIDB_PAGE_LIMIT = 50;
export const RIDB_MAX_PAGES = 10;
export const RIDB_TIMEOUT_MS = 15_000;
/** Largest radius the RIDB API accepts (OpenAPI spec: radius maximum 25). */
export const RIDB_MAX_RADIUS_MILES = 25;
const METERS_PER_MILE = 1609.344;
/** Safety margin on top of the exact centre-to-corner distance. */
const RADIUS_MARGIN = 1.02;

export interface SearchCircle {
  lat: number;
  lng: number;
  radiusMiles: number;
}

/**
 * Centre of `bbox` and a radius (miles, rounded up to 0.01) that reaches all
 * of it. RangeError when the bbox is invalid or needs more than 25 miles.
 */
export function searchCircle(bbox: Bbox): SearchCircle {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new RangeError("Invalid bbox");
  }
  const [w, s, e, n] = bbox;
  if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) throw new RangeError("Invalid bbox");
  const center = { lng: (w + e) / 2, lat: (s + n) / 2 };
  const probes = [
    { lng: w, lat: s }, { lng: w, lat: n }, { lng: e, lat: s }, { lng: e, lat: n },
    { lng: w, lat: center.lat }, { lng: e, lat: center.lat }, { lng: center.lng, lat: s }, { lng: center.lng, lat: n },
  ];
  const farthestM = Math.max(...probes.map((p) => haversineM(center, p)));
  const radiusMiles = Math.ceil(((farthestM * RADIUS_MARGIN) / METERS_PER_MILE) * 100) / 100;
  if (radiusMiles > RIDB_MAX_RADIUS_MILES) {
    throw new RangeError(`Area too large for one RIDB radius search (${radiusMiles} mi > ${RIDB_MAX_RADIUS_MILES} mi)`);
  }
  return { lat: Math.round(center.lat * 1e6) / 1e6, lng: Math.round(center.lng * 1e6) / 1e6, radiusMiles: Math.max(0.01, radiusMiles) };
}

/** URL of one facilities page. */
export function facilitiesUrl(baseUrl: string, circle: SearchCircle, offset: number): string {
  const params = new URLSearchParams({
    latitude: String(circle.lat),
    longitude: String(circle.lng),
    radius: String(circle.radiusMiles),
    limit: String(RIDB_PAGE_LIMIT),
    offset: String(offset),
  });
  return `${baseUrl.replace(/\/+$/, "")}/facilities?${params.toString()}`;
}

const apiKey = () => env().RIDB_API_KEY?.trim() ?? "";

function aborted(): ProviderError {
  return new ProviderError("ridb", "Request aborted", null, false);
}

async function fetchPage(url: string, key: string, signal?: AbortSignal) {
  let res;
  try {
    res = await providerFetch({
      provider: "ridb",
      url,
      headers: { apikey: key },
      timeoutMs: RIDB_TIMEOUT_MS,
      retries: 1,
      signal,
    });
  } catch (err) {
    if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
      throw new ProviderError("ridb", `RIDB rejected the API key (HTTP ${err.status}); check RIDB_API_KEY`, err.status, false);
    }
    throw err;
  }
  let json: unknown;
  try {
    json = res.json();
  } catch {
    throw new ProviderError("ridb", "RIDB returned a response that is not valid JSON", res.status, true);
  }
  try {
    return parseFacilitiesPage(json);
  } catch (err) {
    if (err instanceof RidbResponseError) throw new ProviderError("ridb", err.message, res.status, true);
    throw err;
  }
}

async function fetchArea(layer: CatalogLayer, bbox: Bbox, opts: { signal?: AbortSignal } = {}): Promise<ProviderAreaResult> {
  if (layer !== "outdoor") throw new RangeError(`RIDB serves the outdoor layer only (got ${String(layer)})`);
  const circle = searchCircle(bbox);
  const key = apiKey();
  if (!key) throw new ProviderError("ridb", "RIDB_API_KEY is not configured", null, false);
  const base = env().RIDB_URL;

  const records: unknown[] = [];
  for (let page = 0; page < RIDB_MAX_PAGES; page++) {
    if (opts.signal?.aborted) throw aborted();
    const offset = page * RIDB_PAGE_LIMIT;
    const { records: batch, totalCount } = await fetchPage(facilitiesUrl(base, circle, offset), key, opts.signal);
    records.push(...batch);
    const complete = batch.length < RIDB_PAGE_LIMIT || (totalCount !== null && offset + batch.length >= totalCount);
    if (complete) {
      const { pois, skipped } = facilitiesToPois(records, bbox);
      log.debug("ridb.area_fetched", { pages: page + 1, records: records.length, pois: pois.length, skipped });
      return { trails: [], pois, dataTimestamp: null };
    }
  }
  throw new ProviderError(
    "ridb",
    `More than ${RIDB_MAX_PAGES * RIDB_PAGE_LIMIT} RIDB facilities in this area; not loaded, to avoid storing an incomplete list`,
    null,
    false,
  );
}

export const ridbProvider: TrailDataProvider = {
  id: "ridb",
  label: "Recreation.gov",
  homepage: "https://ridb.recreation.gov",
  license: RIDB_SOURCE_LICENSE,
  attribution: RIDB_SOURCE_NAME,
  layers: ["outdoor"],
  isEnabled: () => apiKey().length > 0,
  covers: (bbox) => coversUs(bbox),
  fetchArea,
};

export { coversUs, US_COVERAGE_BOXES } from "./coverage";
export { facilitiesToPois, parseFacilitiesPage, categoryForFacilityType, FACILITY_TYPE_CATEGORIES } from "./parse";
