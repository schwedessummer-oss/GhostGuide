/**
 * MET Norway weather symbol codes → a plain label and an icon kind (pure).
 * Codes look like "partlycloudy_day", "lightrainshowersandthunder_night",
 * "heavysnow". Unknown codes give a null kind and no label — the UI then
 * shows the numbers only, never a guessed condition.
 *
 * Every code in MET's official symbol legend is recognised (see
 * MET_SYMBOL_CODES), including the two that MET spells with an extra "s":
 * "lightssleetshowersandthunder" and "lightssnowshowersandthunder". (The
 * server's symbolSeverity in src/server/weather/forecast.ts accepts the
 * same spellings, so a code it picks as a day's symbol always has an icon.)
 */
export type WeatherKind = "clear" | "fair" | "partlycloudy" | "cloudy" | "fog" | "drizzle" | "rain" | "sleet" | "snow" | "thunder";

export interface WeatherSymbol {
  kind: WeatherKind;
  label: string;
  night: boolean;
}

/**
 * The base codes of MET Norway's weather symbol legend
 * (api.met.no weathericon 2.0 "legends"), 41 in all. Codes marked with a
 * variant come as `<code>_day`, `<code>_night` and `<code>_polartwilight`;
 * the others have no suffix.
 */
export const MET_SYMBOL_CODES: readonly { code: string; variants: boolean }[] = [
  { code: "clearsky", variants: true },
  { code: "cloudy", variants: false },
  { code: "fair", variants: true },
  { code: "fog", variants: false },
  { code: "heavyrain", variants: false },
  { code: "heavyrainandthunder", variants: false },
  { code: "heavyrainshowers", variants: true },
  { code: "heavyrainshowersandthunder", variants: true },
  { code: "heavysleet", variants: false },
  { code: "heavysleetandthunder", variants: false },
  { code: "heavysleetshowers", variants: true },
  { code: "heavysleetshowersandthunder", variants: true },
  { code: "heavysnow", variants: false },
  { code: "heavysnowandthunder", variants: false },
  { code: "heavysnowshowers", variants: true },
  { code: "heavysnowshowersandthunder", variants: true },
  { code: "lightrain", variants: false },
  { code: "lightrainandthunder", variants: false },
  { code: "lightrainshowers", variants: true },
  { code: "lightrainshowersandthunder", variants: true },
  { code: "lightsleet", variants: false },
  { code: "lightsleetandthunder", variants: false },
  { code: "lightsleetshowers", variants: true },
  { code: "lightsnow", variants: false },
  { code: "lightsnowandthunder", variants: false },
  { code: "lightsnowshowers", variants: true },
  { code: "lightssleetshowersandthunder", variants: true },
  { code: "lightssnowshowersandthunder", variants: true },
  { code: "partlycloudy", variants: true },
  { code: "rain", variants: false },
  { code: "rainandthunder", variants: false },
  { code: "rainshowers", variants: true },
  { code: "rainshowersandthunder", variants: true },
  { code: "sleet", variants: false },
  { code: "sleetandthunder", variants: false },
  { code: "sleetshowers", variants: true },
  { code: "sleetshowersandthunder", variants: true },
  { code: "snow", variants: false },
  { code: "snowandthunder", variants: false },
  { code: "snowshowers", variants: true },
  { code: "snowshowersandthunder", variants: true },
];

const SIMPLE: Record<string, { kind: WeatherKind; label: string }> = {
  clearsky: { kind: "clear", label: "Clear" },
  fair: { kind: "fair", label: "Mostly clear" },
  partlycloudy: { kind: "partlycloudy", label: "Partly cloudy" },
  cloudy: { kind: "cloudy", label: "Cloudy" },
  fog: { kind: "fog", label: "Fog" },
};

const VARIANTS = new Set(["day", "night", "polartwilight"]);

export function weatherSymbol(code: string | null | undefined): WeatherSymbol | null {
  if (typeof code !== "string" || !code) return null;
  const parts = code.trim().toLowerCase().split("_");
  if (parts.length > 2 || (parts.length === 2 && !VARIANTS.has(parts[1]))) return null;
  const [rawBase, variant] = parts;
  const night = variant === "night" || variant === "polartwilight";
  if (SIMPLE[rawBase]) return { ...SIMPLE[rawBase], night };

  // MET's legend spells two codes "lights…": lightssleetshowersandthunder, lightssnowshowersandthunder.
  const base = rawBase.replace(/^lights(sleet|snow)/, "light$1");
  const m = /^(light|heavy)?(rain|sleet|snow)(showers)?(andthunder)?$/.exec(base);
  if (!m) return null;
  const [, intensity, precip, showers, thunder] = m;
  const words = [intensity, precip, showers ? "showers" : null].filter(Boolean).join(" ");
  const label = `${words[0].toUpperCase()}${words.slice(1)}${thunder ? " and thunder" : ""}`;
  const kind: WeatherKind = thunder
    ? "thunder"
    : precip === "rain"
      ? intensity === "light" && !showers
        ? "drizzle"
        : "rain"
      : (precip as WeatherKind);
  return { kind, label, night };
}
