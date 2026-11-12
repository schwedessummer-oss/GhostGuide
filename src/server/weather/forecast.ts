import "server-only";
import type { DailyForecastDto, HourlyForecastDto } from "@/domain/catalog";
import { addDaysToKey, localDateKey, zonedTimeToUtc } from "@/server/geo/timezone";
import { toHourlyDto, type MetnoStep } from "./metno";

/**
 * Pure views over a MET Norway series (see ./metno.ts): the current hour,
 * the next 24 hourly steps and daily aggregates in the trail's time zone.
 * Deterministic for a given (series, now, timeZone); no I/O.
 *
 * MET series are hourly for ~2.5 days, then 6-hourly. Every step carries
 * forecasts for periods STARTING at that step (next_1_hours, next_6_hours),
 * which overlap. To aggregate without double counting, the series is turned
 * into a chain of non-overlapping periods (forecastPeriods): a step's 1-hour
 * period when the next step is ≤ 1 h away, else its 6-hour period, skipping
 * steps already covered.
 *
 * DAILY RULES (each local calendar day, DST-aware: days can be 23 or 25 h)
 *   minC / maxC      min / max of the instant temperatures of the day's steps
 *                    and of the 6-hour min/max of periods centred in the day
 *   precipitationMm  sum over the chain's periods whose MIDPOINT falls in the
 *                    day (a 6-hour period across midnight counts for the day
 *                    holding most of it); null when no period has a value
 *   maxWindMs        max instant (sustained) wind speed of the day's steps
 *   symbol           the most significant (symbolSeverity) symbol among the
 *                    6-hour periods STARTING between 06:00 and 18:00 local
 *                    (daytime hiking hours, chained without overlap); when the
 *                    day has none (e.g. late evening today), among the chain's
 *                    periods centred in the day
 * Today covers only the rest of the day from the current hour: past hours
 * are not part of a forecast.
 */

export const HOUR_MS = 3_600_000;
export const DEFAULT_HOURLY_COUNT = 24;
export const DEFAULT_DAILY_COUNT = 7;
/** Daytime window for the daily symbol, local clock. */
export const DAYTIME_START = "06:00";
export const DAYTIME_END = "18:00";

const t = (s: MetnoStep) => Date.parse(s.time);

/** Start of the hour containing `now` (MET steps are on whole UTC hours). */
const hourStart = (now: Date) => Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;

/** True when `s` has hourly resolution: a 1-hour period, or a next step 1 h later. */
function isHourly(steps: readonly MetnoStep[], i: number): boolean {
  if (steps[i].next1h) return true;
  const next = steps[i + 1];
  return next !== undefined && t(next) - t(steps[i]) <= HOUR_MS;
}

/** The hourly step covering `now` (time ≤ now < time + 1 h), or null when the series does not cover now. */
export function currentStep(steps: readonly MetnoStep[], now: Date): MetnoStep | null {
  const n = now.getTime();
  for (let i = steps.length - 1; i >= 0; i--) {
    const st = t(steps[i]);
    if (st > n) continue;
    return n - st < HOUR_MS && isHourly(steps, i) ? steps[i] : null;
  }
  return null;
}

/** Where "the future" starts: the current step, else the start of the current hour. */
function forecastStart(steps: readonly MetnoStep[], now: Date): number {
  const cur = currentStep(steps, now);
  return cur ? Math.min(t(cur), hourStart(now)) : hourStart(now);
}

/**
 * Hourly DTOs from the current hour for `count` hours (fewer when the
 * series' hourly part ends sooner). Steps before the current hour are past
 * and dropped; 6-hourly steps are never presented as hours.
 */
export function hourlyForecast(steps: readonly MetnoStep[], now: Date, count = DEFAULT_HOURLY_COUNT): HourlyForecastDto[] {
  const from = forecastStart(steps, now);
  const to = from + count * HOUR_MS;
  const out: HourlyForecastDto[] = [];
  for (let i = 0; i < steps.length && out.length < count; i++) {
    const st = t(steps[i]);
    if (st < from || st >= to) continue;
    if (isHourly(steps, i)) out.push(toHourlyDto(steps[i]));
  }
  return out;
}

/** A non-overlapping forecast period built from one step. */
export interface ForecastPeriod {
  start: number; // epoch ms
  end: number;
  precipitationMm: number | null;
  symbol: string | null;
  minC: number | null;
  maxC: number | null;
}

/**
 * Non-overlapping chain of periods for steps at or after `fromMs` (see the
 * module header). Steps without any period data are skipped.
 */
