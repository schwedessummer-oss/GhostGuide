/**
 * Catalog trail page e2e (/trail/<country>/<region>/<slug>) against the MOCK
 * data providers started by run.mjs (tests/e2e/mock-providers.mjs):
 * recorded OpenStreetMap data for Table Rock State Park (SC), recorded MET
 * Norway forecast, recorded (empty) NWS alerts, recorded terrain tiles.
 *
 * Header stats, elevation profile, weather + alerts + daylight planning,
 * emergency number, trailhead amenities, sources/attribution, JSON-LD and
 * canonical metadata, Save (signed out → sign in → save → /saved → remove),
 * honest "unavailable" states when the weather providers fail, and 404s.
 *
 * Self-contained: loads the Table Rock area through the search API first
 * (idempotent when explore.spec already did).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  BASE,
  PASSWORD,
  TABLE_ROCK_TRAIL_PATH,
  ensureTableRockLoaded,
  mockControl,
  mockRequests,
  mockReset,
  newBrowser,
} from "../helpers.mjs";

const TIMEOUT = 20_000;
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const HIKER = "hiker2@demo.ghostguide.test";

let browser;
/** Trails of the loaded area (search API summaries). */
let areaTrails = [];
before(async () => {
  browser = await newBrowser();
  await mockReset();
  areaTrails = (await ensureTableRockLoaded()).trails;
});
after(async () => {
  await mockReset().catch(() => {});
  await browser?.close();
});

let ipCounter = 0;
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

const section = (page, name) => page.getByRole("region", { name, exact: true });

