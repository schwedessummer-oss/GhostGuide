import "server-only";
import type { HourlyForecastDto } from "@/domain/catalog";
import { formatLocalTime, localDateKey, timeZoneOffsetMs } from "@/server/geo/timezone";

/**
 * Plain-language forecast highlights for a trail page, derived ONLY from the
 * hourly forecast numbers and symbol codes (next ~24 h); nothing is guessed
 * from anything else. Times are local to the trail (`timeZone`, en-US clock,
 * e.g. "4 PM"). Pure and deterministic.
 *
 * RULES (in output order; at most HIGHLIGHT_LIMITS.max highlights)
 *  1. Thunder      first hour whose symbol contains "thunder"
 *                  → "Thunderstorms possible this afternoon (around 2 PM)"
 *  2. Heavy        peak hourly precipitation ≥ 4 mm (only when probabilities
 *                  are published; otherwise folded into rule 3)
 *                  → "Heavy rain around 3 PM (up to 6.2 mm per hour)"
 *  3. Precipitation
 *     with probabilities: first hour with probability ≥ 60 % → "… likely",
 *                  else first hour ≥ 30 % → "… possible"
 *                  → "Rain likely around 4 PM (70% chance)"
 *     without:     first hour with ≥ 0.5 mm → "Rain forecast around 4 PM
 *                  (up to 1.2 mm per hour)", "Heavy rain …" when the peak ≥ 4 mm
 *     The word (Rain / Snow / Sleet / Precipitation) comes from that hour's
 *     symbol code; "Precipitation" when the symbol names no type.
 *  4. Wind         peak gust ≥ 15 m/s → "Gusts up to 18 m/s (65 km/h) around 2 PM";
 *                  when no gusts are published: peak sustained wind ≥ 10.8 m/s
 *                  (Beaufort 6) → "Strong wind up to 12 m/s (43 km/h) around 2 PM"
 *  5. Freezing     lowest temperature < 0 °C → "Below freezing overnight
 *                  (down to −3 °C around 5 AM)" when the low falls between
 *                  21:00 and 09:00 local, else "Below freezing (down to −2 °C around 1 PM)"
 *  6. Heat         highest temperature ≥ 30 °C → "Hot around 3 PM (up to 32 °C)"
 *  7. Dry          no rule 1–3 highlight, ≥ 12 hours with a known amount, every
 *                  amount 0 mm and every published probability < 10 %
 *                  → "No precipitation forecast in the next 24 hours"
 *
 * Day words: a time on the next local day gets " tomorrow" (from 05:00);
 * 00:00–04:59 is "overnight".
 */

export const HIGHLIGHT_LIMITS = {
  max: 5,
  precipLikelyPct: 60,
  precipPossiblePct: 30,
  /** mm in one hour that counts as precipitation when probabilities are not published. */
  precipAmountMm: 0.5,
  /** mm in one hour that counts as heavy. */
  heavyPrecipMm: 4,
  gustMs: 15,
  strongWindMs: 10.8,
  freezingC: 0,
  hotC: 30,
  dryMaxProbabilityPct: 10,
  dryMinHours: 12,
} as const;

const L = HIGHLIGHT_LIMITS;

function localHour(d: Date, timeZone: string): number {
  return new Date(d.getTime() + timeZoneOffsetMs(d, timeZone)).getUTCHours();
}

/** "4 PM" / "4:30 PM" in the trail's time zone. */
export function clockTime(d: Date, timeZone: string): string {
  return formatLocalTime(d, timeZone).replace(/:00(?= )/, "");
}

/** "around 4 PM" (+ " tomorrow" for the next local day from 05:00). */
function around(d: Date, now: Date, timeZone: string): string {
  const tomorrow = localDateKey(d, timeZone) !== localDateKey(now, timeZone) && localHour(d, timeZone) >= 5;
  return `around ${clockTime(d, timeZone)}${tomorrow ? " tomorrow" : ""}`;
}

/** "this afternoon", "tomorrow morning", "overnight", ... */
function partOfDay(d: Date, now: Date, timeZone: string): string {
  const h = localHour(d, timeZone);
  if (h < 5) return "overnight";
  const today = localDateKey(d, timeZone) === localDateKey(now, timeZone);
  const part = h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
  if (today) return part === "night" ? "tonight" : `this ${part}`;
  return `tomorrow ${part}`;
}

/** "−3 °C" with a real minus sign; one decimal when rounding would hide a sub-zero value. */
export function formatTemp(c: number): string {
  const r = Math.round(c);
  const shown = r === 0 && c < 0 ? Math.round(c * 10) / 10 : r;
  return `${shown < 0 ? "−" : ""}${Math.abs(shown)} °C`;
}

/** "18 m/s (65 km/h)". */
export function formatWind(ms: number): string {
  return `${Math.round(ms)} m/s (${Math.round(ms * 3.6)} km/h)`;
}

const mm = (v: number) => `${Math.round(v * 10) / 10} mm`;

/** Precipitation word from a symbol code. */
function precipWord(symbol: string | null): "Rain" | "Snow" | "Sleet" | "Precipitation" {
  if (!symbol) return "Precipitation";
  if (symbol.includes("snow")) return "Snow";
  if (symbol.includes("sleet")) return "Sleet";
  if (symbol.includes("rain")) return "Rain";
  return "Precipitation";
}

