import { z } from "zod";
import { log } from "@/server/log";
import { checkRateLimit } from "@/server/rate-limit";
import { clientIpFrom } from "@/server/request";
import { getTrailDetailById } from "@/server/trails/read";

export const dynamic = "force-dynamic";

const NOT_FOUND = "Trail not found";
const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/trails/:id — full public trail detail (TrailDetailDto): geometry
 * (simplified above 20 000 vertices), elevation profile, facts, nearby
 * outdoor POIs and attribution.
 *
 * Public and read-only; 120 requests/min per client IP. 404 for ids that are
 * not UUIDs, unknown trails and hidden (moderated) trails alike.
 * Cache-Control: "public, s-maxage=300, stale-while-revalidate=60". Rows
 * change on tile refresh but also when staff hide a trail, and a CDN copy
 * cannot be purged from here (revalidatePath does not reach CDN-cached route
 * handler responses), so the shared lifetime is what bounds how long a hidden
 * trail can still be served: at most ~6 minutes (300 s + 60 s). Errors,
 * 404s and 429s are "no-store".
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
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000))) } },
      );
    }

    const trail = await getTrailDetailById(id);
    if (!trail) return notFound();
    return Response.json(trail, { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" } });
  } catch (err) {
    log.error("api.trail_detail_failed", { error: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: "Could not load this trail. Please try again." }, { status: 500, headers: NO_STORE });
  }
}

function notFound() {
  return Response.json({ error: NOT_FOUND }, { status: 404, headers: NO_STORE });
}
