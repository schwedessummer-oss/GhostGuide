/**
 * Weather provider interface. Forecasts are informational context for
 * operators (e.g. marketing drafts); they are never used for safety
 * decisions and always carry their source, fetch time and whether they
 * are simulated.
 */
export interface ForecastPeriod {
  /** e.g. "Saturday", "Saturday Night" */
  name: string;
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
  isDaytime: boolean;
  temperature: number;
  temperatureUnit: "F" | "C";
  windSpeed: string;
  shortForecast: string;
  /** probability of precipitation, 0–100, when the provider reports it */
  precipitationChancePct: number | null;
}

export interface Forecast {
  provider: "demo" | "nws";
  periods: ForecastPeriod[];
  fetchedAt: Date;
  /** where the forecast came from (null for simulated data) */
  sourceUrl: string | null;
  simulated: boolean;
}

export interface WeatherProvider {
  readonly key: "demo" | "nws";
  getForecast(lat: number, lng: number): Promise<Forecast>;
}

export class WeatherProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeatherProviderError";
  }
}
