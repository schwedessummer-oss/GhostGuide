import "server-only";
import { z } from "zod";
import type { TrailDetailDto } from "@/domain/catalog";
import type { TrailRoutePreviewDto } from "@/components/explore/types";
import { withAnon } from "@/server/db";
import { log } from "@/server/log";
import { checkRateLimit } from "@/server/rate-limit";
import { clientIpFrom } from "@/server/request";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const NOT_FOUND = "Trail not found";

/** Metres per degree of latitude (tolerances below are in degrees of EPSG:4326). */
const M_PER_DEG = 111_320;
/** Display tolerance: the trail's extent / EXTENT_DIVISOR, clamped to [MIN, MAX] metres. */
const PREVIEW_MIN_TOLERANCE_M = 3;
const PREVIEW_MAX_TOLERANCE_M = 25;
const EXTENT_DIVISOR = 4_000;
/** Lines this short are sent as stored. */
const SIMPLIFY_ABOVE_VERTICES = 200;
/** GeoJSON coordinate decimals (~1.1 m; below the smallest tolerance). */
const PRECISION = 5;

type Row = { geometryJson: string; vertexCount: number; previewVertexCount: number };

/**
 * GET /api/trails/:id/geometry — the route line for Explore's map preview
 * (TrailRoutePreviewDto), instead of the whole trail detail (profile, POIs,
 * facts) of which Explore drew only the line.
 *
 * The line is simplified for display with ST_SimplifyPreserveTopology at a
 * tolerance that grows with the trail's size: about extent / 4000 (a fitted
 * preview a few thousand pixels across loses nothing visible), never less
 * than 3 m or more than 25 m. Short lines are sent as stored. Distances,
 * climbs and the trail page always use the full stored geometry.
 *
 * Public and read-only; 120 requests/min per client IP. 404 for ids that are
 * not UUIDs, unknown trails and hidden (moderated) trails alike. Cached like
 * GET /api/trails/:id ("public, s-maxage=300, stale-while-revalidate=60"):
 * the short shared lifetime bounds how long a newly hidden trail's line can
 * still be served. Errors, 404s and 429s are "no-store".
 *
 * The context type is written out (rather than the generated RouteContext)
 * so type-checking does not depend on a fresh `next typegen` run.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!z.uuid().safeParse(id).success) return notFound();

    const rl = await checkRateLimit(`trails:geometry:ip:${clientIpFrom(request.headers)}`, 120, 60);
    if (!rl.allowed) {
      return Response.json(
        { error: "Too many requests. Please wait a moment and try again." },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000))) } },
      );
    }

    const [row] = await withAnon(
      (tx) => tx<Row[]>`
        with t as (
          select t.geom,
                 greatest(${PREVIEW_MIN_TOLERANCE_M / M_PER_DEG}::float8,
                          least(${PREVIEW_MAX_TOLERANCE_M / M_PER_DEG}::float8,
                                sqrt(power(st_xmax(t.geom) - st_xmin(t.geom), 2) + power(st_ymax(t.geom) - st_ymin(t.geom), 2))
                                  / ${EXTENT_DIVISOR}::float8)) as tolerance
            from public.catalog_trails t
           where t.id = ${id.toLowerCase()}::uuid and not t.hidden
        ), p as (
          select st_npoints(t.geom) as vertex_count,
                 case when st_npoints(t.geom) > ${SIMPLIFY_ABOVE_VERTICES}::int
                      then st_multi(st_simplifypreservetopology(t.geom, t.tolerance))
                      else t.geom end as preview
            from t
        )
        select st_asgeojson(p.preview, ${PRECISION}::int) as geometry_json, p.vertex_count, st_npoints(p.preview) as preview_vertex_count
          from p`,
    );
    if (!row) return notFound();

    const geometry = toMultiLineString(JSON.parse(row.geometryJson));
    if (!geometry) throw new Error("unexpected preview geometry type");
    const body: TrailRoutePreviewDto = { id: id.toLowerCase(), geometry, simplified: row.previewVertexCount < row.vertexCount };
    return Response.json(body, { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" } });
  } catch (err) {
    log.error("api.trail_geometry_failed", { error: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: "Could not load this trail's route. Please try again." }, { status: 500, headers: NO_STORE });
  }
}

function toMultiLineString(g: { type?: string; coordinates?: unknown }): TrailDetailDto["geometry"] | null {
  if (g?.type === "MultiLineString" && Array.isArray(g.coordinates)) return g as TrailDetailDto["geometry"];
  if (g?.type === "LineString" && Array.isArray(g.coordinates)) return { type: "MultiLineString", coordinates: [g.coordinates as [number, number][]] };
  return null;
}

function notFound() {
  return Response.json({ error: NOT_FOUND }, { status: 404, headers: NO_STORE });
}
