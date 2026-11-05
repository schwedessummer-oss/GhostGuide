import "server-only";
import { weatherProvider, type Forecast, type WeatherProvider } from "@/integrations/weather";
import { recordIntegrationEvent } from "@/server/integration-log";
import { withSystem, type JsonValue } from "@/server/db";

export interface WeatherSnapshot {
  id: string;
  provider: string;
  isSimulated: boolean;
  fetchedAt: Date;
  sourceUrl: string | null;
  data: { periods: Forecast["periods"] };
}

/**
 * Fetch a forecast for a trail and store it as a weather snapshot. Every
 * call (success, simulated or failure) is recorded as an integration event.
 * Callers must have authorized the actor; snapshots are written as trusted
 * code (weather_snapshots is not writable by API roles).
 */
export async function captureWeatherSnapshot(
  trail: { id: string; regionId: string; lat: number; lng: number },
  provider: WeatherProvider = weatherProvider(),
): Promise<{ ok: true; snapshot: WeatherSnapshot } | { ok: false; error: string }> {
  const started = Date.now();
  let forecast: Forecast;
  try {
    forecast = await provider.getForecast(trail.lat, trail.lng);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordIntegrationEvent({
      providerKind: "weather",
      providerKey: provider.key,
      operation: "forecast",
      outcome: "failure",
      entityType: "trail",
      entityId: trail.id,
      error: message,
      durationMs: Date.now() - started,
    });
    return { ok: false, error: message };
  }
  const periods = forecast.periods;
  const snapshot = await withSystem(async (tx) => {
    const [row] = await tx<WeatherSnapshot[]>`
      insert into public.weather_snapshots (trail_id, region_id, provider, is_simulated, fetched_at, valid_from, valid_to, data, source_url)
      values (${trail.id}, ${trail.regionId}, ${forecast.provider}, ${forecast.simulated}, ${forecast.fetchedAt}::timestamptz,
              ${periods[0]?.startTime ?? null}::timestamptz, ${periods[periods.length - 1]?.endTime ?? null}::timestamptz,
              ${tx.json({ periods } as unknown as JsonValue)}, ${forecast.sourceUrl})
      returning id, provider, is_simulated, fetched_at, source_url, data`;
    await recordIntegrationEvent(
      {
        providerKind: "weather",
        providerKey: provider.key,
        operation: "forecast",
        outcome: forecast.simulated ? "simulated" : "success",
        entityType: "weather_snapshot",
        entityId: row.id,
        durationMs: Date.now() - started,
      },
      tx,
    );
    return row;
  });
  return { ok: true, snapshot };
}
