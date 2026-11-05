"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/server/auth";
import { updatePermitStatus } from "@/server/hike/records";
import { permitUpdateSchema } from "@/server/hike/schemas";

export type PermitFormState = { ok?: boolean; error?: string; message?: string } | undefined;

/** Customer updates their own permit-tracking status (Ghost Guide never applies for permits). */
export async function updatePermitAction(tripId: string, _prev: PermitFormState, formData: FormData): Promise<PermitFormState> {
  const user = await requireUser(`/trips/${tripId}/prepare`);
  if (!z.uuid().safeParse(tripId).success) return { error: "Trip not found." };
  const parsed = permitUpdateSchema.safeParse({
    permitRequirementId: formData.get("permitRequirementId"),
    status: formData.get("status"),
    confirmationRef: formData.get("confirmationRef") ?? undefined,
  });
  if (!parsed.success) return { error: "Choose a valid status." };
  const r = await updatePermitStatus(user, tripId, parsed.data);
  if (!r.ok) return { error: r.error };
  revalidatePath(`/trips/${tripId}/prepare`);
  return { ok: true, message: "Permit status saved." };
}
