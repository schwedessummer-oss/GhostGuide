/**
 * MET Norway weather symbol codes → a plain label and an icon kind (pure).
 * Codes look like "partlycloudy_day", "lightrainshowersandthunder_night",
 * "heavysnow". Unknown codes give a null kind and no label — the UI then
 * shows the numbers only, never a guessed condition.
 */
export type WeatherKind = "clear" | "fair" | "partlycloudy" | "cloudy" | "fog" | "drizzle" | "rain" | "sleet" | "snow" | "thunder";

export interface WeatherSymbol {
  kind: WeatherKind;
  label: string;
  night: boolean;
}

const SIMPLE: Record<string, { kind: WeatherKind; label: string }> = {
  clearsky: { kind: "clear", label: "Clear" },
  fair: { kind: "fair", label: "Mostly clear" },
  partlycloudy: { kind: "partlycloudy", label: "Partly cloudy" },
  cloudy: { kind: "cloudy", label: "Cloudy" },
  fog: { kind: "fog", label: "Fog" },
};

export function weatherSymbol(code: string | null | undefined): WeatherSymbol | null {
  if (typeof code !== "string" || !code) return null;
  const [base, variant] = code.trim().toLowerCase().split("_");
  const night = variant === "night" || variant === "polartwilight";
  if (SIMPLE[base]) return { ...SIMPLE[base], night };

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
