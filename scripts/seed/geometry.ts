/**
 * Deterministic synthetic route geometry for DEMONSTRATION trails only.
 * These shapes are fictional and must never be presented as real routes.
 */
import { cumulativeDistancesM, lineLengthM, offsetMeters, type LatLng, type Position } from "../../src/domain/geo";

function withElevation(points: LatLng[], profile: (t: number) => number): Position[] {
  const pos: Position[] = points.map((p) => [round(p.lng, 6), round(p.lat, 6)]);
  const cum = cumulativeDistancesM(pos);
  const total = cum[cum.length - 1] || 1;
  return pos.map((p, i) => [p[0], p[1], Math.round(profile(cum[i] / total) * 10) / 10]);
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/** Closed loop around a trailhead, scaled to the target length. */
export function makeLoop(trailhead: LatLng, targetKm: number, baseEleM: number, gainM: number, seed: number): Position[] {
  const n = Math.max(40, Math.round(targetKm * 14));
  const shape = (R: number) => {
    const pts: LatLng[] = [];
    for (let i = 0; i <= n; i++) {
      const th = (i / n) * 2 * Math.PI;
      const r = R * (1 + 0.18 * Math.sin(3 * th + seed) + 0.07 * Math.cos(5 * th + seed * 2));
      // loop passes through the trailhead at th=0 by offsetting the center
      const cx = -R * (1 + 0.18 * Math.sin(seed) + 0.07 * Math.cos(seed * 2));
      pts.push(offsetMeters(trailhead, cx + r * Math.cos(th), r * Math.sin(th) * 0.8));
    }
    pts[pts.length - 1] = pts[0];
    return pts;
  };
  const unit = lineLengthM(shape(1000).map((p) => [p.lng, p.lat] as Position));
  const R = (1000 * targetKm * 1000) / unit;
  return withElevation(shape(R), (t) => baseEleM + gainM * Math.sin(Math.PI * t) + 6 * Math.sin(10 * Math.PI * t));
}

/** Winding path from the trailhead following bearings, scaled to target length. */
function makePath(trailhead: LatLng, lengthKm: number, bearingDeg: number, seed: number): LatLng[] {
  const steps = Math.max(30, Math.round(lengthKm * 14));
  const stepM = (lengthKm * 1000) / steps;
  const pts: LatLng[] = [trailhead];
  let heading = bearingDeg;
  let p = trailhead;
  for (let i = 0; i < steps; i++) {
    heading += 18 * Math.sin(i / 3 + seed) + 7 * Math.cos(i / 1.7 + seed);
    const rad = (heading * Math.PI) / 180;
    p = offsetMeters(p, stepM * Math.sin(rad), stepM * Math.cos(rad));
    pts.push(p);
  }
  // rescale exactly to the target length
  return pts;
}

export function makeOutAndBack(trailhead: LatLng, targetKm: number, bearing: number, baseEleM: number, gainM: number, seed: number): Position[] {
  const out = makePath(trailhead, targetKm / 2, bearing, seed);
  const full = [...out, ...out.slice(0, -1).reverse()];
  // climb on the way out, descend on the way back (with small undulations)
  return withElevation(full, (t) => baseEleM + gainM * Math.sin(Math.PI * t) ** 1.2 + 4 * Math.sin(14 * Math.PI * t));
}

export function makePointToPoint(trailhead: LatLng, targetKm: number, bearing: number, baseEleM: number, gainM: number, seed: number): Position[] {
  const pts = makePath(trailhead, targetKm, bearing, seed);
  // two climbs and descents
  return withElevation(pts, (t) => baseEleM + (gainM / 2) * (1 - Math.cos(4 * Math.PI * t)) / 1 * 0.5 + (gainM / 2) * t);
}
