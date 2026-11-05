"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth";
import { checkRateLimit } from "@/server/rate-limit";
import { confirmShuttleQuote, requestNewShuttleQuote } from "@/server/fulfillment/shuttle";
import { DEMO_PICKUP_POINTS } from "@/integrations/partners/shuttle/pickup-points";

export type ShuttleFormState = { error?: string; message?: string } | undefined;

const ids = z.object({ tripId: z.uuid(), fulfillmentId: z.uuid() });

export async function confirmShuttleAction(tripId: string, fulfillmentId: string, _prev: ShuttleFormState, formData: FormData): Promise<ShuttleFormState> {
  if (!ids.safeParse({ tripId, fulfillmentId }).success) return { error: "Shuttle request not found." };
  const user = await requireUser(`/trips/${tripId}/shuttle/${fulfillmentId}`);
  if (formData.get("confirmPickup") !== "on") {
    return { error: "Tick the box to confirm the pickup location, pickup time and price." };
  }
  // confirmShuttleQuote re-validates everything with zod and checks ownership.
  const result = await confirmShuttleQuote(user, {
    tripId,
    fulfillmentId,
    confirmPickup: true,
    quotedPriceCents: Number(formData.get("quotedPriceCents")),
    pickupAt: String(formData.get("pickupAt") ?? ""),
  });
  if (!result.ok) return { error: result.error };
  redirect(`/trips/${tripId}?shuttle=confirmed`);
}

const pickupSchema = z.enum(DEMO_PICKUP_POINTS.map((p) => p.key) as [string, ...string[]]);

export async function requoteShuttleAction(tripId: string, fulfillmentId: string, _prev: ShuttleFormState, formData: FormData): Promise<ShuttleFormState> {
  if (!ids.safeParse({ tripId, fulfillmentId }).success) return { error: "Shuttle request not found." };
  const user = await requireUser(`/trips/${tripId}/shuttle/${fulfillmentId}`);
  const pickup = pickupSchema.safeParse(formData.get("pickup"));
  if (!pickup.success) return { error: "Choose a pickup point." };
  const limit = await checkRateLimit(`shuttle-quote:user:${user.id}`, 10, 600);
  if (!limit.allowed) return { error: "Too many quote requests. Please wait a few minutes." };
  const result = await requestNewShuttleQuote(user, tripId, fulfillmentId, pickup.data);
  return result.ok ? { message: result.message } : { error: result.error };
}
