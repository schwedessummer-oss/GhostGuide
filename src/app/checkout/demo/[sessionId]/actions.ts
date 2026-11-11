"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth";
import { checkRateLimit } from "@/server/rate-limit";
import { redeliverLastDemoEvent, simulateDemoPayment } from "@/server/commerce/demo-checkout";

export type DemoActionState = { error?: string; message?: string } | undefined;

const sessionSchema = z.string().regex(/^demo_cs_[0-9a-f-]{36}$/);
const outcomeSchema = z.enum(["paid", "declined", "cancelled"]);

export async function simulatePaymentAction(sessionId: string, _prev: DemoActionState, formData: FormData): Promise<DemoActionState> {
  const user = await requireUser(`/checkout/demo/${sessionId}`);
  const s = sessionSchema.safeParse(sessionId);
  const o = outcomeSchema.safeParse(formData.get("outcome"));
  if (!s.success || !o.success) return { error: "Invalid request." };
  const limit = await checkRateLimit(`demo-pay:user:${user.id}`, 30, 600);
  if (!limit.allowed) return { error: "Too many attempts. Please wait a few minutes." };
  const result = await simulateDemoPayment(user, s.data, o.data);
  if (!result.ok) return { error: result.error };
  redirect(result.redirectTo);
}

export async function redeliverWebhookAction(sessionId: string, _prev: DemoActionState, _formData: FormData): Promise<DemoActionState> {
  void _formData;
  const user = await requireUser(`/checkout/demo/${sessionId}`);
  const s = sessionSchema.safeParse(sessionId);
  if (!s.success) return { error: "Invalid request." };
  const limit = await checkRateLimit(`demo-redeliver:user:${user.id}`, 20, 600);
  if (!limit.allowed) return { error: "Too many attempts. Please wait a few minutes." };
  const result = await redeliverLastDemoEvent(user, s.data);
  if (!result.ok) return { error: result.error };
  const d = result.delivery;
  // d.outcome is one of a fixed set of processor outcomes (never response text).
  const what =
    d.outcome === "duplicate"
      ? "recognized as a duplicate and ignored — no second payment, confirmation or fulfillment was created"
      : d.outcome === "rejected" || d.outcome === "failed"
        ? "not processed (the webhook processor reported an error)"
        : `processed with outcome "${d.outcome.replace(/_/g, " ")}"`;
  return { message: `Re-delivered event ${result.eventId} to the webhook processor (status ${d.status}). It was ${what}.` };
}
