import { z } from "zod";
import { log } from "@/server/log";
import { checkRateLimit } from "@/server/rate-limit";
import { clientIpFrom } from "@/server/request";
import { getNearbyServices } from "@/server/trails/nearby";

/** Allows the post-response services-tile loading (next/server after()) to finish. */
export const maxDuration = 300;

export const dynamic = "force-dynamic";

/** Requests per minute per client IP. Uncovered areas enqueue OpenStreetMap loading. */
const NEARBY_RATE_LIMIT_PER_MIN = 60;

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/trails/:id/nearby — NearbyResponse: gas, EV charging, food,
 * coffee, lodging, supplies and medical care within 15 km of the trailhead
 * (OpenStreetMap), plus parking and restrooms within 1 km, nearest first,
 * at most 3 per group, with the area's loading status.
 *
 * Public and read-only; 60 requests/min per client (IPv6 by /64); new
 * tile loads share the client's budget with trail searches. 404 for ids that are
 * not UUIDs, unknown trails and hidden trails alike.
 * Cache-Control: "public, s-maxage=600, stale-while-revalidate=3600" once
 * the area is fully loaded; "no-store" while loading/partial/failed so the
 * client's next poll sees new places. Errors are JSON ({ error }).
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!z.uuid().safeParse(id).success) return notFound();

    const client = clientIpFrom(request.headers);
    const rl = await checkRateLimit(`trails:nearby:ip:${client}`, NEARBY_RATE_LIMIT_PER_MIN, 60);
    if (!rl.allowed) {
      return Response.json(
        { error: "Too many requests. Please wait a moment and try again." },
        {
          status: 429,
          headers: { ...NO_STORE, "Retry-After": String(Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000))) },
        },
      );
    }

    // `client` charges new services-tile loads to the same per-client budget as trail searches.
    const nearby = await getNearbyServices(id, { client });
    if (!nearby) return notFound();
    return Response.json(nearby, {
      headers: {
        "Cache-Control": nearby.coverage.state === "ready" ? "public, s-maxage=600, stale-while-revalidate=3600" : "no-store",
      },
    });
  } catch (err) {
    log.error("api.trail_nearby_failed", { error: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: "Could not load nearby services. Please try again." }, { status: 500, headers: NO_STORE });
  }
}

function notFound() {
  return Response.json({ error: "Trail not found" }, { status: 404, headers: NO_STORE });
}
