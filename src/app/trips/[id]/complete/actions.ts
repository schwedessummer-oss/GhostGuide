"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/server/auth";
import { submitFeedback } from "@/server/hike/records";
import { feedbackSchema } from "@/server/hike/schemas";

export type FeedbackFormState = { ok?: boolean; error?: string } | undefined;

export async function submitFeedbackAction(tripId: string, _prev: FeedbackFormState, formData: FormData): Promise<FeedbackFormState> {
  const user = await requireUser(`/trips/${tripId}/complete`);
  if (!z.uuid().safeParse(tripId).success) return { error: "Trip not found." };
  const parsed = feedbackSchema.safeParse({
    rating: formData.get("rating"),
    comments: formData.get("comments") ?? undefined,
    issues: formData.getAll("issues"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues.some((i) => i.path[0] === "rating") ? "Choose a rating from 1 to 5 stars." : "Please check your answers." };
  }
  const r = await submitFeedback(user, tripId, parsed.data);
  if (!r.ok) return { error: r.error };
  revalidatePath(`/trips/${tripId}/complete`);
  return { ok: true };
}
