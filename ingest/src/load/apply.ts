/**
 * `load`: writes seeds and verified curated facts into the catalog, one
 * transaction per hike, idempotently (an unchanged input changes nothing):
 *
 *  1. source records for every cited page (official_site, CITED-FACT; one per
 *     URL and date checked);
 *  2. agency and area (found by Wikidata QID, else by name and country);
 *  3. the hike's identity columns (status is never changed here);
 *  4. hike_facts: a changed value supersedes the current one, so history stays;
 *  5. typed rows derived from facts: fees, permits + hike_permits, hike_rules,
 *     hike_hazards; closures set operating_status;
 *  6. the published-value columns of hikes, copied from current verified facts
 *     (the only writer of those columns).
 *
 * Invalid, unverified or contradicting facts are reported and skipped, never
 * guessed. Evidence quotes are never stored: hike_facts.evidence keeps the
 * page heading only.
 */
import { loadableFacts, type CuratedEntry, type DataSet } from "../data/read";
import { bannedHost } from "../data/reference";
import type { CuratedFact, FactField, Seed } from "../data/schemas";
import type { Sql, Tx } from "../lib/db";
import { citedPageRecord, type SourceRecordWriter } from "../lib/sources";
import type { SkipLogger } from "../lib/skips";
import {
  canonicalJson,
  publishedColumns,
  resolveFacts,
  ruleKindOf,
  toMinorUnits,
  type CurrentFact,
  type FeeValue,
  type PermitValue,
  type ResolvedFact,
  type RuleValue,
} from "./facts";

export interface LoadContext {
  sql: Sql;
  writer: SourceRecordWriter;
  skips: SkipLogger;
  /** currency code -> minor_unit, from public.currencies. */
  currencies: Map<string, number>;
}

export interface HikeChanges {
  hike: "inserted" | "updated" | "unchanged";
  sourceRecords: number;
  agencies: number;
  areas: number;
  factsAdded: number;
  factsSuperseded: number;
  feesAdded: number;
  feesRemoved: number;
  permitsLinked: number;
  permitsUnlinked: number;
  rulesChanged: number;
  hazardsChanged: number;
  publishedColumns: "updated" | "unchanged";
}

export interface HikeLoadResult {
  slug: string;
  outcome: "loaded" | "skipped" | "failed";
  changes: HikeChanges | null;
  facts: { current: number; unverified: number; invalid: number; conflicting: number; extra: number };
  messages: string[];
  error?: string;
}

const emptyChanges = (): HikeChanges => ({
  hike: "unchanged",
  sourceRecords: 0,
  agencies: 0,
  areas: 0,
  factsAdded: 0,
  factsSuperseded: 0,
  feesAdded: 0,
  feesRemoved: 0,
  permitsLinked: 0,
  permitsUnlinked: 0,
  rulesChanged: 0,
  hazardsChanged: 0,
  publishedColumns: "unchanged",
});

export function changedAnything(c: HikeChanges): boolean {
  return (
    c.hike !== "unchanged" ||
    c.publishedColumns !== "unchanged" ||
    [c.sourceRecords, c.agencies, c.areas, c.factsAdded, c.factsSuperseded, c.feesAdded, c.feesRemoved,
      c.permitsLinked, c.permitsUnlinked, c.rulesChanged, c.hazardsChanged].some((n) => n > 0)
  );
}

export async function loadCurrencies(sql: Sql): Promise<Map<string, number>> {
  const rows = await sql<{ code: string; minor_unit: number }[]>`select code::text as code, minor_unit from public.currencies`;
  return new Map(rows.map((r) => [r.code, r.minor_unit]));
}

/** Load every valid seed of the data set (in seed order). */
export async function loadDataSet(ctx: LoadContext, data: DataSet): Promise<HikeLoadResult[]> {
  const entries = [...data.seeds.values()].sort((a, b) => (a.seed?.seed_no ?? 1e9) - (b.seed?.seed_no ?? 1e9) || a.slug.localeCompare(b.slug));
  const results: HikeLoadResult[] = [];
  for (const entry of entries) {
    const curated = data.curated.get(entry.slug);
    if (!entry.seed) {
      results.push({
        slug: entry.slug,
        outcome: "skipped",
        changes: null,
        facts: { current: 0, unverified: 0, invalid: 0, conflicting: 0, extra: 0 },
        messages: [`seed file ${entry.file} is invalid (run check)`],
      });
      continue;
    }
    results.push(await loadHike(ctx, entry.seed, curated));
  }
  return results;
}

