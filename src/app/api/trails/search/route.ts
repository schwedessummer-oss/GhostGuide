import { trailSearchQuerySchema, type CoverageDto, type TrailSearchResponse } from "@/domain/catalog";
import { jsonError } from "@/server/auth";
import { log } from "@/server/log";
import { checkRateLimit } from "@/server/rate-limit";
import { clientIpFrom } from "@/server/request";
import { ensureCoverage } from "@/server/trails/coverage";
import { catalogAttribution, searchTrails } from "@/server/trails/read";

export const dynamic = "force-dynamic";

/** Coverage reported when the coverage service itself fails: honest, never "ready". */
const COVERAGE_FAILED: Omit<CoverageDto, "layer"> = {
  state: "failed",
  tilesTotal: 0,
  tilesReady: 0,
  tilesLoading: 0,
  tilesFailed: 0,
  oldestSyncAt: null,
  message: "Trail loading is unavailable right now. Showing trails already stored for this area, which may be incomplete.",
};

/**
 * GET /api/trails/search?bbox=w,s,e,n&... — trails in a map area
 * (query schema: trailSearchQuerySchema in src/domain/catalog.ts).
 *
 * Public and read-only; 60 requests/min per client IP. Asks the coverage
 * service to load missing/stale OpenStreetMap tiles for the area (unless
 * load=0) and returns the trails already stored, with the area's loading
 * status so the UI can say "loading", "partial", "zoom in", ... If the
 * coverage service fails, stored trails are still returned with coverage
 * state "failed".
 *
 * Errors: 400 { error, fields } for an invalid query · 429 · 500.
 * Cache-Control: shared caching (60 s, SWR 5 min) only once the area is
 * fully loaded; "no-store" while loading/partial/failed so polling sees
 * new trails.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = trailSearchQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "query")))];
      return Response.json({ error: `Invalid search query: ${fields.join(", ")}`, fields }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const q = parsed.data;
    if (q.minDistanceKm !== undefined && q.maxDistanceKm !== undefined && q.minDistanceKm > q.maxDistanceKm) {
      return Response.json(
        { error: "Invalid search query: minDistanceKm must not exceed maxDistanceKm", fields: ["minDistanceKm", "maxDistanceKm"] },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const rl = await checkRateLimit(`trails:search:ip:${clientIpFrom(request.headers)}`, 60, 60);
    if (!rl.allowed) {
      return Response.json(
        { error: "Too many searches. Please wait a moment and try again." },
        { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000))) } },
      );
    }

    const coveragePromise = ensureCoverage("outdoor", q.bbox, { request: q.load, inlineTiles: q.load ? 2 : 0 }).catch(
      (err: unknown): CoverageDto => {
        log.error("api.trails_search.coverage_failed", { error: err instanceof Error ? err.message : String(err) });
        return { layer: "outdoor", ...COVERAGE_FAILED };
      },
    );
    const [coverage, { trails, total }] = await Promise.all([coveragePromise, searchTrails(q)]);

    const body: TrailSearchResponse = {
      trails,
      total,
      bbox: q.bbox,
      coverage,
      // Outdoor coverage is loaded from OpenStreetMap, so it is always credited.
      attribution: catalogAttribution(["osm", ...trails.map((t) => t.provider)]),
    };
    return Response.json(body, {
      headers: {
        "Cache-Control": coverage.state === "ready" ? "public, s-maxage=60, stale-while-revalidate=300" : "no-store",
      },
    });
  } catch (err) {
    log.error("api.trails_search_failed", { error: err instanceof Error ? err.message : String(err) });
    return jsonError(500, "Trail search failed. Please try again.");
  }
}
