import type { NextRequest } from "next/server";
import { z } from "zod";
import { getApiUser, jsonError } from "@/server/auth";
import { parseJsonBody } from "@/server/hike/http";
import { recordDownload } from "@/server/hike/records";
import { downloadRecordSchema } from "@/server/hike/schemas";
import { toResponse } from "@/server/hike/result";

/** Record that the device downloaded and verified this trip for offline use (owner only). */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/trips/[id]/download">) {
  const user = await getApiUser();
  if (!user) return jsonError(401, "Sign in required");
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return jsonError(404, "Trip not found");
  const body = await parseJsonBody(request, downloadRecordSchema, 8_000);
  if (!body.ok) return body.response;
  return toResponse(await recordDownload(user, id, body.data), { status: 201 });
}