export async function loadHike(ctx: LoadContext, seed: Seed, curated: CuratedEntry | undefined): Promise<HikeLoadResult> {
  const messages: string[] = [];
  const counts = { current: 0, unverified: 0, invalid: 0, conflicting: 0, extra: 0 };
  if (!curated) messages.push("no curated file: facts left as they are");
  else if (!curated.ok) messages.push(`curated file ${curated.file} is unusable (run check): facts left as they are`);
  else {
    for (const fe of curated.facts) {
      if (fe.fact) continue;
      counts.invalid++;
      const e = fe.errors[0];
      messages.push(`skipped invalid facts[${fe.index}]${fe.field ? ` (${fe.field})` : ""}: ${e.at ? `${e.at}: ` : ""}${e.message}`);
    }
    counts.unverified = curated.facts.filter((f) => f.fact && !f.fact.verified).length;
    if (counts.unverified) messages.push(`${counts.unverified} unverified fact(s) not loaded`);
  }

  // Valid, verified facts whose currency the database knows.
  const candidates: CuratedFact[] = [];
  for (const fact of loadableFacts(curated)) {
    const currency = currencyOf(fact);
    if (currency && !ctx.currencies.has(currency)) {
      counts.invalid++;
      messages.push(`skipped ${fact.field}: currency ${currency} is not in public.currencies`);
      continue;
    }
    candidates.push(fact);
  }
  const resolution = resolveFacts(candidates);
  counts.extra = resolution.extras.length;
  for (const c of resolution.conflicts) {
    counts.conflicting += c.facts.length;
    messages.push(`skipped ${c.facts.length} contradicting ${c.field} facts${c.valueKey ? ` (${c.valueKey})` : ""}`);
  }

  try {
    const changes = await ctx.sql.begin(async (tx) => {
      const changes = emptyChanges();
      // Facts from a non-official source never load; record the source as skipped.
      for (const fe of curated?.facts ?? []) {
        const banned = fe.sourceUrl ? bannedHost(fe.sourceUrl) : null;
        if (banned && fe.sourceUrl) {
          await ctx.skips.log(tx, {
            source: "official_site",
            externalId: fe.sourceUrl,
            sourceUrl: fe.sourceUrl,
            reason: "source_excluded",
            detail: `${banned} is not an official source (${curated?.file} facts[${fe.index}])`,
          });
        }
      }
      await writeHike(tx, ctx, seed, curated, resolution.chosen, changes);
      return changes;
    });
    counts.current = curated?.ok ? resolution.chosen.length : counts.current;
    return { slug: seed.slug, outcome: "loaded", changes, facts: counts, messages };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { slug: seed.slug, outcome: "failed", changes: null, facts: counts, messages, error };
  }
}

function currencyOf(fact: CuratedFact): string | null {
  if (fact.field === "fee") return (fact.value as FeeValue).currency;
  if (fact.field === "permit") return (fact.value as PermitValue).price?.currency ?? null;
  return null;
}

