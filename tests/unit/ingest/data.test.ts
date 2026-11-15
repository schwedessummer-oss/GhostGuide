import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../../../ingest/src/commands/check";
import { loadableFacts, readDataDir } from "../../../ingest/src/data/read";
import { factEnvelopeSchema, seedSchema, VALUE_SCHEMAS } from "../../../ingest/src/data/schemas";
import { captureOutput } from "../../../ingest/src/lib/output";

const FIXTURE = path.resolve(__dirname, "../../fixtures/ingest/data");
const TODAY = "2026-11-15";

const seed = {
  seed_no: 1,
  slug: "half-dome",
  name: "Half Dome",
  region_group: "north-central-america",
  countries: ["US"],
  subdivisions: ["US-CA"],
  area: { name: "Yosemite National Park", wikidata: "Q180402", official_url: "https://www.nps.gov/yose/" },
  agency: { name: "National Park Service", wikidata: null },
  hike_wikidata: null,
  official_url: "https://www.nps.gov/yose/planyourvisit/halfdome.htm",
  anchor: null,
  osm: { relation_ids: [], way_ids: [], candidates: [], confidence: "unknown", notes: "" },
  trip_type: "day",
  typical_days: null,
  access_mode: "independent",
  flags: ["seasonal_access", "fallback_for:angels-landing"],
  status: { value: "seasonal", note: "", source_url: null, checked_at: "2026-11-15" },
};

const envelope = {
  field: "parking",
  value: "Small lot at the trailhead.",
  source_url: "https://www.nps.gov/yose/planyourvisit/parking.htm",
  source_title: "Parking",
  publisher: "National Park Service",
  checked_at: "2026-11-15",
  evidence: { page: "P1", quote: "parking" },
  verified: true,
};

