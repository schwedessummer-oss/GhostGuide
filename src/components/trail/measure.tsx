import type { ReactNode } from "react";
import { formatAltitude, formatClimb, formatPrecipitation, formatTemperature, formatTrailDistance, formatWind, type Units } from "./format";

/*
 * Dual-unit values. Both renderings are in the HTML; CSS shows the one that
 * matches <html data-units> (set by UnitsToggle; imperial when absent). The
 * page HTML therefore stays identical for every visitor (cacheable), and the
 * hidden rendering is display:none, so screen readers read only one.
 *
 * Server-component safe (no hooks).
 */
export const UNITS_ATTRIBUTE = "data-units";
/** Site-wide display-units cookie name (shared convention with the rest of the site). */
export const UNITS_COOKIE = "gg_units";

const IMPERIAL_ONLY = "[[data-units=metric]_&]:hidden";
const METRIC_ONLY = "hidden [[data-units=metric]_&]:inline";

export function Dual({ imperial, metric }: { imperial: ReactNode; metric: ReactNode }) {
  return (
    <>
      <span className={IMPERIAL_ONLY}>{imperial}</span>
      <span className={METRIC_ONLY}>{metric}</span>
    </>
  );
}

/** Block-level variant (e.g. different SVG/tick groups). */
export function DualBlock({ imperial, metric, className }: { imperial: ReactNode; metric: ReactNode; className?: string }) {
  return (
    <>
      <div className={`${className ?? ""} [[data-units=metric]_&]:hidden`}>{imperial}</div>
      <div className={`${className ?? ""} hidden [[data-units=metric]_&]:block`}>{metric}</div>
    </>
  );
}

type Kind = "distance" | "climb" | "altitude" | "temperature" | "wind" | "precipitation";

const FORMATTERS: Record<Kind, (v: number, u: Units) => string | null> = {
  distance: formatTrailDistance,
  climb: formatClimb,
  altitude: formatAltitude,
  temperature: formatTemperature,
  wind: formatWind,
  precipitation: formatPrecipitation,
};

/** A measured value in both unit systems; `fallback` when the value is unknown. */
export function Measure({ value, kind, fallback = "—" }: { value: number | null | undefined; kind: Kind; fallback?: ReactNode }) {
  if (typeof value !== "number" || !Number.isFinite(value)) return <>{fallback}</>;
  const f = FORMATTERS[kind];
  const imperial = f(value, "imperial");
  const metric = f(value, "metric");
  if (imperial === null || metric === null) return <>{fallback}</>;
  return <Dual imperial={imperial} metric={metric} />;
}
