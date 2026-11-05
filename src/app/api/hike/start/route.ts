import { getApiUser, jsonError } from "@/server/auth";
import { checkRateLimit } from "@/server/rate-limit";
import { parseJsonBody } from "@/server/hike/http";
import { startHike } from "@/server/hike/sessions";
import { startRequestSchema } from "@/server/hike/schemas";
import { toResponse } from "@/server/hike/result";

/** Start (or resume) the hike for an owned, booked/active trip. Idempotent. */
export async function POST(request: Request) {
  const user = await getApiUser();
  if (!user) return jsonError(401, "Sign in required");
  const body = await parseJsonBody(request, startRequestSchema, 4_000);
  if (!body.ok) return body.response;
  const rl = await checkRateLimit(`hike:start:user:${user.id}`, 30, 60);
  if (!rl.allowed) return jsonError(429, "Too many requests — try again in a minute");
  return toResponse(await startHike(user, body.data));
}
