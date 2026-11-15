/**
 * `check`: validate every seed and curated YAML file of the data directory
 * against DATA_FORMATS.md, print the problems per file, and fail on errors.
 * Offline: no network, no database.
 */
import { readDataDir, type DataSet, type Problem } from "../data/read";
import type { Output } from "../lib/output";

export interface CheckSummary {
  seedFiles: number;
  seedsValid: number;
  curatedFiles: number;
  curatedUsable: number;
  facts: number;
  factsValid: number;
  factsVerified: number;
  factsInvalid: number;
  seedsWithoutCurated: number;
  errors: number;
  warnings: number;
}

export function summarise(data: DataSet): CheckSummary {
  const curated = [...data.curated.values()];
  const facts = curated.flatMap((c) => c.facts);
  return {
    seedFiles: data.seeds.size,
    seedsValid: [...data.seeds.values()].filter((s) => s.seed).length,
    curatedFiles: curated.length,
    curatedUsable: curated.filter((c) => c.ok).length,
    facts: facts.length,
    factsValid: facts.filter((f) => f.fact).length,
    factsVerified: facts.filter((f) => f.fact?.verified).length,
    factsInvalid: facts.filter((f) => !f.fact).length,
    seedsWithoutCurated: [...data.seeds.keys()].filter((slug) => !data.curated.has(slug)).length,
    errors: data.problems.filter((p) => p.level === "error").length,
    warnings: data.problems.filter((p) => p.level === "warning").length,
  };
}

export function formatProblems(problems: Problem[]): string[] {
  const byFile = new Map<string, Problem[]>();
  for (const p of problems) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
  const lines: string[] = [];
  for (const file of [...byFile.keys()].sort()) {
    const list = byFile.get(file)!;
    const errors = list.filter((p) => p.level === "error").length;
    const warnings = list.length - errors;
    lines.push(`${file}  (${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"})`);
    for (const p of list.sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1))) {
      lines.push(`  ${p.level === "error" ? "ERROR" : "warn "} ${p.at ? `${p.at}: ` : ""}${p.message}`);
    }
  }
  return lines;
}

export async function runCheck(dir: string, out: Output, opts: { today?: string } = {}): Promise<{ data: DataSet; summary: CheckSummary }> {
  const data = await readDataDir(dir, { today: opts.today });
  const summary = summarise(data);
  out.line(`Checking ${dir}`);
  for (const line of formatProblems(data.problems)) out.line(line);
  out.line("");
  out.line(`Seeds:   ${summary.seedFiles} files, ${summary.seedsValid} valid, ${summary.seedFiles - summary.seedsValid} invalid`);
  out.line(
    `Curated: ${summary.curatedFiles} files (${summary.curatedUsable} usable); ${summary.facts} facts, ` +
      `${summary.factsValid} valid, ${summary.factsVerified} verified (loadable), ${summary.factsInvalid} with errors`,
  );
  out.line(`Seeds without a curated file: ${summary.seedsWithoutCurated}`);
  out.line(`${summary.errors} error(s), ${summary.warnings} warning(s)`);
  return { data, summary };
}
