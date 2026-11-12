/**
 * Elevation profile chart geometry (pure; rendered server-side as SVG).
 *
 * The plot is drawn once in a fixed viewBox (VIEW_W × VIEW_H) with
 * preserveAspectRatio="none", so it stretches to any width; text labels are
 * HTML positioned by percentage, so they stay crisp and readable. The path
 * is unit-agnostic (metres); only the tick labels differ between imperial and
 * metric, and each tick carries its position as a percentage.
 */
import { FT_PER_M, M_PER_MILE, type Units } from "./format";

export const VIEW_W = 1000;
export const VIEW_H = 240;

export interface Tick {
  /** Label text, e.g. "2 mi", "3,000 ft". */
  label: string;
  /** Position along the axis, 0–100 (x: from the left; y: from the top). */
  pct: number;
}

export interface ElevationPoint {
  distanceM: number;
  elevationM: number;
  /** Percentages within the plot. */
  xPct: number;
  yPct: number;
}

export interface ElevationChart {
  linePath: string;
  areaPath: string;
  totalM: number;
  /** Vertical domain of the plot, metres (padded around the data). */
  domainMinM: number;
  domainMaxM: number;
  high: ElevationPoint;
  low: ElevationPoint;
  start: ElevationPoint;
  end: ElevationPoint;
  xTicks: Record<Units, Tick[]>;
  yTicks: Record<Units, Tick[]>;
}

const NICE = [1, 2, 2.5, 5];

/** A "nice" step (1, 2, 2.5, 5 × 10^n) giving at most `maxTicks` intervals over `range`. */
export function niceStep(range: number, maxTicks: number): number {
  if (!(range > 0) || !(maxTicks > 0)) return 1;
  const raw = range / maxTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const n of NICE) if (n * mag >= raw - 1e-12) return n * mag;
  return 10 * mag;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const fmtNum = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Clean a [distance, elevation] series: finite values, non-decreasing distance. */
export function cleanProfile(profile: [number, number][] | null | undefined): [number, number][] {
  if (!Array.isArray(profile)) return [];
  const out: [number, number][] = [];
  for (const p of profile) {
    if (!Array.isArray(p)) continue;
    const [d, e] = p;
    if (!Number.isFinite(d) || !Number.isFinite(e) || d < 0) continue;
    if (out.length && d < out[out.length - 1][0]) continue;
    out.push([d, e]);
  }
  return out;
}

function axisTicks(totalM: number, units: Units, maxTicks: number): Tick[] {
  const per = units === "metric" ? 1000 : M_PER_MILE;
  const unit = units === "metric" ? "km" : "mi";
  const totalU = totalM / per;
  // Very short trails: label in ft / m instead of fractions of a mile/km.
  if (totalU < 0.5) {
    const perSmall = units === "metric" ? 1 : 1 / FT_PER_M;
    const smallUnit = units === "metric" ? "m" : "ft";
    const totalS = totalM / perSmall;
    const step = niceStep(totalS, maxTicks);
    const ticks: Tick[] = [];
    for (let v = 0; v <= totalS + 1e-9; v += step)
      ticks.push({ label: `${fmtNum(Math.round(v))} ${smallUnit}`, pct: r1(((v * perSmall) / totalM) * 100) });
    return ticks;
  }
  const step = niceStep(totalU, maxTicks);
  const ticks: Tick[] = [];
  for (let i = 0; i * step <= totalU + 1e-9; i++) {
    const v = Number((i * step).toFixed(6));
    ticks.push({ label: `${fmtNum(v)} ${unit}`, pct: r1(((v * per) / totalM) * 100) });
  }
  return ticks;
}

function elevationTicks(minM: number, maxM: number, units: Units, maxTicks: number): Tick[] {
  const k = units === "metric" ? 1 : FT_PER_M;
  const lo = minM * k;
  const hi = maxM * k;
  const step = niceStep(hi - lo, maxTicks);
  const ticks: Tick[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    const m = v / k;
    ticks.push({ label: `${fmtNum(Math.round(v))} ${units === "metric" ? "m" : "ft"}`, pct: r1(((maxM - m) / (maxM - minM)) * 100) });
  }
  return ticks;
}

/**
 * Chart geometry for a profile of [distance_m, elevation_m] pairs. Null when
 * fewer than two usable points or no distance covered.
 */
export function buildElevationChart(profile: [number, number][] | null | undefined): ElevationChart | null {
  const pts = cleanProfile(profile);
  if (pts.length < 2) return null;
  const totalM = pts[pts.length - 1][0];
  if (!(totalM > 0)) return null;

  let hi = pts[0];
  let lo = pts[0];
  for (const p of pts) {
    if (p[1] > hi[1]) hi = p;
    if (p[1] < lo[1]) lo = p;
  }
  // Pad the vertical domain so flat trails don't look dramatic: at least 40 m of range.
  const span = Math.max(hi[1] - lo[1], 40);
  const mid = (hi[1] + lo[1]) / 2;
  const domainMinM = Math.min(lo[1], mid - span / 2) - span * 0.08;
  const domainMaxM = Math.max(hi[1], mid + span / 2) + span * 0.12;

  const x = (d: number) => (d / totalM) * VIEW_W;
  const y = (e: number) => ((domainMaxM - e) / (domainMaxM - domainMinM)) * VIEW_H;
  const coords = pts.map(([d, e]) => `${r1(x(d))},${r1(y(e))}`);
  const linePath = `M${coords.join("L")}`;
  const areaPath = `${linePath}L${VIEW_W},${VIEW_H}L0,${VIEW_H}Z`;

  const point = ([d, e]: [number, number]): ElevationPoint => ({
    distanceM: d,
    elevationM: e,
    xPct: r1((x(d) / VIEW_W) * 100),
    yPct: r1((y(e) / VIEW_H) * 100),
  });

  return {
    linePath,
    areaPath,
    totalM,
    domainMinM,
    domainMaxM,
    high: point(hi),
    low: point(lo),
    start: point(pts[0]),
    end: point(pts[pts.length - 1]),
    xTicks: { imperial: axisTicks(totalM, "imperial", 5), metric: axisTicks(totalM, "metric", 5) },
    yTicks: {
      imperial: elevationTicks(domainMinM, domainMaxM, "imperial", 3),
      metric: elevationTicks(domainMinM, domainMaxM, "metric", 3),
    },
  };
}
