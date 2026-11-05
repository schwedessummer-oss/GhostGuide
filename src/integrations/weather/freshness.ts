/**
 * Freshness rules for weather shown to operators (pure, isomorphic).
 * Weather older than WEATHER_STALE_HOURS must not be presented as current,
 * and simulated weather must always be labeled as not a real forecast.
 */
export const WEATHER_STALE_HOURS = 6;

export interface WeatherFreshness {
  status: "fresh" | "stale";
  simulated: boolean;
  ageMinutes: number;
  warnings: string[];
}

export function classifyWeatherFreshness(input: { fetchedAt: Date | string; simulated: boolean }, now: Date = new Date()): WeatherFreshness {
  const fetched = new Date(input.fetchedAt);
  const ageMinutes = Math.max(0, Math.round((now.getTime() - fetched.getTime()) / 60_000));
  const stale = Number.isNaN(fetched.getTime()) || ageMinutes > WEATHER_STALE_HOURS * 60;
  const warnings: string[] = [];
  if (input.simulated) warnings.push("Weather is SIMULATED demo data, not a real forecast. Do not publish it as real conditions.");
  if (stale) {
    warnings.push(
      `Weather snapshot is ${Number.isNaN(fetched.getTime()) ? "of unknown age" : `${Math.round(ageMinutes / 60)} h old`} (older than ${WEATHER_STALE_HOURS} h). Refresh it before publishing.`,
    );
  }
  return { status: stale ? "stale" : "fresh", simulated: input.simulated, ageMinutes, warnings };
}
