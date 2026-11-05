import { getApiUser, jsonError } from "@/server/auth";
import { checkRateLimit } from "@/server/rate-limit";
import { parseJsonBody } from "@/server/hike/http";
import { syncHike } from "@/server/hike/sync";
import { syncRequestSchema } from "@/server/hike/schemas";
import { toResponse } from "@/server/hike/result";

/**
 * Upload queued location points (≤ 500) and events (≤ 200) for an owned
 * hike session. Idempotent per client id; 404 for sessions that are not
 * yours; points stamped > 2 min in the future are rejected; rate limited.
 */
export async function POST(request: Request) {
  const user = await getApiUser();
  if (!user) return jsonError(401, "Sign in required");
  const rl = await checkRateLimit(`hike:sync:user:${user.id}`, 120, 60);
  if (!rl.allowed) {
    return Response.json(
      { error: "Too many sync requests" },
      { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000))) } },
    );
  }
  const body = await parseJsonBody(request, syncRequestSchema, 400_000);
  if (!body.ok) return body.response;
  return toResponse(await syncHike(user, body.data));
}
