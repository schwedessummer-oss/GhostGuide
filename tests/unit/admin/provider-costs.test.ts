/**
 * Provider cost / usage-policy configuration (src/server/admin/provider-costs.ts):
 * one well-formed entry per ProviderKey, the documented policy lines, the
 * monthly cost estimate, and the "approaching a documented limit" warnings.
 */
import { describe, expect, it } from "vitest";
import { PROVIDER_LABELS, type ProviderKey } from "@/server/providers/http";
import {
  ERROR_RATE_MIN_REQUESTS,
  PROVIDER_COSTS,
  WARN_FRACTION,
  estimateMonthlyCostUsd,
  formatBytes,
  formatUsd,
  secondsSinceUtcMidnight,
  usageWarnings,
  type ProviderCostPolicy,
  type UsageSnapshot,
} from "@/server/admin/provider-costs";

const KEYS = Object.keys(PROVIDER_LABELS) as ProviderKey[];
const idle: UsageSnapshot = { requestsToday: 0, errorsToday: 0, bytesToday: 0, peakDayRequests7d: 0, peakDayBytes7d: 0, requests30d: 0, lastStatus: 200 };
/** 12:00 UTC: 43 200 s into the day. */
const NOON = new Date("2026-11-12T12:00:00Z");

describe("provider cost configuration", () => {
  it("has exactly one entry per ProviderKey", () => {
    expect(Object.keys(PROVIDER_COSTS).sort()).toEqual([...KEYS].sort());
    for (const key of KEYS) expect(PROVIDER_COSTS[key].provider).toBe(key);
  });

  for (const key of KEYS) {
    describe(key, () => {
      const p: ProviderCostPolicy = PROVIDER_COSTS[key];

      it("links to the provider's policy over https", () => {
        const url = new URL(p.docsUrl);
        expect(url.protocol).toBe("https:");
        expect(url.hostname).toMatch(/\./);
      });

      it("has a plan, a one-line policy and a review date", () => {
        expect(p.plan.trim().length).toBeGreaterThan(5);
        expect(p.policy.trim().length).toBeGreaterThan(5);
        expect(p.policy).not.toMatch(/\n/);
        expect(p.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isNaN(Date.parse(`${p.reviewedOn}T00:00:00Z`))).toBe(false);
        expect(p.requirements.length).toBeGreaterThan(0);
        for (const r of p.requirements) expect(r.trim().length).toBeGreaterThan(2);
      });

      it("has well-formed limits", () => {
        const kinds = new Set<string>();
        for (const l of p.limits) {
          expect(Number.isFinite(l.value) && l.value > 0, `${l.kind} value`).toBe(true);
          expect(l.label.trim().length).toBeGreaterThan(3);
          expect(["hard", "fair_use"]).toContain(l.enforcement);
          expect(kinds.has(l.kind), `duplicate ${l.kind}`).toBe(false);
          kinds.add(l.kind);
        }
      });

      it("has well-formed pricing", () => {
        if (p.pricing.model === "metered") {
          expect(p.pricing.freeRequestsPerMonth).toBeGreaterThanOrEqual(0);
          expect(p.pricing.usdPerThousandRequests).toBeGreaterThan(0);
        } else {
          expect(p.pricing.model).toBe("free");
        }
      });
    });
  }

  it("states the documented policies of today's free providers", () => {
    expect(PROVIDER_COSTS.nominatim.policy).toBe("Nominatim: max 1 req/s, no autocomplete");
    expect(PROVIDER_COSTS.overpass.policy).toBe("Overpass public instance: fair use ≈ 10 000 queries/day, 2 concurrent per IP");
    expect(PROVIDER_COSTS.metno.policy).toBe("MET Norway: ≤ 20 req/s, must cache");
    expect(PROVIDER_COSTS.nws.policy).toBe("NWS: free, User-Agent required");
    expect(PROVIDER_COSTS.terrain_tiles.policy).toBe("AWS Terrain Tiles: free (AWS Open Data)");
    expect(PROVIDER_COSTS.ridb.policy).toMatch(/^RIDB: free with key/);
    expect(PROVIDER_COSTS.ridb.keyEnv).toBe("RIDB_API_KEY");
    expect(PROVIDER_COSTS.overpass.limits.find((l) => l.kind === "requests_per_day")?.value).toBe(10_000);
    expect(PROVIDER_COSTS.overpass.limits.find((l) => l.kind === "concurrent_requests")?.value).toBe(2);
    expect(PROVIDER_COSTS.nominatim.limits.find((l) => l.kind === "requests_per_second")?.value).toBe(1);
    expect(PROVIDER_COSTS.metno.limits.find((l) => l.kind === "requests_per_second")?.value).toBe(20);
    for (const key of KEYS) expect(PROVIDER_COSTS[key].pricing.model).toBe("free");
  });
});

