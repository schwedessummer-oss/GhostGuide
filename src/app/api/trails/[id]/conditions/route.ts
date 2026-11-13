import { z } from "zod";
import { log } from "@/server/log";
import { checkRateLimit } from "@/server/rate-limit";
import { clientIpFrom } from "@/server/request";
import { conditionsCacheControl, loadTrailConditions } from "@/server/weather/conditions";

export const dynamic = "force-dynamic";

/** Requests per minute per client IP. Each uncached request can reach MET Norway and NWS. */
const CONDITIONS_RATE_LIMIT_PER_MIN = 60;

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/trails/:id/conditions — TrailConditionsDto: MET Norway forecast
 * (current hour, next 24 h, next 7 days, highlights), NWS alerts (US),
 * sun times and daylight planning.
 *
 * Public and read-only; 60 requests/min per client IP. 404 for ids that are
 * not UUIDs, unknown trails and hidden trails alike. A failing weather or
 * alerts provider is NOT an error: the body says "unavailable" (200).
 * Cache-Control (conditionsCacheControl): the body is built for the moment of
 * the request (daylight left, "finish if you start now", the current hour,
 * active alerts), so a complete response is shared for at most 60 s with no
 * stale-while-revalidate ("public, max-age=0, s-maxage=60"). Any degraded
 * response (forecast unavailable or served from the stale-if-error fallback,
 * alerts unavailable) is "no-store", so the next request retries.
 * Errors are JSON ({ error }) without internals.
 *
 * The context type is written out (not the generated RouteContext) so
 * type-checking does not depend on a fresh `next typegen` run.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!z.uuid().safeParse(id).success) return notFound();

    const rl = await checkRateLimit(`trails:conditions:ip:${clientIpFrom(request.headers)}`, CONDITIONS_RATE_LIMIT_PER_MIN, 60);
    if (!rl.allowed) {
      return Response.json(
        { error: "Too many requests. Please wait a moment and try again." },
        {
          status: 429,
          headers: { ...NO_STORE, "Retry-After": String(Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000))) },
        },
      );
    }

    const result = await loadTrailConditions(id);
    if (!result) return notFound();
    return Response.json(result.conditions, { headers: { "Cache-Control": conditionsCacheControl(result) } });
  } catch (err) {
    log.error("api.trail_conditions_failed", { error: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: "Could not load trail conditions. Please try again." }, { status: 500, headers: NO_STORE });
  }
}

function notFound() {
  return Response.json({ error: "Trail not found" }, { status: 404, headers: NO_STORE });
}
