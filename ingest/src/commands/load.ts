/**
 * `load [--slug x]`: load seeds and verified curated facts into the database,
 * one transaction per hike (see load/apply.ts). Prints what changed per hike
 * and the totals; records the run in public.ingest_runs.
 */
import { readDataDir } from "../data/read";
import { finishRun, startRun, type Sql } from "../lib/db";
import type { Output } from "../lib/output";
import { SkipLogger } from "../lib/skips";
import { SourceRecordWriter } from "../lib/sources";
import { changedAnything, loadCurrencies, loadDataSet, type HikeLoadResult } from "../load/apply";

export interface LoadTotals {
  seeds: number;
  loaded: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  factsCurrent: number;
  factsAdded: number;
  factsSuperseded: number;
  factsUnverified: number;
  factsInvalid: number;
  factsConflicting: number;
  factsExtra: number;
  sourceRecords: number;
  agencies: number;
  areas: number;
  fees: number;
  permits: number;
  rules: number;
  hazards: number;
  skipsLogged: number;
}

export function totalsOf(results: HikeLoadResult[], skipsLogged: number): LoadTotals {
  const t: LoadTotals = {
    seeds: results.length, loaded: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0,
    factsCurrent: 0, factsAdded: 0, factsSuperseded: 0, factsUnverified: 0, factsInvalid: 0, factsConflicting: 0, factsExtra: 0,
    sourceRecords: 0, agencies: 0, areas: 0, fees: 0, permits: 0, rules: 0, hazards: 0, skipsLogged,
  };
  for (const r of results) {
    if (r.outcome === "skipped") t.skipped++;
    if (r.outcome === "failed") t.failed++;
    t.factsUnverified += r.facts.unverified;
    t.factsInvalid += r.facts.invalid;
    t.factsConflicting += r.facts.conflicting;
    t.factsExtra += r.facts.extra;
    const c = r.changes;
    if (r.outcome !== "loaded" || !c) continue;
    t.loaded++;
    t.factsCurrent += r.facts.current;
    if (c.hike === "inserted") t.inserted++;
    else if (changedAnything(c)) t.updated++;
    else t.unchanged++;
    t.factsAdded += c.factsAdded;
    t.factsSuperseded += c.factsSuperseded;
    t.sourceRecords += c.sourceRecords;
    t.agencies += c.agencies;
    t.areas += c.areas;
    t.fees += c.feesAdded + c.feesRemoved;
    t.permits += c.permitsLinked + c.permitsUnlinked;
    t.rules += c.rulesChanged;
    t.hazards += c.hazardsChanged;
  }
  return t;
}

function describe(r: HikeLoadResult): string {
  if (r.outcome === "failed") return `FAILED: ${r.error}`;
  if (r.outcome === "skipped" || !r.changes) return "skipped";
  const c = r.changes;
  const parts: string[] = [];
  if (c.hike !== "unchanged") parts.push(`hike ${c.hike}`);
  if (c.factsAdded || c.factsSuperseded) parts.push(`facts +${c.factsAdded} / superseded ${c.factsSuperseded}`);
  if (c.feesAdded || c.feesRemoved) parts.push(`fees +${c.feesAdded} -${c.feesRemoved}`);
  if (c.permitsLinked || c.permitsUnlinked) parts.push(`permits +${c.permitsLinked} -${c.permitsUnlinked}`);
  if (c.rulesChanged) parts.push(`rules ${c.rulesChanged} changed`);
  if (c.hazardsChanged) parts.push(`hazards ${c.hazardsChanged} changed`);
  if (c.sourceRecords) parts.push(`${c.sourceRecords} new source record(s)`);
  if (c.publishedColumns === "updated") parts.push("published values updated");
  return parts.length ? parts.join("; ") : "unchanged";
}

export async function runLoad(
  sql: Sql,
  dir: string,
  out: Output,
  opts: { slug?: string; today?: string } = {},
): Promise<{ results: HikeLoadResult[]; totals: LoadTotals; runId: string }> {
  const data = await readDataDir(dir, { slug: opts.slug, today: opts.today });
  if (opts.slug && !data.seeds.has(opts.slug)) throw new Error(`No seed file seeds/hikes/${opts.slug}.yaml in ${dir}`);
  const runId = await startRun(sql, { command: "load", slug: opts.slug ?? null, data_dir: dir });
  const skips = new SkipLogger(runId);
  const writer = new SourceRecordWriter(runId, skips);
  try {
    const results = await loadDataSet({ sql, writer, skips, currencies: await loadCurrencies(sql) }, data);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.skipped_records where ingest_run_id = ${runId}`;
    const totals = totalsOf(results, n);

    out.line(`Loading ${dir}${opts.slug ? ` (only ${opts.slug})` : ""}`);
    for (const r of results) {
      out.line(`${r.slug}: ${describe(r)}`);
      for (const m of r.messages) out.line(`    ${m}`);
    }
    out.line("");
    out.line(
      `Hikes: ${totals.seeds} seeds; ${totals.loaded} loaded (${totals.inserted} new, ${totals.updated} changed, ` +
        `${totals.unchanged} unchanged); ${totals.skipped} skipped (invalid seed); ${totals.failed} failed`,
    );
    out.line(
      `Facts: ${totals.factsCurrent} current from curated files (${totals.factsAdded} added, ${totals.factsSuperseded} superseded); ` +
        `not loaded: ${totals.factsUnverified} unverified, ${totals.factsInvalid} invalid, ${totals.factsConflicting} contradicting, ` +
        `${totals.factsExtra} extra for a field that already has a value`,
    );
    out.line(
      `Rows changed: ${totals.sourceRecords} source records, ${totals.agencies} agencies, ${totals.areas} areas, ` +
        `${totals.fees} fees, ${totals.permits} permit links, ${totals.rules} rules, ${totals.hazards} hazards; ` +
        `${totals.skipsLogged} skipped record(s) logged`,
    );
    const status = totals.failed ? (totals.loaded ? "partial" : "failed") : totals.skipped ? "partial" : "succeeded";
    await finishRun(sql, runId, status, { totals, failed: results.filter((r) => r.outcome === "failed").map((r) => ({ slug: r.slug, error: r.error })) });
    return { results, totals, runId };
  } catch (err) {
    await finishRun(sql, runId, "failed", {}, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
