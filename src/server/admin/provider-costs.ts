import "server-only";
import type { ServerEnv } from "@/config/env";
import type { ProviderKey } from "@/server/providers/http";

/**
 * Cost and usage-policy configuration for every external data provider
 * (one entry per ProviderKey in src/server/providers/http.ts), shown on the
 * admin "Trail data" page next to the measured usage.
 *
 * Maintain this file when a provider changes its terms or when Ghost Guide
 * moves to a paid plan: update `pricing` (metered plans compute an estimate
 * from the last 30 days of usage), `limits` (drive the "approaching the
 * limit" warnings), `policy`, `docsUrl` and `reviewedOn`. Numbers come from
 * each provider's published policy (see docsUrl); "fair_use" limits are
 * guidelines of a free public service, "hard" limits are enforced.
 *
 * What usage can be compared against: usage is recorded per UTC day
 * (public.external_api_usage), so per-day, per-month and bytes-per-day
 * limits are checked directly; per-second limits only against the average
 * rate (peaks are not measured); concurrency limits are shown, not checked
 * (the clients enforce them: Overpass fetch concurrency, Nominatim spacing).
 */

export type UsageLimitKind = "requests_per_day" | "requests_per_month" | "requests_per_second" | "bytes_per_day" | "concurrent_requests";

export interface UsageLimit {
  kind: UsageLimitKind;
  value: number;
  /** As the provider states it, e.g. "≈ 10 000 queries/day". */
  label: string;
  enforcement: "hard" | "fair_use";
}

export type Pricing =
  /** No charge at the current usage level. */
  | { model: "free" }
  /** Pay per request beyond a monthly free allowance. */
  | { model: "metered"; freeRequestsPerMonth: number; usdPerThousandRequests: number };

export interface ProviderCostPolicy {
  provider: ProviderKey;
  /** Plan or instance in use, e.g. "Public instance overpass-api.de". */
  plan: string;
  pricing: Pricing;
  /** One line shown next to the cost, e.g. "Nominatim: max 1 req/s, no autocomplete". */
  policy: string;
  limits: readonly UsageLimit[];
  /** Obligations of the terms of use that the integration must keep. */
  requirements: readonly string[];
  /** The provider's usage policy / terms (https). */
  docsUrl: string;
  /** Server env var that must be set for the provider to be used (null: none). */
  keyEnv: keyof ServerEnv | null;
  /** What to do when the free tier is outgrown (null: nothing planned). */
  scaleOption: string | null;
  /** When the numbers above were last checked against docsUrl (YYYY-MM-DD). */
  reviewedOn: string;
}