export function forecastPeriods(steps: readonly MetnoStep[], fromMs = -Infinity): ForecastPeriod[] {
  const out: ForecastPeriod[] = [];
  let cursor = fromMs;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const st = t(s);
    if (st < cursor) continue;
    const next = steps[i + 1];
    const gap = next ? t(next) - st : Infinity;
    let p: ForecastPeriod | null = null;
    if (s.next1h && (gap <= HOUR_MS || !s.next6h)) {
      p = { start: st, end: st + HOUR_MS, precipitationMm: s.next1h.precipitationMm, symbol: s.next1h.symbol, minC: null, maxC: null };
    } else if (s.next6h) {
      p = {
        start: st,
        end: st + 6 * HOUR_MS,
        precipitationMm: s.next6h.precipitationMm,
        symbol: s.next6h.symbol,
        minC: s.next6h.minC,
        maxC: s.next6h.maxC,
      };
    }
    if (!p) continue;
    out.push(p);
    cursor = p.end;
  }
  return out;
}

/**
 * How significant a MET symbol is, for picking a day's symbol (higher =
 * more significant; ties go to the earlier period):
 *   clearsky 0 < fair 1 < partlycloudy 2 < cloudy 3 < fog 4
 *   < precipitation 10–33: light 10 / normal 20 / heavy 30, + rain 0 · sleet 1 · snow 2, + 1 when continuous (not showers)
 *   < thunder 50–73: the same scale + 40
 * Unknown codes rank −1 (never chosen over a known code).
 */
export function symbolSeverity(code: string | null | undefined): number {
  if (typeof code !== "string") return -1;
  const base = code.replace(/_(day|night|polartwilight)$/, "");
  const simple: Record<string, number> = { clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3, fog: 4 };
  if (base in simple) return simple[base];
  const m = /^(light|heavy)?s?(rain|sleet|snow)(showers)?(andthunder)?$/.exec(base);
  if (!m) return -1;
  const intensity = m[1] === "light" ? 10 : m[1] === "heavy" ? 30 : 20;
  const kind = m[2] === "snow" ? 2 : m[2] === "sleet" ? 1 : 0;
  const continuous = m[3] ? 0 : 1;
  return (m[4] ? 40 : 0) + intensity + kind + continuous;
}

function mostSignificant(symbols: (string | null)[]): string | null {
  let best: string | null = null;
  let bestRank = -2;
  for (const s of symbols) {
    if (s === null) continue;
    const r = symbolSeverity(s);
    if (r > bestRank) {
      best = s;
      bestRank = r;
    }
  }
  return best;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Daily aggregates for up to `days` local days starting with today (in
 * `timeZone`), using only steps from the current hour on. Days the series
 * does not reach are omitted. See the module header for the rules.
 * Throws RangeError for an unknown time zone.
 */
export function dailyForecast(
  steps: readonly MetnoStep[],
  now: Date,
  timeZone: string,
  days = DEFAULT_DAILY_COUNT,
): DailyForecastDto[] {
  const from = forecastStart(steps, now);
  const future = steps.filter((s) => t(s) >= from);
  const periods = forecastPeriods(future, from);
  const todayKey = localDateKey(now, timeZone);
  const out: DailyForecastDto[] = [];

  for (let d = 0; d < days; d++) {
    const date = addDaysToKey(todayKey, d);
    const start = zonedTimeToUtc(date, "00:00", timeZone).getTime();
    const end = zonedTimeToUtc(addDaysToKey(date, 1), "00:00", timeZone).getTime();
    const inDay = (ms: number) => ms >= start && ms < end;
    const daySteps = future.filter((s) => inDay(t(s)));
    const dayPeriods = periods.filter((p) => inDay((p.start + p.end) / 2));
    if (daySteps.length === 0 && dayPeriods.length === 0) continue;

    const temps = [
      ...daySteps.map((s) => s.temperatureC),
      ...dayPeriods.flatMap((p) => [p.minC, p.maxC]),
    ].filter((v): v is number => v !== null);
    const winds = daySteps.map((s) => s.windSpeedMs).filter((v): v is number => v !== null);
    const precip = dayPeriods.map((p) => p.precipitationMm).filter((v): v is number => v !== null);

    // Daytime 6-hour periods, chained without overlap.
    const dayFrom = Math.max(from, zonedTimeToUtc(date, DAYTIME_START, timeZone).getTime());
    const dayTo = zonedTimeToUtc(date, DAYTIME_END, timeZone).getTime();
    const daytime: (string | null)[] = [];
    let cursor = dayFrom;
    for (const s of future) {
      const st = t(s);
      if (st < cursor || st >= dayTo || !s.next6h?.symbol) continue;
      daytime.push(s.next6h.symbol);
      cursor = st + 6 * HOUR_MS;
    }
    const symbol = mostSignificant(daytime) ?? mostSignificant(dayPeriods.map((p) => p.symbol));

    out.push({
      date,
      minC: temps.length ? Math.min(...temps) : null,
      maxC: temps.length ? Math.max(...temps) : null,
      precipitationMm: precip.length ? round1(precip.reduce((a, b) => a + b, 0)) : null,
      maxWindMs: winds.length ? Math.max(...winds) : null,
      symbol,
    });
  }
  return out;
}
