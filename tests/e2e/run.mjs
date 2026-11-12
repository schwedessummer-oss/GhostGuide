#!/usr/bin/env node
/**
 * End-to-end test harness (no extra dependencies):
 *  1. start the mock data providers (tests/e2e/mock-providers.mjs): Overpass,
 *     Nominatim, MET Norway, NWS, terrain tiles and a blank map style, so the
 *     suite never touches the internet and always sees the same recorded data
 *  2. recreate + migrate + seed a dedicated e2e database
 *  3. build (unless --no-build) and start `next start` against it, both
 *     pointed at the mocks (NEXT_PUBLIC_* values are inlined by the build)
 *  4. run Playwright-driven specs with Node's built-in test runner
 *
 * Usage: npm run test:e2e [-- --no-build] [-- --headed] [-- explore trail ...]
 *        (bare names / paths select spec files; default: every spec)
 * Env:   E2E_DATABASE_URL (default local ghostguide_e2e), E2E_PORT (3200),
 *        E2E_MOCK_PORT (3299; another free port is used when it is taken and
 *        the app is being built), E2E_MOCK_LOG=1 prints every mock request.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mockProviderEnv, startMockProviders } from "./mock-providers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = process.env.E2E_PORT ?? "3200";
const baseUrl = `http://localhost:${port}`;
const dbUrl = process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/ghostguide_e2e";
const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
/** Records which mock URL the current build inlined (NEXT_PUBLIC_MAP_STYLE_URL). */
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

/**
 * Run a command to completion WITHOUT blocking this process: the mock
 * providers live in this process's event loop and must keep answering the
 * app server (and the browser) while builds and specs run.
 */
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

/** The mock on the preferred port; with a build, any free port when that one is taken. */
async function startMock() {
  const preferred = Number(process.env.E2E_MOCK_PORT ?? 3299);
  const quiet = !process.env.E2E_MOCK_LOG;
  let built = null;
  if (noBuild) {
    try {
      built = JSON.parse(readFileSync(buildMarker, "utf8"));
    } catch {
      throw new Error("--no-build: the current build was not made by this harness (no .next/e2e-build.json). Run without --no-build once.");
    }
  }
  const wanted = built ? Number(new URL(built.mockUrl).port) : preferred;
  try {
    return await startMockProviders({ port: wanted, quiet });
  } catch (err) {
    if (err?.code !== "EADDRINUSE") throw err;
    if (built) throw new Error(`--no-build: the build expects the mock providers on port ${wanted}, which is in use. Free it or rebuild.`);
    console.warn(`Port ${wanted} is in use; starting the mock providers on a free port.`);
    return startMockProviders({ port: 0, quiet });
  }
}

/**
 * Catalog trail pages are ISR pages generated on first request. Their cached
 * HTML embeds trail ids from the database of an earlier run, so a run that
 * reuses a build (--no-build) with a fresh database drops them first.
 */
function dropRuntimeTrailPages() {
  const dir = path.join(root, ".next", "server", "app", "trail");
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith("[")) rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

/** Requests to the local mocks must never go through an outbound proxy. */
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
let mock;
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
  mock = await startMock();
  console.log(`Mock data providers at ${mock.url}`);

  const serverEnv = withoutProxyForLocalhost({
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
    // The suite signs in many times from one IP; production limits stay at x1.
    RATE_LIMIT_SCALE: "50",
    // The fictional demo region (bookings, hike, safety specs) is a development fixture.
    SHOW_DEMO_FIXTURES: "true",
    // Real-data providers → local mocks (server URLs read at runtime, map URLs inlined by the build).
    ...mockProviderEnv(mock.url),
    // Provider policies require an identifying User-Agent; the mocks record what is sent.
    DATA_PROVIDER_USER_AGENT: process.env.DATA_PROVIDER_USER_AGENT || "GhostGuide/e2e (+http://localhost; e2e tests)",
    // US facilities enrichment (Recreation.gov) has no mock: keep it disabled.
    RIDB_API_KEY: "",
  });

  await run("npx tsx scripts/db/reset.ts", { ...process.env, DATABASE_URL: dbUrl, AUTH_PROVIDER: "demo" });
  if (!noBuild) {
    await run("npx next build", serverEnv);
    mkdirSync(path.dirname(buildMarker), { recursive: true });
    writeFileSync(buildMarker, JSON.stringify({ mockUrl: mock.url, builtAt: new Date().toISOString() }, null, 2));
  } else {
    dropRuntimeTrailPages();
  }
  server = spawn("npx", ["next", "start", "-p", port], { cwd: root, env: serverEnv, stdio: ["ignore", "inherit", "inherit"], detached: true });
  await waitForServer(`${baseUrl}/status`);
  const testEnv = {
    ...withoutProxyForLocalhost(process.env),
    E2E_BASE_URL: baseUrl,
    E2E_DATABASE_URL: dbUrl,
    E2E_CRON_SECRET: serverEnv.CRON_SECRET,
    E2E_MOCK_URL: mock.url,
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
  if (mock) await mock.close();
}
process.exit(exitCode);