export const PROVIDER_COSTS: Readonly<Record<ProviderKey, ProviderCostPolicy>> = {
  overpass: {
    provider: "overpass",
    plan: "Public instance (overpass-api.de), free",
    pricing: { model: "free" },
    policy: "Overpass public instance: fair use ≈ 10 000 queries/day, 2 concurrent per IP",
    limits: [
      { kind: "requests_per_day", value: 10_000, label: "≈ 10 000 queries/day", enforcement: "fair_use" },
      { kind: "bytes_per_day", value: 1_000_000_000, label: "< 1 GB downloaded/day", enforcement: "fair_use" },
      { kind: "concurrent_requests", value: 2, label: "2 concurrent queries per IP", enforcement: "hard" },
    ],
    requirements: ["Identifying User-Agent", "ODbL attribution (© OpenStreetMap contributors) wherever the data is shown"],
    docsUrl: "https://dev.overpass-api.de/overpass-doc/en/preface/commons.html",
    keyEnv: null,
    scaleOption: "Self-hosted or commercial Overpass instance (≈ $40–80/month VPS); point OVERPASS_URLS at it",
    reviewedOn: "2026-11-12",
  },
  nominatim: {
    provider: "nominatim",
    plan: "Public OSMF instance (nominatim.openstreetmap.org), free",
    pricing: { model: "free" },
    policy: "Nominatim: max 1 req/s, no autocomplete",
    limits: [{ kind: "requests_per_second", value: 1, label: "max 1 request/second (absolute)", enforcement: "hard" }],
    requirements: ["Identifying User-Agent", "No autocomplete / search-as-you-type", "Cache results", "ODbL attribution"],
    docsUrl: "https://operations.osmfoundation.org/policies/nominatim/",
    keyEnv: null,
    scaleOption: "Paid geocoder (e.g. Mapbox, Stadia Maps) or a self-hosted Nominatim behind the same interface",
    reviewedOn: "2026-11-12",
  },
  metno: {
    provider: "metno",
    plan: "MET Norway Locationforecast, free (CC BY 4.0)",
    pricing: { model: "free" },
    policy: "MET Norway: ≤ 20 req/s, must cache",
    limits: [{ kind: "requests_per_second", value: 20, label: "≤ 20 requests/second per application", enforcement: "hard" }],
    requirements: ["Identifying User-Agent with contact", "Cache responses and honor Expires / If-Modified-Since", "At most 4 coordinate decimals", "CC BY 4.0 attribution"],
    docsUrl: "https://api.met.no/doc/TermsOfService",
    keyEnv: null,
    scaleOption: "Above 20 requests/second: agree terms with MET Norway",
    reviewedOn: "2026-11-12",
  },
  nws: {
    provider: "nws",
    plan: "api.weather.gov, free (US government)",
    pricing: { model: "free" },
    policy: "NWS: free, User-Agent required",
    // NWS applies an unpublished "reasonable" rate limit (HTTP 429 when exceeded); nothing to compare against.
    limits: [],
    requirements: ["User-Agent identifying the application and a contact"],
    docsUrl: "https://www.weather.gov/documentation/services-web-api",
    keyEnv: null,
    scaleOption: null,
    reviewedOn: "2026-11-12",
  },
  terrain_tiles: {
    provider: "terrain_tiles",
    plan: "AWS Open Data Terrain Tiles, free",
    pricing: { model: "free" },
    policy: "AWS Terrain Tiles: free (AWS Open Data)",
    limits: [],
    requirements: ["No key", "Attribute the underlying elevation sources"],
    docsUrl: "https://registry.opendata.aws/terrain-tiles/",
    keyEnv: null,
    scaleOption: null,
    reviewedOn: "2026-11-12",
  },
  ridb: {
    provider: "ridb",
    plan: "Recreation.gov RIDB API, free with key",
    pricing: { model: "free" },
    policy: "RIDB: free with key, 50 req/s",
    limits: [{ kind: "requests_per_second", value: 50, label: "50 requests/second (RIDB API spec)", enforcement: "hard" }],
    requirements: ["API key in the apikey header (RIDB_API_KEY)", "Attribute Recreation.gov"],
    docsUrl: "https://ridb.recreation.gov/docs",
    keyEnv: "RIDB_API_KEY",
    scaleOption: null,
    reviewedOn: "2026-11-12",
  },
};

// ---------------------------------------------------------------------------
// Cost estimate
// ---------------------------------------------------------------------------

/**
 * Estimated cost (USD, rounded to cents) of `monthlyRequests` requests in a
 * month under `pricing`. Free plans cost 0 whatever the volume (their limits
 * are policy limits, reported as warnings, not charges).
 */
export function estimateMonthlyCostUsd(pricing: Pricing, monthlyRequests: number): number {
  if (pricing.model === "free") return 0;
  const requests = Number.isFinite(monthlyRequests) ? Math.max(0, monthlyRequests) : 0;
  const billable = Math.max(0, requests - Math.max(0, pricing.freeRequestsPerMonth));
  return Math.round((billable / 1000) * Math.max(0, pricing.usdPerThousandRequests) * 100) / 100;
}

