/**
 * Reads and validates an ingest data directory:
 *
 *   <dir>/seeds/hikes/<slug>.yaml
 *   <dir>/curated/<slug>.yaml
 *
 * The files are still being written by the research process, so missing and
 * partial files are expected: every problem is reported against its file,
 * and valid parts stay usable. Nothing here touches the database.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import type { z } from "zod";
import { resolveFacts } from "../load/facts";
import {
  curatedFileSchema,
  factEnvelopeSchema,
  seedSchema,
  VALUE_SCHEMAS,
  type CuratedFact,
  type FactField,
  type Seed,
} from "./schemas";

export interface Problem {
  level: "error" | "warning";
  /** Path relative to the data directory. */
  file: string;
  /** Location inside the file, e.g. facts[3].value.amount. */
  at?: string;
  message: string;
}

export interface SeedEntry {
  file: string;
  slug: string;
  seed: Seed | null;
}

export interface FactEntry {
  index: number;
  field: string | null;
  /** source_url as written, even when the fact is invalid (for skip logging). */
  sourceUrl: string | null;
  /** The validated fact, or null when it has errors (it is then skipped). */
  fact: CuratedFact | null;
  /** `at` is relative to the fact, e.g. value.amount. */
  errors: Array<{ at: string; message: string }>;
}

export interface CuratedEntry {
  file: string;
  slug: string;
  /** False when the file itself is unusable (YAML error, bad header): its facts are not loaded. */
  ok: boolean;
  researchedAt: string | null;
  verifier: string | null;
  facts: FactEntry[];
}

export interface DataSet {
  dir: string;
  seeds: Map<string, SeedEntry>;
  curated: Map<string, CuratedEntry>;
  problems: Problem[];
}

export interface ReadOptions {
  /** Today's date (YYYY-MM-DD) for "checked in the future" checks. Defaults to the UTC date. */
  today?: string;
  /** Only this slug (load --slug). */
  slug?: string;
}

function formatPath(p: readonly PropertyKey[]): string {
  return p.reduce<string>((acc, part) => {
    if (typeof part === "number") return `${acc}[${part}]`;
    return acc ? `${acc}.${String(part)}` : String(part);
  }, "");
}

function zodProblems(file: string, error: z.ZodError, prefix: string): Problem[] {
  return error.issues.map((issue) => {
    const at = formatPath([...(prefix ? [prefix] : []), ...issue.path]);
    return { level: "error", file, at: at || undefined, message: issue.message };
  });
}

async function listYaml(dir: string, rel: string, problems: Problem[]): Promise<string[] | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const out: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    if (name.endsWith(".yml")) {
      problems.push({ level: "warning", file: path.join(rel, name), message: "ignored: data files use the .yaml extension" });
      continue;
    }
    if (!name.endsWith(".yaml")) continue;
    const full = path.join(dir, name);
    if ((await stat(full)).isFile()) out.push(name);
  }
  return out;
}

/** Parse YAML with the YAML 1.2 core schema (dates stay strings) and duplicate keys rejected. */
async function parseYaml(full: string, rel: string, problems: Problem[]): Promise<unknown> {
  const text = await readFile(full, "utf8");
  if (!text.trim()) {
    problems.push({ level: "error", file: rel, message: "file is empty" });
    return undefined;
  }
  const doc = parseDocument(text, { schema: "core", uniqueKeys: true, prettyErrors: false });
  for (const w of doc.warnings) problems.push({ level: "warning", file: rel, message: `YAML: ${w.message}` });
  if (doc.errors.length) {
    for (const e of doc.errors) problems.push({ level: "error", file: rel, message: `YAML: ${e.message.split("\n")[0]}` });
    return undefined;
  }
  return doc.toJS({ maxAliasCount: 50 });
}

