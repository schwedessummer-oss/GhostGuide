import type { NextRequest } from "next/server";
import { z } from "zod";
import { getApiUser, jsonError, setOwnerHintCookie } from "@/server/auth";
import { getTripBundle } from "@/server/hike/bundle";
import { toResponse } from "@/server/hike/result";

export const dynamic = "force-dynamic";

/**
 * Offline trip bundle (owner only): trip, itinerary, trail facts and
 * provenance, checksummed route geometry, POIs, APPROVED narration, region
 * emergency info, expected return, the download manifest and the owner tag.
 * 401 signed out · 404 not yours / unknown · 409 not booked/active/completed.
 *
 * Also (re)sets the readable `gg_owner` device tag for the signed-in user, so
 * sessions that were not created through the sign-in form get it too: the
 * offline screens compare it with the bundle's `ownerHint` and refuse to show
 * another account's downloaded data on a shared device.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/trips/[id]/bundle">) {
  const user = await getApiUser();
  if (!user) return jsonError(401, "Sign in required");
  await setOwnerHintCookie(user.id);
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return jsonError(404, "Trip not found");
  return toResponse(await getTripBundle(user, id));
}
