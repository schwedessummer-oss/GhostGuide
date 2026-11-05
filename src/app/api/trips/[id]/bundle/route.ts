import type { NextRequest } from "next/server";
import { z } from "zod";
import { getApiUser, jsonError } from "@/server/auth";
import { getTripBundle } from "@/server/hike/bundle";
import { toResponse } from "@/server/hike/result";

export const dynamic = "force-dynamic";

/**
 * Offline trip bundle (owner only): trip, itinerary, trail facts and
 * provenance, checksummed route geometry, POIs, APPROVED narration, region
 * emergency info, expected return and the download manifest.
 * 401 signed out · 404 not yours / unknown · 409 not booked/active/completed.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/trips/[id]/bundle">) {
  const user = await getApiUser();
  if (!user) return jsonError(401, "Sign in required");
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return jsonError(404, "Trip not found");
  return toResponse(await getTripBundle(user, id));
}
