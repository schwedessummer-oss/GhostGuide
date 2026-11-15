/**
 * Weather contracts shared by server and client (no server imports).
 *
 * Weather is hidden for now (docs/PLAN.md §2): the provider clients in
 * src/server/weather and src/integrations/weather are kept so forecasts can
 * be reattached to hike pages behind a switch. Values are never invented:
 * a field the provider does not supply is null.
 */

/** Credit line a weather source requires wherever its data is shown. */
export interface AttributionDto {
  name: string;
  url: string | null;
  license: string | null;
}

export interface HourlyForecastDto {
  time: string; // ISO
  temperatureC: number | null;
  precipitationMm: number | null;
  precipitationProbability: number | null; // %
  windSpeedMs: number | null;
  windGustMs: number | null;
  symbol: string | null; // provider symbol code, e.g. "partlycloudy_day"
}

export interface DailyForecastDto {
  date: string; // YYYY-MM-DD in the location's timezone
  minC: number | null;
  maxC: number | null;
  precipitationMm: number | null;
  maxWindMs: number | null;
  symbol: string | null;
}

export interface WeatherAlertDto {
  id: string;
  event: string;
  severity: string; // as given by the source (e.g. Minor/Moderate/Severe/Extreme)
  headline: string | null;
  description: string | null;
  instruction: string | null;
  onset: string | null;
  ends: string | null;
  source: string; // e.g. "National Weather Service"
  url: string | null;
}
