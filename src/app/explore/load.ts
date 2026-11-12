import "server-only";
import { headers } from "next/headers";
import { trailSearchQuerySchema, type Bbox, type CoverageDto, type TrailSearchResponse } from "@/domain/catalog";
import { bboxForPlace } from "@/components/explore/geometry";
import { searchApiQuery, type ExploreFilters, type ExploreUrlState } from "@/components/explore/url-state";
import type { ExploreInitial, PlaceSearchState } from "@/components/explore/types";
import { geocodePlaces, parsePlaceQuery } from "@/server/geo/geocode";
import { log } from "@/server/log";
import { checkRateLimit } from "@/server/rate-limit";
import { clientIpFrom } from "@/server/request";
import { ensureCoverage } from "@/server/trails/coverage";
import { catalogAttribution, searchTrails } from "@/server/trails/read";

/**
 * Server render of /explore: the first results for ?bbox= (or for ?q=, via
 * the first place found), so the page works and is shareable without
 * JavaScript. Uses the same query schema and rate-limit buckets as
 * GET /api/trails/search and GET /api/geocode.
 */

const COVERAGE_FAILED: Omit<CoverageDto, "layer"> = {
  state: "failed",
  tilesTotal: 0,
  tilesReady: 0,
  tilesLoading: 0,
  tilesFailed: 0,
  oldestSyncAt: null,
  message: "Trail loading is unavailable right now. Showing trails already stored for this area, which may be incomplete.",
};

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function search(bbox: Bbox, filters: ExploreFilters, ip: string): Promise<{ results: TrailSearchResponse | null; error: string | null }> {
  const parsed = trailSearchQuerySchema.safeParse(Object.fromEntries(new URLSearchParams(searchApiQuery(bbox, filters))));
  if (!parsed.success) return { results: null, error: "This search couldn’t be read. Try clearing the filters." };
  try {
    const rl = await checkRateLimit(`trails:search:ip:${ip}`, 60, 60);
    if (!rl.allowed) return { results: null, error: "You’ve searched a lot in a short time. Wait a minute, then try again." };
    const q = parsed.data;
    const coveragePromise = ensureCoverage("outdoor", q.bbox, { request: true, inlineTiles: 0 }).catch((err: unknown): CoverageDto => {
      log.error("explore.coverage_failed", { error: errorMessage(err) });
      return { layer: "outdoor", ...COVERAGE_FAILED };
    });
    const [coverage, { trails, total }] = await Promise.all([coveragePromise, searchTrails(q)]);
    return {
      results: { trails, total, bbox: q.bbox, coverage, attribution: catalogAttribution(["osm", ...trails.map((t) => t.provider)]) },
      error: null,
    };
  } catch (err) {
    log.error("explore.search_failed", { error: errorMessage(err) });
    return { results: null, error: "We couldn’t reach the trail catalog." };
  }
}

async function lookUpPlace(q: string, ip: string): Promise<PlaceSearchState> {
  const { nearMe } = parsePlaceQuery(q);
  if (nearMe) return { query: q, status: "near_me", results: [], chosenId: null };
  if (q.length < 2) return { query: q, status: "no_results", results: [], chosenId: null, message: "Type at least two letters of a place name." };
  try {
    const rl = await checkRateLimit(`geocode:ip:${ip}`, 30, 60);
    if (!rl.allowed) {
      return { query: q, status: "unavailable", results: [], chosenId: null, message: "Too many place searches in a short time. Wait a minute, then try again." };
    }
    const res = await geocodePlaces(q);
    if (res.status === "unavailable") return { query: q, status: "unavailable", results: [], chosenId: null };
    if (!res.results.length) return { query: q, status: "no_results", results: [], chosenId: null };
    return { query: q, status: "ok", results: res.results, chosenId: res.results[0].id };
  } catch (err) {
    log.error("explore.geocode_failed", { error: errorMessage(err) });
    return { query: q, status: "unavailable", results: [], chosenId: null };
  }
}

export async function loadExplore(state: ExploreUrlState, units: ExploreInitial["units"]): Promise<ExploreInitial> {
  const ip = clientIpFrom(new Headers(await headers()));
  if (state.bbox) {
    const { results, error } = await search(state.bbox, state.filters, ip);
    return { state, results, searchError: error, place: null, units };
  }
  if (state.q) {
    const place = await lookUpPlace(state.q, ip);
    if (place.status === "ok") {
      const bbox = bboxForPlace(place.results[0]);
      const { results, error } = await search(bbox, state.filters, ip);
      return { state: { ...state, bbox }, results, searchError: error, place, units };
    }
    return { state, results: null, searchError: null, place, units };
  }
  return { state, results: null, searchError: null, place: null, units };
}
