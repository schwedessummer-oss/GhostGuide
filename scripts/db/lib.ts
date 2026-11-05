import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

export const ROOT = path.resolve(__dirname, "../..");
export const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");
export const LOCAL_SHIM = path.join(ROOT, "db/local/00_supabase_shim.sql");

export function loadEnv() {
  // Load .env.local then .env without overriding real environment variables.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dotenv = require("dotenv");
  dotenv.config({ path: path.join(ROOT, ".env.local"), quiet: true });
  dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
}

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/ghostguide";
}

export function isLocalUrl(url: string): boolean {
  const u = new URL(url);
  return ["127.0.0.1", "localhost", "::1"].includes(u.hostname);
}

export function connect(url = databaseUrl()) {
  return postgres(url, { max: 1, onnotice: () => {}, ssl: process.env.DATABASE_SSL === "true" ? "require" : false });
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
}

/**
 * Apply pending migrations. On a plain Postgres (no `auth.users`), the local
 * Supabase shim is applied first. On Supabase, use `supabase db push` instead
 * (this runner also works there but tracks versions in its own table).
 */
export async function migrate(url = databaseUrl(), log = console.log) {
  const sql = connect(url);
  try {
    const [{ hasAuth }] = await sql<{ hasAuth: boolean }[]>`select to_regclass('auth.users') is not null as "hasAuth"`;
    if (!hasAuth) {
      if (!isLocalUrl(url)) throw new Error("auth.users missing on a non-local database; refusing to apply the local shim.");
      log("Applying local Supabase shim (db/local/00_supabase_shim.sql)");
      await sql.unsafe(readFileSync(LOCAL_SHIM, "utf8")).simple();
    }
    await sql`create schema if not exists ggmeta`;
    await sql`create table if not exists ggmeta.schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
    const applied = new Set((await sql<{ version: string }[]>`select version from ggmeta.schema_migrations`).map((r) => r.version));
    for (const file of migrationFiles()) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) continue;
      log(`Applying ${file}`);
      const body = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body).simple();
        await tx`insert into ggmeta.schema_migrations (version) values (${version})`;
      });
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Drop and recreate a LOCAL database. Refuses non-local URLs. */
export async function recreateDatabase(url = databaseUrl(), log = console.log) {
  if (!isLocalUrl(url)) throw new Error("db:reset only runs against a local database.");
  const u = new URL(url);
  const dbName = u.pathname.replace(/^\//, "");
  if (!/^[a-z0-9_]+$/.test(dbName)) throw new Error(`Unsafe database name: ${dbName}`);
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = connect(adminUrl.toString());
  try {
    log(`Recreating local database ${dbName}`);
    await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin.unsafe(`create database ${dbName}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}
