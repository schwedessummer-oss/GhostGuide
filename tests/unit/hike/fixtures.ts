import { offsetMeters, type LatLng, type Position } from "@/domain/geo";
import { buildRouteModel } from "@/domain/progress";

export const ORIGIN: LatLng = { lat: 47.5, lng: -121.7 };

/** Straight line east from ORIGIN, one vertex every `stepM` metres. */
export function straightLine(lengthM: number, stepM = 50): Position[] {
  const n = Math.round(lengthM / stepM);
  return Array.from({ length: n + 1 }, (_, i) => {
    const p = offsetMeters(ORIGIN, i * stepM, 0);
    return [p.lng, p.lat] as Position;
  });
}

/** Out-and-back: east for `halfM` then back along the same line. */
export function outAndBack(halfM: number, stepM = 50): Position[] {
  const out = straightLine(halfM, stepM);
  return [...out, ...out.slice(0, -1).reverse()];
}

export const lineModel = (lengthM = 2000) => buildRouteModel(straightLine(lengthM), "point_to_point");
export const outAndBackModel = (halfM = 1000) => buildRouteModel(outAndBack(halfM), "out_and_back");

/** A point `eastM` along the line and `northM` off it. */
export const at = (eastM: number, northM = 0): LatLng => offsetMeters(ORIGIN, eastM, northM);
