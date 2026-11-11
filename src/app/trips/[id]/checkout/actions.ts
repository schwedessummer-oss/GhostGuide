"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth";
import { checkRateLimit } from "@/server/rate-limit";
import { createCheckout, ensureCheckoutSession, releasePendingCheckout, simulateModeSchema } from "@/server/commerce/checkout";

export type CheckoutFormState = { error?: string; newIdempotencyKey?: string } | undefined;

const formSchema = z.object({
  tripId: z.uuid(),
  hikeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a valid date."),
  partySize: z.coerce.number().int().min(1, "At least 1 hiker.").max(12, "At most 12 hikers."),
  addonCodes: z.array(z.string().regex(/^[a-z0-9-]{1,60}$/)).max(10),
  shuttlePickup: z.string().regex(/^[a-z0-9-]{1,60}$/).optional(),
  idempotencyKey: z.uuid(),
});

/** Validate the form, then hand off to the createCheckout use-case (which re-validates and prices server-side). */
export async function startCheckoutAction(tripId: string, _prev: CheckoutFormState, formData: FormData): Promise<CheckoutFormState> {
  if (!z.uuid().safeParse(tripId).success) return { error: "Trip not found." };
  const user = await requireUser(`/trips/${tripId}/checkout`);
  const parsed = formSchema.safeParse({
    tripId,
    hikeDate: formData.get("hikeDate"),
    partySize: formData.get("partySize"),
    addonCodes: formData.getAll("addon").map(String),
    shuttlePickup: formData.get("shuttlePickup") || undefined,
    idempotencyKey: formData.get("idempotencyKey"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the booking details." };

  // Demo-only failure injection (ignored by the use-case outside demo mode).
  const simulate: Record<string, "fail" | "fail_once" | "reject"> = {};
  for (const code of parsed.data.addonCodes) {
    const v = simulateModeSchema.safeParse(formData.get(`simulate_${code}`));
    if (v.success) simulate[code] = v.data;
  }

  const limit = await checkRateLimit(`checkout:user:${user.id}`, 30, 600);
  if (!limit.allowed) return { error: "Too many checkout attempts. Please wait a few minutes and try again." };

  const result = await createCheckout(user, { ...parsed.data, simulate });
  // A different checkout is already holding spots: show what is held, with continue / release.
  if (!result.ok && result.code === "in_progress") redirect(`/trips/${tripId}/checkout?changed=1`);
  if (!result.ok) return { error: result.error, newIdempotencyKey: result.renewKey ? randomUUID() : undefined };
  redirect(result.url);
}

/** Continue paying for a pending booking (re-opens the provider session). */
export async function resumeCheckoutAction(tripId: string, bookingId: string): Promise<void> {
  if (!z.uuid().safeParse(tripId).success) redirect("/trips");
  const user = await requireUser(`/trips/${tripId}/checkout`);
  if (!z.uuid().safeParse(bookingId).success) redirect(`/trips/${tripId}`);
  const url = await ensureCheckoutSession(user, bookingId).catch(() => null);
  redirect(url ?? `/trips/${tripId}`);
}

export type ReleaseFormState = { error?: string } | undefined;

/**
 * Release the held (unpaid) checkout so the details can be changed. The
 * use-case closes the provider session first, then frees the spots; on
 * success the customer returns to the form pre-filled with what was held.
 */
export async function releaseCheckoutAction(tripId: string, bookingId: string, _prev: ReleaseFormState, _formData: FormData): Promise<ReleaseFormState> {
  void _formData;
  if (!z.uuid().safeParse(tripId).success || !z.uuid().safeParse(bookingId).success) return { error: "Checkout not found." };
  const user = await requireUser(`/trips/${tripId}/checkout`);
  const limit = await checkRateLimit(`checkout-release:user:${user.id}`, 20, 600);
  if (!limit.allowed) return { error: "Too many attempts. Please wait a few minutes and try again." };
  const result = await releasePendingCheckout(user, tripId, bookingId);
  if (!result.ok) return { error: result.error };
  if (result.outcome === "paid") redirect(`/checkout/success?booking=${result.bookingId}`);
  const qs = new URLSearchParams({ date: result.held.hikeDate, party: String(result.held.partySize), released: "1" });
  if (result.held.addonCodes.length) qs.set("addons", result.held.addonCodes.join(","));
  if (result.held.shuttlePickup) qs.set("pickup", result.held.shuttlePickup);
  redirect(`/trips/${tripId}/checkout?${qs.toString()}`);
}
