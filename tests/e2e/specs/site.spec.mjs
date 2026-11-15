/**
 * Public site — end-to-end spec (node:test + Playwright).
 *
 * While the hike catalog is rebuilt the public site is a placeholder home
 * page plus accounts. Covers:
 *  - the home page says Ghost Guide is being rebuilt and the catalog is coming
 *    soon, with no console errors and no horizontal scrolling at 390 px;
 *  - every link in the header, phone menu and footer works (signed out and
 *    signed in): no 404s from navigation;
 *  - old OpenStreetMap trail URLs answer 410 Gone; removed pages and APIs 404;
 *  - sitemap.xml lists only the home page and robots.txt points at it;
 *  - signing in lands on the account page; signing out returns home.
 *
 * Run: E2E_BASE_URL=http://localhost:3200 node --test tests/e2e/specs/site.spec.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { BASE, login, newBrowser } from "../helpers.mjs";

const HIKER = "hiker@demo.ghostguide.test";
const ADMIN = "admin@demo.ghostguide.test";
const NAV = 30_000;

let browser;
before(async () => {
  browser = await newBrowser();
});
after(async () => {
  await browser?.close();
});

const newCtx = (viewport = { width: 1280, height: 900 }) => browser.newContext({ viewport, baseURL: BASE });

function watchErrors(page) {
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${page.url()} :: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror ${page.url()} :: ${e.message}`));
  return errors;
}

/** Same-origin link targets in the header, its phone menu and the footer. */
async function chromeLinks(page) {
  const hrefs = await page.locator("header a[href], footer a[href]").evaluateAll((els) => els.map((a) => a.getAttribute("href")));
  return [...new Set(hrefs.filter((h) => h && h.startsWith("/")))];
}

async function assertLinksWork(page, label) {
  const links = await chromeLinks(page);
  assert.ok(links.length >= 3, `${label}: expected header and footer links, got ${JSON.stringify(links)}`);
  for (const href of links) {
    const res = await page.request.get(href, { maxRedirects: 5 });
    assert.ok(res.status() < 400, `${label}: ${href} -> HTTP ${res.status()}`);
  }
  return links;
}

test("home page: an honest placeholder (mobile 390px), no console errors, no horizontal scroll", async () => {
  const ctx = await newCtx({ width: 390, height: 844 });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  try {
    const res = await page.goto("/", { timeout: NAV });
    assert.equal(res?.status(), 200);
    await page.getByRole("heading", { level: 1, name: "The world's best hikes." }).waitFor({ timeout: NAV });
    const text = await page.locator("main").innerText();
    assert.match(text, /being rebuilt as a guide to the world's best hikes/);
    assert.match(text, /catalog is coming soon/i);
    // No leftovers of the old trail finder.
    assert.equal(await page.locator('a[href^="/explore"], a[href^="/trail"], a[href^="/saved"], a[href="/how-it-works"]').count(), 0);
    assert.equal(await page.getByRole("search").count(), 0);
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= iw, `home scrolls horizontally at 390px (${sw} > ${iw})`);
    await page.waitForLoadState("networkidle");
    assert.deepEqual(errors, [], `console errors:\n${errors.join("\n")}`);
  } finally {
    await ctx.close();
  }
});

test("every header, menu and footer link works, signed out and signed in", { timeout: 120_000 }, async () => {
  const ctx = await newCtx();
  const page = await ctx.newPage();
  try {
    await page.goto("/", { timeout: NAV });
    const signedOut = await assertLinksWork(page, "signed out");
    for (const href of ["/", "/login", "/signup", "/status"]) assert.ok(signedOut.includes(href), `signed out: missing ${href} in ${JSON.stringify(signedOut)}`);

    await login(page, ADMIN);
    await page.goto("/", { timeout: NAV });
    // The signed-in chrome arrives after hydration (GET /api/session).
    await page.locator('header a[href="/admin"]').first().waitFor({ state: "attached", timeout: NAV });
    const signedIn = await assertLinksWork(page, "signed in (admin)");
    for (const href of ["/", "/account", "/admin", "/status"]) assert.ok(signedIn.includes(href), `signed in: missing ${href} in ${JSON.stringify(signedIn)}`);
  } finally {
    await ctx.close();
  }
});

test("old trail URLs are gone (410); removed pages and APIs are not found (404)", async () => {
  for (const path of ["/trail/us/south-carolina/table-rock-trail", "/trail/US/South-Carolina/Table-Rock-Trail", "/trail"]) {
    const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
    assert.equal(res.status, 410, `${path} -> ${res.status}`);
    assert.equal(res.headers.get("x-robots-tag"), "noindex");
    assert.match(await res.text(), /This page has been removed/);
  }
  for (const path of ["/explore", "/saved", "/how-it-works", "/api/trails/search?bbox=-82.8,34.9,-82.6,35.1", "/api/geocode?q=banff", "/api/cron/catalog"]) {
    const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
    assert.equal(res.status, 404, `${path} -> ${res.status}`);
  }
});

test("sitemap.xml lists only the home page; robots.txt points at it", async () => {
  const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, [`${BASE}/`]);
  const robots = await (await fetch(`${BASE}/robots.txt`)).text();
  assert.match(robots, new RegExp(`Sitemap: ${BASE}/sitemap.xml`));
  assert.match(robots, /Disallow: \/admin/);
  assert.doesNotMatch(robots, /Disallow: \/login/);
});

test("signing in lands on the account page; signing out returns home", async () => {
  const ctx = await newCtx();
  const page = await ctx.newPage();
  try {
    await login(page, HIKER);
    assert.equal(new URL(page.url()).pathname, "/account");
    await page.getByRole("heading", { level: 1, name: "Your account" }).waitFor({ timeout: NAV });
    await Promise.all([page.waitForURL((u) => u.pathname === "/", { timeout: NAV }), page.getByTestId("sign-out").first().click()]);
    await page.locator('header a[href="/login"]').first().waitFor({ timeout: NAV });
    const res = await page.goto("/account", { timeout: NAV });
    assert.ok(res);
    assert.equal(new URL(page.url()).pathname, "/login", "the account page needs a session after signing out");
  } finally {
    await ctx.close();
  }
});
