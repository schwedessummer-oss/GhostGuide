import "server-only";
import { env } from "@/config/env";
import { DemoPaymentProvider } from "./demo";
import { StripePaymentProvider } from "./stripe";
import type { PaymentProvider, PaymentProviderName } from "./types";

export type * from "./types";
export { WebhookSignatureError, PaymentProviderError } from "./types";

const instances: Partial<Record<PaymentProviderName, PaymentProvider>> = {};

/** A provider by name (bookings remember which provider took their payment). */
export function getPaymentProviderByName(name: string): PaymentProvider {
  if (name !== "stripe" && name !== "demo") throw new Error(`Unknown payment provider: ${name}`);
  if (!instances[name]) instances[name] = name === "stripe" ? new StripePaymentProvider() : new DemoPaymentProvider();
  return instances[name]!;
}

/** The provider new checkouts use (PAYMENTS_PROVIDER). */
export function getPaymentProvider(): PaymentProvider {
  return getPaymentProviderByName(env().PAYMENTS_PROVIDER);
}