async function writeHike(
  tx: Tx,
  ctx: LoadContext,
  seed: Seed,
  curated: CuratedEntry | undefined,
  chosen: ResolvedFact[],
  changes: HikeChanges,
): Promise<void> {
  // Page titles known from curated facts, for attribution of seed pages.
  const titles = new Map<string, string>();
  for (const fe of curated?.facts ?? []) if (fe.fact && !titles.has(fe.fact.sourceUrl)) titles.set(fe.fact.sourceUrl, fe.fact.sourceTitle);

  // 1. Source records: facts first (they carry page titles), then the seed's pages.
  const records = new Map<string, { id: string; licenseCode: string }>();
  const record = async (url: string, checkedAt: string, publisher: string, title: string | null) => {
    const key = `${url}|${checkedAt}`;
    const hit = records.get(key);
    if (hit) return hit;
    const res = await ctx.writer.write(tx, citedPageRecord({ url, checkedAt, publisher, title }));
    if (!res.ok) throw new Error(`source record for ${url} refused: ${res.reason}`);
    if (res.created) changes.sourceRecords++;
    const out = { id: res.id, licenseCode: res.licenseCode };
    records.set(key, out);
    return out;
  };
  for (const f of chosen) await record(f.sourceUrl, f.checkedAt, f.publisher, f.sourceTitle);
  const checked = seed.status.checked_at;
  const hikePage = await record(seed.official_url, checked, seed.agency.name, titles.get(seed.official_url) ?? null);
  const areaPage = seed.area.official_url
    ? await record(seed.area.official_url, checked, seed.agency.name, titles.get(seed.area.official_url) ?? null)
    : hikePage;

  // 2. Agency and area.
  const country = seed.countries[0];
  const agencyId = await upsertAgency(tx, seed, country, hikePage.id, changes);
  const areaId = await upsertArea(tx, seed, country, agencyId, areaPage.id, changes);

  // 3. Hike identity.
  const hikeId = await upsertHike(tx, seed, areaId, agencyId, changes);

  // 4 + 5. Facts and typed rows (only when the curated file is usable).
  if (curated?.ok) {
    const verifiedBy = curated.verifier ?? "verify_facts.py";
    await syncFacts(tx, hikeId, chosen, records, verifiedBy, changes);
    await syncTypedRows(tx, ctx, hikeId, chosen, records, changes);
  }

  // 6. Published values from current verified facts.
  await copyPublishedValues(tx, hikeId, seed, changes);

  const [h] = await tx<{ status: string; problems: string[] }[]>`
    select status::text as status, public.hike_publish_problems(id) as problems from public.hikes where id = ${hikeId}`;
  if (h.status === "published" && h.problems.length) {
    throw new Error(`hike is published but the new data fails the publish gate: ${h.problems.join("; ")}`);
  }
}

// ---------------------------------------------------------------------------
// Agencies, areas, hikes
// ---------------------------------------------------------------------------
async function upsertAgency(tx: Tx, seed: Seed, country: string, sourceRecordId: string, changes: HikeChanges): Promise<string> {
  const qid = seed.agency.wikidata;
  type Row = { id: string; wikidata_qid: string | null };
  let row: Row | undefined;
  if (qid) [row] = await tx<Row[]>`select id, wikidata_qid from public.agencies where wikidata_qid = ${qid}`;
  if (!row) {
    [row] = await tx<Row[]>`
      select id, wikidata_qid from public.agencies
      where lower(name) = lower(${seed.agency.name}) and country_code is not distinct from ${country}
        and (wikidata_qid is null or ${qid}::text is null)
      order by created_at, id limit 1`;
  }
  if (row) {
    if (qid && !row.wikidata_qid) {
      await tx`update public.agencies set wikidata_qid = ${qid} where id = ${row.id}`;
      changes.agencies++;
    }
    return row.id;
  }
  const [created] = await tx<{ id: string }[]>`
    insert into public.agencies (name, country_code, wikidata_qid, source_record_id)
    values (${seed.agency.name}, ${country}, ${qid}, ${sourceRecordId}) returning id`;
  changes.agencies++;
  return created.id;
}

async function upsertArea(
  tx: Tx,
  seed: Seed,
  country: string,
  agencyId: string,
  sourceRecordId: string,
  changes: HikeChanges,
): Promise<string> {
  const qid = seed.area.wikidata;
  const subdivision = seed.subdivisions.length === 1 ? seed.subdivisions[0] : null;
  type Row = { id: string; wikidata_qid: string | null; official_url: string | null; agency_id: string | null; subdivision_code: string | null };
  let row: Row | undefined;
  if (qid) [row] = await tx<Row[]>`select id, wikidata_qid, official_url, agency_id, subdivision_code from public.areas where wikidata_qid = ${qid}`;
  if (!row) {
    [row] = await tx<Row[]>`
      select id, wikidata_qid, official_url, agency_id, subdivision_code from public.areas
      where lower(name) = lower(${seed.area.name}) and country_code is not distinct from ${country}
        and (wikidata_qid is null or ${qid}::text is null)
      order by created_at, id limit 1`;
  }
  if (row) {
    // First writer wins; later seeds only fill what is still missing.
    const fill = {
      wikidata_qid: row.wikidata_qid ?? qid,
      official_url: row.official_url ?? seed.area.official_url,
      agency_id: row.agency_id ?? agencyId,
      subdivision_code: row.subdivision_code ?? subdivision,
    };
    if (canonicalJson(fill) !== canonicalJson({ wikidata_qid: row.wikidata_qid, official_url: row.official_url, agency_id: row.agency_id, subdivision_code: row.subdivision_code })) {
      await tx`
        update public.areas set wikidata_qid = ${fill.wikidata_qid}, official_url = ${fill.official_url},
          agency_id = ${fill.agency_id}, subdivision_code = ${fill.subdivision_code}
        where id = ${row.id}`;
      changes.areas++;
    }
    return row.id;
  }
  const [created] = await tx<{ id: string }[]>`
    insert into public.areas (name, kind, country_code, subdivision_code, official_url, wikidata_qid, agency_id, source_record_id)
    values (${seed.area.name}, 'other', ${country}, ${subdivision}, ${seed.area.official_url}, ${qid}, ${agencyId}, ${sourceRecordId})
    returning id`;
  changes.areas++;
  return created.id;
}

