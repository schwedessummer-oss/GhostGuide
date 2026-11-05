import { getApiUser, jsonError } from "@/server/auth";
import { checkRateLimit } from "@/server/rate-limit";
import { parseJsonBody } from "@/server/hike/http";
import { finishHike } from "@/server/hike/sessions";
import { finishRequestSchema } from "@/server/hike/schemas";
import { toResponse } from "@/server/hike/result";

/** Finish the hike: session finished, trip completed, check-in reminders stopped. Idempotent. */
export async function POST(request: Request) {
  const user = await getApiUser();
  if (!user) return jsonError(401, "Sign in required");
  const body = await parseJsonBody(request, finishRequestSchema, 4_000);
  if (!body.ok) return body.response;
  const rl = await checkRateLimit(`hike:finish:user:${user.id}`, 30, 60);
  if (!rl.allowed) return jsonError(429, "Too many requests — try again in a minute");
  return toResponse(await finishHike(user, body.data));
}
