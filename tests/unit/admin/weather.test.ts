import { describe, expect, it } from "vitest";
import { createDemoWeatherProvider, simulateForecast } from "@/integrations/weather/demo";
import { classifyWeatherFreshness, WEATHER_STALE_HOURS } from "@/integrations/weather/freshness";
import { createNwsWeatherProvider, isLikelyUsLocation } from "@/integrations/weather/nws";

const LAT = 47.5052;
const LNG = -121.7021;

describe("demo weather provider", () => {
  it("is deterministic for the same location and time window, and always labeled simulated", async () => {
    const now = new Date("2026-11-05T18:30:00Z");
    const a = await createDemoWeatherProvider({ now: () => now }).getForecast(LAT, LNG);
    const b = await createDemoWeatherProvider({ now: () => now }).getForecast(LAT, LNG);
    expect(a).toEqual(b);
    expect(a.simulated).toBe(true);
    expect(a.provider).toBe("demo");
    expect(a.sourceUrl).toBeNull();
    expect(a.periods).toHaveLength(6);
    // later in the same 12-hour window: identical periods
    const c = simulateForecast(LAT, LNG, new Date("2026-11-05T19:45:00Z"));
    expect(c.periods).toEqual(a.periods);
    // periods are contiguous 12-hour windows alternating day/night
    for (let i = 1; i < a.periods.length; i++) {
      expect(a.periods[i].startTime).toBe(a.periods[i - 1].endTime);
      expect(a.periods[i].isDaytime).toBe(!a.periods[i - 1].isDaytime);
    }
  });

  it("varies by location and by window", () => {
    const now = new Date("2026-11-05T18:30:00Z");
    const here = simulateForecast(LAT, LNG, now);
    const there = simulateForecast(40.1, -105.2, now);
    expect(JSON.stringify(here.periods)).not.toBe(JSON.stringify(there.periods));
    const nextDay = simulateForecast(LAT, LNG, new Date("2026-11-06T18:30:00Z"));
    expect(nextDay.periods[0].startTime).not.toBe(here.periods[0].startTime);
  });

  it("uses plausible values", () => {
    const f = simulateForecast(LAT, LNG, new Date("2026-07-01T12:00:00Z"));
    for (const p of f.periods) {
      expect(p.temperatureUnit).toBe("F");
      expect(p.temperature).toBeGreaterThan(20);
      expect(p.temperature).toBeLessThan(90);
      expect(p.precipitationChancePct).toBeGreaterThanOrEqual(0);
      expect(p.precipitationChancePct).toBeLessThanOrEqual(100);
    }
  });
});

describe("weather freshness", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  it("is fresh within the window and stale after it", () => {
    const fresh = classifyWeatherFreshness({ fetchedAt: new Date(now.getTime() - 2 * 3600_000), simulated: false }, now);
    expect(fresh).toMatchObject({ status: "fresh", ageMinutes: 120, warnings: [] });
    const stale = classifyWeatherFreshness({ fetchedAt: new Date(now.getTime() - (WEATHER_STALE_HOURS * 60 + 1) * 60_000), simulated: false }, now);
    expect(stale.status).toBe("stale");
    expect(stale.warnings.join(" ")).toMatch(/older than 6 h/);
    expect(classifyWeatherFreshness({ fetchedAt: "not a date", simulated: false }, now).status).toBe("stale");
  });

  it("always warns about simulated weather, even when fresh", () => {
    const r = classifyWeatherFreshness({ fetchedAt: now, simulated: true }, now);
    expect(r.status).toBe("fresh");
    expect(r.simulated).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/SIMULATED/);
  });
});

describe("NWS provider guards", () => {
  it("requires a User-Agent and a U.S. location, and never follows non-NWS URLs", async () => {
    expect(isLikelyUsLocation(LAT, LNG)).toBe(true);
    expect(isLikelyUsLocation(51.5, -0.12)).toBe(false);
    const noUa = createNwsWeatherProvider({ userAgent: undefined, fetchImpl: async () => new Response("{}") });
    await expect(noUa.getForecast(LAT, LNG)).rejects.toThrow(/WEATHER_USER_AGENT/);
    const p = createNwsWeatherProvider({ userAgent: "GhostGuide test (ops@example.com)", fetchImpl: async () => new Response("{}") });
    await expect(p.getForecast(51.5, -0.12)).rejects.toThrow(/U\.S\./);
    const evil = createNwsWeatherProvider({
      userAgent: "GhostGuide test (ops@example.com)",
      fetchImpl: async () => Response.json({ properties: { forecast: "https://evil.example.com/forecast" } }),
    });
    await expect(evil.getForecast(LAT, LNG)).rejects.toThrow(/outside api.weather.gov/);
  });

  it("maps a forecast response and sends the User-Agent", async () => {
    const seen: { url: string; ua: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, ua: new Headers(init?.headers).get("User-Agent") });
      if (url.includes("/points/")) return Response.json({ properties: { forecast: "https://api.weather.gov/gridpoints/SEW/150,60/forecast" } });
      return Response.json({
        properties: {
          periods: [
            { name: "Today", startTime: "2026-11-05T06:00:00-08:00", endTime: "2026-11-05T18:00:00-08:00", isDaytime: true, temperature: 52, temperatureUnit: "F", windSpeed: "5 mph", shortForecast: "Showers", probabilityOfPrecipitation: { value: 60 } },
          ],
        },
      });
    }) as unknown as typeof fetch;
    const f = await createNwsWeatherProvider({ userAgent: "GhostGuide test (ops@example.com)", fetchImpl }).getForecast(LAT, LNG);
    expect(f.simulated).toBe(false);
    expect(f.sourceUrl).toBe("https://api.weather.gov/gridpoints/SEW/150,60/forecast");
    expect(f.periods[0]).toMatchObject({ name: "Today", temperature: 52, precipitationChancePct: 60, shortForecast: "Showers" });
    expect(seen[0].url).toBe("https://api.weather.gov/points/47.5052,-121.7021");
    expect(seen.every((s) => s.ua === "GhostGuide test (ops@example.com)")).toBe(true);
  });

  it("turns HTTP errors into provider errors", async () => {
    const p = createNwsWeatherProvider({ userAgent: "x (y@example.com)", fetchImpl: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch });
    await expect(p.getForecast(LAT, LNG)).rejects.toThrow(/HTTP 503/);
  });
});
