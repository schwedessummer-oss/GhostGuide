import { execSync } from "node:child_process";
import path from "node:path";

/**
 * Recreate, migrate and seed the integration-test database once per run.
 * Uses TEST_DATABASE_URL (default: local ghostguide_test). Refuses non-local URLs.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/ghostguide_test";
  const root = path.resolve(__dirname, "../..");
  execSync("npx tsx scripts/db/reset.ts", {
    cwd: root,
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: url, AUTH_PROVIDER: "demo" },
  });
}
