import "server-only";
import { assertSimulationAllowed } from "@/config/env";
import type { Tx } from "@/server/db";
import { injectSimulatedFailure, partnerCall } from "../failure";
import { releaseReservations, reserveItems } from "../gear-locker/demo";
import type { GearReservationResult, PartnerCallContext, SatelliteDeviceRentalProvider } from "../types";

/**
 * DEMO satellite-communicator rental: reserves one gear_items row of kind
 * 'satellite_communicator' from the demo locker.
 *
 * IMPORTANT (customer copy must say this): the rented device's own satellite
 * subscription/SOS service applies. Ghost Guide does not provide, monitor or
 * relay SOS messages.
 */
export const SATELLITE_DISCLAIMER =
  "The device's own satellite subscription and SOS service apply. Ghost Guide does not provide, monitor or relay SOS messages and cannot contact emergency services for you.";

export class DemoSatelliteDeviceRentalProvider implements SatelliteDeviceRentalProvider {
  readonly key = "demo";
  readonly simulated = true;

  async reserve(tx: Tx, ctx: PartnerCallContext & { regionId: string }, date: string): Promise<GearReservationResult> {
    assertSimulationAllowed("satellite device rental");
    return partnerCall(
      { providerKind: "satellite_device", providerKey: this.key, operation: "reserve", entityType: "fulfillment", entityId: ctx.fulfillmentId, simulated: true },
      async () => {
        injectSimulatedFailure("satellite rental", ctx);
        return reserveItems(tx, ctx.fulfillmentId, ctx.regionId, date, [{ kind: "satellite_communicator", count: 1 }]);
      },
    );
  }

  async release(tx: Tx, fulfillmentId: string): Promise<number> {
    assertSimulationAllowed("satellite device rental");
    return releaseReservations(tx, fulfillmentId);
  }
}