const heavy = (word: string) => `Heavy ${word === "Precipitation" ? "precipitation" : word.toLowerCase()}`;

const at = (h: HourlyForecastDto) => new Date(h.time);

function peak(hours: HourlyForecastDto[], value: (h: HourlyForecastDto) => number | null): { hour: HourlyForecastDto; value: number } | null {
  let best: { hour: HourlyForecastDto; value: number } | null = null;
  for (const h of hours) {
    const v = value(h);
    if (v !== null && Number.isFinite(v) && (best === null || v > best.value)) best = { hour: h, value: v };
  }
  return best;
}

function trough(hours: HourlyForecastDto[], value: (h: HourlyForecastDto) => number | null): { hour: HourlyForecastDto; value: number } | null {
  const p = peak(hours, (h) => {
    const v = value(h);
    return v === null ? null : -v;
  });
  return p ? { hour: p.hour, value: -p.value } : null;
}

/**
 * Highlights for the next hours (pass the hourly forecast from the current
 * hour on, normally 24 entries). Returns [] for an empty forecast. Throws
 * RangeError for an unknown time zone.
 */
export function forecastHighlights(hourly: readonly HourlyForecastDto[], now: Date, timeZone: string): string[] {
  const hours = hourly.filter((h) => Number.isFinite(Date.parse(h.time)));
  if (hours.length === 0) return [];
  const out: string[] = [];
  let precipitationSaid = false;

  // 1. Thunder (symbol codes only).
  const thunder = hours.find((h) => h.symbol?.includes("thunder"));
  if (thunder) {
    out.push(`Thunderstorms possible ${partOfDay(at(thunder), now, timeZone)} (around ${clockTime(at(thunder), timeZone)})`);
    precipitationSaid = true;
  }

  // 2–3. Precipitation.
  const hasProbabilities = hours.some((h) => h.precipitationProbability !== null);
  const wettest = peak(hours, (h) => h.precipitationMm);
  if (hasProbabilities) {
    if (wettest && wettest.value >= L.heavyPrecipMm) {
      out.push(`${heavy(precipWord(wettest.hour.symbol))} ${around(at(wettest.hour), now, timeZone)} (up to ${mm(wettest.value)} per hour)`);
      precipitationSaid = true;
    }
    const likely = hours.find((h) => (h.precipitationProbability ?? -1) >= L.precipLikelyPct);
    const possible = likely ? null : hours.find((h) => (h.precipitationProbability ?? -1) >= L.precipPossiblePct);
    const first = likely ?? possible;
    if (first) {
      const pct = Math.round(first.precipitationProbability as number);
      out.push(`${precipWord(first.symbol)} ${likely ? "likely" : "possible"} ${around(at(first), now, timeZone)} (${pct}% chance)`);
      precipitationSaid = true;
    }
  } else {
    const onset = hours.find((h) => (h.precipitationMm ?? -1) >= L.precipAmountMm);
    if (onset && wettest) {
      const word = wettest.value >= L.heavyPrecipMm ? heavy(precipWord(wettest.hour.symbol)) : precipWord(onset.symbol);
      out.push(`${word} forecast ${around(at(onset), now, timeZone)} (up to ${mm(wettest.value)} per hour)`);
      precipitationSaid = true;
    }
  }

  // 4. Wind.
  const hasGusts = hours.some((h) => h.windGustMs !== null);
  if (hasGusts) {
    const gust = peak(hours, (h) => h.windGustMs);
    if (gust && gust.value >= L.gustMs) out.push(`Gusts up to ${formatWind(gust.value)} ${around(at(gust.hour), now, timeZone)}`);
  } else {
    const windy = peak(hours, (h) => h.windSpeedMs);
    if (windy && windy.value >= L.strongWindMs) out.push(`Strong wind up to ${formatWind(windy.value)} ${around(at(windy.hour), now, timeZone)}`);
  }

  // 5. Freezing.
  const coldest = trough(hours, (h) => h.temperatureC);
  if (coldest && coldest.value < L.freezingC) {
    const h = localHour(at(coldest.hour), timeZone);
    const overnight = h >= 21 || h < 9;
    out.push(
      `Below freezing${overnight ? " overnight" : ""} (down to ${formatTemp(coldest.value)} ${around(at(coldest.hour), now, timeZone)})`,
    );
  }

  // 6. Heat.
  const hottest = peak(hours, (h) => h.temperatureC);
  if (hottest && hottest.value >= L.hotC) {
    out.push(`Hot ${around(at(hottest.hour), now, timeZone)} (up to ${formatTemp(hottest.value)})`);
  }

  // 7. Dry.
  if (!precipitationSaid) {
    const known = hours.filter((h) => h.precipitationMm !== null);
    const dry =
      known.length >= L.dryMinHours &&
      known.length === hours.length &&
      known.every((h) => (h.precipitationMm as number) <= 0) &&
      hours.every((h) => h.precipitationProbability === null || h.precipitationProbability < L.dryMaxProbabilityPct);
    if (dry) out.push(`No precipitation forecast in the next ${hours.length} hours`);
  }

  return out.slice(0, L.max);
}
