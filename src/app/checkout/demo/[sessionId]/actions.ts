"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { env } from "@/config/env";
import { requireUser } from "@/server/auth";
import { checkRateLimit } from "@/server/rate-limit";
import { redeliverLastDemoEvent, simulateDemoPayment } from "@/server/commerce/demo-checkout";

export type DemoActionState = { error?: string; message?: string } | undefined;

const sessionSchema = z.string().regex(/^demo_cs_[0-9a-f-]{36}$/);
const outcomeSchema = z.enum(["paid", "declined", "cancelled"]);

/**
 * Origin used to POST the simulated webhook to ourselves, like a provider
 * would. Only this app's configured host or a loopback host is used;
 * anything else falls back to in-process delivery (still signature-checked).
 */
async function selfOrigin(): Promise<string | null> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return null;
  const configured = new URL(env().NEXT_PUBLIC_APP_URL);
  const hostname = host.split(":")[0];
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  if (!loopback && host !== configured.host) return null;
  const proto = h.get("x-forwarded-proto") ?? (loopback ? "http" : configured.protocol.replace(":", ""));
  return `${proto}://${host}`;
}

export async function simulatePaymentAction(sessionId: string, _prev: DemoActionState, formData: FormData): Promise<DemoActionState> {
  const user = await requireUser(`/checkout/demo/${sessionId}`);
  const s = sessionSchema.safeParse(sessionId);
  const o = outcomeSchema.safeParse(formData.get("outcome"));
  if (!s.success || !o.success) return { error: "Invalid request." };
  const limit = await checkRateLimit(`demo-pay:user:${user.id}`, 30, 600);
  if (!limit.allowed) return { error: "Too many attempts. Please wait a few minutes." };
  const result = await simulateDemoPayment(user, s.data, o.data, await selfOrigin());
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
  const result = await redeliverLastDemoEvent(user, s.data, await selfOrigin());
  if (!result.ok) return { error: result.error };
  const d = result.delivery;
  const what =
    d.outcome === "duplicate"
      ? "recognized as a duplicate and ignored — no second payment, confirmation or fulfillment was created"
      : `processed with outcome "${d.outcome}"`;
  return { message: `Re-delivered event ${result.eventId} (HTTP ${d.status}, ${d.via}). It was ${what}.` };
}
