import "server-only";
import { withUser } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { getOwnedTrip } from "@/server/trips/queries";
import type { DownloadRecordInput, FeedbackInput } from "./schemas";
import { permitUpdateSchema } from "./schemas";
import type { z } from "zod";
import { conflict, notFound, ok, type HikeResult } from "./result";

/**
 * Customer-written records owned by the hike slice: offline-download
 * receipts, trip feedback and permit-status tracking. All written as the
 * user (RLS), after an explicit trip-ownership check (404 otherwise).
 */

export async function recordDownload(
  user: SessionUser,
  tripId: string,
  input: DownloadRecordInput,
): Promise<HikeResult<{ id: string; createdAt: string }>> {
  const trip = await getOwnedTrip(user, tripId);
  if (!trip) return notFound("Trip not found");
  if (trip.status !== "booked" && trip.status !== "active" && trip.status !== "completed") {
    return conflict("Only booked trips can be downloaded.");
  }
  const [row] = await withUser(
    user,
    (tx) => tx<{ id: string; createdAt: Date }[]>`
      insert into public.trip_downloads (trip_id, user_id, manifest_version, manifest_checksum, item_count, verified_complete)
      values (${trip.id}, ${user.id}, ${input.manifestVersion}, ${input.manifestChecksum}, ${input.itemCount}, ${input.verifiedComplete})
      returning id, created_at`,
  );
  return ok({ id: row.id, createdAt: row.createdAt.toISOString() });
}

export async function submitFeedback(user: SessionUser, tripId: string, input: FeedbackInput): Promise<HikeResult<{ id: string }>> {
  const trip = await getOwnedTrip(user, tripId);
  if (!trip) return notFound("Trip not found");
  if (trip.status !== "completed") return conflict("You can leave feedback once your hike is finished.");
  const [row] = await withUser(
    user,
    (tx) => tx<{ id: string }[]>`
      insert into public.trip_feedback (trip_id, user_id, rating, comments, issues)
      values (${trip.id}, ${user.id}, ${input.rating}, ${input.comments}, ${input.issues}::text[])
      on conflict (trip_id) do update set rating = excluded.rating, comments = excluded.comments, issues = excluded.issues
      returning id`,
  );
  return ok({ id: row.id });
}

export type PermitUpdateInput = z.infer<typeof permitUpdateSchema>;

/** Customers track their own permit status; Ghost Guide never applies for permits on their behalf. */
export async function updatePermitStatus(user: SessionUser, tripId: string, input: PermitUpdateInput): Promise<HikeResult<{ status: string }>> {
  const trip = await getOwnedTrip(user, tripId);
  if (!trip) return notFound("Trip not found");
  return withUser(user, async (tx) => {
    const [req] = await tx<{ id: string }[]>`
      select id from public.permit_requirements where id = ${input.permitRequirementId} and trail_id = ${trip.trailId}`;
    if (!req) return notFound<{ status: string }>("Permit requirement not found");
    await tx`
      insert into public.trip_permits (trip_id, permit_requirement_id, status, confirmation_ref)
      values (${trip.id}, ${req.id}, ${input.status}, ${input.confirmationRef})
      on conflict (trip_id, permit_requirement_id) do update set status = excluded.status, confirmation_ref = excluded.confirmation_ref`;
    return ok({ status: input.status });
  });
}
