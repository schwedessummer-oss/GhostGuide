/**
 * Database helper for ingestion. Connects as the database owner (the
 * "system" role the app's server code also uses for ingestion and admin
 * writes); RLS does not apply. Never imported by the Next.js app.
 */
import { execSync } from "node:child_process";
import postgres from "postgres";
import { databaseUrl, REPO_ROOT } from "../config";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
/** Anything that runs a query: the pool or a transaction. */
export type Db = postgres.ISql;

export function connect(url = databaseUrl()): Sql {
  return postgres(url, {
    max: 2,
    onnotice: () => {},
    ssl: process.env.DATABASE_SSL === "true" ? "require" : false,
  });
}

export async function withTransaction<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin((tx) => fn(tx)) as Promise<T>;
}

export interface RunScope {
  command: string;
  [key: string]: unknown;
}

function gitCommit(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
}

/** Open an ingest_runs row. Its id goes on every source and skipped record of the run. */
export async function startRun(sql: Sql, scope: RunScope): Promise<string> {
  const full = { ...scope, git_commit: gitCommit(), runner: process.env.CI ? "ci" : "laptop" };
  const [row] = await sql<{ id: string }[]>`
    insert into public.ingest_runs (scope) values (${sql.json(full as postgres.JSONValue)}) returning id`;
  return row.id;
}

export async function finishRun(
  sql: Sql,
  runId: string,
  status: "succeeded" | "failed" | "partial",
  report: Record<string, unknown>,
  error?: string,
): Promise<void> {
  await sql`
    update public.ingest_runs
    set finished_at = now(), status = ${status}, report = ${sql.json(report as postgres.JSONValue)}, error = ${error ?? null}
    where id = ${runId}`;
}
