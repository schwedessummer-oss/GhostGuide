import "server-only";
import { DemoGearLockerProvider } from "./gear-locker/demo";
import { DemoMealPackProvider } from "./meal-pack/demo";
import { DemoSatelliteDeviceRentalProvider } from "./satellite-device/demo";
import { DemoShuttleProvider } from "./shuttle/demo";
import { PartnerRejectedError, type GearLockerProvider, type MealPackProvider, type SatelliteDeviceRentalProvider, type ShuttleProvider } from "./types";

export * from "./types";

/**
 * Partner registry keyed by addons.provider_key. Only "demo" adapters exist:
 * no real partner API is integrated. An unknown key is a configuration
 * problem, reported as a permanent rejection so the fulfillment is flagged
 * for an operator instead of retried forever.
 */
function noLiveAdapter(kind: string, key: string): never {
  throw new PartnerRejectedError(`No ${kind} adapter is configured for provider key "${key}" (only simulated "demo" adapters exist)`);
}

const gear = new DemoGearLockerProvider();
const shuttle = new DemoShuttleProvider();
const meal = new DemoMealPackProvider();
const satellite = new DemoSatelliteDeviceRentalProvider();

export function getGearLockerProvider(key: string): GearLockerProvider {
  return key === "demo" ? gear : noLiveAdapter("gear locker", key);
}
export function getShuttleProvider(key: string): ShuttleProvider {
  return key === "demo" ? shuttle : noLiveAdapter("shuttle", key);
}
export function getMealPackProvider(key: string): MealPackProvider {
  return key === "demo" ? meal : noLiveAdapter("meal pack", key);
}
export function getSatelliteDeviceRentalProvider(key: string): SatelliteDeviceRentalProvider {
  return key === "demo" ? satellite : noLiveAdapter("satellite device rental", key);
}
