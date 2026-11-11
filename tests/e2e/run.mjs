#!/usr/bin/env node
/**
 * End-to-end test harness (no extra dependencies):
 *  1. recreate + migrate + seed a dedicated e2e database
 *  2. build (unless --no-build) and start `next start` against it
 *  3. run Playwright-driven specs with Node's built-in test runner
 *
 * Usage: npm run test:e2e [-- --no-build] [-- --headed]
 * Env:   E2E_DATABASE_URL (default local ghostguide_e2e), E2E_PORT (3200)
 */
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = process.env.E2E_PORT ?? "3200";
const baseUrl = `http://localhost:${port}`;
const dbUrl = process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/ghostguide_e2e";
const args = process.argv.slice(2);

const serverEnv = {
  ...process.env,
  NODE_ENV: "production",
  APP_MODE: "demo",
  AUTH_PROVIDER: "demo",
  PAYMENTS_PROVIDER: "demo",
  AI_PROVIDER: "demo",
  NOTIFY_PROVIDER: "demo",
  WEATHER_PROVIDER: "demo",
  STORAGE_PROVIDER: "local",
  LOCAL_STORAGE_DIR: ".data/e2e-storage",
  NEXT_PUBLIC_APP_URL: baseUrl,
  DATABASE_URL: dbUrl,
  AUTH_SECRET: "e2e-secret-0123456789abcdef0123456789abcdef",
  CRON_SECRET: "e2e-cron-secret-0123456789",
  NEXT_PUBLIC_MAPBOX_TOKEN: "",
  // The suite signs in many times from one IP; production limits stay at x1.
  RATE_LIMIT_SCALE: "50",
};

function run(cmd, env = process.env) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: "inherit", env });
}

async function waitForServer(url, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not start at ${url}`);
}

let server;
let exitCode = 1;
try {
  run("npx tsx scripts/db/reset.ts", { ...process.env, DATABASE_URL: dbUrl, AUTH_PROVIDER: "demo" });
  if (!args.includes("--no-build")) run("npx next build", { ...serverEnv, NODE_ENV: "production" });
  server = spawn("npx", ["next", "start", "-p", port], { cwd: root, env: serverEnv, stdio: ["ignore", "inherit", "inherit"] });
  await waitForServer(`${baseUrl}/status`);
  const testEnv = { ...process.env, E2E_BASE_URL: baseUrl, E2E_DATABASE_URL: dbUrl, E2E_CRON_SECRET: serverEnv.CRON_SECRET, E2E_HEADED: args.includes("--headed") ? "1" : "" };
  try {
    execSync("node --test --test-concurrency=1 tests/e2e/specs/", { cwd: root, stdio: "inherit", env: testEnv });
    exitCode = 0;
  } catch {
    exitCode = 1;
  }
} catch (err) {
  console.error(err.message);
  exitCode = 1;
} finally {
  if (server) server.kill("SIGTERM");
}
process.exit(exitCode);
