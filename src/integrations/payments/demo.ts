import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { assertSimulationAllowed, env } from "@/config/env";
import { withSystem, type JsonValue, type Tx } from "@/server/db";
import { DEMO_SIGNATURE_HEADER, signDemoWebhook, verifyDemoSignature } from "./demo-signature";
import {
  PaymentProviderError,
  WebhookSignatureError,
  type CheckoutSessionRef,
  type CreateCheckoutSessionInput,
  type NormalizedPaymentEvent,
  type PaymentProvider,
  type ProviderSession,
  type RefundInput,
  type RefundResult,
} from "./types";

/**
 * SIMULATED payment provider for demo mode. No money moves. Sessions live in
 * public.demo_checkout_sessions; the simulated payment page
 * (/checkout/demo/[sessionId]) builds Stripe-shaped events, signs them with
 * HMAC-SHA256(AUTH_SECRET) and POSTs them to /api/webhooks/demo-payments,
 * which runs the exact same processor as the Stripe webhook.
 *
 * Every entry point calls assertSimulationAllowed("payments"), so a live
 * deployment can never "take" a simulated payment.
 */
export interface DemoSessionRow {
  id: string;
  bookingId: string;
  userId: string;
  amountTotal: number;
  currency: string;
  lineItems: { label: string; amountCents: number }[];
  successUrl: string;
  cancelUrl: string;
  status: "open" | "complete" | "expired";
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  paymentIntentId: string | null;
  expiresAt: Date | null;
  lastEventBody: string | null;
  createdAt: Date;
}

const SESSION_COLUMNS = (tx: Tx) => tx`
  id, booking_id, user_id, amount_total, currency, line_items, success_url, cancel_url, status,
  payment_status, payment_intent_id, expires_at, last_event_body, created_at`;

export const DEMO_SESSION_ID = /^demo_cs_[0-9a-f-]{36}$/;

/** Stripe-shaped event the simulated provider emits. */
const demoEventSchema = z.object({
  id: z.string().regex(/^demo_evt_[0-9a-f-]{36}$/),
  object: z.literal("event"),
  type: z.string().min(1).max(100),
  created: z.number().int().positive(),
  data: z.object({
    object: z.object({
      id: z.string().min(1).max(200),
      object: z.enum(["checkout.session", "charge"]),
      client_reference_id: z.string().nullish(),
      metadata: z.record(z.string(), z.string()).nullish(),
      amount_total: z.number().int().nullish(),
      amount_refunded: z.number().int().nullish(),
      currency: z.string().nullish(),
      payment_status: z.enum(["paid", "unpaid", "no_payment_required"]).nullish(),
      status: z.string().nullish(),
      payment_intent: z.string().nullish(),
    }),
  }),
});
export type DemoEvent = z.infer<typeof demoEventSchema>;

export class DemoPaymentProvider implements PaymentProvider {
  readonly name = "demo" as const;
  readonly simulated = true;

  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionRef> {
    assertSimulationAllowed("payments");
    const sum = input.lineItems.reduce((s, l) => s + l.amountCents, 0);
    if (sum !== input.totalCents) throw new PaymentProviderError("Line items do not add up to the total");
    const id = `demo_cs_${randomUUID()}`;
    const row = await withSystem(async (tx) => {
      await tx`
        insert into public.demo_checkout_sessions
          (id, booking_id, user_id, amount_total, currency, line_items, success_url, cancel_url, idempotency_key, expires_at)
        values (${id}, ${input.bookingId}, ${input.userId}, ${input.totalCents}, ${input.currency},
                ${tx.json(input.lineItems as unknown as JsonValue)}, ${input.successUrl}, ${input.cancelUrl},
                ${input.idempotencyKey}, ${input.expiresAt ?? null}::timestamptz)
        on conflict (idempotency_key) do nothing`;
      const [r] = await tx<{ id: string; bookingId: string }[]>`
        select id, booking_id from public.demo_checkout_sessions where idempotency_key = ${input.idempotencyKey}`;
      return r;
    });
    if (row.bookingId !== input.bookingId) throw new PaymentProviderError("Idempotency key reused for a different booking");
    return { sessionId: row.id, url: `/checkout/demo/${row.id}` };
  }

  parseWebhook(rawBody: string, headers: Headers): NormalizedPaymentEvent {
    assertSimulationAllowed("payments");
    const check = verifyDemoSignature(env().AUTH_SECRET, rawBody, headers.get(DEMO_SIGNATURE_HEADER));
    if (!check.ok) throw new WebhookSignatureError(`Demo webhook signature ${check.reason}`);
    let parsed: DemoEvent;
    try {
      parsed = demoEventSchema.parse(JSON.parse(rawBody));
    } catch {
      throw new WebhookSignatureError("Malformed demo webhook body");
    }
    return normalizeDemoEvent(parsed);
  }