async function upsertHike(tx: Tx, seed: Seed, areaId: string, agencyId: string, changes: HikeChanges): Promise<string> {
  const want = {
    seed_no: seed.seed_no,
    name: seed.name,
    alt_names: seed.alt_names ?? [],
    route_variant: seed.route_variant ?? null,
    region_group: seed.region_group,
    countries: seed.countries,
    country_code: seed.countries[0],
    subdivision_codes: seed.subdivisions,
    area_id: areaId,
    agency_id: agencyId,
    wikidata_qid: seed.hike_wikidata,
    trip_type: seed.trip_type,
    typical_days: seed.typical_days,
    flags: seed.flags,
  };
  const [row] = await tx<Array<typeof want & { id: string }>>`
    select id, seed_no, name, alt_names, route_variant, region_group, countries::text[] as countries,
           country_code::text as country_code, subdivision_codes, area_id, agency_id, wikidata_qid,
           trip_type::text as trip_type, typical_days, flags
    from public.hikes where slug = ${seed.slug}`;
  if (!row) {
    const [created] = await tx<{ id: string }[]>`
      insert into public.hikes (slug, seed_no, name, alt_names, route_variant, region_group, countries, country_code,
                                subdivision_codes, area_id, agency_id, wikidata_qid, trip_type, typical_days, flags,
                                official_url, access_mode)
      values (${seed.slug}, ${want.seed_no}, ${want.name}, ${want.alt_names}::text[], ${want.route_variant}, ${want.region_group},
              ${want.countries}::char(2)[], ${want.country_code}, ${want.subdivision_codes}::text[], ${areaId}, ${agencyId},
              ${want.wikidata_qid}, ${want.trip_type}::public.trip_type, ${want.typical_days}, ${want.flags}::text[],
              ${seed.official_url}, ${seed.access_mode}::public.access_mode)
      returning id`;
    changes.hike = "inserted";
    return created.id;
  }
  const { id, ...have } = row;
  if (canonicalJson(have) !== canonicalJson(want)) {
    await tx`
      update public.hikes set seed_no = ${want.seed_no}, name = ${want.name}, alt_names = ${want.alt_names}::text[],
        route_variant = ${want.route_variant}, region_group = ${want.region_group}, countries = ${want.countries}::char(2)[],
        country_code = ${want.country_code}, subdivision_codes = ${want.subdivision_codes}::text[], area_id = ${areaId},
        agency_id = ${agencyId}, wikidata_qid = ${want.wikidata_qid}, trip_type = ${want.trip_type}::public.trip_type,
        typical_days = ${want.typical_days}, flags = ${want.flags}::text[]
      where id = ${id}`;
    changes.hike = "updated";
  }
  return id;
}

// ---------------------------------------------------------------------------
// hike_facts
// ---------------------------------------------------------------------------
interface FactRow {
  id: string;
  field: FactField;
  value_key: string | null;
  value: unknown;
  basis: string | null;
  note: string | null;
  method: string;
  source_record_id: string;
  checked_at: Date | null;
  verified: boolean;
  verified_by: string | null;
  evidence: unknown;
}

