import "server-only";
import { createHash } from "node:crypto";
import { assertSimulationAllowed } from "@/config/env";
import { injectSimulatedFailure, partnerCall } from "../failure";
import {
  ShuttleConfirmationRequiredError,
  type PartnerCallContext,
  type ShuttleProvider,
  type ShuttleQuote,
  type ShuttleQuoteRequest,
  type ShuttleRideRequest,
} from "../types";

/**
 * DEMO shuttle partner. No rideshare/shuttle vendor API is called. Quotes
 * equal the amount the customer prepaid for the shuttle add-on, so
 * confirming never adds a charge in the demo. requestRide refuses to run
 * without the customer's explicit confirmation of pickup location, price
 * and time (defense in depth: the use-case checks this too).
 */
const KIND = "shuttle";
const QUOTE_TTL_MS = 24 * 3_600_000;

const ref = (prefix: string, seed: string) => `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 20)}`;

export class DemoShuttleProvider implements ShuttleProvider {
  readonly key = "demo";
  readonly simulated = true;

  async requestQuote(req: ShuttleQuoteRequest, ctx: PartnerCallContext): Promise<ShuttleQuote> {
    assertSimulationAllowed("shuttle");
    return partnerCall(
      { providerKind: KIND, providerKey: this.key, operation: "quote", entityType: "fulfillment", entityId: ctx.fulfillmentId, simulated: true },
      async () => {
        injectSimulatedFailure("shuttle", ctx);
        const now = Date.now();
        // Valid for 24 h but never past 1 h before pickup; at least 15 minutes to decide.
        const expires = Math.max(now + 15 * 60_000, Math.min(now + QUOTE_TTL_MS, req.pickupAt.getTime() - 3_600_000));
        return {
          quoteRef: ref("demo_sq", `${ctx.fulfillmentId}:${now}`),
          priceCents: req.prepaidCents,
          expiresAt: new Date(expires),
        };
      },
    );
  }

  async requestRide(req: ShuttleRideRequest, ctx: PartnerCallContext) {
    assertSimulationAllowed("shuttle");
    if (!req.customerConfirmedAt) throw new ShuttleConfirmationRequiredError();
    return partnerCall(
      { providerKind: KIND, providerKey: this.key, operation: "request_ride", entityType: "fulfillment", entityId: ctx.fulfillmentId, simulated: true },
      async () => {
        injectSimulatedFailure("shuttle", ctx);
        // Deterministic per shuttle request: a retried call returns the same ride.
        return { rideRef: ref("demo_ride", req.shuttleRequestId), status: "confirmed" as const };
      },
    );
  }

  async cancelRide(rideRef: string, ctx: PartnerCallContext): Promise<void> {
    assertSimulationAllowed("shuttle");
    await partnerCall(
      { providerKind: KIND, providerKey: this.key, operation: "cancel_ride", entityType: "fulfillment", entityId: ctx.fulfillmentId, simulated: true },
      async () => {
        void rideRef;
      },
    );
  }
}
