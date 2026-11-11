import { describe, expect, it } from "vitest";
import { classifyFactFreshness, composeMarketingDraft, type MarketingFact } from "@/server/admin/marketing-template";

const now = new Date("2026-11-05T12:00:00Z");
const facts: MarketingFact[] = [
  { field: "distance_km", label: "Distance", value: "7.4 km (4.6 mi)", kind: "verified", sourceLabel: "Ridge Land Agency trail page", sourceUrl: "https://example.org/ridge", retrievedAt: "2026-10-01T09:00:00Z", verifiedAt: "2026-10-02T12:00:00Z" },
  { field: "estimated_duration_min", label: "Typical time", value: "about 3 h", kind: "estimate", sourceLabel: "Ghost Guide estimate", sourceUrl: null, retrievedAt: null, verifiedAt: "2026-09-20T12:00:00Z" },
  { field: "difficulty", label: "Difficulty", value: "Moderate", kind: "operator_note", sourceLabel: "Field survey", sourceUrl: null, retrievedAt: "2026-06-01T00:00:00Z", verifiedAt: "2026-06-01T00:00:00Z" },
];
const weather = {
  provider: "demo",
  simulated: true,
  fetchedAt: "2026-11-05T11:00:00Z",
  sourceUrl: null,
  periods: [{ name: "Today", startTime: "2026-11-05T14:00:00Z", endTime: "2026-11-06T02:00:00Z", isDaytime: true, temperature: 55, temperatureUnit: "F" as const, windSpeed: "5 mph", shortForecast: "Partly Cloudy", precipitationChancePct: 10 }],
};

describe("marketing draft template", () => {
  it("uses only the provided facts, with their sources and timestamps", () => {
    const d = composeMarketingDraft({ trailName: "Hollow Pine Ridge", regionName: "Ghost Ridge", isDemo: false, channel: "newsletter", facts, weather: null, now });
    expect(d.body).toContain("Distance: 7.4 km (4.6 mi) (verified; Ridge Land Agency trail page; verified 2026-10-02, source retrieved 2026-10-01)");
    expect(d.body).toContain("Typical time: about 3 h (estimate;");
    expect(d.body).toContain("Difficulty: Moderate (operator note; Field survey; reviewed 2026-06-01");
    expect(d.body).toContain("https://example.org/ridge");
    // every number in the body comes from the inputs (no invented figures)
    const allowed = new Set(["7.4", "4.6", "3", "2026", "10", "02", "01", "09", "20", "06"]);
    for (const n of d.body.match(/\d+(\.\d+)?/g) ?? []) expect(allowed.has(n), `unexpected number ${n}`).toBe(true);
    expect(d.body).not.toMatch(/^- (Elevation|Permit|Dogs|Parking|Highest)/m);
    expect(d.sources.map((s) => s.label)).toEqual(["Ridge Land Agency trail page", "Ghost Guide estimate", "Field survey"]);
    expect(d.factsAsOf).toBe("2026-06-01T00:00:00Z");
  });

  it("warns about stale facts, estimates, missing weather, and demo trails", () => {
    const d = composeMarketingDraft({ trailName: "Lantern Creek Loop", regionName: "Ghost Ridge", isDemo: true, channel: "web", facts, weather: null, now });
    const w = d.warnings.join(" ");
    expect(w).toMatch(/Difficulty was last reviewed 157 days ago/);
    expect(w).toMatch(/Typical time is an estimate/);
    expect(w).toMatch(/No weather snapshot/);
    expect(w).toMatch(/DEMONSTRATION/);
    expect(d.title).toMatch(/demonstration/);
    expect(d.body).toMatch(/fictional/);
  });

  it("labels simulated weather with its fetch time and drops unsourced facts", () => {
    const d = composeMarketingDraft({
      trailName: "Hollow Pine Ridge",
      regionName: "Ghost Ridge",
      isDemo: false,
      channel: "social",
      facts: [...facts, { ...facts[0], field: "x", label: "Unsourced", sourceLabel: " " }],
      weather,
      now,
    });
    expect(d.body).toContain("SIMULATED demo data, not a real forecast (generated 2026-11-05 11:00 UTC)");
    expect(d.body).toContain("Today: Partly Cloudy, 55°F, wind 5 mph, 10% chance of precipitation");
    expect(d.body).not.toContain("Unsourced");
    expect(d.warnings.join(" ")).toMatch(/SIMULATED/);
    expect(d.warnings.join(" ")).toMatch(/no source/);
    expect(d.sources.some((s) => s.label === "Simulated weather (demo provider)" && s.retrievedAt === weather.fetchedAt)).toBe(true);
  });

  it("says \"verified\" only for provenance kind 'verified'; other kinds were reviewed", () => {
    const d = composeMarketingDraft({ trailName: "Hollow Pine Ridge", regionName: "Ghost Ridge", isDemo: false, channel: "newsletter", facts, weather, now });
    const lines = d.body.split("\n");
    const line = (label: string) => lines.find((l) => l.startsWith(`- ${label}:`)) ?? "";
    expect(line("Distance")).toMatch(/verified 2026-10-02/);
    expect(line("Typical time")).toMatch(/reviewed 2026-09-20/);
    expect(line("Difficulty")).toMatch(/reviewed 2026-06-01/);
    for (const label of ["Typical time", "Difficulty"]) expect(line(label)).not.toMatch(/verified/);
    // source list: only a source whose facts are all 'verified' says verified
    expect(lines.find((l) => l.startsWith("- Ridge Land Agency trail page"))).toMatch(/verified 2026-10-02/);
    expect(lines.find((l) => l.startsWith("- Ghost Guide estimate"))).toMatch(/reviewed 2026-09-20/);
    expect(lines.find((l) => l.startsWith("- Field survey"))).not.toMatch(/verified/);
    expect(d.sources.map((s) => s.verifiedKind)).toEqual([true, false, false, false]);
    // a demo fact never reads as verified, and a source mixing kinds says reviewed
    const demo = composeMarketingDraft({
      trailName: "Lantern Creek Loop",
      regionName: "Ghost Ridge",
      isDemo: true,
      channel: "web",
      facts: [facts[0], { ...facts[0], field: "elev", label: "Elevation gain", value: "300 m", kind: "demo" }],
      weather: null,
      now,
    });
    expect(demo.body).toMatch(/- Elevation gain: 300 m \(demonstration data; Ridge Land Agency trail page; reviewed 2026-10-02/);
    expect(demo.sources[0].verifiedKind).toBe(false);
    expect(demo.body.split("\n").find((l) => l.startsWith("- Ridge Land Agency trail page"))).toMatch(/reviewed 2026-10-02/);
  });

  it("is deterministic", () => {
    const input = { trailName: "A", regionName: "B", isDemo: false, channel: "web" as const, facts, weather, now };
    expect(composeMarketingDraft(input)).toEqual(composeMarketingDraft(input));
  });

  it("classifies fact freshness at 90 days", () => {
    expect(classifyFactFreshness("2026-08-08T12:00:00Z", now)).toEqual({ status: "fresh", ageDays: 89 });
    expect(classifyFactFreshness("2026-08-01T12:00:00Z", now).status).toBe("stale");
    expect(classifyFactFreshness(null, now).status).toBe("unverified");
  });
});
