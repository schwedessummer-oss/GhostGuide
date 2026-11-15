#!/usr/bin/env node
/**
 * End-to-end test harness (no extra dependencies):
 *  1. recreate + migrate + seed a dedicated e2e database
 *  2. build (unless --no-build) and start `next start` against it
 *     (NEXT_PUBLIC_* values are inlined by the build)
 *  3. run Playwright-driven specs with Node's built-in test runner
 *
 * No page calls an external data provider, so the suite needs no provider
 * mocks and never touches the internet.
 *
 * Usage: npm run test:e2e [-- --no-build] [-- --headed] [-- site admin ...]
 *        (bare names / paths select spec files; default: every spec)
 * Env:   E2E_DATABASE_URL (default local ghostguide_e2e), E2E_PORT (3200).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = process.env.E2E_PORT ?? "3200";
const baseUrl = `http://localhost:${port}`;
const dbUrl = process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/ghostguide_e2e";
const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
/** Records which base URL the current build inlined (NEXT_PUBLIC_APP_URL). */
const buildMarker = path.join(root, ".next", "e2e-build.json");

function selectedSpecs() {
  const picked = args.filter((a) => !a.startsWith("--"));
  if (picked.length === 0) return ["tests/e2e/specs/*.spec.mjs"];
  return picked.map((a) => {
    const name = path.basename(a).replace(/\.spec\.mjs$/, "");
    const file = path.join("tests/e2e/specs", `${name}.spec.mjs`);
    if (!existsSync(path.join(root, file))) throw new Error(`No such spec: ${file}`);
    return file;
  });
}

/** Run a command to completion (inherits stdio). */
function run(cmd, env = process.env) {
  console.log(`$ ${cmd}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { cwd: root, stdio: "inherit", env, shell: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed (${signal ?? `exit ${code}`})`))));
  });
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

async function assertPortFree(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
  } catch {
    return;
  }
  throw new Error(`Something already answers at ${url}; stop it (or set E2E_PORT) so the suite tests this build.`);
}

/** With --no-build, the existing build must have been made by this harness for this base URL. */
function assertReusableBuild() {
  let built;
  try {
    built = JSON.parse(readFileSync(buildMarker, "utf8"));
  } catch {
    throw new Error("--no-build: the current build was not made by this harness (no .next/e2e-build.json). Run without --no-build once.");
  }
  if (built.baseUrl !== baseUrl) throw new Error(`--no-build: the build was made for ${built.baseUrl}, not ${baseUrl}. Rebuild.`);
}

/** Requests to the local app must never go through an outbound proxy. */
function withoutProxyForLocalhost(env) {
  const out = { ...env };
  delete out.NODE_USE_ENV_PROXY;
  delete out.HTTP_PROXY;
  delete out.http_proxy;
  const local = ["localhost", "127.0.0.1", "::1"];
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const list = (out[key] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    out[key] = [...new Set([...local, ...list])].join(",");
  }
  return out;
}

let server;
let exitCode = 1;

/** `next start` runs in its own process group so the whole tree stops with the suite. */
function stopServer() {
  if (!server || server.exitCode !== null) return;
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopServer();
    process.exit(130);
  });
}

try {
  const specs = selectedSpecs();
  await assertPortFree(`${baseUrl}/status`);
  if (noBuild) assertReusableBuild();

  const serverEnv = withoutProxyForLocalhost({
    ...process.env,
    NODE_ENV: "production",
    APP_MODE: "demo",
    AUTH_PROVIDER: "demo",
    PAYMENTS_PROVIDER: "demo",
    WEATHER_PROVIDER: "demo",
    NEXT_PUBLIC_APP_URL: baseUrl,
    DATABASE_URL: dbUrl,
    AUTH_SECRET: "e2e-secret-0123456789abcdef0123456789abcdef",
    CRON_SECRET: "e2e-cron-secret-0123456789",
    // The suite signs in many times from one IP; production limits stay at x1.
    RATE_LIMIT_SCALE: "50",
  });

  await run("npx tsx scripts/db/reset.ts", { ...process.env, DATABASE_URL: dbUrl, AUTH_PROVIDER: "demo" });
  if (!noBuild) {
    await run("npx next build", serverEnv);
    mkdirSync(path.dirname(buildMarker), { recursive: true });
    writeFileSync(buildMarker, JSON.stringify({ baseUrl, builtAt: new Date().toISOString() }, null, 2));
  }
  server = spawn("npx", ["next", "start", "-p", port], { cwd: root, env: serverEnv, stdio: ["ignore", "inherit", "inherit"], detached: true });
  await waitForServer(`${baseUrl}/status`);
  const testEnv = {
    ...withoutProxyForLocalhost(process.env),
    E2E_BASE_URL: baseUrl,
    E2E_DATABASE_URL: dbUrl,
    E2E_CRON_SECRET: serverEnv.CRON_SECRET,
    E2E_HEADED: args.includes("--headed") ? "1" : "",
  };
  try {
    await run(`node --test --test-concurrency=1 ${specs.map((s) => `"${s}"`).join(" ")}`, testEnv);
    exitCode = 0;
  } catch {
    exitCode = 1;
  }
} catch (err) {
  console.error(err.message);
  exitCode = 1;
} finally {
  stopServer();
}
process.exit(exitCode);
