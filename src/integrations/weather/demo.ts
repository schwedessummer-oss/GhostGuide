import { assertSimulationAllowed } from "@/config/env";
import type { Forecast, ForecastPeriod, WeatherProvider } from "./types";

/**
 * SIMULATED weather for demo mode. Deterministic: the same location and the
 * same 12-hour window always produce the same forecast, so demos and tests
 * are reproducible. Every forecast is flagged `simulated: true` and must be
 * labeled as such wherever it is shown. It is not a real forecast.
 */
const CONDITIONS = [
  "Sunny",
  "Mostly Sunny",
  "Partly Cloudy",
  "Mostly Cloudy",
  "Chance Light Rain",
  "Light Rain",
  "Patchy Fog",
  "Clear",
] as const;

/** FNV-1a 32-bit hash → seed. */
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG (deterministic for a seed). */
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HALF_DAY_MS = 12 * 3_600_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function simulateForecast(lat: number, lng: number, now: Date, periodsCount = 6): Forecast {
  // 12-hour windows anchored at approximate LOCAL 06:00 / 18:00 (solar offset
  // from longitude; good enough for clearly-labeled simulated data).
  const offsetMs = Math.round(lng / 15) * 3_600_000;
  const local = now.getTime() + offsetMs;
  const windowStart = Math.floor((local - 6 * 3_600_000) / HALF_DAY_MS) * HALF_DAY_MS + 6 * 3_600_000 - offsetMs;
  const rand = prng(hashSeed(`${lat.toFixed(3)},${lng.toFixed(3)},${new Date(windowStart).toISOString()}`));
  const baseHigh = 48 + Math.round(rand() * 20); // °F
  const periods: ForecastPeriod[] = [];
  for (let i = 0; i < periodsCount; i++) {
    const start = new Date(windowStart + i * HALF_DAY_MS);
    const end = new Date(start.getTime() + HALF_DAY_MS);
    const localStart = new Date(start.getTime() + offsetMs);
    const isDaytime = localStart.getUTCHours() === 6;
    const condition = CONDITIONS[Math.floor(rand() * CONDITIONS.length)];
    const wet = /Rain/.test(condition);
    const day = WEEKDAYS[localStart.getUTCDay()];
    periods.push({
      name: i === 0 ? (isDaytime ? "Today" : "Tonight") : isDaytime ? day : `${day} Night`,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      isDaytime,
      temperature: isDaytime ? baseHigh + Math.round(rand() * 6) - 3 : baseHigh - 14 + Math.round(rand() * 6) - 3,
      temperatureUnit: "F",
      windSpeed: `${2 + Math.floor(rand() * 10)} mph`,
      shortForecast: condition,
      precipitationChancePct: wet ? 40 + Math.round(rand() * 40) : Math.round(rand() * 20),
    });
  }
  return { provider: "demo", periods, fetchedAt: new Date(now.getTime()), sourceUrl: null, simulated: true };
}

export function createDemoWeatherProvider(opts: { now?: () => Date } = {}): WeatherProvider {
  return {
    key: "demo",
    async getForecast(lat: number, lng: number) {
      assertSimulationAllowed("weather");
      return simulateForecast(lat, lng, opts.now ? opts.now() : new Date());
    },
  };
}