const factKey = (field: string, valueKey: string | null) => `${field}\u0000${valueKey ?? ""}`;

async function syncFacts(
  tx: Tx,
  hikeId: string,
  chosen: ResolvedFact[],
  records: Map<string, { id: string; licenseCode: string }>,
  verifiedBy: string,
  changes: HikeChanges,
): Promise<void> {
  const current = await tx<FactRow[]>`
    select id, field, value_key, value, basis::text as basis, note, method::text as method, source_record_id,
           checked_at, verified, verified_by, evidence
    from public.hike_facts where hike_id = ${hikeId} and superseded_at is null`;
  const byKey = new Map(current.map((r) => [factKey(r.field, r.value_key), r]));
  const wanted = new Set<string>();

  for (const f of chosen) {
    const key = factKey(f.field, f.valueKey);
    wanted.add(key);
    const rec = records.get(`${f.sourceUrl}|${f.checkedAt}`)!;
    const desired = {
      value: f.value,
      basis: f.basis,
      note: f.note,
      method: "curated",
      source_record_id: rec.id,
      checked_at: new Date(`${f.checkedAt}T00:00:00Z`).toISOString(),
      verified: true,
      verified_by: verifiedBy,
      evidence: f.evidenceHeading ? { heading: f.evidenceHeading } : null,
    };
    const cur = byKey.get(key);
    if (cur) {
      const have = {
        value: cur.value,
        basis: cur.basis,
        note: cur.note,
        method: cur.method,
        source_record_id: cur.source_record_id,
        checked_at: cur.checked_at ? new Date(cur.checked_at).toISOString() : null,
        verified: cur.verified,
        verified_by: cur.verified_by,
        evidence: cur.evidence,
      };
      if (canonicalJson(have) === canonicalJson(desired)) continue;
      await tx`update public.hike_facts set superseded_at = now() where id = ${cur.id}`;
      changes.factsSuperseded++;
    }
    await tx`
      insert into public.hike_facts (hike_id, field, value_key, value, basis, note, method, source_record_id, license_code,
                                     checked_at, verified, verified_by, evidence)
      values (${hikeId}, ${f.field}, ${f.valueKey}, ${tx.json(f.value as never)}, ${f.basis}::public.distance_basis, ${f.note},
              'curated', ${rec.id}, ${rec.licenseCode}, ${desired.checked_at}, true, ${verifiedBy},
              ${desired.evidence ? tx.json(desired.evidence) : null})`;
    changes.factsAdded++;
  }
  // Curated facts the file no longer supports (removed, unverified, invalid or contradicted) stop being current.
  for (const cur of current) {
    if (cur.method === "curated" && !wanted.has(factKey(cur.field, cur.value_key))) {
      await tx`update public.hike_facts set superseded_at = now() where id = ${cur.id}`;
      changes.factsSuperseded++;
    }
  }
}

