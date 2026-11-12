import { z } from "zod";
import { jsonError } from "@/server/auth";
import { geocodePlaces, parsePlaceQuery } from "@/server/geo/geocode";
import { log } from "@/server/log";
import { checkRateLimit } from "@/server/rate-limit";
import { clientIpFrom } from "@/server/request";

export const dynamic = "force-dynamic";

const querySchema = z.object({ q: z.string().trim().min(2).max(120) });

/**
 * GET /api/geocode?q=<2..120 chars> — place search for the explore page.
 *
 * Public and read-only. Rate limited to 30 requests/min per client IP (each
 * cache miss costs one request against Nominatim's global 1 req/s policy).
 * Returns GeocodeResponse plus `nearMe` (true for "hikes near me" style
 * queries, which have no place to look up: the client should use the
 * device location instead). Provider failures come back as 200 with
 * status "unavailable" — never invented results. There is deliberately no
 * autocomplete variant (Nominatim policy).
 *
 * Errors: 400 invalid q · 429 rate limited · 500 unexpected.
 * Cache-Control: "private, max-age=300" ("no-store" when unavailable, so a
 * retry reaches the provider again).
 */
export async function GET(request: Request) {
  try {
    const parsed = querySchema.safeParse({ q: new URL(request.url).searchParams.get("q") ?? "" });
    if (!parsed.success) return jsonError(400, "q must be between 2 and 120 characters");

    const rl = await checkRateLimit(`geocode:ip:${clientIpFrom(request.headers)}`, 30, 60);
    if (!rl.allowed) {
      return Response.json(
        { error: "Too many place searches. Please wait a moment and try again." },
        { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000))) } },
      );
    }

    const result = await geocodePlaces(parsed.data.q);
    const { nearMe } = parsePlaceQuery(parsed.data.q);
    return Response.json(
      { ...result, nearMe },
      { headers: { "Cache-Control": result.status === "unavailable" ? "no-store" : "private, max-age=300" } },
    );
  } catch (err) {
    log.error("api.geocode_failed", { error: err instanceof Error ? err.message : String(err) });
    return jsonError(500, "Place search failed. Please try again.");
  }
}