const messages = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) =>
  r.success ? [] : r.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`);

describe("seed schema", () => {
  it("accepts a seed written as in DATA_FORMATS.md", () => {
    expect(messages(seedSchema.safeParse(seed))).toEqual([]);
  });

  it("rejects unknown keys, bad codes and subdivisions outside the listed countries", () => {
    expect(messages(seedSchema.safeParse({ ...seed, offical_url: "x" }))).toEqual([': Unrecognized key: "offical_url"']);
    expect(messages(seedSchema.safeParse({ ...seed, subdivisions: ["CA-BC"] }))).toEqual(["subdivisions.0: CA-BC is not in a listed country"]);
    expect(messages(seedSchema.safeParse({ ...seed, countries: ["usa"] }))[0]).toMatch(/^countries\.0: must be an ISO 3166-1/);
    expect(messages(seedSchema.safeParse({ ...seed, flags: ["fallback"] }))).toEqual(["flags.0: is not a known flag"]);
    expect(messages(seedSchema.safeParse({ ...seed, official_url: "" }))).toEqual(["official_url: must be an http(s) URL"]);
    expect(messages(seedSchema.safeParse({ ...seed, official_url: "https://www.alltrails.com/trail/x" }))).toEqual([
      "official_url: alltrails.com is not an official source",
    ]);
    expect(messages(seedSchema.safeParse({ ...seed, status: { ...seed.status, checked_at: "15/11/2026" } }))).toEqual([
      "status.checked_at: must be an ISO date (YYYY-MM-DD)",
    ]);
  });
});

describe("fact schemas", () => {
  it("validates the envelope", () => {
    expect(messages(factEnvelopeSchema.safeParse(envelope))).toEqual([]);
    expect(messages(factEnvelopeSchema.safeParse({ ...envelope, field: "distance_km", value: 5 }))).toEqual([
      "basis: is required for distance_km (round_trip, one_way or loop)",
    ]);
    expect(messages(factEnvelopeSchema.safeParse({ ...envelope, basis: "loop" }))).toEqual(["basis: only applies to distance_km"]);
    expect(messages(factEnvelopeSchema.safeParse({ ...envelope, evidence: undefined }))).toEqual(["evidence: Invalid input: expected object, received undefined"]);
    expect(messages(factEnvelopeSchema.safeParse({ ...envelope, source_url: "https://en.wikipedia.org/wiki/Half_Dome" }))).toEqual([
      "source_url: wikipedia.org is not an official source",
    ]);
    expect(messages(factEnvelopeSchema.safeParse({ ...envelope, note: "x".repeat(301) }))).toEqual(["note: must be at most 300 characters"]);
  });

  it("validates values per field", () => {
    const check = (field: keyof typeof VALUE_SCHEMAS, value: unknown) => messages(VALUE_SCHEMAS[field].safeParse(value));
    expect(check("distance_km", 22.45)).toEqual([]);
    expect(check("distance_km", 22.456)).toEqual([": must have at most 2 decimals"]);
    expect(check("elevation_gain_m", 1463.5)).toEqual([": must be whole metres"]);
    expect(check("duration", { min_hours: 10, max_hours: 12 })).toEqual([]);
    expect(check("duration", { min_hours: 10, max_days: 2 })).toEqual([": give min_hours/max_hours or min_days/max_days (one pair)"]);
    expect(check("duration", { min_days: 5, max_days: 4 })).toEqual([": min_days is greater than max_days"]);
    expect(check("best_months", [5, 5])).toEqual([": must not repeat a month"]);
    expect(check("rule_dogs", { value: "restricted" })).toEqual(["note: is required when value is restricted"]);
    expect(check("rule_dogs", { value: "allowed", max_group: 4, note: "x" })).toEqual(["max_group: only applies to rule_group_size"]);
    expect(check("rule_group_size", { value: "restricted", max_group: 12, note: "Groups of 12 at most." })).toEqual([]);
    expect(check("fee", { name: "Entry", amount: 1000, currency: "JPY", unit: "per_person", audience: "all" })).toEqual([]);
    expect(check("fee", { name: "Entry", amount: 1000.5, currency: "JPY", unit: "per_person", audience: "all" })).toEqual([
      "amount: has more decimals than JPY allows (0)",
    ]);
    expect(check("fee", { name: "Entry", amount: 5, currency: "XXX", unit: "per_person", audience: "all" })).toEqual([
      "currency: is not in the currencies table",
    ]);
    expect(check("fee", { name: "Entry", amount: 5, currency: "USD", unit: "per_person", audience: "all", valid_from: "05-01" })).toEqual([
      "valid_from: must be an ISO date (YYYY-MM-DD)",
    ]);
    expect(check("closure", { status: "closed", note: "Bridge out.", as_of: "2026-02-30" })).toEqual(["as_of: is not a real calendar date"]);
    expect(check("entry_fee_none", false)[0]).toMatch(/expected true/);
    expect(check("permit", { name: "Day permit", kind: "lottery", price: { amount: 6, currency: "USD", unit: "per_application", audience: "all" } })).toEqual([]);
  });
});

describe("readDataDir and check on the fixture data", () => {
  it("reports problems per file and keeps the valid parts", async () => {
    const data = await readDataDir(FIXTURE, { today: TODAY });
    expect([...data.seeds.keys()].sort()).toEqual(["test-broken-seed", "test-half-dome", "test-preikestolen"]);
    expect(data.seeds.get("test-broken-seed")!.seed).toBeNull();
    expect(data.seeds.get("test-half-dome")!.seed!.name).toBe("Half Dome (test)");
    expect(data.problems.map((p) => `${p.level} ${p.file} ${p.at ?? ""}`)).toEqual([
      "error seeds/hikes/test-broken-seed.yaml region_group",
      "error seeds/hikes/test-broken-seed.yaml official_url",
      "error seeds/hikes/test-broken-seed.yaml flags[0]",
      "error curated/test-half-dome.yaml facts[19].source_url",
      "error curated/test-half-dome.yaml facts[20].value.amount",
      "warning curated/test-half-dome.yaml route_type",
    ]);
    const facts = loadableFacts(data.curated.get("test-half-dome"));
    expect(facts).toHaveLength(21);
    expect(facts.find((f) => f.field === "best_months")!.value).toEqual([5, 6, 7, 8, 9, 10]);
    expect(facts.some((f) => f.field === "trailhead_access")).toBe(false);
  });

  it("check prints the problem list and counts errors", async () => {
    const out = captureOutput();
    const { summary } = await runCheck(FIXTURE, out, { today: TODAY });
    expect(summary).toMatchObject({ seedFiles: 3, seedsValid: 2, curatedFiles: 1, facts: 24, factsVerified: 21, errors: 5, warnings: 1 });
    expect(out.lines).toContain("curated/test-half-dome.yaml  (2 errors, 1 warning)");
    expect(out.lines).toContain("  ERROR facts[20].value.amount: has more decimals than USD allows (2) (fee)");
  });

  it("tolerates missing and partial files, and flags cross-file problems", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gg-ingest-"));
    await mkdir(path.join(dir, "seeds", "hikes"), { recursive: true });
    await mkdir(path.join(dir, "curated"));
    const yaml = (o: object) => JSON.stringify(o); // JSON is valid YAML
    await writeFile(path.join(dir, "seeds", "hikes", "a-hike.yaml"), yaml({ ...seed, slug: "a-hike" }));
    await writeFile(path.join(dir, "seeds", "hikes", "b-hike.yaml"), yaml({ ...seed, slug: "b-hike", flags: [] }));
    await writeFile(path.join(dir, "seeds", "hikes", "c-hike.yaml"), yaml({ ...seed, slug: "wrong", seed_no: 3 }));
    await writeFile(path.join(dir, "seeds", "hikes", "d-hike.yaml"), yaml({ ...seed, slug: "d-hike", seed_no: 4 }));
    await writeFile(path.join(dir, "seeds", "hikes", "empty.yaml"), "");
    await writeFile(path.join(dir, "seeds", "hikes", "notes.md"), "ignored");
    await writeFile(path.join(dir, "curated", "orphan.yaml"), "slug: orphan\nresearched_at: 2026-11-15\nfacts: []\n");
    await writeFile(path.join(dir, "curated", "a-hike.yaml"), "slug: a-hike\nslug: twice\n");
    const data = await readDataDir(dir, { today: TODAY });
    const lines = data.problems.map((p) => `${p.level} ${p.file} ${p.at ?? ""} ${p.message}`);
    expect(lines).toEqual(
      expect.arrayContaining([
        "error seeds/hikes/c-hike.yaml slug \"wrong\" does not match the file name",
        "error seeds/hikes/empty.yaml  file is empty",
        "error seeds/hikes/a-hike.yaml seed_no 1 is also used by b-hike",
        "error seeds/hikes/b-hike.yaml seed_no 1 is also used by a-hike",
        "warning seeds/hikes/d-hike.yaml flags fallback_for:angels-landing names no seed file",
        "error curated/orphan.yaml  no seed file seeds/hikes/orphan.yaml for these facts",
      ]),
    );
    expect(lines.some((l) => l.startsWith("error curated/a-hike.yaml  YAML:"))).toBe(true);
    // Clashing seeds are not loadable.
    expect(data.seeds.get("a-hike")!.seed).toBeNull();
    expect(data.curated.get("a-hike")!.ok).toBe(false);
  });

  it("errors when the data directory has no seeds", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gg-ingest-empty-"));
    const data = await readDataDir(dir, { today: TODAY });
    expect(data.problems).toEqual([{ level: "error", file: "seeds/hikes", message: `no seeds/hikes directory in ${dir}` }]);
  });

  it("rejects facts checked in the future", async () => {
    const data = await readDataDir(FIXTURE, { today: "2026-11-14" });
    const errs = data.problems.filter((p) => p.message.startsWith("2026-11-15 is in the future"));
    expect(errs.length).toBeGreaterThan(10);
  });
});