// ---------------------------------------------------------------------------
// Typed rows: fees, permits, rules, hazards
// ---------------------------------------------------------------------------
async function syncTypedRows(
  tx: Tx,
  ctx: LoadContext,
  hikeId: string,
  chosen: ResolvedFact[],
  records: Map<string, { id: string; licenseCode: string }>,
  changes: HikeChanges,
): Promise<void> {
  const recordOf = (f: ResolvedFact) => records.get(`${f.sourceUrl}|${f.checkedAt}`)!.id;
  const minor = (currency: string) => ctx.currencies.get(currency)!;

  // Rules: one per kind.
  type RuleRow = { id: string; rule: string; value: string; max_group: number | null; note: string | null; source_record_id: string; owned: boolean };
  const rules = await tx<RuleRow[]>`
    select r.id, r.rule::text as rule, r.value::text as value, r.max_group, r.note, r.source_record_id,
           ds.key = 'official_site' as owned
    from public.hike_rules r join public.source_records sr on sr.id = r.source_record_id
    join public.data_sources ds on ds.id = sr.data_source_id
    where r.hike_id = ${hikeId}`;
  const wantRules = new Map<string, { value: string; max_group: number | null; note: string | null; source_record_id: string }>();
  for (const f of chosen) {
    const kind = ruleKindOf(f.field);
    if (!kind) continue;
    const v = f.value as RuleValue;
    wantRules.set(kind, { value: v.value, max_group: v.max_group ?? null, note: v.note ?? null, source_record_id: recordOf(f) });
  }
  for (const [kind, want] of wantRules) {
    const have = rules.find((r) => r.rule === kind);
    if (have) {
      const { value, max_group, note, source_record_id } = have;
      if (canonicalJson({ value, max_group, note, source_record_id }) === canonicalJson(want)) continue;
      await tx`
        update public.hike_rules set value = ${want.value}::public.rule_value, max_group = ${want.max_group}, note = ${want.note},
          source_record_id = ${want.source_record_id}
        where id = ${have.id}`;
    } else {
      await tx`
        insert into public.hike_rules (hike_id, rule, value, max_group, note, source_record_id)
        values (${hikeId}, ${kind}::public.rule_kind, ${want.value}::public.rule_value, ${want.max_group}, ${want.note}, ${want.source_record_id})`;
    }
    changes.rulesChanged++;
  }
  for (const r of rules) {
    if (r.owned && !wantRules.has(r.rule)) {
      await tx`delete from public.hike_rules where id = ${r.id}`;
      changes.rulesChanged++;
    }
  }

  // Hazards: one per type.
  type HazardRow = { id: string; type: string; note: string | null; source_record_id: string; owned: boolean };
  const hazards = await tx<HazardRow[]>`
    select h.id, h.type::text as type, h.note, h.source_record_id, ds.key = 'official_site' as owned
    from public.hike_hazards h join public.source_records sr on sr.id = h.source_record_id
    join public.data_sources ds on ds.id = sr.data_source_id
    where h.hike_id = ${hikeId}`;
  const wantHazards = new Map<string, { note: string | null; source_record_id: string }>();
  for (const f of chosen) {
    if (f.field !== "hazard") continue;
    const v = f.value as { type: string; note: string };
    wantHazards.set(v.type, { note: v.note ?? null, source_record_id: recordOf(f) });
  }
  for (const [type, want] of wantHazards) {
    const have = hazards.find((h) => h.type === type);
    if (have) {
      if (canonicalJson({ note: have.note, source_record_id: have.source_record_id }) === canonicalJson(want)) continue;
      await tx`update public.hike_hazards set note = ${want.note}, source_record_id = ${want.source_record_id} where id = ${have.id}`;
    } else {
      await tx`
        insert into public.hike_hazards (hike_id, type, note, source_record_id)
        values (${hikeId}, ${type}::public.hazard_type, ${want.note}, ${want.source_record_id})`;
    }
    changes.hazardsChanged++;
  }
  for (const h of hazards) {
    if (h.owned && !wantHazards.has(h.type)) {
      await tx`delete from public.hike_hazards where id = ${h.id}`;
      changes.hazardsChanged++;
    }
  }

  // Hike-level fees: compared as whole rows.
  type FeeRow = {
    id: string; name: string | null; amount_minor: string; currency: string; unit: string; audience: string;
    valid_from: string | null; valid_to: string | null; note: string | null; source_record_id: string; owned: boolean;
  };
  const feeShape = (r: Omit<FeeRow, "id" | "owned">) =>
    canonicalJson({ ...r, amount_minor: String(r.amount_minor) });
  const fees = await tx<FeeRow[]>`
    select f.id, f.name, f.amount_minor::text as amount_minor, f.currency::text as currency, f.unit::text as unit,
           f.audience::text as audience, f.valid_from::text as valid_from, f.valid_to::text as valid_to, f.note,
           f.source_record_id, ds.key = 'official_site' as owned
    from public.fees f join public.source_records sr on sr.id = f.source_record_id
    join public.data_sources ds on ds.id = sr.data_source_id
    where f.hike_id = ${hikeId}`;
  const wantFees = new Map<string, Omit<FeeRow, "id" | "owned">>();
  for (const f of chosen) {
    if (f.field !== "fee") continue;
    const v = f.value as FeeValue;
    const row = {
      name: v.name,
      amount_minor: String(toMinorUnits(v.amount, minor(v.currency))),
      currency: v.currency,
      unit: v.unit,
      audience: v.audience,
      valid_from: v.valid_from ?? null,
      valid_to: v.valid_to ?? null,
      note: v.note ?? null,
      source_record_id: recordOf(f),
    };
    wantFees.set(feeShape(row), row);
  }
  const haveFees = new Set<string>();
  for (const f of fees) {
    const { id, owned, ...rest } = f;
    const shape = feeShape(rest);
    if (owned && !wantFees.has(shape)) {
      await tx`delete from public.fees where id = ${id}`;
      changes.feesRemoved++;
    } else haveFees.add(shape);
  }
  for (const [shape, row] of wantFees) {
    if (haveFees.has(shape)) continue;
    await tx`
      insert into public.fees (hike_id, name, amount_minor, currency, unit, audience, valid_from, valid_to, note, source_record_id)
      values (${hikeId}, ${row.name}, ${row.amount_minor}::bigint, ${row.currency}, ${row.unit}::public.fee_unit,
              ${row.audience}::public.fee_audience, ${row.valid_from}::date, ${row.valid_to}::date, ${row.note}, ${row.source_record_id})`;
    changes.feesAdded++;
  }

  // Permits (shared rows, linked through hike_permits) with their price as a permit fee.
  await syncPermits(tx, ctx, hikeId, chosen, recordOf, changes);
}