function validateFact(raw: unknown, index: number, today: string): FactEntry {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const field = typeof obj.field === "string" ? obj.field : null;
  const sourceUrl = typeof obj.source_url === "string" ? obj.source_url : null;
  const errors: FactEntry["errors"] = [];
  const env = factEnvelopeSchema.safeParse(raw);
  if (!env.success) {
    for (const issue of env.error.issues) errors.push({ at: formatPath(issue.path), message: issue.message });
  }
  let value: unknown = undefined;
  if (field && field in VALUE_SCHEMAS) {
    const parsed = VALUE_SCHEMAS[field as FactField].safeParse((raw as { value?: unknown }).value);
    if (parsed.success) value = parsed.data;
    else for (const issue of parsed.error.issues) errors.push({ at: formatPath(["value", ...issue.path]), message: issue.message });
  }
  if (env.success && env.data.checked_at > today) errors.push({ at: "checked_at", message: `${env.data.checked_at} is in the future` });
  if (!env.success || errors.length) return { index, field, sourceUrl, fact: null, errors };

  const f = env.data;
  // best_months: one order, so the published array equals the fact value.
  if (f.field === "best_months") value = [...(value as number[])].sort((a, b) => a - b);
  if (f.field === "permit" && (value as { months?: number[] }).months) {
    const v = value as { months: number[] };
    value = { ...v, months: [...v.months].sort((a, b) => a - b) };
  }
  return {
    index,
    field,
    sourceUrl,
    errors: [],
    fact: {
      field: f.field,
      value,
      basis: f.basis ?? null,
      note: f.note ? f.note : null,
      sourceUrl: f.source_url,
      sourceTitle: f.source_title,
      publisher: f.publisher,
      checkedAt: f.checked_at,
      evidenceHeading: f.evidence_heading ?? null,
      verified: f.verified === true,
      verifyReason: f.verify_reason ?? null,
    },
  };
}

export async function readDataDir(dir: string, opts: ReadOptions = {}): Promise<DataSet> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const problems: Problem[] = [];
  const seeds = new Map<string, SeedEntry>();
  const curated = new Map<string, CuratedEntry>();
  const seedRel = path.join("seeds", "hikes");
  const seedNames = await listYaml(path.join(dir, seedRel), seedRel, problems);
  if (seedNames === null) {
    problems.push({ level: "error", file: seedRel, message: `no seeds/hikes directory in ${dir}` });
  }
  const curatedNames = (await listYaml(path.join(dir, "curated"), "curated", problems)) ?? [];

  const wanted = (name: string) => !opts.slug || name === `${opts.slug}.yaml`;

  for (const name of (seedNames ?? []).filter(wanted)) {
    const rel = path.join(seedRel, name);
    const fileSlug = name.replace(/\.yaml$/, "");
    const raw = await parseYaml(path.join(dir, rel), rel, problems);
    if (raw === undefined) {
      seeds.set(fileSlug, { file: rel, slug: fileSlug, seed: null });
      continue;
    }
    const parsed = seedSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(...zodProblems(rel, parsed.error, ""));
      seeds.set(fileSlug, { file: rel, slug: fileSlug, seed: null });
      continue;
    }
    if (parsed.data.slug !== fileSlug) {
      problems.push({ level: "error", file: rel, at: "slug", message: `"${parsed.data.slug}" does not match the file name` });
      seeds.set(fileSlug, { file: rel, slug: fileSlug, seed: null });
      continue;
    }
    seeds.set(fileSlug, { file: rel, slug: fileSlug, seed: parsed.data });
  }

  for (const name of curatedNames.filter(wanted)) {
    const rel = path.join("curated", name);
    const fileSlug = name.replace(/\.yaml$/, "");
    const entry: CuratedEntry = { file: rel, slug: fileSlug, ok: false, researchedAt: null, verifier: null, facts: [] };
    curated.set(fileSlug, entry);
    const raw = await parseYaml(path.join(dir, rel), rel, problems);
    if (raw === undefined) continue;
    const header = curatedFileSchema.safeParse(raw);
    if (!header.success) {
      problems.push(...zodProblems(rel, header.error, ""));
      continue;
    }
    if (header.data.slug !== fileSlug) {
      problems.push({ level: "error", file: rel, at: "slug", message: `"${header.data.slug}" does not match the file name` });
      continue;
    }
    entry.ok = true;
    entry.researchedAt = header.data.researched_at;
    const verifier = header.data.verifier;
    entry.verifier = typeof verifier === "string" ? verifier : verifier ? JSON.stringify(verifier) : null;
    entry.facts = header.data.facts.map((f, i) => validateFact(f, i, today));
    for (const fe of entry.facts) {
      for (const e of fe.errors) {
        const label = fe.field ? ` (${fe.field})` : "";
        problems.push({ level: "error", file: rel, at: `facts[${fe.index}]${e.at ? `.${e.at}` : ""}`, message: `${e.message}${label}` });
      }
    }
    if (!seeds.has(fileSlug) && !opts.slug) {
      problems.push({ level: "error", file: rel, message: `no seed file seeds/hikes/${fileSlug}.yaml for these facts` });
    }
    // Several verified facts for one field: the loader keeps one or none (see resolveFacts).
    const verified = entry.facts.filter((f) => f.fact?.verified).map((f) => f.fact as CuratedFact);
    for (const c of resolveFacts(verified).conflicts) {
      problems.push({
        level: "warning",
        file: rel,
        at: c.field,
        message: `${c.facts.length} verified facts disagree${c.valueKey ? ` for "${c.valueKey}"` : ""}; none will be loaded until one remains`,
      });
    }
  }

  crossFileChecks(seeds, problems);
  return { dir, seeds, curated, problems };
}