/** Wait for the client-loaded conditions panel to settle (loaded or an error message). */
async function conditionsSettled(page) {
  const panel = section(page, "Weather & daylight");
  await panel.locator("[aria-busy=false]").first().waitFor({ timeout: 30_000 });
  return panel;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

test("Table Rock Trail: header stats, map, elevation, weather, alerts, daylight, emergency number and sources", { timeout: 90_000 }, async () => {
  const { context, page, pageErrors } = await openPage();
  try {
    const res = await page.goto(TABLE_ROCK_TRAIL_PATH);
    assert.equal(res.status(), 200);
    await page.getByRole("heading", { level: 1, name: "Table Rock Trail" }).waitFor();
    const trail = areaTrails.find((t) => t.path === TABLE_ROCK_TRAIL_PATH);
    assert.ok(trail, "the trail is in the loaded area");

    // Header: where it is (recorded Nominatim admin names), the hike numbers, difficulty.
    const header = page.locator("article header").first();
    assert.match(await header.innerText(), /South Carolina · United States/);
    const stats = page.locator("article dl").first();
    const statsText = await stats.innerText();
    const miles = (trail.hikeDistanceM / 1609.344).toFixed(1);
    assert.match(statsText, new RegExp(`${miles.replace(".", "\\.")} mi\\s+Out & back`));
    assert.match(statsText, /[\d,]+ ft\s+total climb/);
    assert.match(statsText, /≈ \d+(\.\d)? ?(h|hr|min)[^\n]*\s+moving time, estimated/);
    assert.match(statsText, /Hard|Moderate|Expert|Easy/);
    assert.ok(!/Not available/.test(statsText), `every header number is known: ${statsText}`);
    // Actions: Save, Directions (a trailhead is mapped) and Share.
    assert.ok(await page.getByRole("link", { name: /^Save Table Rock Trail/ }).or(page.getByRole("button", { name: /^Save Table Rock Trail/ })).first().isVisible());
    assert.ok(await page.getByRole("button", { name: /Directions/ }).first().isVisible());

    // Map (MapLibre, blank local style in e2e) with the OSM credit and a link to the source.
    await page.locator("canvas.maplibregl-canvas").first().waitFor();
    const mapSection = page.locator("section[aria-labelledby=map-heading]");
    assert.match(await mapSection.innerText(), /Map data © OpenStreetMap contributors\. Route and points as mapped; not for navigation on its own\./);
    assert.match(await mapSection.getByRole("link", { name: /View on OpenStreetMap/ }).getAttribute("href"), /^https:\/\/www\.openstreetmap\.org\/(relation|way)\/\d+$/);

    // Elevation: a real profile from the recorded terrain tiles, labeled as an estimate.
    const elevation = section(page, "Elevation");
    const elevationText = await elevation.innerText();
    assert.ok(!/Elevation data isn't available/.test(elevationText), elevationText);
    assert.match(elevationText, /Highest\s+[\d,]+ ft/);
    assert.match(elevationText, /Lowest\s+[\d,]+ ft/);
    assert.match(elevationText, /Terrarium terrain tiles|DEM|estimate/i);

    // Weather from the mock MET Norway forecast: a current temperature, hours, days; attribution.
    const conditions = await conditionsSettled(page);
    await conditions.getByText("Trail conditions loaded.").waitFor({ state: "attached" });
    const now = conditions.locator("p.text-3xl").first();
    assert.match(await now.innerText(), /^-?\d+°F$/, "a current temperature at the trailhead");
    assert.match(await conditions.innerText(), /at the trailhead/);
    assert.ok((await conditions.getByRole("list", { name: "Hourly forecast" }).getByRole("listitem").count()) >= 6, "hourly forecast");
    // (Sub-headings are upper-cased by CSS, which innerText reflects.)
    assert.match(await conditions.innerText(), /Next 7 days/i);
    assert.ok(await conditions.getByRole("link", { name: /MET Norway/ }).isVisible(), "MET Norway is credited");
    // Official alerts (NWS, US): the recorded empty answer is shown as such, not hidden.
    assert.match(await conditions.innerText(), /Official alerts\s+No active official weather alerts for this location\./i);
    // Daylight and planning, computed locally for the trail's time zone.
    const daylight = await conditions.innerText();
    assert.match(daylight, /Daylight today \(E[SD]T\)/i);
    assert.match(daylight, /Sunrise\s+\d{1,2}:\d{2}\s?[AP]M/);
    assert.match(daylight, /Sunset\s+\d{1,2}:\d{2}\s?[AP]M/);
    assert.match(daylight, /Latest recommended start/);
    assert.match(daylight, /Finish if you start now/);
    assert.match(daylight, /Daylight left/);
    // (An earlier spec may have filled the forecast cache; any request made since carries the app User-Agent.)
    for (const provider of ["metno", "nws"]) {
      const reqs = await mockRequests(provider);
      assert.ok(reqs.every((r) => /GhostGuide/.test(r.ua ?? "")), `${provider} requests carry the app User-Agent`);
    }

    // Getting there: trailhead amenities from the recorded OSM data; services honestly empty
    // (the mock has no recorded services sample, so nothing may be invented).
    const nearby = section(page, "Getting there");
    assert.match(await nearby.innerText(), /Trailhead: .*\d+\.\d{5}, -\d+\.\d{5}/);
    await nearby.getByRole("heading", { name: "Nearby services" }).waitFor({ timeout: 30_000 });
    await nearby.getByText(/No gas, food, lodging or medical care is mapped within \d+ km\.|Nearby places for this area are still loading|Loading nearby places/).first().waitFor({ timeout: 60_000 });

    // Safety: the US emergency number as a tel: link; no claim that Ghost Guide calls anyone.
    const safety = section(page, "Safety");
    const call = safety.getByRole("link", { name: /911/ });
    assert.equal(await call.getAttribute("href"), "tel:911");
    assert.match(await safety.innerText(), /Emergency number in United States/);
    assert.match(await safety.innerText(), /Ghost Guide does not contact emergency services\./);

    // Sources: OSM attribution with the licence and freshness, elevation credit, how to fix data.
    const sources = section(page, "Sources");
    const sourcesText = await sources.innerText();
    assert.match(sourcesText, /Trail data © OpenStreetMap contributors \(ODbL 1\.0\)/);
    assert.match(sourcesText, /last updated in Ghost Guide less than an hour ago/);
    assert.equal(await sources.getByRole("link", { name: "OpenStreetMap contributors" }).getAttribute("href"), "https://www.openstreetmap.org/copyright");
    assert.match(sourcesText, /Data looks wrong\?/);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("search metadata: canonical URL, description and parseable schema.org JSON-LD; mixed-case paths redirect", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage();
  try {
    await page.goto(TABLE_ROCK_TRAIL_PATH);
    const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
    assert.equal(canonical, `${BASE}${TABLE_ROCK_TRAIL_PATH}`);
    assert.match(await page.title(), /^Table Rock Trail — .*United States/);
    const description = await page.locator('meta[name="description"]').getAttribute("content");
    assert.match(description, /^Table Rock Trail is an? [\d.]+ mi \([\d.]+ km\) out-and-back hike in .*South Carolina, United States, with about [\d,]+ ft of climbing\./);
    assert.match(description, /Trail data: OpenStreetMap\./);
    assert.equal(await page.locator('meta[property="og:url"]').getAttribute("content"), canonical);

    const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
    assert.equal(scripts.length, 1);
    const ld = JSON.parse(scripts[0]);
    assert.equal(ld["@context"], "https://schema.org");
    assert.equal(ld["@type"], "TouristAttraction");
    assert.equal(ld.name, "Table Rock Trail");
    assert.equal(ld.url, canonical);
    assert.equal(ld.geo["@type"], "GeoCoordinates");
    assert.ok(Math.abs(ld.geo.latitude - 35.04) < 0.1 && Math.abs(ld.geo.longitude + 82.7) < 0.1, JSON.stringify(ld.geo));
    assert.deepEqual(ld.address, { "@type": "PostalAddress", addressRegion: "South Carolina", addressCountry: "US" });
    for (const k of ["aggregateRating", "review", "openingHours", "priceRange"]) assert.equal(ld[k], undefined, `no invented ${k}`);
  } finally {
    await context.close();
  }

  const redirect = await fetch(`${BASE}/trail/US/South-Carolina/Table-Rock-Trail`, { redirect: "manual" });
  assert.equal(redirect.status, 308);
  assert.equal(new URL(redirect.headers.get("location"), BASE).pathname, TABLE_ROCK_TRAIL_PATH);
});

// ---------------------------------------------------------------------------
// Saved trails
// ---------------------------------------------------------------------------

test("Save: signed out it is a sign-in link; signed in it saves, /saved lists it, and removing it empties the list", { timeout: 120_000 }, async () => {
  const { context, page, pageErrors } = await openPage();
  try {
    await page.goto(TABLE_ROCK_TRAIL_PATH);
    const saveLink = page.getByRole("link", { name: /^Save Table Rock Trail \(sign in to save trails\)/ });
    await saveLink.waitFor();
    // After mounting, the button asks for the visitor's own state; signed out it stays a link.
    await page.waitForFunction(() => !document.querySelector('a[aria-busy="true"][href^="/login"]'));
    const href = await saveLink.getAttribute("href");
    assert.equal(href, `/login?next=${encodeURIComponent(TABLE_ROCK_TRAIL_PATH)}`);

    // Sign in from the link as a demo hiker and come back to the trail.
    await Promise.all([page.waitForURL((u) => u.pathname === "/login"), saveLink.click()]);
    await page.fill("#email", HIKER);
    await page.fill("#password", PASSWORD);
    await Promise.all([page.waitForURL(`**${TABLE_ROCK_TRAIL_PATH}`, { timeout: 30_000 }), page.click("button[type=submit]")]);
    await page.getByRole("heading", { level: 1, name: "Table Rock Trail" }).waitFor();

    // Signed in: a toggle button; Save → Saved.
    const toggle = page.getByRole("button", { name: /^(Save|Saved) Table Rock Trail$/ });
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('button[aria-pressed="true"]')?.textContent?.includes("Saved"));
    await page.getByText("Table Rock Trail saved. Find it on your Saved page.").waitFor({ state: "attached" });

    // It survives a reload (stored on the server, owner-only).
    await page.reload();
    await page.getByRole("button", { name: /^Saved Table Rock Trail$/ }).waitFor();
    assert.equal(await page.getByRole("button", { name: /^Saved Table Rock Trail$/ }).getAttribute("aria-pressed"), "true");

    // /saved lists it with its numbers and a link back.
    await page.goto("/saved");
    await page.getByRole("heading", { level: 1, name: "Saved trails" }).waitFor();
    const item = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Table Rock Trail" }) });
    await item.waitFor();
    assert.equal(await item.getByRole("link", { name: "Table Rock Trail" }).getAttribute("href"), TABLE_ROCK_TRAIL_PATH);
    const itemText = await item.innerText();
    assert.match(itemText, /[\d.]+ mi out & back/);
    assert.match(itemText, /[\d,]+ ft climb/);
    assert.match(itemText, /Saved less than an hour ago/);
    assert.match(await page.locator("main").innerText(), /1 trail, newest first\./);

    // Remove → the empty state.
    await item.getByRole("button", { name: /Remove Table Rock Trail from saved trails/ }).click();
    await page.getByText("Save trails you like and find them here").waitFor();
    assert.equal(await page.getByRole("link", { name: "Table Rock Trail" }).count(), 0);
    assert.equal(await page.getByRole("link", { name: "Explore trails" }).last().getAttribute("href"), "/explore");

    // And the trail page agrees.
    await page.goto(TABLE_ROCK_TRAIL_PATH);
    await page.getByRole("button", { name: /^Save Table Rock Trail$/ }).waitFor();
    assert.equal(await page.getByRole("button", { name: /^Save Table Rock Trail$/ }).getAttribute("aria-pressed"), "false");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }

  // Signed out, /saved asks to sign in.
  const anon = await fetch(`${BASE}/saved`, { redirect: "manual" });
  assert.ok([303, 307, 308].includes(anon.status), `signed-out /saved → ${anon.status}`);
  assert.match(anon.headers.get("location") ?? "", /\/login\?next=%2Fsaved/);
});

// ---------------------------------------------------------------------------
// Honest unavailable states
// ---------------------------------------------------------------------------

test("when the weather providers fail, the page says so (no invented forecast) and still shows daylight", { timeout: 90_000 }, async () => {
  // A trail whose trailhead is not Table Rock's (forecasts are cached per ~100 m point).
  const tr = areaTrails.find((t) => t.path === TABLE_ROCK_TRAIL_PATH);
  const round = (n) => Math.round(n * 1000);
  const other = areaTrails.find(
    (t) => t.path !== TABLE_ROCK_TRAIL_PATH && t.trailhead && (round(t.trailhead.lat) !== round(tr.trailhead.lat) || round(t.trailhead.lng) !== round(tr.trailhead.lng)),
  );
  assert.ok(other, "another trail with its own trailhead");
  await mockControl({ metno: { mode: "fail" }, nws: { mode: "fail" } });
  const { context, page, pageErrors } = await openPage();
  try {
    await page.goto(other.path);
    await page.getByRole("heading", { level: 1, name: other.name }).waitFor();
    const conditions = await conditionsSettled(page);
    const text = await conditions.innerText();
    assert.match(text, /Weather is unavailable right now/);
    assert.match(text, /Check a local forecast before you go\./);
    assert.match(text, /Couldn't load alerts right now\./);
    assert.ok(!/°F|°C/.test(text), `no temperature without a forecast: ${text}`);
    // Sunrise/sunset are computed locally, so they are still there.
    assert.match(text, /Sunrise\s+\d{1,2}:\d{2}\s?[AP]M/);
    assert.ok(await conditions.getByRole("button", { name: "Try again" }).isVisible());

    // The providers recover: "Try again" loads the real forecast.
    await mockControl({ metno: { mode: "normal" }, nws: { mode: "normal" } });
    await conditions.getByRole("button", { name: "Try again" }).click();
    await conditions.locator("p.text-3xl").first().waitFor({ timeout: 30_000 });
    assert.match(await conditions.locator("p.text-3xl").first().innerText(), /^-?\d+°F$/);
    assert.deepEqual(pageErrors, []);
  } finally {
    await mockReset();
    await context.close();
  }
});

test("phone (390×844): the trail page fits the screen, with the tab bar and a tappable emergency number", { timeout: 60_000 }, async () => {
  const { context, page, pageErrors } = await openPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await page.goto(TABLE_ROCK_TRAIL_PATH);
    await page.getByRole("heading", { level: 1, name: "Table Rock Trail" }).waitFor();
    await conditionsSettled(page);
    const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
    assert.ok(sw <= w, `scrolls horizontally (${sw} > ${w})`);
    const tabs = page.getByRole("navigation", { name: "Primary" });
    assert.ok(await tabs.isVisible());
    assert.equal(await tabs.getByRole("link", { name: "Explore" }).getAttribute("aria-current"), "page");
    const call = section(page, "Safety").getByRole("link", { name: /911/ });
    const box = await call.boundingBox();
    assert.ok(box.height >= 44, `emergency call target is ${box.height}px tall`);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Not found
// ---------------------------------------------------------------------------

test("unknown trail paths are real 404s with a way back to Explore", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage();
  try {
    for (const path of ["/trail/us/south-carolina/no-such-trail", "/trail/zz/nowhere/table-rock-trail", "/trail/us/south-carolina/Table_Rock"]) {
      const res = await page.goto(path);
      assert.equal(res.status(), 404, `${path} → ${res.status()}`);
      await page.getByRole("heading", { level: 1, name: "We couldn't find this trail" }).waitFor();
      assert.equal(await page.getByRole("main").getByRole("link", { name: "Explore trails" }).getAttribute("href"), "/explore");
    }
  } finally {
    await context.close();
  }
  const api = await fetch(`${BASE}/api/trails/00000000-0000-4000-8000-000000000000`);
  assert.equal(api.status, 404);
  const conditions = await fetch(`${BASE}/api/trails/not-a-uuid/conditions`);
  assert.ok([400, 404].includes(conditions.status), `invalid id → ${conditions.status}`);
});