interface PermitShape {
  name: string;
  kind: string;
  how_to_apply: string | null;
  booking_window: string | null;
  official_url: string | null;
  months: number[] | null;
  note: string | null;
  source_record_id: string;
  price: { amount_minor: string; currency: string; unit: string; audience: string; note: string | null } | null;
}

async function syncPermits(
  tx: Tx,
  ctx: LoadContext,
  hikeId: string,
  chosen: ResolvedFact[],
  recordOf: (f: ResolvedFact) => string,
  changes: HikeChanges,
): Promise<void> {
  const permitRows = (where: "linked" | "candidates", names: string[]) => tx<Array<PermitShape & { id: string; owned: boolean }>>`
    select p.id, p.name, p.kind::text as kind, p.how_to_apply, p.booking_window, p.official_url, p.months::int[] as months,
           p.note, p.source_record_id, ds.key = 'official_site' as owned,
           (select jsonb_build_object('amount_minor', f.amount_minor::text, 'currency', f.currency::text, 'unit', f.unit::text,
                                      'audience', f.audience::text, 'note', f.note)
            from public.fees f where f.permit_id = p.id order by f.created_at, f.id limit 1) as price
    from public.permits p
    join public.source_records sr on sr.id = p.source_record_id
    join public.data_sources ds on ds.id = sr.data_source_id
    where ${where === "linked"
      ? tx`exists (select 1 from public.hike_permits hp where hp.permit_id = p.id and hp.hike_id = ${hikeId})`
      : tx`p.name = any(${names}::text[])`}`;
  const shapeOf = (p: PermitShape) =>
    canonicalJson({
      name: p.name, kind: p.kind, how_to_apply: p.how_to_apply, booking_window: p.booking_window, official_url: p.official_url,
      months: p.months, note: p.note, source_record_id: p.source_record_id, price: p.price,
    });

  const want = new Map<string, PermitShape>();
  for (const f of chosen) {
    if (f.field !== "permit") continue;
    const v = f.value as PermitValue;
    const shape: PermitShape = {
      name: v.name,
      kind: v.kind,
      how_to_apply: v.how_to_apply ?? null,
      booking_window: v.booking_window ?? null,
      official_url: v.official_url ?? null,
      months: v.months ?? null,
      note: f.note,
      source_record_id: recordOf(f),
      price: v.price
        ? {
            amount_minor: String(toMinorUnits(v.price.amount, ctx.currencies.get(v.price.currency)!)),
            currency: v.price.currency,
            unit: v.price.unit,
            audience: v.price.audience,
            note: v.price.note ?? null,
          }
        : null,
    };
    want.set(shapeOf(shape), shape);
  }

  const linked = await permitRows("linked", []);
  const haveShapes = new Set<string>();
  for (const p of linked) {
    const shape = shapeOf(p);
    if (p.owned && !want.has(shape)) {
      await tx`delete from public.hike_permits where hike_id = ${hikeId} and permit_id = ${p.id}`;
      await tx`delete from public.permits p where p.id = ${p.id} and not exists (select 1 from public.hike_permits hp where hp.permit_id = p.id)`;
      changes.permitsUnlinked++;
    } else haveShapes.add(shape);
  }
  const missing = [...want.entries()].filter(([shape]) => !haveShapes.has(shape));
  if (!missing.length) return;
  // A permit another hike already cites with the same content is shared, not copied.
  const candidates = await permitRows("candidates", missing.map(([, p]) => p.name));
  for (const [shape, p] of missing) {
    let permitId = candidates.find((c) => shapeOf(c) === shape)?.id;
    if (!permitId) {
      const [created] = await tx<{ id: string }[]>`
        insert into public.permits (name, kind, how_to_apply, booking_window, official_url, months, note, source_record_id)
        values (${p.name}, ${p.kind}::public.permit_kind, ${p.how_to_apply}, ${p.booking_window}, ${p.official_url},
                ${p.months}::smallint[], ${p.note}, ${p.source_record_id})
        returning id`;
      permitId = created.id;
      if (p.price) {
        await tx`
          insert into public.fees (permit_id, name, amount_minor, currency, unit, audience, note, source_record_id)
          values (${permitId}, ${p.name}, ${p.price.amount_minor}::bigint, ${p.price.currency}, ${p.price.unit}::public.fee_unit,
                  ${p.price.audience}::public.fee_audience, ${p.price.note}, ${p.source_record_id})`;
      }
    }
    await tx`insert into public.hike_permits (hike_id, permit_id) values (${hikeId}, ${permitId}) on conflict do nothing`;
    changes.permitsLinked++;
  }
}

