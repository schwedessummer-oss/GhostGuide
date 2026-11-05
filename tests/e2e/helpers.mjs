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
