/**
 * Ingest configuration. Ingestion runs offline (a developer laptop or CI),
 * never inside the Next.js app.
 *
 *   INGEST_DATA_DIR  directory holding seeds/hikes/*.yaml and curated/*.yaml
 *                    (default: ingest/ in this repo)
 *   INGEST_CACHE_DIR raw-response cache (default: ingest/.cache, git-ignored)
 *   DATABASE_URL     Postgres connection (from .env.local / .env when unset)
 */
import path from "node:path";
import dotenv from "dotenv";

export const REPO_ROOT = path.resolve(__dirname, "../..");
export const INGEST_ROOT = path.join(REPO_ROOT, "ingest");

let envLoaded = false;

/** Load .env.local then .env without overriding variables that are already set. */
export function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  dotenv.config({ path: path.join(REPO_ROOT, ".env.local"), quiet: true });
  dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true });
}

export function dataDir(): string {
  const dir = process.env.INGEST_DATA_DIR?.trim();
  return dir ? path.resolve(dir) : INGEST_ROOT;
}

export function cacheDir(): string {
  const dir = process.env.INGEST_CACHE_DIR?.trim();
  return dir ? path.resolve(dir) : path.join(INGEST_ROOT, ".cache");
}

export function databaseUrl(): string {
  loadEnv();
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set (put it in .env.local).");
  return url;
}