  async getSession(sessionId: string): Promise<ProviderSession | null> {
    assertSimulationAllowed("payments");
    const row = await getDemoSession(sessionId);
    if (!row) return null;
    return {
      sessionId: row.id,
      status: row.status,
      paymentStatus: row.paymentStatus,
      amountTotal: row.amountTotal,
      currency: row.currency,
      paymentIntentId: row.paymentIntentId,
      bookingId: row.bookingId,
      url: row.status === "open" ? `/checkout/demo/${row.id}` : null,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    assertSimulationAllowed("payments");
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new PaymentProviderError("Refund amount must be positive");
    const [session] = await withSystem(
      (tx) => tx<{ amountTotal: number }[]>`
        select amount_total from public.demo_checkout_sessions where payment_intent_id = ${input.paymentIntentId} and payment_status = 'paid'`,
    );
    if (!session) throw new PaymentProviderError("No such simulated payment");
    if (input.amountCents > session.amountTotal) throw new PaymentProviderError("Refund exceeds the simulated payment");
    // Deterministic per idempotency key, like a real provider replaying the original response.
    const refundId = `demo_re_${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 24)}`;
    return { refundId, status: "succeeded" };
  }

  async expireSession(sessionId: string): Promise<void> {
    assertSimulationAllowed("payments");
    await withSystem((tx) => tx`update public.demo_checkout_sessions set status = 'expired' where id = ${sessionId} and status = 'open'`);
  }
}

export function normalizeDemoEvent(e: DemoEvent): NormalizedPaymentEvent {
  const o = e.data.object;
  const base = {
    provider: "demo" as const,
    eventId: e.id,
    rawType: e.type,
    occurredAt: new Date(e.created * 1000),
    sessionId: o.object === "checkout.session" ? o.id : null,
    bookingId: o.client_reference_id ?? o.metadata?.booking_id ?? null,
    paymentStatus: o.payment_status ?? null,
    amountTotal: o.amount_total ?? null,
    currency: o.currency ?? null,
    paymentIntentId: o.payment_intent ?? null,
  };
  switch (e.type) {
    case "checkout.session.completed":
      return { ...base, type: "checkout.completed" };
    case "checkout.session.async_payment_succeeded":
      return { ...base, type: "checkout.async_payment_succeeded" };
    case "checkout.session.async_payment_failed":
      return { ...base, type: "checkout.async_payment_failed" };
    case "checkout.session.expired":
      return { ...base, type: "checkout.expired" };
    case "charge.refunded":
      return { ...base, type: "charge.refunded", amountRefunded: o.amount_refunded ?? null };
    default:
      return { ...base, type: "ignored" };
  }
}

// ---------------------------------------------------------------------------
// Demo-only helpers used by the simulated payment page and tests
// ---------------------------------------------------------------------------

export async function getDemoSession(sessionId: string): Promise<DemoSessionRow | null> {
  if (!DEMO_SESSION_ID.test(sessionId)) return null;
  const [row] = await withSystem(
    (tx) => tx<DemoSessionRow[]>`select ${SESSION_COLUMNS(tx)} from public.demo_checkout_sessions where id = ${sessionId}`,
  );
  return row ?? null;
}

export type DemoOutcome = "paid" | "declined" | "cancelled";

/** Build a signed-ready event body for a session outcome (no PII inside). */
export function buildDemoEventBody(
  session: Pick<DemoSessionRow, "id" | "bookingId" | "amountTotal" | "currency">,
  type: string,
  fields: { paymentStatus: "paid" | "unpaid"; status: "open" | "complete" | "expired"; paymentIntentId: string | null; amountTotal?: number },
  now = new Date(),
): string {
  const event: DemoEvent = {
    id: `demo_evt_${randomUUID()}`,
    object: "event",
    type,
    created: Math.floor(now.getTime() / 1000),
    data: {
      object: {
        id: session.id,
        object: "checkout.session",
        client_reference_id: session.bookingId,
        metadata: { booking_id: session.bookingId },
        amount_total: fields.amountTotal ?? session.amountTotal,
        currency: session.currency,
        payment_status: fields.paymentStatus,
        status: fields.status,
        payment_intent: fields.paymentIntentId,
      },
    },
  };
  return JSON.stringify(event);
}

/**
 * Settle a simulated session (paid / declined / cancelled) and return the
 * event body the "provider" will deliver. Idempotent: a settled session
 * returns null (use redelivery for duplicates).
 */
export async function settleDemoSession(
  sessionId: string,
  outcome: DemoOutcome,
  opts: { amountTotalOverride?: number } = {},
): Promise<{ body: string; session: DemoSessionRow } | null> {
  assertSimulationAllowed("payments");
  return withSystem(async (tx) => {
    const [s] = await tx<DemoSessionRow[]>`
      select ${SESSION_COLUMNS(tx)} from public.demo_checkout_sessions where id = ${sessionId} for update`;
    if (!s || s.status !== "open") return null;
    let body: string;
    if (outcome === "paid") {
      const pi = `demo_pi_${randomUUID()}`;
      const amount = opts.amountTotalOverride ?? s.amountTotal;
      await tx`update public.demo_checkout_sessions set status = 'complete', payment_status = 'paid', payment_intent_id = ${pi},
               amount_total = ${amount} where id = ${s.id}`;
      body = buildDemoEventBody(s, "checkout.session.completed", { paymentStatus: "paid", status: "complete", paymentIntentId: pi, amountTotal: amount });
    } else if (outcome === "declined") {
      await tx`update public.demo_checkout_sessions set status = 'expired' where id = ${s.id}`;
      body = buildDemoEventBody(s, "checkout.session.async_payment_failed", { paymentStatus: "unpaid", status: "expired", paymentIntentId: null });
    } else {
      await tx`update public.demo_checkout_sessions set status = 'expired' where id = ${s.id}`;
      body = buildDemoEventBody(s, "checkout.session.expired", { paymentStatus: "unpaid", status: "expired", paymentIntentId: null });
    }
    await tx`update public.demo_checkout_sessions set last_event_body = ${body} where id = ${s.id}`;
    const [updated] = await tx<DemoSessionRow[]>`select ${SESSION_COLUMNS(tx)} from public.demo_checkout_sessions where id = ${s.id}`;
    return { body, session: updated };
  });
}

/** Headers for delivering a demo event (fresh timestamp each delivery). */
export function demoWebhookHeaders(rawBody: string, nowSec?: number): Record<string, string> {
  assertSimulationAllowed("payments");
  return { "content-type": "application/json", [DEMO_SIGNATURE_HEADER]: signDemoWebhook(env().AUTH_SECRET, rawBody, nowSec) };
}
