"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth";
import { cancelTripByCustomer } from "@/server/commerce/cancellation";

export type CancelFormState = { error?: string } | undefined;

export async function cancelTripAction(tripId: string, _prev: CancelFormState, formData: FormData): Promise<CancelFormState> {
  if (!z.uuid().safeParse(tripId).success) return { error: "Trip not found." };
  const user = await requireUser(`/trips/${tripId}/cancel`);
  if (formData.get("acknowledge") !== "on") return { error: "Tick the box to confirm you want to cancel." };
  const result = await cancelTripByCustomer(user, tripId);
  if (!result.ok) return { error: result.error };
  redirect(`/trips/${tripId}?cancelled=1`);
}
