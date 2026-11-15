import { describe, expect, it } from "vitest";
import type { CuratedFact } from "../../../ingest/src/data/schemas";
import { publishedColumns, resolveFacts, toMinorUnits, valueKeyOf } from "../../../ingest/src/load/facts";

function fact(field: CuratedFact["field"], value: unknown, extra: Partial<CuratedFact> = {}): CuratedFact {
  return {
    field,
    value,
    basis: null,
    note: null,
    sourceUrl: "https://www.nps.gov/yose/planyourvisit/halfdome.htm",
    sourceTitle: "Half Dome",
    publisher: "National Park Service",
    checkedAt: "2026-11-15",
    evidenceHeading: null,
    verified: true,
    verifyReason: null,
    ...extra,
  };
}

describe("toMinorUnits", () => {
  it("uses the currency's minor unit", () => {
    expect(toMinorUnits(35, 2)).toBe(3500);
    expect(toMinorUnits(10.1, 2)).toBe(1010);
    expect(toMinorUnits(0.29, 2)).toBe(29);
    expect(toMinorUnits(1000, 0)).toBe(1000); // JPY
    expect(toMinorUnits(1.5, 3)).toBe(1500); // JOD
  });

  it("refuses amounts finer than the currency allows", () => {
    expect(() => toMinorUnits(12.345, 2)).toThrow(/more than 2 decimals/);
    expect(() => toMinorUnits(100.5, 0)).toThrow(/more than 0 decimals/);
  });
});

describe("valueKeyOf", () => {
  it("names each value of multi-valued fields", () => {
    expect(valueKeyOf("permit", { name: "Day permit", kind: "lottery" })).toBe("Day permit");
    expect(valueKeyOf("fee", { name: "Entry", amount: 35, currency: "USD", unit: "per_vehicle", audience: "all" })).toBe("Entry|all|per_vehicle");
    expect(valueKeyOf("hazard", { type: "heat", note: "x" })).toBe("heat");
    expect(valueKeyOf("parking", "text")).toBeNull();
  });
});

describe("resolveFacts", () => {
  it("keeps one fact per field, and the first of agreeing text facts", () => {
    const first = fact("public_transport", "Shuttle A");
    const second = fact("public_transport", "Bus B", { sourceUrl: "https://www.nps.gov/yose/bus.htm" });
    const r = resolveFacts([first, second, fact("hazard", { type: "heat", note: "a" }), fact("hazard", { type: "heat", note: "b" })]);
    expect(r.chosen.map((f) => [f.field, f.value])).toEqual([
      ["public_transport", "Shuttle A"],
      ["hazard", { type: "heat", note: "a" }],
    ]);
    expect(r.extras).toHaveLength(2);
    expect(r.conflicts).toEqual([]);
  });

  it("loads none of the facts that contradict each other (never guesses)", () => {
    const r = resolveFacts([
      fact("distance_km", 10, { basis: "one_way" }),
      fact("distance_km", 20, { basis: "round_trip" }),
      fact("rule_dogs", { value: "allowed", note: "On leash." }),
      fact("rule_dogs", { value: "not_allowed", note: "No dogs." }),
      fact("rule_camping", { value: "restricted", note: "Huts only." }),
      fact("rule_camping", { value: "restricted", note: "Designated sites." }),
      fact("closure", { status: "seasonal", note: "Winter." }),
      fact("closure", { status: "partially_closed", note: "Bridge out." }),
      fact("route_type", "loop"),
      fact("route_type", "loop"),
    ]);
    expect(r.conflicts.map((c) => c.field)).toEqual(["distance_km", "rule_dogs", "closure"]);
    expect(r.chosen.map((f) => f.field)).toEqual(["rule_camping", "route_type"]);
  });

  it("fees conflict only when the same fee has different amounts", () => {
    const fee = (amount: number, note?: string) => fact("fee", { name: "Entry", amount, currency: "USD", unit: "per_person", audience: "all", note });
    expect(resolveFacts([fee(10, "a"), fee(10, "b")]).conflicts).toEqual([]);
    expect(resolveFacts([fee(10), fee(12)]).conflicts).toHaveLength(1);
  });
});

describe("publishedColumns", () => {
  const defaults = { officialUrl: "https://seed.example.org/hike", accessMode: "independent" };

  it("is all null (plus seed defaults) without facts", () => {
    const cols = publishedColumns([], defaults);
    expect(cols.distance_km).toBeNull();
    expect(cols.best_months).toBeNull();
    expect(cols.official_url).toBe(defaults.officialUrl);
    expect(cols.access_mode).toBe("independent");
    expect(cols.operating_status).toBe("unknown");
    expect(cols.last_verified_at).toBeNull();
  });

  it("copies current verified facts into the hike columns", () => {
    const cols = publishedColumns(
      [
        { field: "distance_km", value: 22.4, basis: "round_trip", checkedAt: "2026-11-14T00:00:00Z" },
        { field: "duration", value: { min_hours: 10, max_hours: 12.5 }, basis: null, checkedAt: "2026-11-15T00:00:00Z" },
        { field: "nearest_town", value: { name: "Yosemite Valley" }, basis: null, checkedAt: null },
        { field: "closure", value: { status: "seasonal", note: "x" }, basis: null, checkedAt: null },
        { field: "official_url", value: "https://www.nps.gov/yose/planyourvisit/halfdome.htm", basis: null, checkedAt: null },
        { field: "access_mode", value: "guide_recommended", basis: null, checkedAt: null },
        { field: "fee", value: { name: "x" }, basis: null, checkedAt: null },
      ],
      defaults,
    );
    expect(cols).toMatchObject({
      distance_km: 22.4,
      distance_basis: "round_trip",
      duration_min_minutes: 600,
      duration_max_minutes: 750,
      duration_min_days: null,
      nearest_town: "Yosemite Valley",
      operating_status: "seasonal",
      official_url: "https://www.nps.gov/yose/planyourvisit/halfdome.htm",
      access_mode: "guide_recommended",
      last_verified_at: "2026-11-15T00:00:00.000Z",
    });
  });

  it("maps day durations to the day columns", () => {
    const cols = publishedColumns([{ field: "duration", value: { min_days: 4, max_days: 5 }, basis: null, checkedAt: null }], defaults);
    expect(cols).toMatchObject({ duration_min_days: 4, duration_max_days: 5, duration_min_minutes: null, duration_max_minutes: null });
  });
});
