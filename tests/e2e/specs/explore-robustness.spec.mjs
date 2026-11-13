/**
 * Caching, SEO hygiene and Explore robustness — what only a real build and
 * browser show (against the MOCK data providers, see run.mjs):
 *
 *  - #3   public pages are cacheable: the trail page is ISR (no private /
 *         no-store), the shared HTML carries no session, and the header
 *         fills in Sign out / Profile / Admin after hydration;
 *  - #36  the signed-out Save link is rel=nofollow and /login is noindex;
 *  - #35  sitemap entries carry no churning lastmod;
 *  - #21  an area that only partly loaded never says "no trails here";
 *  - #30  a slow place lookup that answers late does not override a newer
 *         area choice (Near me).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { BASE, TABLE_ROCK_TRAIL_PATH, ensureTableRockLoaded, login, mockReset, newBrowser } from "../helpers.mjs";

const TIMEOUT = 20_000;
const PLACE = "Table Rock State Park";
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TABLE_ROCK = { latitude: 35.0431, longitude: -82.7087 };

let browser;
before(async () => {
  browser = await newBrowser();
  await mockReset();
});
after(async () => {
  await mockReset().catch(() => {});
  await browser?.close();
});

let ipCounter = 0;
/** Own client IP per context, so per-IP rate limits never couple tests. */
function uniqueIp() {
  ipCounter += 1;
  const n = parseInt(RUN_ID.slice(-3), 36) % 250;
  return `10.${150 + (n % 50)}.${ipCounter % 250}.${(n + ipCounter * 11) % 250}`;
}

async function openPage({ viewport = { width: 1280, height: 900 }, ...opts } = {}) {
  const context = await browser.newContext({ baseURL: BASE, viewport, extraHTTPHeaders: { "x-forwarded-for": uniqueIp() }, ...opts });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  page.setDefaultNavigationTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  return { context, page, pageErrors };
}

const heading = (page) => page.locator("#explore-results-heading");

// ---------------------------------------------------------------------------
// #3 caching + #36 / #35 SEO hygiene
// ---------------------------------------------------------------------------

