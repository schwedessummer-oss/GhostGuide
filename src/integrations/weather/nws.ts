import { z } from "zod";
import { WeatherProviderError, type Forecast, type WeatherProvider } from "./types";

/**
 * U.S. National Weather Service (api.weather.gov) adapter.
 *  1. GET /points/{lat},{lng} → the grid's forecast URL
 *  2. GET that forecast URL → 12-hour periods
 * The API requires an identifying User-Agent (app name + contact). It only
 * covers U.S. locations. Errors are thrown as WeatherProviderError; the
 * calling use-case records the integration event.
 */
const API_ORIGIN = "https://api.weather.gov";
const TIMEOUT_MS = 8000;

const pointsSchema = z.object({
  properties: z.object({ forecast: z.url() }),
});

const periodSchema = z.object({
  name: z.string().max(100),
  startTime: z.string(),
  endTime: z.string(),
  isDaytime: z.boolean(),
  temperature: z.number(),
  temperatureUnit: z.enum(["F", "C"]),
  windSpeed: z.string().max(60).nullish(),
  shortForecast: z.string().max(200),
  probabilityOfPrecipitation: z.object({ value: z.number().nullable() }).nullish(),
});

const forecastSchema = z.object({
  properties: z.object({ periods: z.array(periodSchema).min(1) }),
});

/** Rough bounding boxes for NWS coverage (CONUS, Alaska, Hawaii, Puerto Rico/USVI). */
export function isLikelyUsLocation(lat: number, lng: number): boolean {
  const boxes = [
    { minLat: 24, maxLat: 50, minLng: -125.5, maxLng: -66.5 }, // CONUS
    { minLat: 51, maxLat: 72, minLng: -180, maxLng: -129 }, // Alaska
    { minLat: 18.5, maxLat: 22.5, minLng: -161, maxLng: -154 }, // Hawaii
    { minLat: 17.5, maxLat: 18.6, minLng: -67.5, maxLng: -64.5 }, // PR / USVI
  ];
  return boxes.some((b) => lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng);
}

export function createNwsWeatherProvider(opts: { userAgent: string | undefined; fetchImpl?: typeof fetch }): WeatherProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  async function getJson(url: string): Promise<unknown> {
    if (!url.startsWith(`${API_ORIGIN}/`)) throw new WeatherProviderError("Refusing to follow a forecast URL outside api.weather.gov");
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { "User-Agent": opts.userAgent as string, Accept: "application/geo+json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (err) {
      throw new WeatherProviderError(`api.weather.gov request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new WeatherProviderError(`api.weather.gov returned HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new WeatherProviderError("api.weather.gov returned invalid JSON");
    }
  }

  return {
    key: "nws",
    async getForecast(lat: number, lng: number): Promise<Forecast> {
      if (!opts.userAgent) throw new WeatherProviderError("WEATHER_USER_AGENT must be set to use api.weather.gov");
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new WeatherProviderError("Invalid coordinates");
      if (!isLikelyUsLocation(lat, lng)) throw new WeatherProviderError("api.weather.gov only covers U.S. locations");
      const points = pointsSchema.safeParse(await getJson(`${API_ORIGIN}/points/${lat.toFixed(4)},${lng.toFixed(4)}`));
      if (!points.success) throw new WeatherProviderError("Unexpected response from the points endpoint");
      const forecastUrl = points.data.properties.forecast;
      const fc = forecastSchema.safeParse(await getJson(forecastUrl));
      if (!fc.success) throw new WeatherProviderError("Unexpected response from the forecast endpoint");
      return {
        provider: "nws",
        periods: fc.data.properties.periods.slice(0, 6).map((p) => ({
          name: p.name,
          startTime: p.startTime,
          endTime: p.endTime,
          isDaytime: p.isDaytime,
          temperature: p.temperature,
          temperatureUnit: p.temperatureUnit,
          windSpeed: p.windSpeed ?? "",
          shortForecast: p.shortForecast,
          precipitationChancePct: p.probabilityOfPrecipitation?.value ?? null,
        })),
        fetchedAt: new Date(),
        sourceUrl: forecastUrl,
        simulated: false,
      };
    },
  };
}