export function formatUsd(usd: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(usd);
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/** Fraction of a limit at which usage is reported as approaching it. */
export const WARN_FRACTION = 0.8;
/** Error-rate warning: at least this share of today's requests failed… */
export const ERROR_RATE_WARN = 0.25;
/** …out of at least this many requests (a few failures are noise). */
export const ERROR_RATE_MIN_REQUESTS = 10;

export interface UsageSnapshot {
  requestsToday: number;
  errorsToday: number;
  bytesToday: number;
  /** Busiest UTC day of the last 7 (requests / bytes). */
  peakDayRequests7d: number;
  peakDayBytes7d: number;
  requests30d: number;
  /** HTTP status of the most recent request (null: none or a network error). */
  lastStatus: number | null;
}

export interface UsageWarning {
  level: "warning" | "critical";
  message: string;
}

const nf = new Intl.NumberFormat("en-US");
const pct = (x: number) => `${Math.round(x * 100)} %`;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3));
  const v = bytes / 1000 ** i;
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Seconds since 00:00 UTC of `now` (at least 60, so early-morning averages stay meaningful). */
export function secondsSinceUtcMidnight(now: Date): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(60, (now.getTime() - midnight) / 1000);
}

function levelFor(fraction: number): UsageWarning["level"] | null {
  if (fraction >= 1) return "critical";
  if (fraction >= WARN_FRACTION) return "warning";
  return null;
}

/**
 * Warnings for one provider: usage approaching or over a documented limit,
 * a high error rate today, or a last response that signals rate limiting or
 * a refusal. Pure.
 */
export function usageWarnings(policy: ProviderCostPolicy, u: UsageSnapshot, now: Date = new Date()): UsageWarning[] {
  const out: UsageWarning[] = [];
  for (const limit of policy.limits) {
    if (!(limit.value > 0)) continue;
    const kindOf = limit.enforcement === "fair_use" ? "fair-use guideline" : "limit";
    switch (limit.kind) {
      case "requests_per_day": {
        const used = Math.max(u.requestsToday, u.peakDayRequests7d);
        const level = levelFor(used / limit.value);
        if (level) {
          const when = u.requestsToday >= u.peakDayRequests7d ? "today" : "on the busiest day of the last 7";
          out.push({ level, message: `${nf.format(used)} requests ${when}: ${pct(used / limit.value)} of the ${kindOf} (${limit.label}).` });
        }
        break;
      }
      case "bytes_per_day": {
        const used = Math.max(u.bytesToday, u.peakDayBytes7d);
        const level = levelFor(used / limit.value);
        if (level) out.push({ level, message: `${formatBytes(used)} downloaded in one day: ${pct(used / limit.value)} of the ${kindOf} (${limit.label}).` });
        break;
      }
      case "requests_per_month": {
        const level = levelFor(u.requests30d / limit.value);
        if (level) out.push({ level, message: `${nf.format(u.requests30d)} requests in the last 30 days: ${pct(u.requests30d / limit.value)} of the ${kindOf} (${limit.label}).` });
        break;
      }
      case "requests_per_second": {
        const avg = u.requestsToday / secondsSinceUtcMidnight(now);
        const level = levelFor(avg / limit.value);
        if (level) {
          out.push({
            level,
            message: `Average ${avg.toFixed(2)} requests/second today: ${pct(avg / limit.value)} of the ${kindOf} (${limit.label}); peaks are higher than the average.`,
          });
        }
        break;
      }
      case "concurrent_requests":
        // Not measurable from daily usage; enforced by the client.
        break;
    }
  }
  if (u.requestsToday >= ERROR_RATE_MIN_REQUESTS && u.errorsToday / u.requestsToday >= ERROR_RATE_WARN) {
    out.push({ level: "warning", message: `${pct(u.errorsToday / u.requestsToday)} of today's requests failed (${nf.format(u.errorsToday)} of ${nf.format(u.requestsToday)}).` });
  }
  if (u.lastStatus === 429) {
    out.push({ level: "critical", message: "The last response was HTTP 429: the provider is rate-limiting Ghost Guide. Reduce request volume." });
  } else if (u.lastStatus === 401 || u.lastStatus === 403) {
    out.push({
      level: "critical",
      message: `The last response was HTTP ${u.lastStatus}: the provider refused the request (check the API key, User-Agent and usage policy).`,
    });
  }
  return out;
}
