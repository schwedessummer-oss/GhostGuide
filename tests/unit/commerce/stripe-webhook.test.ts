import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { resetEnvCache } from "@/config/env";
import { StripePaymentProvider } from "@/integrations/payments/stripe";
import { WebhookSignatureError } from "@/integrations/payments/types";

const SECRET = "whsec_unit_test_secret_0123456789";

function event(type: string, object: Record<string, unknown>) {
  return JSON.stringify({ id: `evt_${type.replace(/\W/g, "_")}`, object: "event", type, created: 1_793_000_000, data: { object }, api_version: "2026-10-28.endive" });
}
const sign = (payload: string, secret = SECRET) => Stripe.webhooks.generateTestHeaderString({ payload, secret });

describe("Stripe webhook adapter", () => {
  const provider = new StripePaymentProvider();
  beforeAll(() => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    resetEnvCache();
  });
  afterAll(() => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    resetEnvCache();
  });

  it("verifies and normalizes checkout.session.completed", () => {
    const body = event("checkout.session.completed", {
      id: "cs_test_123",
      object: "checkout.session",
      client_reference_id: "11111111-1111-1111-1111-111111111111",
      metadata: { booking_id: "11111111-1111-1111-1111-111111111111" },
      amount_total: 5750,
      currency: "usd",
      payment_status: "paid",
      status: "complete",
      payment_intent: "pi_123",
      customer_details: { email: "someone@example.com" },
    });
    const e = provider.parseWebhook(body, new Headers({ "stripe-signature": sign(body) }));
    expect(e).toMatchObject({
      provider: "stripe",
      type: "checkout.completed",
      sessionId: "cs_test_123",
      bookingId: "11111111-1111-1111-1111-111111111111",
      paymentStatus: "paid",
      amountTotal: 5750,
      currency: "usd",
      paymentIntentId: "pi_123",
    });
    expect(JSON.stringify(e)).not.toContain("someone@example.com"); // no PII carried forward
  });

  it("maps async success/failure, expiry and refunds; ignores other events", () => {
    const s = { id: "cs_1", object: "checkout.session", client_reference_id: null, metadata: { booking_id: "b" }, amount_total: 100, currency: "usd", payment_status: "unpaid", payment_intent: { id: "pi_x" } };
    const parse = (type: string, obj: Record<string, unknown>) => {
      const body = event(type, obj);
      return provider.parseWebhook(body, new Headers({ "stripe-signature": sign(body) }));
    };
    expect(parse("checkout.session.async_payment_succeeded", s)).toMatchObject({ type: "checkout.async_payment_succeeded", bookingId: "b", paymentIntentId: "pi_x" });
    expect(parse("checkout.session.async_payment_failed", s).type).toBe("checkout.async_payment_failed");
    expect(parse("checkout.session.expired", s).type).toBe("checkout.expired");
    expect(parse("charge.refunded", { id: "ch_1", object: "charge", amount: 100, amount_refunded: 40, currency: "usd", payment_intent: "pi_x", metadata: {} })).toMatchObject({
      type: "charge.refunded",
      amountRefunded: 40,
      paymentIntentId: "pi_x",
    });
    expect(parse("customer.created", { id: "cus_1", object: "customer" }).type).toBe("ignored");
  });

  it("rejects missing, forged and tampered signatures", () => {
    const body = event("checkout.session.completed", { id: "cs_x", object: "checkout.session", amount_total: 100, payment_status: "paid" });
    expect(() => provider.parseWebhook(body, new Headers())).toThrow(WebhookSignatureError);
    expect(() => provider.parseWebhook(body, new Headers({ "stripe-signature": sign(body, "whsec_other_secret_000000000000") }))).toThrow(WebhookSignatureError);
    const tampered = body.replace('"amount_total":100', '"amount_total":1');
    expect(() => provider.parseWebhook(tampered, new Headers({ "stripe-signature": sign(body) }))).toThrow(WebhookSignatureError);
  });
});
