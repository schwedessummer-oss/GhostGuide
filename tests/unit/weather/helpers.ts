/**
 * Builders for synthetic MET Norway series and hourly DTOs used by the
 * weather unit tests. Values are invented for tests only.
 */
import { readFileSync } from "node:fs";
import type { HourlyForecastDto } from "@/domain/catalog";
import type { MetnoStep } from "@/server/weather/metno";

export const HOUR = 3_600_000;

export const fixtureJson = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8"));
export const fixtureText = (name: string): string => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");

export interface StepSpec {
  t?: number | null;
  wind?: number | null;
  gust?: number | null;
  /** next_1_hours precipitation; omit all 1h fields for a step without a 1-hour period. */
  p1?: number | null;
  prob1?: number | null;
  sym1?: string | null;
  /** next_6_hours. */
  p6?: number | null;
  prob6?: number | null;
  sym6?: string | null;
  min6?: number | null;
  max6?: number | null;
}

export function step(time: string | number, s: StepSpec = {}): MetnoStep {
  const has1 = "p1" in s || "prob1" in s || "sym1" in s;
  const has6 = "p6" in s || "prob6" in s || "sym6" in s || "min6" in s || "max6" in s;
  return {
    time: new Date(time).toISOString(),
    temperatureC: s.t ?? null,
    windSpeedMs: s.wind ?? null,
    windGustMs: s.gust ?? null,
    next1h: has1 ? { precipitationMm: s.p1 ?? null, probability: s.prob1 ?? null, symbol: s.sym1 ?? null } : null,
    next6h: has6
      ? { precipitationMm: s.p6 ?? null, probability: s.prob6 ?? null, symbol: s.sym6 ?? null, minC: s.min6 ?? null, maxC: s.max6 ?? null }
      : null,
  };
}

/** `count` steps every `everyH` hours from `startIso`; `spec(i, ms)` gives each step's fields. */
export function series(startIso: string, count: number, everyH: number, spec: (i: number, ms: number) => StepSpec): MetnoStep[] {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => {
    const ms = start + i * everyH * HOUR;
    return step(ms, spec(i, ms));
  });
}

export interface HourSpec {
  t?: number | null;
  mm?: number | null;
  prob?: number | null;
  wind?: number | null;
  gust?: number | null;
  sym?: string | null;
}

/** `count` hourly DTOs from `startIso`; `spec(i)` overrides defaults (dry, mild, calm, no probabilities). */
export function hours(startIso: string, count: number, spec: (i: number) => HourSpec = () => ({})): HourlyForecastDto[] {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => {
    const s = spec(i);
    return {
      time: new Date(start + i * HOUR).toISOString(),
      temperatureC: s.t === undefined ? 10 : s.t,
      precipitationMm: s.mm === undefined ? 0 : s.mm,
      precipitationProbability: s.prob === undefined ? null : s.prob,
      windSpeedMs: s.wind === undefined ? 3 : s.wind,
      windGustMs: s.gust === undefined ? null : s.gust,
      symbol: s.sym === undefined ? "cloudy" : s.sym,
    };
  });
}