test("public pages are cacheable; the session is filled in by the browser", { timeout: 120_000 }, async () => {
  await ensureTableRockLoaded();
  // The trail page is ISR (revalidate = 3600): nothing in the root layout reads cookies or headers.
  const trail = await fetch(`${BASE}${TABLE_ROCK_TRAIL_PATH}`);
  assert.equal(trail.status, 200);
  const cc = trail.headers.get("cache-control") ?? "";
  assert.doesNotMatch(cc, /private|no-store/, `trail page Cache-Control: ${cc}`);
  assert.match(cc, /s-maxage=3600/, `trail page Cache-Control: ${cc}`);
  const how = await fetch(`${BASE}/how-it-works`);
  assert.doesNotMatch(how.headers.get("cache-control") ?? "", /private|no-store/);

  const { context, page, pageErrors } = await openPage();
  try {
    await login(page, "admin@demo.ghostguide.test");
    // Signed in, the server HTML is still the shared signed-out chrome…
    const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const html = await (await fetch(`${BASE}/how-it-works`, { headers: { cookie } })).text();
    assert.ok(html.includes('href="/login"'), "shared HTML has the sign-in link");
    assert.ok(!html.includes("Sign out"), "shared HTML has no session-specific chrome");
    assert.ok(!html.includes('href="/admin"'), "shared HTML has no Admin link");

    // …and the browser fills in the visitor's own chrome after hydration.
    await page.goto("/how-it-works");
    const header = page.getByRole("navigation", { name: "Main" });
    await header.getByRole("link", { name: "Admin", exact: true }).waitFor();
    await header.getByRole("button", { name: "Sign out" }).waitFor();
    assert.equal(await header.getByRole("link", { name: "Profile" }).getAttribute("href"), "/account");
    assert.equal(await header.getByRole("link", { name: "Sign in", exact: true }).count(), 0);
    const session = await page.evaluate(() => fetch("/api/session").then(async (r) => ({ cc: r.headers.get("cache-control"), body: await r.json() })));
    assert.deepEqual(session.body, { signedIn: true, canAdmin: true });
    assert.match(session.cc ?? "", /no-store/);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("signed-out Save is a nofollow link; /login is noindex; sitemap has no churning lastmod", { timeout: 90_000 }, async () => {
  await ensureTableRockLoaded();
  const { context, page, pageErrors } = await openPage();
  try {
    await page.goto(TABLE_ROCK_TRAIL_PATH);
    const save = page.getByRole("link", { name: /^Save Table Rock Trail \(sign in to save trails\)/ });
    await save.waitFor();
    assert.equal(await save.getAttribute("rel"), "nofollow");
    assert.equal(await save.getAttribute("href"), `/login?next=${encodeURIComponent(TABLE_ROCK_TRAIL_PATH)}`);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
  const loginHtml = await (await fetch(`${BASE}/login?next=${encodeURIComponent(TABLE_ROCK_TRAIL_PATH)}`)).text();
  assert.match(loginHtml, /<meta name="robots" content="noindex, follow"/);
  const robots = await (await fetch(`${BASE}/robots.txt`)).text();
  assert.doesNotMatch(robots, /Disallow: \/login/, "a disallowed page's noindex would never be seen");
  const xml = await (await fetch(`${BASE}/sitemap/0.xml`)).text();
  assert.match(xml, /<urlset/);
  assert.ok(!xml.includes("<lastmod>"), "no lastmod that moves on every refresh");
});

// ---------------------------------------------------------------------------
// #21 partial areas
// ---------------------------------------------------------------------------

test("an area that only partly loaded never says 'no trails here'", { timeout: 90_000 }, async () => {
  const { context, page, pageErrors } = await openPage();
  try {
    let searches = 0;
    await page.route("**/api/trails/search?**", async (route) => {
      searches += 1;
      const bbox = new URL(route.request().url()).searchParams.get("bbox").split(",").map(Number);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({
          trails: [],
          total: 0,
          bbox,
          coverage: {
            layer: "outdoor",
            state: "partial",
            tilesTotal: 4,
            tilesReady: 1,
            tilesLoading: 0,
            tilesFailed: 3,
            oldestSyncAt: null,
            message: "Some of this area could not be loaded right now; showing what is available.",
          },
          attribution: [],
        }),
      });
    });
    await page.goto("/explore");
    await page.locator("#explore-q").fill(PLACE);
    await page.getByRole("search").getByRole("button", { name: "Search" }).click();
    await page.waitForFunction(() => document.querySelector("#explore-results-heading")?.textContent?.trim() === "Some of this area couldn’t be loaded");
    const list = page.locator("#explore-list");
    await list.getByText("Part of this area couldn’t be loaded").waitFor();
    await list.getByText("No trails were found in the parts that did load.").waitFor();
    assert.equal(await page.getByText("No mapped trails in this area yet").count(), 0);
    assert.notEqual((await heading(page).innerText()).trim(), "No trails found");
    // Try again asks again.
    const before = searches;
    await list.getByRole("button", { name: "Try again" }).click();
    for (let i = 0; i < 50 && searches === before; i++) await page.waitForTimeout(100);
    assert.ok(searches > before, "Try again re-runs the search");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// #30 late answers
// ---------------------------------------------------------------------------

test("a slow place lookup that answers after Near me does not move the map", { timeout: 90_000 }, async () => {
  const { context, page, pageErrors } = await openPage({ permissions: ["geolocation"], geolocation: TABLE_ROCK });
  try {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    let lookups = 0;
    await page.route("**/api/geocode?**", async (route) => {
      lookups += 1;
      await held;
      // The page may have aborted the request meanwhile (that is the point): ignore the error.
      await route.continue().catch(() => {});
    });

    await page.goto("/explore");
    await page.locator("#explore-q").fill("Banff");
    await page.getByRole("search").getByRole("button", { name: "Search" }).click();
    await page.getByText("Looking up “Banff”…").waitFor();
    assert.equal(lookups, 1);

    // A newer choice while the lookup waits: the device location.
    await Promise.all([
      page.waitForURL((u) => u.pathname === "/explore" && u.searchParams.has("bbox") && !u.searchParams.has("q")),
      page.getByRole("button", { name: "Near me" }).click(),
    ]);
    const nearMeUrl = page.url();
    const [w, s, e, n] = new URL(nearMeUrl).searchParams.get("bbox").split(",").map(Number);
    assert.ok(w < TABLE_ROCK.longitude && e > TABLE_ROCK.longitude && s < TABLE_ROCK.latitude && n > TABLE_ROCK.latitude, nearMeUrl);
    assert.equal(await page.getByText("Looking up “Banff”…").count(), 0, "the abandoned lookup is no longer shown as running");

    // Now the old lookup answers (Banff exists in the recorded Nominatim data): it must change nothing.
    release();
    await page.waitForTimeout(2_000);
    assert.equal(page.url(), nearMeUrl, "the late Banff answer did not move the map or rewrite the URL");
    assert.equal(await page.getByText(/Showing\s+Banff/).count(), 0);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});