describe("estimateMonthlyCostUsd", () => {
  it("is $0 for free plans at any volume", () => {
    for (const key of KEYS) expect(estimateMonthlyCostUsd(PROVIDER_COSTS[key].pricing, 5_000_000)).toBe(0);
  });

  it("charges metered usage beyond the free allowance, rounded to cents", () => {
    const metered = { model: "metered" as const, freeRequestsPerMonth: 100_000, usdPerThousandRequests: 0.75 };
    expect(estimateMonthlyCostUsd(metered, 0)).toBe(0);
    expect(estimateMonthlyCostUsd(metered, 100_000)).toBe(0);
    expect(estimateMonthlyCostUsd(metered, 101_000)).toBe(0.75);
    expect(estimateMonthlyCostUsd(metered, 250_000)).toBe(112.5);
    expect(estimateMonthlyCostUsd(metered, 100_333)).toBe(0.25);
    expect(estimateMonthlyCostUsd(metered, -5)).toBe(0);
    expect(estimateMonthlyCostUsd(metered, Number.NaN)).toBe(0);
    expect(estimateMonthlyCostUsd({ model: "metered", freeRequestsPerMonth: 0, usdPerThousandRequests: 2 }, 1500)).toBe(3);
  });

  it("formats dollars", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(112.5)).toBe("$112.50");
  });
});

