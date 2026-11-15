/**
 * GhostGuide ingestion CLI. Runs offline (a laptop or CI), never in the app.
 *
 *   npm run ingest -- <command> [options]
 *
 * Commands are registered in COMMANDS below. Adapters (wiki, osm, dem, ...)
 * plug in as further commands and share the services in lib/: the HTTP
 * client (cache, rate limit, User-Agent), the source-record writer, the skip
 * logger, the licence mapper and the database helper.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { runCheck } from "./commands/check";
import { runLoad } from "./commands/load";
import { runPublish } from "./commands/publish";
import { runReport } from "./commands/report";
import { runReportSkipped } from "./commands/report-skipped";
import { dataDir, INGEST_ROOT, loadEnv, REPO_ROOT } from "./config";
import { connect, type Sql } from "./lib/db";
import { consoleOutput, type Output } from "./lib/output";

export interface CommandArgs {
  slug?: string;
  dryRun: boolean;
  out?: string;
}

export interface Command {
  name: string;
  usage: string;
  summary: string;
  /** Opens a database connection for run(). */
  needsDb: boolean;
  run(args: CommandArgs, env: { sql: Sql | null; out: Output }): Promise<number>;
}

export const COMMANDS: Command[] = [
  {
    name: "check",
    usage: "check",
    summary: "Validate seeds/hikes/*.yaml and curated/*.yaml in INGEST_DATA_DIR; non-zero exit on errors.",
    needsDb: false,
    async run(_args, { out }) {
      const { summary } = await runCheck(dataDir(), out);
      return summary.errors ? 1 : 0;
    },
  },
  {
    name: "load",
    usage: "load [--slug <slug>]",
    summary: "Load seeds and verified curated facts into the database (one transaction per hike, idempotent).",
    needsDb: true,
    async run(args, { sql, out }) {
      const { totals } = await runLoad(sql!, dataDir(), out, { slug: args.slug });
      return totals.failed ? 1 : 0;
    },
  },
  {
    name: "publish",
    usage: "publish [--slug <slug>] [--dry-run]",
    summary: "Check the publish gate for each hike, print what is missing, publish the hikes that pass.",
    needsDb: true,
    async run(args, { sql, out }) {
      const results = await runPublish(sql!, out, { slug: args.slug, dryRun: args.dryRun });
      return results.some((r) => r.action === "failed") ? 1 : 0;
    },
  },
  {
    name: "report",
    usage: "report [--out <file>]",
    summary: "Write ingest/reports/coverage.md: filled vs empty key fields per hike, status and source counts.",
    needsDb: true,
    async run(args, { sql, out }) {
      await runReport(sql!, out, { file: args.out ?? path.join(INGEST_ROOT, "reports", "coverage.md") });
      return 0;
    },
  },
  {
    name: "report-skipped",
    usage: "report-skipped [--out <file>]",
    summary: 'Regenerate the "Run-time skips" section of docs/skipped-sources.md from skipped_records.',
    needsDb: true,
    async run(args, { sql, out }) {
      await runReportSkipped(sql!, out, { file: args.out ?? path.join(REPO_ROOT, "docs", "skipped-sources.md") });
      return 0;
    },
  },
];

function help(out: Output): void {
  out.line("Usage: npm run ingest -- <command> [options]");
  out.line("");
  for (const c of COMMANDS) out.line(`  ${c.usage.padEnd(38)} ${c.summary}`);
  out.line("");
  out.line("Environment: INGEST_DATA_DIR (default ingest/), INGEST_CACHE_DIR (default ingest/.cache), DATABASE_URL.");
}

export async function main(argv: string[], out: Output = consoleOutput): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      slug: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const name = positionals[0];
  if (!name || values.help || name === "help") {
    help(out);
    return name || values.help ? 0 : 1;
  }
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    out.line(`Unknown command "${name}".`);
    help(out);
    return 1;
  }
  if (positionals.length > 1) throw new Error(`Unexpected argument(s): ${positionals.slice(1).join(" ")}`);
  loadEnv();
  const sql = command.needsDb ? connect() : null;
  try {
    return await command.run({ slug: values.slug, dryRun: values["dry-run"] ?? false, out: values.out }, { sql, out });
  } finally {
    await sql?.end({ timeout: 5 });
  }
}

if (typeof require !== "undefined" && require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
