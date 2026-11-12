import { z } from "zod";
import { jsonError } from "@/server/auth";
import { log } from "@/server/log";
import { checkRateLimit } from "@/server/rate-limit";
import { clientIpFrom } from "@/server/request";
import { getTrailDetailById } from "@/server/trails/read";

export const dynamic = "force-dynamic";

const NOT_FOUND = "Trail not found";

/**
 * GET /api/trails/:id — full public trail detail (TrailDetailDto): geometry
 * (simplified above 20 000 vertices), elevation profile, facts, nearby
 * outdoor POIs and attribution.
 *
 * Public and read-only; 120 requests/min per client IP. 404 for ids that are
 * not UUIDs, unknown trails and hidden (moderated) trails alike.
 * Cache-Control: "public, s-maxage=3600, stale-while-revalidate=86400"
 * (catalog rows change at most on tile refresh).
 *
 * The context type is written out (rather than the generated
 * RouteContext<"/api/trails/[id]">) so type-checking does not depend on a
 * fresh `next typegen` run; it is the same shape.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!z.uuid().safeParse(id).success) return notFound();

    const rl = await checkRateLimit(`trails:detail:ip:${clientIpFrom(request.headers)}`, 120, 60);
    if (!rl.allowed) {
      return Response.json(
        { error: "Too many requests. Please wait a moment and try again." },
        { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000))) } },
      );
    }

    const trail = await getTrailDetailById(id);
    if (!trail) return notFound();
    return Response.json(trail, { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } });
  } catch (err) {
    log.error("api.trail_detail_failed", { error: err instanceof Error ? err.message : String(err) });
    return jsonError(500, "Could not load this trail. Please try again.");
  }
}

function notFound() {
  return Response.json({ error: NOT_FOUND }, { status: 404, headers: { "Cache-Control": "no-store" } });
}
