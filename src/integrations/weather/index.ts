import "server-only";
import { env } from "@/config/env";
import { createDemoWeatherProvider } from "./demo";
import { createNwsWeatherProvider } from "./nws";
import type { WeatherProvider } from "./types";

export type { Forecast, ForecastPeriod, WeatherProvider } from "./types";
export { WeatherProviderError } from "./types";
export { classifyWeatherFreshness, WEATHER_STALE_HOURS } from "./freshness";

/** The configured weather provider: NWS (live) or the simulated demo provider. */
export function weatherProvider(): WeatherProvider {
  const e = env();
  return e.WEATHER_PROVIDER === "nws" ? createNwsWeatherProvider({ userAgent: e.WEATHER_USER_AGENT }) : createDemoWeatherProvider();
}