// ---------------------------------------------------------------------------
// Published values (single writer)
// ---------------------------------------------------------------------------
async function copyPublishedValues(tx: Tx, hikeId: string, seed: Seed, changes: HikeChanges): Promise<void> {
  const facts = await tx<Array<{ field: FactField; value: unknown; basis: CurrentFact["basis"]; checked_at: Date | null }>>`
    select field, value, basis::text as basis, checked_at from public.hike_facts
    where hike_id = ${hikeId} and superseded_at is null and verified
    order by created_at, id`;
  const want = publishedColumns(
    facts.map((f) => ({ field: f.field, value: f.value, basis: f.basis, checkedAt: f.checked_at })),
    { officialUrl: seed.official_url, accessMode: seed.access_mode },
  );
  const [have] = await tx<Array<Record<string, unknown>>>`
    select distance_km::float8 as distance_km, distance_basis::text as distance_basis, elevation_gain_m, high_point_m,
           duration_min_minutes, duration_max_minutes, duration_min_days, duration_max_days, route_type::text as route_type,
           difficulty_official, best_months::int[] as best_months, season_note, permit_required::text as permit_required,
           parking, trailhead_access, public_transport, nearest_town, official_url, access_mode::text as access_mode,
           operating_status::text as operating_status, last_verified_at
    from public.hikes where id = ${hikeId}`;
  const normalised = { ...have, last_verified_at: have.last_verified_at ? new Date(have.last_verified_at as Date).toISOString() : null };
  if (canonicalJson(normalised) === canonicalJson(want)) return;
  await tx`
    update public.hikes set
      distance_km = ${want.distance_km}, distance_basis = ${want.distance_basis}::public.distance_basis,
      elevation_gain_m = ${want.elevation_gain_m}, high_point_m = ${want.high_point_m},
      duration_min_minutes = ${want.duration_min_minutes}, duration_max_minutes = ${want.duration_max_minutes},
      duration_min_days = ${want.duration_min_days}, duration_max_days = ${want.duration_max_days},
      route_type = ${want.route_type}::public.hike_route_type,
      difficulty_official = ${want.difficulty_official ? tx.json(want.difficulty_official as never) : null},
      best_months = ${want.best_months}::smallint[], season_note = ${want.season_note},
      permit_required = ${want.permit_required}::public.permit_requirement, parking = ${want.parking},
      trailhead_access = ${want.trailhead_access}, public_transport = ${want.public_transport},
      nearest_town = ${want.nearest_town}, official_url = ${want.official_url},
      access_mode = ${want.access_mode}::public.access_mode, operating_status = ${want.operating_status}::public.operating_status,
      last_verified_at = ${want.last_verified_at}
    where id = ${hikeId}`;
  changes.publishedColumns = "updated";
}