describe("usageWarnings", () => {
  it("is quiet for idle providers and normal use", () => {
    for (const key of KEYS) expect(usageWarnings(PROVIDER_COSTS[key], idle, NOON)).toEqual([]);
    expect(usageWarnings(PROVIDER_COSTS.overpass, { ...idle, requestsToday: 1200, peakDayRequests7d: 3000 }, NOON)).toEqual([]);
  });

  it("warns when daily requests approach the Overpass fair-use guideline, and flags going over it", () => {
    const near = usageWarnings(PROVIDER_COSTS.overpass, { ...idle, requestsToday: 8_000 }, NOON);
    expect(near).toEqual([{ level: "warning", message: expect.stringContaining("8,000 requests today: 80 % of the fair-use guideline (≈ 10 000 queries/day)") }]);
    expect(WARN_FRACTION).toBe(0.8);
    expect(usageWarnings(PROVIDER_COSTS.overpass, { ...idle, requestsToday: 7_999 }, NOON)).toEqual([]);
    const over = usageWarnings(PROVIDER_COSTS.overpass, { ...idle, requestsToday: 200, peakDayRequests7d: 12_500 }, NOON);
    expect(over).toEqual([{ level: "critical", message: expect.stringContaining("12,500 requests on the busiest day of the last 7: 125 %") }]);
  });

  it("warns on bytes per day", () => {
    const w = usageWarnings(PROVIDER_COSTS.overpass, { ...idle, bytesToday: 900_000_000 }, NOON);
    expect(w).toEqual([{ level: "warning", message: expect.stringContaining("900 MB downloaded in one day: 90 %") }]);
  });

  it("compares per-second limits with today's average rate", () => {
    // Nominatim: 1 req/s. At noon, 43 200 s have passed: 34 560 requests = 0.8 req/s.
    expect(secondsSinceUtcMidnight(NOON)).toBe(43_200);
    const w = usageWarnings(PROVIDER_COSTS.nominatim, { ...idle, requestsToday: 34_560 }, NOON);
    expect(w).toHaveLength(1);
    expect(w[0].level).toBe("warning");
    expect(w[0].message).toContain("Average 0.80 requests/second today: 80 % of the limit (max 1 request/second (absolute))");
    expect(usageWarnings(PROVIDER_COSTS.nominatim, { ...idle, requestsToday: 30_000 }, NOON)).toEqual([]);
    // Just after midnight the average uses at least 60 s.
    expect(secondsSinceUtcMidnight(new Date("2026-11-12T00:00:05Z"))).toBe(60);
    expect(usageWarnings(PROVIDER_COSTS.nominatim, { ...idle, requestsToday: 60 }, new Date("2026-11-12T00:00:05Z"))[0].level).toBe("critical");
  });

  it("checks monthly limits against the last 30 days", () => {
    const policy: ProviderCostPolicy = {
      ...PROVIDER_COSTS.ridb,
      limits: [{ kind: "requests_per_month", value: 100_000, label: "100 000 requests/month", enforcement: "hard" }],
    };
    expect(usageWarnings(policy, { ...idle, requests30d: 79_999 }, NOON)).toEqual([]);
    expect(usageWarnings(policy, { ...idle, requests30d: 100_000 }, NOON)[0]).toEqual({
      level: "critical",
      message: "100,000 requests in the last 30 days: 100 % of the limit (100 000 requests/month).",
    });
  });

  it("never checks concurrency limits from daily totals", () => {
    const policy: ProviderCostPolicy = { ...PROVIDER_COSTS.overpass, limits: PROVIDER_COSTS.overpass.limits.filter((l) => l.kind === "concurrent_requests") };
    expect(usageWarnings(policy, { ...idle, requestsToday: 1_000_000 }, NOON)).toEqual([]);
  });

  it("warns on a high error rate only with enough requests", () => {
    const n = ERROR_RATE_MIN_REQUESTS;
    expect(usageWarnings(PROVIDER_COSTS.nws, { ...idle, requestsToday: n - 1, errorsToday: n - 1 }, NOON)).toEqual([]);
    expect(usageWarnings(PROVIDER_COSTS.nws, { ...idle, requestsToday: 40, errorsToday: 10 }, NOON)).toEqual([
      { level: "warning", message: "25 % of today's requests failed (10 of 40)." },
    ]);
    expect(usageWarnings(PROVIDER_COSTS.nws, { ...idle, requestsToday: 40, errorsToday: 9 }, NOON)).toEqual([]);
  });

  it("flags rate limiting and refusals from the last response", () => {
    expect(usageWarnings(PROVIDER_COSTS.overpass, { ...idle, lastStatus: 429 }, NOON)).toEqual([
      { level: "critical", message: expect.stringContaining("HTTP 429") },
    ]);
    expect(usageWarnings(PROVIDER_COSTS.ridb, { ...idle, lastStatus: 401 }, NOON)[0].message).toContain("check the API key");
    expect(usageWarnings(PROVIDER_COSTS.metno, { ...idle, lastStatus: 403 }, NOON)[0].level).toBe("critical");
    expect(usageWarnings(PROVIDER_COSTS.metno, { ...idle, lastStatus: 500 }, NOON)).toEqual([]);
    expect(usageWarnings(PROVIDER_COSTS.metno, { ...idle, lastStatus: null }, NOON)).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("uses decimal units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_500)).toBe("1.5 KB");
    expect(formatBytes(25_000_000)).toBe("25 MB");
    expect(formatBytes(1_000_000_000)).toBe("1.0 GB");
  });
});
