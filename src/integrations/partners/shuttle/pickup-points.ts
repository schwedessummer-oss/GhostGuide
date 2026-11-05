/**
 * Pickup points offered by the DEMO shuttle partner (fictional places in the
 * demo region). Pure data, safe for client components. A live shuttle
 * adapter would load its service area from the partner instead.
 */
export interface PickupPoint {
  key: string;
  label: string;
  lat: number;
  lng: number;
  /** estimated drive time to the trailheads, minutes (estimate) */
  driveMinutes: number;
}

export const DEMO_PICKUP_POINTS: readonly PickupPoint[] = [
  { key: "visitor-center", label: "Ghost Ridge Visitor Center (demo)", lat: 47.5161, lng: -121.7412, driveMinutes: 25 },
  { key: "pinecrest-park-ride", label: "Pinecrest Park & Ride (demo)", lat: 47.5302, lng: -121.7651, driveMinutes: 35 },
  { key: "ridge-town-inn", label: "Ridge Town Inn (demo)", lat: 47.4987, lng: -121.7298, driveMinutes: 20 },
];

export function pickupPointByKey(key: string | null | undefined): PickupPoint | null {
  return DEMO_PICKUP_POINTS.find((p) => p.key === key) ?? null;
}
