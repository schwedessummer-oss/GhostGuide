import "server-only";
import { assertSimulationAllowed } from "@/config/env";
import { injectSimulatedFailure, partnerCall } from "../failure";
import { PartnerRejectedError, type MealPackOrder, type MealPackProvider, type PartnerCallContext } from "../types";

/**
 * DEMO meal-pack partner (no kitchen or vendor API is called).
 * Failure-injection rule: the demo kitchen REJECTS orders for a party of
 * exactly 7, in addition to booking_addons.details.simulate.
 */
const KIND = "meal_pack";
export const MEAL_PACK_REJECTED_PARTY_SIZE = 7;

export class DemoMealPackProvider implements MealPackProvider {
  readonly key = "demo";
  readonly simulated = true;

  async placeOrder(order: MealPackOrder, ctx: PartnerCallContext) {
    assertSimulationAllowed("meal pack");
    return partnerCall(
      { providerKind: KIND, providerKey: this.key, operation: "place_order", entityType: "fulfillment", entityId: ctx.fulfillmentId, simulated: true },
      async () => {
        injectSimulatedFailure("meal pack", ctx);
        if (order.partySize === MEAL_PACK_REJECTED_PARTY_SIZE) {
          throw new PartnerRejectedError("Demo kitchen cannot pack orders for a party of exactly 7 (failure-injection rule)");
        }
        // Idempotent: the fulfillment id is the order key, so a retry never double-orders.
        return { orderRef: `demo_meal_${ctx.fulfillmentId}` };
      },
    );
  }

  async cancelOrder(orderRef: string, ctx: PartnerCallContext): Promise<void> {
    assertSimulationAllowed("meal pack");
    await partnerCall(
      { providerKind: KIND, providerKey: this.key, operation: "cancel_order", entityType: "fulfillment", entityId: ctx.fulfillmentId, simulated: true },
      async () => {
        void orderRef;
      },
    );
  }
}
