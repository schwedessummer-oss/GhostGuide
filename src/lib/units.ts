/**
 * Display units and user-facing number formatting (isomorphic, pure).
 *
 * Rounding follows what a hiker can use: 0.1 mi / 0.1 km for distances,
 * 10 ft / 5 m for climbs, and 5-minute steps for time estimates (an
 * estimate printed to the minute claims a precision it does not have).
 */
export const UNITS = ["imperial", "metric"] as const;
export type Units = (typeof UNITS)[number];

/** Cookie holding the visitor's choice (not personal data; readable by client code). */
export const UNITS_COOKIE = "gg_units";
export const UNITS_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 365;

export const M_PER_MILE = 1609.344;
export const FT_PER_M = 3.28084;

export function parseUnits(value: unknown): Units | null {
  return value === "imperial" || value === "metric" ? value : null;
}

/** Regions whose hikers read distances in miles and climbs in feet. */
const IMPERIAL_REGIONS = new Set(["us", "lr", "mm"]);

/**
 * Default units for an Accept-Language header: imperial for US English (and
 * a bare "en"), metric for other regions. Imperial when nothing is known,
 * since the first catalog markets are in the US.
 */
export function unitsForLocale(acceptLanguage: string | null | undefined): Units {
  const first = (acceptLanguage ?? "").split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!first || first === "*") return "imperial";
  const [lang, ...rest] = first.split(/[-_]/);
  const region = rest.find((p) => /^[a-z]{2}$/.test(p));
  if (region) return IMPERIAL_REGIONS.has(region) ? "imperial" : "metric";
  return lang === "en" ? "imperial" : "metric";
}

const fixed = (n: number, digits: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);

/** Distance for display: "6.8 mi", "320 ft", "11.0 km", "850 m". */
export function formatLength(meters: number, units: Units): string {
  const m = Number.isFinite(meters) && meters > 0 ? meters : 0;
  if (units === "metric") {
    if (m >= 999.5) {
      const km = m / 1000;
      return km >= 100 ? `${fixed(km, 0)} km` : `${fixed(km, 1)} km`;
    }
    return `${fixed(Math.round(m / 10) * 10, 0)} m`;
  }
  const miles = m / M_PER_MILE;
  if (miles >= 0.095) return miles >= 100 ? `${fixed(miles, 0)} mi` : `${fixed(miles, 1)} mi`;
  return `${fixed(Math.round((m * FT_PER_M) / 10) * 10, 0)} ft`;
}

/** Climb or elevation for display: "2,280 ft" (nearest 10 ft) or "695 m" (nearest 5 m). */
export function formatClimb(meters: number, units: Units): string {
  const m = Number.isFinite(meters) ? Math.max(0, meters) : 0;
  if (units === "metric") return `${fixed(Math.round(m / 5) * 5, 0)} m`;
  return `${fixed(Math.round((m * FT_PER_M) / 10) * 10, 0)} ft`;
}

/** Time estimate rounded to 5 minutes: "45 min", "3 h 05 min", "4 h". */
export function formatEstimate(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 2.5) return "under 5 min";
  const rounded = Math.round(minutes / 5) * 5;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${String(m).padStart(2, "0")} min` : `${h} h`;
}

/** "≈ 3 h 05 min": always marks the value as an estimate. */
export const approxDuration = (minutes: number) => `≈ ${formatEstimate(minutes)}`;

// ---------------------------------------------------------------------------
// Filter inputs: values typed in display units ↔ API units (km, m)
// ---------------------------------------------------------------------------

export const lengthUnit = (units: Units) => (units === "metric" ? "km" : "mi");
export const climbUnit = (units: Units) => (units === "metric" ? "m" : "ft");

const round = (n: number, digits: number) => Number(n.toFixed(digits));

/** Kilometres → the number shown in a length input (0.1 precision). */
export function kmToInput(km: number, units: Units): number {
  return round(units === "metric" ? km : (km * 1000) / M_PER_MILE, 1);
}

/** A length input value → kilometres for the API (0.001 precision). */
export function inputToKm(value: number, units: Units): number {
  return round(units === "metric" ? value : (value * M_PER_MILE) / 1000, 3);
}

/** Metres of climb → the number shown in a climb input (whole ft / m). */
export function climbMToInput(m: number, units: Units): number {
  return Math.round(units === "metric" ? m : m * FT_PER_M);
}

/** A climb input value → metres for the API (0.1 precision). */
export function inputToClimbM(value: number, units: Units): number {
  return round(units === "metric" ? value : value / FT_PER_M, 1);
}
