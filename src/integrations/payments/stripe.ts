import "server-only";
import Stripe from "stripe";
import { env } from "@/config/env";
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
 * Stripe Checkout adapter (stripe-node v23, API 2026-10-28.endive).
 *
 *  - Checkout Sessions in `payment` mode with inline price_data line items.
 *  - client_reference_id + metadata.booking_id tie the session to our booking.
 *  - expires_at = the inventory hold expiry when it is at least 30 minutes
 *    away (Stripe's minimum); otherwise Stripe's default applies and our
 *    hold-expiry job expires the session explicitly.
 *  - Every mutating call carries an idempotency key.
 *  - Webhooks are verified with stripe.webhooks.constructEvent over the RAW
 *    body and STRIPE_WEBHOOK_SECRET.
 */
const STRIPE_MIN_EXPIRY_MS = 30 * 60_000;

let client: Stripe | null = null;
function stripe(): Stripe {
  if (client) return client;
  const key = env().STRIPE_SECRET_KEY;
  if (!key) throw new PaymentProviderError("STRIPE_SECRET_KEY is not configured");
  client = new Stripe(key, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: "Ghost Guide" } });
  return client;
}

const idOf = (v: string | { id: string } | null | undefined): string | null => (v == null ? null : typeof v === "string" ? v : v.id);

function normalizeStatus(s: string | null): ProviderSession["status"] {
  return s === "complete" ? "complete" : s === "expired" ? "expired" : "open";
}
function normalizePaymentStatus(s: string | null | undefined): ProviderSession["paymentStatus"] {
  return s === "paid" ? "paid" : s === "no_payment_required" ? "no_payment_required" : "unpaid";
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  readonly simulated = false;

  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionRef> {
    const sum = input.lineItems.reduce((s, l) => s + l.amountCents, 0);
    if (sum !== input.totalCents) throw new PaymentProviderError("Line items do not add up to the total");
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      line_items: input.lineItems.map((li) => ({
        quantity: 1,
        price_data: { currency: input.currency, unit_amount: li.amountCents, product_data: { name: li.label.slice(0, 250) } },
      })),
      client_reference_id: input.bookingId,
      metadata: { booking_id: input.bookingId },
      payment_intent_data: { metadata: { booking_id: input.bookingId } },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    };
    if (input.expiresAt) {
      const untilHold = input.expiresAt.getTime() - Date.now();
      if (untilHold >= STRIPE_MIN_EXPIRY_MS) {
        params.expires_at = Math.floor(input.expiresAt.getTime() / 1000);
      } else if (untilHold >= STRIPE_MIN_EXPIRY_MS - 5 * 60_000) {
        // A 30-minute hold is a few seconds short of Stripe's minimum by the time
        // we get here: clamp to the minimum. A payment in that small gap takes
        // the late-payment path (capacity re-checked, refunded if gone).
        params.expires_at = Math.ceil((Date.now() + STRIPE_MIN_EXPIRY_MS + 15_000) / 1000);
      }
      // Much shorter holds: omit; the hold-expiry job expires the session explicitly.
    }
    const session = await stripe().checkout.sessions.create(params, { idempotencyKey: input.idempotencyKey });
    if (!session.url) throw new PaymentProviderError("Stripe did not return a checkout URL");
    return { sessionId: session.id, url: session.url };
  }

  parseWebhook(rawBody: string, headers: Headers): NormalizedPaymentEvent {
    const secret = env().STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new WebhookSignatureError("STRIPE_WEBHOOK_SECRET is not configured");
    const signature = headers.get("stripe-signature");
    if (!signature) throw new WebhookSignatureError("Missing Stripe-Signature header");
    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch {
      throw new WebhookSignatureError("Stripe signature verification failed");
    }
    return normalizeStripeEvent(event);
  }

  async getSession(sessionId: string): Promise<ProviderSession | null> {
    try {
      const s = await stripe().checkout.sessions.retrieve(sessionId);
      return {
        sessionId: s.id,
        status: normalizeStatus(s.status),
        paymentStatus: normalizePaymentStatus(s.payment_status),
        amountTotal: s.amount_total,
        currency: s.currency,
        paymentIntentId: idOf(s.payment_intent),
        bookingId: s.client_reference_id ?? s.metadata?.booking_id ?? null,
        url: s.status === "open" ? s.url : null,
      };
    } catch (err) {
      if (err instanceof Stripe.errors.StripeInvalidRequestError && err.statusCode === 404) return null;
      throw err;
    }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const r = await stripe().refunds.create(
      { payment_intent: input.paymentIntentId, amount: input.amountCents, reason: "requested_by_customer" },
      { idempotencyKey: input.idempotencyKey },
    );
    const status = r.status === "succeeded" ? "succeeded" : r.status === "failed" || r.status === "canceled" ? "failed" : "pending";
    return { refundId: r.id, status };
  }

  async expireSession(sessionId: string): Promise<void> {
    try {
      await stripe().checkout.sessions.expire(sessionId);
    } catch (err) {
      // Already complete/expired sessions cannot be expired; that is fine.
      if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) throw err;
    }
  }
}

export function normalizeStripeEvent(event: Stripe.Event): NormalizedPaymentEvent {
  const base = {
    provider: "stripe" as const,
    eventId: event.id,
    rawType: event.type,
    occurredAt: new Date(event.created * 1000),
    sessionId: null as string | null,
    bookingId: null as string | null,
    paymentStatus: null as NormalizedPaymentEvent["paymentStatus"],
    amountTotal: null as number | null,
    currency: null as string | null,
    paymentIntentId: null as string | null,
  };
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired": {
      const s = event.data.object;
      const fields = {
        ...base,
        sessionId: s.id,
        bookingId: s.client_reference_id ?? s.metadata?.booking_id ?? null,
        paymentStatus: normalizePaymentStatus(s.payment_status),
        amountTotal: s.amount_total,
        currency: s.currency,
        paymentIntentId: idOf(s.payment_intent),
      };
      const type =
        event.type === "checkout.session.completed"
          ? "checkout.completed"
          : event.type === "checkout.session.async_payment_succeeded"
            ? "checkout.async_payment_succeeded"
            : event.type === "checkout.session.async_payment_failed"
              ? "checkout.async_payment_failed"
              : "checkout.expired";
      return { ...fields, type };
    }
    case "charge.refunded": {
      const c = event.data.object;
      return {
        ...base,
        type: "charge.refunded",
        paymentIntentId: idOf(c.payment_intent),
        amountTotal: c.amount,
        currency: c.currency,
        amountRefunded: c.amount_refunded,
        bookingId: c.metadata?.booking_id ?? null,
      };
    }
    default:
      return { ...base, type: "ignored" };
  }
}
