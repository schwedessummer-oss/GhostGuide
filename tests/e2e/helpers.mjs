import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Use the project's playwright if installed, else the preinstalled global one.
function loadPlaywright() {
  for (const id of ["playwright", "/opt/node-tools/node_modules/playwright"]) {
    try {
      return require(id);
    } catch {
      /* try next */
    }
  }
  throw new Error("Playwright is not available");
}

export const { chromium } = loadPlaywright();
export const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3200";
export const PASSWORD = "ghostguide-demo";
/** The mock data providers started by run.mjs (tests/e2e/mock-providers.mjs). */
export const MOCK = process.env.E2E_MOCK_URL ?? "http://127.0.0.1:3299";

export async function newBrowser() {
  return chromium.launch({ headless: !process.env.E2E_HEADED });
}

/** Mobile-ish context with geolocation permission for the hike flow. */
export async function newContext(browser, opts = {}) {
  return browser.newContext({
    viewport: { width: 390, height: 844 },
    baseURL: BASE,
    permissions: ["geolocation"],
    geolocation: { latitude: 47.5052, longitude: -121.7021, accuracy: 10 },
    ...opts,
  });
}

export async function login(page, email) {
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 }), page.click("button[type=submit]")]);
}

export async function runJobs() {
  const res = await fetch(`${BASE}/api/cron/jobs`, { headers: { authorization: `Bearer ${process.env.E2E_CRON_SECRET}` } });
  if (!res.ok) throw new Error(`cron failed: ${res.status}`);
  return res.json();
}

/** The trail-catalog job runner (tile ingestion), separate from the safety job runner. */
export async function runCatalogJobs() {
  const res = await fetch(`${BASE}/api/cron/catalog`, { headers: { authorization: `Bearer ${process.env.E2E_CRON_SECRET}` } });
  if (!res.ok) throw new Error(`catalog cron failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Mock data providers
// ---------------------------------------------------------------------------

async function mockCall(pathname, body) {
  const res = await fetch(`${MOCK}${pathname}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`mock ${pathname} failed: ${res.status}`);
  return res.json();
}

/** Deep-merge settings into the mock (see mock-providers.mjs), e.g. a slow or failing Overpass tile. */
export const mockControl = (patch) => mockCall("/__mock/control", patch);
/** Default mock settings and an empty request log. */
export const mockReset = () => mockCall("/__mock/reset", {});
/** Requests the mock received (optionally for one provider: overpass, nominatim, metno, nws, terrain_tiles). */
export const mockRequests = (provider) => mockCall(`/__mock/requests${provider ? `?provider=${provider}` : ""}`);

// ---------------------------------------------------------------------------
// The recorded real-world area: Table Rock State Park, South Carolina
// ---------------------------------------------------------------------------

/** The area Explore searches for "Table Rock State Park" (≈10 km around the park; see bboxForPlace). */
export const TABLE_ROCK_SEARCH_BBOX = "-82.82361,34.94664,-82.60419,35.1263";
export const TABLE_ROCK_TRAIL_PATH = "/trail/us/south-carolina/table-rock-trail";

/** GET /api/trails/search, with the HTTP status. */
export async function searchTrailsApi(query) {
  const res = await fetch(`${BASE}/api/trails/search?${new URLSearchParams(query)}`, { headers: { accept: "application/json" } });
  return { status: res.status, body: await res.json() };
}

/**
 * Make sure the recorded Table Rock area is in the catalog (search → on-demand
 * tile ingestion through the mock Overpass), polling like the Explore page.
 * Idempotent: returns at once when the area is already loaded.
 */
export async function ensureTableRockLoaded({ timeoutMs = 90_000 } = {}) {
  const started = Date.now();
  for (;;) {
    const { status, body } = await searchTrailsApi({ bbox: TABLE_ROCK_SEARCH_BBOX });
    if (status !== 200) throw new Error(`trail search failed: ${status} ${JSON.stringify(body)}`);
    if (body.coverage.state === "ready") return body;
    if (body.coverage.state !== "loading") throw new Error(`Table Rock coverage is ${body.coverage.state}: ${body.coverage.message}`);
    if (Date.now() - started > timeoutMs) throw new Error(`Table Rock area still loading after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 1_500));
  }
}
