/**
 * Provider-agnostic payment interfaces. Business logic (src/server/commerce)
 * only ever sees these types; provider SDKs stay inside src/integrations/payments.
 */
export type PaymentProviderName = "stripe" | "demo";

export interface CheckoutLineItem {
  label: string;
  amountCents: number;
}

export interface CreateCheckoutSessionInput {
  bookingId: string;
  /** owner of the booking (used by the demo provider for access checks) */
  userId: string;
  lineItems: CheckoutLineItem[];
  totalCents: number;
  currency: string;
  customerEmail: string | null;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
  /** when the inventory hold ends; providers may expire the session then */
  expiresAt?: Date;
}

export interface CheckoutSessionRef {
  sessionId: string;
  url: string;
}

export interface ProviderSession {
  sessionId: string;
  status: "open" | "complete" | "expired";
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  amountTotal: number | null;
  currency: string | null;
  paymentIntentId: string | null;
  bookingId: string | null;
  /** where the customer can (still) pay; null when the session is closed */
  url: string | null;
}

export type NormalizedEventType =
  | "checkout.completed" // checkout finished; check paymentStatus (async methods may still be unpaid)
  | "checkout.async_payment_succeeded"
  | "checkout.async_payment_failed"
  | "checkout.expired"
  | "charge.refunded"
  | "ignored";

/** Provider event reduced to the fields the processor needs. Contains no PII. */
export interface NormalizedPaymentEvent {
  provider: PaymentProviderName;
  eventId: string;
  type: NormalizedEventType;
  /** the provider's own event type, e.g. "checkout.session.completed" */
  rawType: string;
  occurredAt: Date;
  sessionId: string | null;
  bookingId: string | null;
  paymentStatus: "paid" | "unpaid" | "no_payment_required" | null;
  amountTotal: number | null;
  currency: string | null;
  paymentIntentId: string | null;
  /** charge.refunded: cumulative amount refunded on the charge */
  amountRefunded?: number | null;
}

export interface RefundInput {
  paymentIntentId: string;
  amountCents: number;
  idempotencyKey: string;
}

export interface RefundResult {
  refundId: string;
  status: "succeeded" | "pending" | "failed";
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** true for simulated providers (UI must label them) */
  readonly simulated: boolean;
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionRef>;
  /** Verify the signature and normalize. Throws WebhookSignatureError on a bad/missing/stale signature. */
  parseWebhook(rawBody: string, headers: Headers): NormalizedPaymentEvent;
  getSession(sessionId: string): Promise<ProviderSession | null>;
  refund(input: RefundInput): Promise<RefundResult>;
  /** Close an open session so it can no longer be paid (best effort). */
  expireSession?(sessionId: string): Promise<void>;
}

export class WebhookSignatureError extends Error {
  constructor(message = "Invalid webhook signature") {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export class PaymentProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentProviderError";
  }
}
