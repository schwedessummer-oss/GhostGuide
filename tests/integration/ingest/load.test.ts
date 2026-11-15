/**
 * The ingest core against the test database: load the fixture data directory
 * (tests/fixtures/ingest/data), re-run it, the licence gate for source
 * records, the publish gate, and the two reports. No network.
 */
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runLoad } from "../../../ingest/src/commands/load";
import { runPublish } from "../../../ingest/src/commands/publish";
import { runReport } from "../../../ingest/src/commands/report";
import { runReportSkipped } from "../../../ingest/src/commands/report-skipped";
import { CURRENCY_MINOR_UNITS } from "../../../ingest/src/data/reference";
import { connect, type Sql } from "../../../ingest/src/lib/db";
import { LICENCES } from "../../../ingest/src/lib/licence";
import { captureOutput } from "../../../ingest/src/lib/output";
import { SkipLogger } from "../../../ingest/src/lib/skips";
import { clearSourceCache, SourceRecordWriter } from "../../../ingest/src/lib/sources";
import { addOsmTrailhead } from "../catalog/helpers";

const FIXTURE = path.resolve(__dirname, "../../fixtures/ingest/data");
const TODAY = "2026-11-15";
const ROOT = path.resolve(__dirname, "../../..");

let sql: Sql;

beforeAll(() => {
  clearSourceCache();
  sql = connect(process.env.DATABASE_URL);
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const TABLES = [
  "hikes", "hike_facts", "fees", "permits", "hike_permits", "hike_rules", "hike_hazards", "areas", "agencies",
  "source_records", "skipped_records",
];

/** Every row of the tables the loader writes. */
async function snapshot(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) {
    out[t] = (await sql.unsafe(`select to_jsonb(t) as row from public.${t} t order by to_jsonb(t)::text`)).map((r) => r.row);
  }
  return out;
}

async function hike(slug: string) {
  const [row] = await sql`
    select id, status::text as status, name, country_code::text as country_code, official_url, access_mode::text as access_mode,
           distance_km::float8 as distance_km, distance_basis::text as distance_basis, elevation_gain_m, high_point_m,
           duration_min_minutes, duration_max_minutes, best_months::int[] as best_months, season_note,
           permit_required::text as permit_required, parking, trailhead_access, public_transport, nearest_town,
           route_type::text as route_type, operating_status::text as operating_status, last_verified_at, seed_no,
           region_group, flags, wikidata_qid, area_id, agency_id
    from public.hikes where slug = ${slug}`;
  return row;
}

describe("ingest load", () => {
  it("loads seeds and verified facts, skipping what is invalid, unverified or contradicting", async () => {
    const out = captureOutput();
    const { results, totals } = await runLoad(sql, FIXTURE, out, { today: TODAY });
    expect(results.map((r) => [r.slug, r.outcome])).toEqual([
      ["test-half-dome", "loaded"],
      ["test-preikestolen", "loaded"],
      ["test-broken-seed", "skipped"],
    ]);
    expect(totals).toMatchObject({ inserted: 2, failed: 0, skipped: 1, factsInvalid: 2, factsUnverified: 1, factsConflicting: 2, factsExtra: 1 });

    const h = await hike("test-half-dome");
    expect(h).toMatchObject({
      status: "draft",
      name: "Half Dome (test)",
      country_code: "US",
      seed_no: 9001,
      region_group: "north-central-america",
      flags: ["seasonal_access"],
      wikidata_qid: "Q96053096",
      official_url: "https://www.nps.gov/yose/planyourvisit/halfdome.htm",
      access_mode: "independent",
      distance_km: 22.4,
      distance_basis: "round_trip",
      elevation_gain_m: 1475,
      high_point_m: 2682,
      duration_min_minutes: 600,
      duration_max_minutes: 720,
      best_months: [5, 6, 7, 8, 9, 10],
      permit_required: "seasonal",
      parking: "Park at the trailhead parking lot near Curry Village and walk to Happy Isles.",
      public_transport: "The free valley shuttle stops at Happy Isles.",
      nearest_town: "Yosemite Valley",
      operating_status: "seasonal",
      trailhead_access: null, // failed verification
      route_type: null, // two facts disagree
    });
    expect(new Date(h.last_verified_at).toISOString()).toBe("2026-11-15T00:00:00.000Z");

    // Area and agency found or created by QID, each with a source record.
    const [area] = await sql`select name, country_code::text as country_code, subdivision_code, official_url, wikidata_qid, source_record_id from public.areas where id = ${h.area_id}`;
    expect(area).toMatchObject({ name: "Yosemite National Park", country_code: "US", subdivision_code: "US-CA", official_url: "https://www.nps.gov/yose/", wikidata_qid: "Q180402" });
    const [agency] = await sql`select name, wikidata_qid from public.agencies where id = ${h.agency_id}`;
    expect(agency).toEqual({ name: "National Park Service", wikidata_qid: "Q308439" });

    // Facts: one current row per field (and per key for fees, permits, hazards).
    const facts = await sql`
      select f.field, f.value_key, f.method::text as method, f.license_code, f.verified, f.evidence, f.checked_at,
             sr.external_id, sr.version, sr.attribution_text, ds.key as source
      from public.hike_facts f join public.source_records sr on sr.id = f.source_record_id
      join public.data_sources ds on ds.id = sr.data_source_id
      where f.hike_id = ${h.id} and f.superseded_at is null order by f.field, f.value_key`;
    expect(facts.map((f) => (f.value_key ? `${f.field}:${f.value_key}` : f.field))).toEqual([
      "best_months", "closure", "distance_km", "duration", "elevation_gain_m", "fee:Park entrance|all|per_vehicle",
      "hazard:exposure", "hazard:lightning", "high_point_m", "nearest_town", "official_url", "parking",
      "permit:Half Dome day-hiker permit (preseason lottery)", "permit_required", "public_transport", "rule_dogs",
      "rule_group_size", "season_note",
    ]);
    for (const f of facts) {
      expect(f).toMatchObject({ method: "curated", license_code: "CITED-FACT", verified: true, source: "official_site" });
      // Only the heading is kept; evidence quotes are never stored.
      if (f.evidence) expect(Object.keys(f.evidence)).toEqual(["heading"]);
    }
    const distance = facts.find((f) => f.field === "distance_km")!;
    expect(distance).toMatchObject({
      external_id: "https://www.nps.gov/yose/planyourvisit/valleyhikes.htm",
      version: "2026-11-15",
      attribution_text: 'National Park Service, "Yosemite Valley Day Hikes - Yosemite National Park (U.S. National Park Service)"',
      evidence: { heading: "Yosemite Valley Day Hikes" },
    });
    const [{ quotes }] = await sql`
      select count(*)::int as quotes from public.hike_facts
      where hike_id = ${h.id} and (evidence::text ilike '%quote%' or evidence::text like '%Most hikers take 10 to 12 hours%')`;
    expect(quotes).toBe(0);

    // One source record per page and date checked; the seed's page shares the facts' record.
    const [{ n: halfDomePage }] = await sql`
      select count(*)::int as n from public.source_records where external_id = 'https://www.nps.gov/yose/planyourvisit/halfdome.htm'`;
    expect(halfDomePage).toBe(1);
    const [areaRecord] = await sql`select attribution_text, license_code, retrieved_at from public.source_records where id = ${area.source_record_id}`;
    expect(areaRecord).toMatchObject({ attribution_text: "National Park Service, https://www.nps.gov/yose/", license_code: "CITED-FACT" });

    // Typed rows derived from the facts.
    const fees = await sql`
      select f.name, f.amount_minor::int as amount_minor, f.currency::text as currency, f.unit::text as unit,
             f.valid_from::text as valid_from, f.permit_id is not null as permit_fee
      from public.fees f left join public.hike_permits hp on hp.permit_id = f.permit_id
      where f.hike_id = ${h.id} or hp.hike_id = ${h.id} order by f.name`;
    expect(fees).toEqual([
      { name: "Half Dome day-hiker permit (preseason lottery)", amount_minor: 1000, currency: "USD", unit: "per_application", valid_from: null, permit_fee: true },
      { name: "Park entrance", amount_minor: 3500, currency: "USD", unit: "per_vehicle", valid_from: "2026-01-01", permit_fee: false },
    ]);
    const permits = await sql`
      select p.name, p.kind::text as kind, p.months::int[] as months, p.official_url
      from public.permits p join public.hike_permits hp on hp.permit_id = p.id where hp.hike_id = ${h.id}`;
    expect(permits).toEqual([
      { name: "Half Dome day-hiker permit (preseason lottery)", kind: "lottery", months: [5, 6, 7, 8, 9, 10], official_url: "https://www.recreation.gov/permits/234652" },
    ]);
    const rules = await sql`select rule::text as rule, value::text as value, max_group from public.hike_rules where hike_id = ${h.id} order by rule`;
    expect(rules).toEqual([
      { rule: "dogs", value: "not_allowed", max_group: null },
      { rule: "group_size", value: "restricted", max_group: 15 },
    ]);
    const hazards = await sql`select type::text as type from public.hike_hazards where hike_id = ${h.id} order by type`;
    expect(hazards.map((r) => r.type)).toEqual(["exposure", "lightning"]);

    // The non-official source is logged as skipped.
    const skipped = await sql`
      select s.reason::text as reason, s.source_url, ds.key from public.skipped_records s
      join public.data_sources ds on ds.id = s.data_source_id where s.source_url like 'https://www.alltrails.com/%'`;
    expect(skipped).toEqual([{ reason: "source_excluded", source_url: "https://www.alltrails.com/trail/us/california/half-dome-trail", key: "official_site" }]);

    // A hike without a curated file: identity only, every fact column null.
    const p = await hike("test-preikestolen");
    expect(p).toMatchObject({ status: "draft", country_code: "NO", distance_km: null, permit_required: null, operating_status: "unknown", last_verified_at: null });
    expect(await hike("test-broken-seed")).toBeUndefined();
    expect(out.lines).toContain("test-broken-seed: skipped");
  });

  it("re-running on unchanged input changes nothing", async () => {
    const before = await snapshot();
    const { totals } = await runLoad(sql, FIXTURE, captureOutput(), { today: TODAY });
    expect(totals).toMatchObject({ inserted: 0, updated: 0, unchanged: 2, factsAdded: 0, factsSuperseded: 0, sourceRecords: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it("supersedes a changed fact and keeps its history", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gg-ingest-load-"));
    await cp(FIXTURE, dir, { recursive: true });
    const file = path.join(dir, "curated", "test-half-dome.yaml");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace("  value: 1475\n", "  value: 1480\n").replace(/# 15\n- field: parking[\s\S]*?verified: true\n/, ""));
    const { totals } = await runLoad(sql, dir, captureOutput(), { today: TODAY, slug: "test-half-dome" });
    expect(totals).toMatchObject({ updated: 1, factsAdded: 1, factsSuperseded: 2 });
    const h = await hike("test-half-dome");
    expect(h).toMatchObject({ elevation_gain_m: 1480, parking: null });
    const history = await sql`
      select value, superseded_at is not null as superseded from public.hike_facts
      where hike_id = ${h.id} and field = 'elevation_gain_m' order by created_at, superseded_at nulls last`;
    expect(history).toEqual([
      { value: 1475, superseded: true },
      { value: 1480, superseded: false },
    ]);
    // Back to the fixture: the old value returns as a new current fact.
    await runLoad(sql, FIXTURE, captureOutput(), { today: TODAY });
    expect(await hike("test-half-dome")).toMatchObject({ elevation_gain_m: 1475, parking: expect.any(String) });
  });
});

describe("licence gate for source records", () => {
  it("rejects an NC licence and logs it as skipped (once)", async () => {
    const skips = new SkipLogger(null);
    const writer = new SourceRecordWriter(null, skips);
    const input = {
      source: "commons",
      externalId: "File:Test non-commercial photo.jpg",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Test_non-commercial_photo.jpg",
      licence: "CC BY-NC-SA 4.0",
      attributionText: "A. Photographer, CC BY-NC-SA 4.0, via Wikimedia Commons",
      retrievedAt: new Date(),
      photo: true,
    };
    expect(await sql.begin((tx) => writer.write(tx, input))).toEqual({ ok: false, reason: "license_not_allowed" });
    expect(await sql.begin((tx) => writer.write(tx, input))).toEqual({ ok: false, reason: "license_not_allowed" });
    const rows = await sql`
      select s.reason::text as reason, s.license_text, s.detail, ds.key from public.skipped_records s
      join public.data_sources ds on ds.id = s.data_source_id where s.external_id = ${input.externalId}`;
    expect(rows).toEqual([{ reason: "license_not_allowed", license_text: "CC BY-NC-SA 4.0", detail: "licence CC-BY-NC-SA-4.0", key: "commons" }]);
    const [{ n }] = await sql`select count(*)::int as n from public.source_records where external_id = ${input.externalId}`;
    expect(n).toBe(0);

    // The database gate refuses it too, even if application code were bypassed.
    await expect(sql`
      insert into public.source_records (data_source_id, external_id, source_url, license_code, attribution_text, retrieved_at)
      select id, 'bypass', 'https://commons.wikimedia.org/wiki/File:X.jpg', 'CC-BY-NC-4.0', 'x', now() from public.data_sources where key = 'commons'`).rejects.toThrow(
      /source_records_license_gate/,
    );
  });

  it("writes allowed records once per upstream content", async () => {
    const writer = new SourceRecordWriter(null, new SkipLogger(null));
    const input = {
      source: "wikidata",
      externalId: "Q180402",
      sourceUrl: "https://www.wikidata.org/wiki/Q180402",
      licence: "https://creativecommons.org/publicdomain/zero/1.0/",
      attributionText: "Wikidata (CC0)",
      retrievedAt: new Date("2026-11-15T00:00:00Z"),
      contentHash: "abc123",
    };
    const first = await sql.begin((tx) => writer.write(tx, input));
    const second = await sql.begin((tx) => writer.write(tx, input));
    expect(first).toMatchObject({ ok: true, licenseCode: "CC0-1.0", created: true });
    expect(second).toMatchObject({ ok: true, created: false });
    expect(second.ok && first.ok && second.id === first.id).toBe(true);
  });

  it("the licence and currency tables mirrored in ingest/ match the database", async () => {
    const licences = await sql<{ code: string; allowed: boolean; photo_ok: boolean }[]>`select code, allowed, photo_ok from public.licenses order by code`;
    expect(Object.fromEntries(licences.map((l) => [l.code, { allowed: l.allowed, photoOk: l.photo_ok }]))).toEqual(LICENCES);
    const currencies = await sql<{ code: string; minor_unit: number }[]>`select code::text as code, minor_unit from public.currencies`;
    expect(Object.fromEntries(currencies.map((c) => [c.code, c.minor_unit]))).toEqual(CURRENCY_MINOR_UNITS);
  });
});

describe("publish gate", () => {
  it("publishes a complete hike and reports what an incomplete one is missing", async () => {
    // What the OSM adapter will add: a trailhead from OpenStreetMap.
    const h = await hike("test-half-dome");
    await sql.begin((tx) => addOsmTrailhead(tx, h.id));

    const dry = captureOutput();
    const [preview] = await runPublish(sql, dry, { slug: "test-half-dome", dryRun: true });
    expect(preview).toMatchObject({ action: "would_publish", problems: [] });
    expect((await hike("test-half-dome")).status).toBe("draft");

    const [published] = await runPublish(sql, captureOutput(), { slug: "test-half-dome" });
    expect(published.action).toBe("published");
    expect((await hike("test-half-dome")).status).toBe("published");

    const out = captureOutput();
    const [blocked] = await runPublish(sql, out, { slug: "test-preikestolen" });
    expect(blocked).toMatchObject({ action: "blocked", problems: ["a primary route or an OSM trailhead is required"] });
    expect(out.lines).toContain("    missing: a primary route or an OSM trailhead is required");
    expect((await hike("test-preikestolen")).status).toBe("draft");

    // Loading again keeps the published status and changes nothing.
    const { results } = await runLoad(sql, FIXTURE, captureOutput(), { today: TODAY });
    expect(results.find((r) => r.slug === "test-half-dome")).toMatchObject({ outcome: "loaded" });
    expect((await hike("test-half-dome")).status).toBe("published");
  });
});

describe("reports", () => {
  it("writes the coverage report and the run-time skips section", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gg-ingest-report-"));
    const coverage = path.join(dir, "coverage.md");
    await runReport(sql, captureOutput(), { file: coverage, today: TODAY });
    const md = await readFile(coverage, "utf8");
    expect(md).toMatch(/\| 9001 \| Half Dome \(test\) \(`test-half-dome`\) \| published \| Y \| Y \| Y \| Y \| Y \| Y \| 2 \| Y \| Y \| - \| - \| - \| \d+ \|/);
    expect(md).toMatch(/\| 9002 \| Preikestolen \(test\) \(`test-preikestolen`\) \| draft \| - \| - \| - \| - \| - \| - \| - \| - \| - \| - \| - \| - \| 1 \|/);

    const skippedDoc = path.join(dir, "skipped-sources.md");
    await cp(path.join(ROOT, "docs", "skipped-sources.md"), skippedDoc);
    await runReportSkipped(sql, captureOutput(), { file: skippedDoc });
    const doc = await readFile(skippedDoc, "utf8");
    expect(doc).toContain("## Source decisions");
    expect(doc).toContain("| commons | license_not_allowed | [File:Test non-commercial photo.jpg](https://commons.wikimedia.org/wiki/File:Test_non-commercial_photo.jpg) | CC BY-NC-SA 4.0 |");
    expect(doc).toContain("| official_site | source_excluded | <https://www.alltrails.com/trail/us/california/half-dome-trail> |");
  });
});