function crossFileChecks(seeds: Map<string, SeedEntry>, problems: Problem[]) {
  const valid = [...seeds.values()].filter((s): s is SeedEntry & { seed: Seed } => s.seed !== null);
  const bySeedNo = new Map<number, string[]>();
  const byQid = new Map<string, string[]>();
  const areaNames = new Map<string, Set<string>>();
  const agencyNames = new Map<string, Set<string>>();
  for (const { seed } of valid) {
    bySeedNo.set(seed.seed_no, [...(bySeedNo.get(seed.seed_no) ?? []), seed.slug]);
    if (seed.hike_wikidata) byQid.set(seed.hike_wikidata, [...(byQid.get(seed.hike_wikidata) ?? []), seed.slug]);
    if (seed.area.wikidata) areaNames.set(seed.area.wikidata, (areaNames.get(seed.area.wikidata) ?? new Set()).add(seed.area.name));
    if (seed.agency.wikidata) agencyNames.set(seed.agency.wikidata, (agencyNames.get(seed.agency.wikidata) ?? new Set()).add(seed.agency.name));
  }
  const fileOf = (slug: string) => seeds.get(slug)?.file ?? slug;
  // Clashing identities cannot both be stored; neither is loaded until one is fixed.
  const clash = (slugs: string[], at: string, value: string | number) => {
    if (slugs.length < 2) return;
    for (const s of slugs) {
      problems.push({ level: "error", file: fileOf(s), at, message: `${value} is also used by ${slugs.filter((x) => x !== s).join(", ")}` });
      const entry = seeds.get(s);
      if (entry) entry.seed = null;
    }
  };
  for (const [no, slugs] of bySeedNo) clash(slugs, "seed_no", no);
  for (const [qid, slugs] of byQid) clash(slugs, "hike_wikidata", qid);
  for (const [qid, names] of areaNames) {
    if (names.size > 1) problems.push({ level: "warning", file: "seeds/hikes", message: `area ${qid} has different names: ${[...names].join(" | ")} (the first loaded wins)` });
  }
  for (const [qid, names] of agencyNames) {
    if (names.size > 1) problems.push({ level: "warning", file: "seeds/hikes", message: `agency ${qid} has different names: ${[...names].join(" | ")} (the first loaded wins)` });
  }
  for (const { seed, file } of valid.filter((v) => v.seed)) {
    for (const flag of seed.flags) {
      const target = flag.startsWith("fallback_for:") ? flag.slice("fallback_for:".length) : null;
      if (target && !seeds.has(target)) problems.push({ level: "warning", file, at: "flags", message: `fallback_for:${target} names no seed file` });
    }
    const fb = seed.replacement?.fallback_slug;
    if (fb && !seeds.has(fb)) problems.push({ level: "warning", file, at: "replacement.fallback_slug", message: `${fb} names no seed file` });
    if (seed.flags.includes("operator_only") && seed.access_mode === "independent") {
      problems.push({ level: "warning", file, at: "access_mode", message: "flag operator_only but access_mode is independent" });
    }
  }
}

/** Facts of a curated entry that may be loaded: valid and verified: true. */
export function loadableFacts(entry: CuratedEntry | undefined): CuratedFact[] {
  if (!entry?.ok) return [];
  return entry.facts.filter((f) => f.fact?.verified).map((f) => f.fact as CuratedFact);
}
