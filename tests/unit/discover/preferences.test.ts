import { describe, expect, it } from "vitest";
import {
  defaultPlanDate,
  parsePlanQuery,
  parseTripPreferences,
  toPlanQuery,
  validatePlanTiming,
} from "@/server/discover/preferences";
import { filterTrails, parseTrailFilters, filtersToQuery, worstClosure } from "@/server/discover/browse";

const base =
  "experience=some&fitness=moderate&terrain=forest&terrain=river&pace=steady&hours=4&minMi=2&maxMi=5&maxGainFt=1500&date=2026-11-14&start=08:30&needs=rest_stops&party=2&gear=headlamp";

describe("parsePlanQuery", () => {
  it("validates the questionnaire and converts imperial form units to metric preferences", () => {
    const r = parsePlanQuery(new URLSearchParams(`${base}&dog=yes&trail=lantern-creek-loop`));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trailSlug).toBe("lantern-creek-loop");
    expect(r.prefs).toMatchObject({
      experience: "some",
      fitness: "moderate",
      preferredTerrain: ["forest", "river"],
      availableHours: 4,
      distanceKmMin: 3.219,
      distanceKmMax: 8.047,
      maxElevationGainM: 457.2,
      plannedDate: "2026-11-14",
      startTime: "08:30",
      accessibilityNeeds: ["rest_stops"],
      partySize: 2,
      equipment: ["headlamp"],
      bringingDog: true,
    });
  });

  it("round-trips through the canonical query string", () => {
    const r = parsePlanQuery(new URLSearchParams(base));
    if (!r.ok) throw new Error("expected ok");
    const again = parsePlanQuery(new URLSearchParams(toPlanQuery(r.prefs)));
    expect(again).toEqual(r);
  });

  it("reports field errors for invalid input and ignores unknown parameters", () => {
    const r = parsePlanQuery(
      new URLSearchParams("experience=guru&fitness=moderate&pace=steady&hours=40&date=2026-02-30&start=25:00&party=13&terrain=lava&score=100"),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(["date", "experience", "hours", "party", "start", "terrain"]);
    expect(r.hasInput).toBe(true);
  });

  it("rejects a minimum distance above the maximum", () => {
    const r = parsePlanQuery(new URLSearchParams(base.replace("minMi=2", "minMi=9")));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.maxMi).toMatch(/Minimum distance/);
  });

  it("treats an empty query as a first visit", () => {
    const r = parsePlanQuery(new URLSearchParams("trail=lantern-creek-loop"));
    expect(r).toMatchObject({ ok: false, hasInput: false });
  });
});

describe("parseTripPreferences (saved shape)", () => {
  it("strips unknown keys such as tampered scores", () => {
    const r = parseTripPreferences({
      experience: "regular",
      fitness: "high",
      preferredTerrain: [],
      pace: "brisk",
      availableHours: 6,
      plannedDate: "2026-12-01",
      startTime: "09:00",
      accessibilityNeeds: [],
      partySize: 3,
      equipment: [],
      score: 100,
      recommendation: { score: 100 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.prefs).not.toHaveProperty("score");
      expect(r.prefs).not.toHaveProperty("recommendation");
    }
  });
});

describe("plan timing", () => {
  const now = new Date("2026-11-05T18:00:00Z"); // 10:00 in Los Angeles
  it("requires today or later in the region's time zone", () => {
    expect(validatePlanTiming({ plannedDate: "2026-11-04", startTime: "09:00" }, now, "America/Los_Angeles")).toHaveProperty("date");
    expect(validatePlanTiming({ plannedDate: "2026-11-05", startTime: "09:00" }, now, "America/Los_Angeles")).toHaveProperty("start");
    expect(validatePlanTiming({ plannedDate: "2026-11-05", startTime: "11:00" }, now, "America/Los_Angeles")).toEqual({});
    // 01:00Z on Nov 6 is still Nov 5 in Los Angeles
    expect(validatePlanTiming({ plannedDate: "2026-11-05", startTime: "20:00" }, new Date("2026-11-06T01:00:00Z"), "America/Los_Angeles")).toEqual({});
    expect(validatePlanTiming({ plannedDate: "2028-01-01", startTime: "09:00" }, now, "America/Los_Angeles")).toHaveProperty("date");
  });

  it("defaults to the next Saturday", () => {
    expect(defaultPlanDate("2026-11-05")).toBe("2026-11-07"); // Thursday → Saturday
    expect(defaultPlanDate("2026-11-07")).toBe("2026-11-14"); // Saturday → next Saturday
    expect(defaultPlanDate("2026-11-08")).toBe("2026-11-14"); // Sunday
  });
});

describe("trail browse filters", () => {
  const trails = [
    { name: "A", difficulty: "easy" as const, distanceKm: 3.2, elevationGainM: 40, terrain: ["forest"], accessibilityFeatures: ["benches", "firm_surface"], dogsAllowed: true },
    { name: "B", difficulty: "hard" as const, distanceKm: 12.8, elevationGainM: 780, terrain: ["ridge"], accessibilityFeatures: [], dogsAllowed: false },
    { name: "C", difficulty: "moderate" as const, distanceKm: 5.6, elevationGainM: 220, terrain: ["river"], accessibilityFeatures: ["shade"], dogsAllowed: null },
  ];
  it("parses leniently and filters", () => {
    const f = parseTrailFilters({ difficulty: ["easy", "moderate", "bogus"], maxMi: "4", access: "benches", view: "weird" });
    expect(f).toMatchObject({ view: "list", difficulty: ["easy", "moderate"], maxMi: 4, access: ["benches"] });
    expect(filterTrails(trails, f).map((t) => t.name)).toEqual(["A"]);
    expect(filterTrails(trails, parseTrailFilters({ dogs: "yes" })).map((t) => t.name)).toEqual(["A"]);
    expect(filterTrails(trails, parseTrailFilters({ maxGainFt: "800" })).map((t) => t.name)).toEqual(["A", "C"]);
    expect(filtersToQuery(f, { view: "map" })).toBe("?view=map&difficulty=easy&difficulty=moderate&maxMi=4&access=benches");
  });
  it("picks the most severe closure", () => {
    expect(worstClosure([{ severity: "advisory" }, { severity: "partial" }])).toBe("partial");
    expect(worstClosure([])).toBeNull();
  });
});
