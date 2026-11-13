/**
 * Explore e2e (Phase 1 real-data discovery) against the MOCK data providers
 * started by run.mjs (tests/e2e/mock-providers.mjs, recorded OpenStreetMap /
 * Nominatim answers for Table Rock State Park, South Carolina):
 *
 *   search "Table Rock State Park" → geocode → on-demand tile loading
 *   (ensureCoverage → inline ingestion through the mock Overpass → ingest)
 *   → polling → the recorded trails with out & back distance / climb / time;
 *   filters ↔ list ↔ URL, back/forward, result → trail page, phone bottom
 *   sheet and tab bar, the no-JavaScript fallback, an area whose provider
 *   fails (honest "couldn't be loaded"), unknown places, and API validation.
 *
 * Tests share one browser and run in order; the first one loads the area.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  BASE,
  TABLE_ROCK_TRAIL_PATH,
  ensureTableRockLoaded,
  mockControl,
  mockRequests,
  mockReset,
  newBrowser,
  runCatalogJobs,
  searchTrailsApi,
} from "../helpers.mjs";
import { TABLE_ROCK_TILE, tileKeyFor } from "../mock-providers.mjs";

const TIMEOUT = 20_000;
const LOAD_TIMEOUT = 90_000;
const PLACE = "Table Rock State Park";
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

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
  return `10.${200 + (n % 50)}.${ipCounter % 250}.${(n + ipCounter * 7) % 250}`;
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
const listNames = (page) => page.locator("#explore-list li[data-trail-id] h3").allInnerTexts();
const resultLink = (page, name) => page.locator("#explore-list li[data-trail-id] a").filter({ has: page.getByRole("heading", { name, exact: true }) });

/** Wait until the list shows the trails and the area reports no more loading. */
async function waitForLoadedList(page) {
  await resultLink(page, "Table Rock Trail").waitFor({ timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => /^\d+ trails?$|^Showing /.test(document.querySelector("#explore-results-heading")?.textContent?.trim() ?? ""), null, {
    timeout: LOAD_TIMEOUT,
  });
}

const bboxOf = (page) => new URL(page.url()).searchParams.get("bbox");

/** Open /explore?q=<place> (server-rendered results), once hydrated and the URL is canonical (q + bbox). */
async function gotoPlace(page, place = PLACE) {
  await page.goto(`/explore?q=${encodeURIComponent(place)}`);
  await waitForLoadedList(page);
  await page.waitForURL((u) => u.searchParams.get("q") === place && u.searchParams.has("bbox"));
}
const sortedNames = (trails) => trails.map((t) => t.name).sort();

// ---------------------------------------------------------------------------
// Search → on-demand loading → recorded trails
// ---------------------------------------------------------------------------

test("searching a place loads its trails on demand: loading state, then the recorded OpenStreetMap trails", { timeout: 180_000 }, async (t) => {
  const { context, page, pageErrors } = await openPage();
  try {
    const res = await page.goto("/explore");
    assert.equal(res.status(), 200);
    assert.equal((await heading(page).innerText()).trim(), "Explore trails");
    await page.getByText("Find a trail anywhere").waitFor();

    await page.locator("#explore-q").fill(PLACE);
    await page.getByRole("search").getByRole("button", { name: "Search" }).click();

    // The URL carries the place and the searched area (shareable, back/forward).
    await page.waitForURL((u) => u.pathname === "/explore" && u.searchParams.get("q") === PLACE && u.searchParams.has("bbox"));
    const bbox = bboxOf(page);
    const before = await searchTrailsApi({ bbox, load: "0" });
    if (before.body.coverage.state === "ready") {
      t.diagnostic("the Table Rock area was already loaded (spec re-run against the same database): loading state not observable");
    } else {
      // Nothing stored yet: the honest on-demand loading state (list notice + map pill), never placeholder trails.
      await page.getByText("Loading trails for this area from OpenStreetMap. The first load can take a minute.").waitFor({ timeout: TIMEOUT });
      assert.equal((await heading(page).innerText()).trim(), "Loading trails…");
      // The map pill (desktop shows the full coverage message; screen readers get it from a live region).
      await page.locator("span.lg\\:inline", { hasText: "Loading trails for this area from OpenStreetMap… this can take a minute." }).waitFor();
      assert.equal(await page.locator("#explore-list li[data-trail-id]").count(), 0, "no trails before the area is loaded");
    }

    // Polling picks up the ingested trails (the mock Overpass answers after a short delay).
    await waitForLoadedList(page);
    assert.match((await heading(page).innerText()).trim(), /^\d+ trails$/);
    assert.match(await page.locator("#explore-results-heading + p").innerText(), /near Table Rock State Park/);
    // Fully loaded: the status pill is gone and the footer credits OpenStreetMap with the sync date.
    await page.locator("span.lg\\:inline", { hasText: /^Loading/ }).waitFor({ state: "detached", timeout: LOAD_TIMEOUT });
    const footer = page.locator("#explore-list").getByText(/Trail data/);
    assert.match(await footer.innerText(), /© OpenStreetMap contributors · updated today/);

    // The list is exactly what the search API returns for the area.
    const api = await searchTrailsApi({ bbox });
    assert.equal(api.status, 200);
    assert.equal(api.body.coverage.state, "ready", api.body.coverage.message);
    const names = await listNames(page);
    assert.deepEqual([...names].sort(), sortedNames(api.body.trails));
    assert.ok(names.length >= 5, `expected the recorded park trails, got ${names.join(", ")}`);
    for (const n of ["Table Rock Trail", "Pinnacle Mountain Trail", "Carrick Creek Loop Trail"]) assert.ok(names.includes(n), `missing ${n}`);

    // Table Rock Trail: an out & back hike with real distance, climb (DEM) and time estimates.
    const trail = api.body.trails.find((x) => x.name === "Table Rock Trail");
    assert.equal(trail.path, TABLE_ROCK_TRAIL_PATH);
    assert.equal(trail.routeType, "linear");
    assert.equal(trail.hikeDistanceM, trail.distanceM * 2, "out & back doubles the one-way distance");
    assert.ok(trail.hikeGainM > 500, `climb comes from the recorded terrain tiles (${trail.hikeGainM} m)`);
    assert.ok(trail.hikeDurationMin > trail.estimatedDurationMin, "the out & back time exceeds one traversal");
    const row = resultLink(page, "Table Rock Trail");
    const rowText = await row.innerText();
    const miles = (trail.hikeDistanceM / 1609.344).toFixed(1);
    assert.match(rowText, new RegExp(`${miles.replace(".", "\\.")} mi out & back`));
    assert.match(rowText, /Climb:\s*[\d,]+ ft/);
    assert.match(rowText, /Estimated moving time:\s*≈ \d+ (h|min)/);
    assert.match(rowText, /South Carolina/);
    assert.ok(!/Climb unknown|Time unknown/.test(rowText), rowText);

    // The app called the providers with an identifying User-Agent; one geocode, then cached.
    const overpass = await mockRequests("overpass");
    if (before.body.coverage.state !== "ready") {
      assert.ok(overpass.some((r) => r.tileKey === TABLE_ROCK_TILE && r.note === "fixture"), "the Table Rock tile came from the recorded Overpass answer");
    }
    assert.ok(overpass.every((r) => /GhostGuide/.test(r.ua ?? "")), "Overpass requests carry the app User-Agent");
    const searches = (await mockRequests("nominatim")).filter((r) => r.path.endsWith("/search") && r.query === "table rock state park");
    assert.ok(searches.length <= 1, `geocoded once, then cached (${searches.length} requests)`);
    const flat = (await mockRequests("terrain_tiles")).filter((r) => r.note === "flat");
    assert.deepEqual(flat, [], "every terrain tile the trails needed is a recorded one");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Filters ↔ list ↔ URL, back/forward, result → trail page
// ---------------------------------------------------------------------------

test("filters update the list and the URL; back and forward restore each state", { timeout: 120_000 }, async () => {
  await ensureTableRockLoaded();
  const { context, page, pageErrors } = await openPage();
  try {
    await gotoPlace(page);
    const bbox = bboxOf(page);
    assert.ok(bbox, "the server render settles the URL on the searched area");
    const allNames = await listNames(page);

    // Waterfall feature + Hard difficulty, through the filter dialog.
    await page.getByRole("button", { name: /^Filters/ }).click();
    const dialog = page.getByRole("dialog", { name: "Filters" });
    await dialog.waitFor();
    await dialog.getByText("Waterfall", { exact: true }).click();
    await dialog.getByText("Hard", { exact: true }).click();
    assert.ok(await dialog.getByRole("checkbox", { name: "Waterfall" }).isChecked());
    assert.ok(await dialog.getByRole("checkbox", { name: "Hard" }).isChecked());
    await dialog.getByRole("button", { name: "Show trails" }).click();
    await dialog.waitFor({ state: "hidden" });

    await page.waitForURL((u) => u.searchParams.get("features") === "waterfall" && u.searchParams.get("difficulty") === "hard");
    assert.equal(bboxOf(page), bbox, "filtering keeps the area");
    assert.match(await page.getByRole("button", { name: /^Filters/ }).innerText(), /2\s*active/);
    const expected = await searchTrailsApi({ bbox, features: "waterfall", difficulty: "hard" });
    assert.ok(expected.body.trails.length >= 1, "the recorded park has hard trails near waterfalls");
    await page.waitForFunction(
      (n) => document.querySelectorAll("#explore-list li[data-trail-id]").length === n,
      expected.body.trails.length,
      { timeout: TIMEOUT },
    );
    const filtered = await listNames(page);
    assert.deepEqual([...filtered].sort(), sortedNames(expected.body.trails));
    assert.ok(filtered.length < allNames.length, "the filters narrow the list");
    assert.ok(filtered.includes("Table Rock Trail"));
    for (const item of await page.locator("#explore-list li[data-trail-id]").all()) {
      const text = await item.innerText();
      assert.match(text, /Hard/, `${text} is not hard`);
      assert.equal(await item.getByRole("list", { name: "Features near the route" }).getByText("Waterfall").count(), 1, `${text} lacks the waterfall feature`);
    }

    // A filter combination with no match: honest empty state with a way out.
    await page.getByRole("button", { name: /^Filters/ }).click();
    await dialog.getByText("Lake", { exact: true }).click();
    await dialog.getByRole("button", { name: "Show trails" }).click();
    await page.waitForURL((u) => u.searchParams.get("features") === "waterfall,lake");
    const none = await searchTrailsApi({ bbox, features: "waterfall,lake", difficulty: "hard" });
    if (none.body.trails.length === 0) {
      // Filters are on, so the page must not claim the area has no mapped trails.
      await page.getByText("No trails here match your filters").waitFor();
      assert.equal(await page.getByText("No mapped trails in this area yet").count(), 0);
      assert.equal((await heading(page).innerText()).trim(), "No trails found");
    }

    // Back: the previous filters (and their list) come back without a server round trip.
    await page.goBack();
    await page.waitForURL((u) => u.searchParams.get("features") === "waterfall" && u.searchParams.get("difficulty") === "hard");
    await page.waitForFunction((n) => document.querySelectorAll("#explore-list li[data-trail-id]").length === n, filtered.length);
    assert.deepEqual(await listNames(page), filtered);
    await page.goBack();
    await page.waitForURL((u) => !u.searchParams.has("features") && !u.searchParams.has("difficulty"));
    await page.waitForFunction((n) => document.querySelectorAll("#explore-list li[data-trail-id]").length === n, allNames.length);
    assert.deepEqual(await listNames(page), allNames);
    // Forward re-applies them.
    await page.goForward();
    await page.waitForURL((u) => u.searchParams.get("features") === "waterfall");
    await page.waitForFunction((n) => document.querySelectorAll("#explore-list li[data-trail-id]").length === n, filtered.length);

    // Clear removes every filter.
    await page.getByRole("button", { name: /Clear/ }).click();
    await page.waitForURL((u) => !u.searchParams.has("features"));
    await page.waitForFunction((n) => document.querySelectorAll("#explore-list li[data-trail-id]").length === n, allNames.length);

    // A filtered URL renders filtered on the server too (shareable).
    await page.goto(`/explore?bbox=${bbox}&features=waterfall&difficulty=hard`);
    await page.waitForFunction((n) => document.querySelectorAll("#explore-list li[data-trail-id]").length === n, filtered.length);
    assert.match(await page.getByRole("button", { name: /^Filters/ }).innerText(), /2\s*active/);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("a result opens its trail page, and back returns to the same search", { timeout: 90_000 }, async () => {
  await ensureTableRockLoaded();
  const { context, page, pageErrors } = await openPage();
  try {
    await gotoPlace(page);
    const searchUrl = page.url();
    await Promise.all([page.waitForURL(`**${TABLE_ROCK_TRAIL_PATH}`), resultLink(page, "Table Rock Trail").click()]);
    await page.getByRole("heading", { level: 1, name: "Table Rock Trail" }).waitFor();
    await page.goBack();
    await page.waitForURL(searchUrl);
    await resultLink(page, "Table Rock Trail").waitFor();
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Phone layout
// ---------------------------------------------------------------------------

test("phone (390×844): map with a bottom sheet, list toggle and the primary tab bar", { timeout: 90_000 }, async () => {
  await ensureTableRockLoaded();
  const { context, page, pageErrors } = await openPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await gotoPlace(page);

    // Primary tab bar: the five destinations, Explore current.
    const tabs = page.getByRole("navigation", { name: "Primary" });
    assert.ok(await tabs.isVisible());
    assert.deepEqual((await tabs.getByRole("link").allInnerTexts()).map((s) => s.trim()), ["Explore", "Trips", "Hike", "Saved", "Profile"]);
    assert.equal(await tabs.getByRole("link", { name: "Explore" }).getAttribute("aria-current"), "page");
    assert.equal(await tabs.getByRole("link", { name: "Profile" }).getAttribute("href"), "/login", "signed out: Profile signs in");
    // The desktop header links are hidden on phones.
    assert.equal(await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Trips" }).isVisible(), false);

    // The map fills the screen behind a peeking bottom sheet.
    const map = page.getByRole("region", { name: /Map of trails/ });
    await map.waitFor();
    await page.locator("canvas.maplibregl-canvas").waitFor({ timeout: TIMEOUT });
    const sheet = page.locator("section[aria-labelledby=explore-results-heading]");
    const peek = await sheet.boundingBox();
    assert.ok(peek.height >= 150 && peek.height <= 260, `peek sheet height ${peek.height}`);
    const tabBox = await tabs.boundingBox();
    assert.ok(peek.y + peek.height <= tabBox.y + 2, "the sheet sits above the tab bar");

    // Sheet height as a share of the app frame (the area between the header and the tab bar).
    const sheetShare = () =>
      page.evaluate(() => {
        const frame = document.querySelector("[data-app-fullscreen]").getBoundingClientRect().height;
        return document.querySelector("section[aria-labelledby=explore-results-heading]").getBoundingClientRect().height / frame;
      });
    const waitForShare = (min, max) =>
      page.waitForFunction(
        ([lo, hi]) => {
          const frame = document.querySelector("[data-app-fullscreen]").getBoundingClientRect().height;
          const share = document.querySelector("section[aria-labelledby=explore-results-heading]").getBoundingClientRect().height / frame;
          return share >= lo && share <= hi;
        },
        [min, max],
      );
    assert.ok((await sheetShare()) < 0.4, `the sheet starts as a peek (${(await sheetShare()).toFixed(2)} of the frame)`);

    // "List" opens the sheet over the map (up to the search bar); "Map" brings the map back.
    await sheet.getByRole("button", { name: "List", exact: true }).click();
    await waitForShare(0.6, 1);
    assert.equal(await sheet.getByRole("button", { name: "Show the map" }).getAttribute("aria-expanded"), "true");
    assert.ok(await resultLink(page, "Table Rock Trail").isVisible());
    await sheet.getByRole("button", { name: "Map", exact: true }).click();
    await waitForShare(0, 0.4);
    // The drag handle steps peek → half.
    await sheet.getByRole("button", { name: "Show more of the list" }).click();
    await waitForShare(0.45, 0.65);

    // No horizontal scrolling; a result still opens its page.
    const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
    assert.ok(sw <= w, `explore scrolls horizontally (${sw} > ${w})`);
    await sheet.getByRole("button", { name: "List", exact: true }).click();
    await Promise.all([page.waitForURL(`**${TABLE_ROCK_TRAIL_PATH}`), resultLink(page, "Table Rock Trail").click()]);
    await page.getByRole("heading", { level: 1, name: "Table Rock Trail" }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Explore" }).getAttribute("aria-current"), "page");
    const trailPage = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
    assert.ok(trailPage.sw <= trailPage.w, `trail page scrolls horizontally (${trailPage.sw} > ${trailPage.w})`);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Without JavaScript
// ---------------------------------------------------------------------------

test("no-JS fallback: /explore?q= renders the trail links in the HTML", { timeout: 60_000 }, async () => {
  await ensureTableRockLoaded();
  const html = await (await fetch(`${BASE}/explore?q=${encodeURIComponent(PLACE)}`)).text();
  assert.ok(html.includes(`href="${TABLE_ROCK_TRAIL_PATH}"`), "server-rendered link to Table Rock Trail");
  assert.match(html, /<meta name="robots" content="noindex, follow"/, "search result pages are not indexed");
  // The search box is a plain GET form to /explore, so it can work without JavaScript.
  assert.match(html, /<form[^>]*role="search"[^>]*action="\/explore"[^>]*method="get"|<form[^>]*action="\/explore"[^>]*method="get"[^>]*role="search"/);
  // Bare /explore (indexable) is not marked noindex.
  const bare = await (await fetch(`${BASE}/explore`)).text();
  assert.doesNotMatch(bare, /<meta name="robots" content="noindex/);
});

/*
 * KNOWN APP BUG (reported, not fixed here: src/app/explore/loading.tsx is not owned by the e2e suite).
 * /explore has a route-level loading.tsx, so Next streams the real page into a <div hidden> that only
 * JavaScript reveals. With JavaScript off (any user agent, Googlebot included), a browser shows the
 * "Searching…" skeleton forever: the links are in the HTML but invisible and the search box is not usable.
 * Kept as a TODO test so the suite reports it until the page renders without the Suspense fallback.
 */
test("no-JS fallback in a real browser: trail links are visible and the search form works", { timeout: 60_000, todo: "app bug: explore/loading.tsx hides the page without JavaScript" }, async () => {
  await ensureTableRockLoaded();

  const { context, page } = await openPage({ javaScriptEnabled: false });
  try {
    await page.goto(`/explore?q=${encodeURIComponent(PLACE)}`);
    const links = page.locator(`a[href="${TABLE_ROCK_TRAIL_PATH}"]`);
    assert.ok((await links.count()) >= 1, "trail links in the document");
    assert.ok(await links.first().isVisible(), "trail links are visible without JavaScript");
    assert.equal(await page.getByText("Searching…").filter({ visible: true }).count(), 0, "no endless loading skeleton");
    await Promise.all([page.waitForURL(`**${TABLE_ROCK_TRAIL_PATH}`), links.first().click()]);
    assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Table Rock Trail");
    // The search form itself (a GET form) works without JavaScript too.
    await page.goto("/explore");
    assert.ok(await page.locator("#explore-q").isVisible(), "the search box is usable without JavaScript");
    await page.locator("#explore-q").fill(PLACE, { timeout: 5_000 });
    await Promise.all([page.waitForURL((u) => u.searchParams.get("q") === PLACE), page.locator("#explore-q").press("Enter")]);
    assert.ok(await links.first().isVisible());
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Honest failure states
// ---------------------------------------------------------------------------

test("a place nobody can find, and an area whose trail provider fails, are reported honestly", { timeout: 150_000 }, async () => {
  const { context, page, pageErrors } = await openPage();
  try {
    await page.goto("/explore");
    // Unknown place: no invented results.
    await page.locator("#explore-q").fill("Xqzv Nowhere Peak");
    await page.getByRole("search").getByRole("button", { name: "Search" }).click();
    await page.getByText("We couldn’t find “Xqzv Nowhere Peak”. Try a town, park or mountain name, or check the spelling.").waitFor();
    assert.equal(await page.locator("#explore-list li[data-trail-id]").count(), 0);

    // Overpass rejects the query for every tile around Banff (the area Explore searches: ~10 km around the
    // town, see bboxForPlace): nothing loads, and the page says so once the job runner gives up.
    const banff = { lng: -115.5720773, lat: 51.175076 };
    const tiles = {};
    for (const dLng of [-0.15, 0, 0.15]) for (const dLat of [-0.1, 0, 0.1]) tiles[tileKeyFor(banff.lng + dLng, banff.lat + dLat)] = { mode: "fail", status: 400 };
    await mockControl({ overpass: { tiles } });
    await page.locator("#explore-q").fill("Banff");
    await page.getByRole("search").getByRole("button", { name: "Search" }).click();
    await page.waitForURL((u) => u.searchParams.get("q") === "Banff" && u.searchParams.has("bbox"));
    await page.getByText("Showing", { exact: true }).waitFor();
    assert.match(await page.getByRole("status").first().innerText(), /Banff, Alberta, Canada/);
    const bbox = bboxOf(page);
    // While its tiles are retried the area is "loading" (never shown as empty or ready).
    let api = await searchTrailsApi({ bbox, load: "0" });
    assert.notEqual(api.body.coverage.state, "ready");
    assert.equal(api.body.trails.length, 0);

    // Let the inline attempts finish, then run the catalog job runner: the rejected tiles end as failed.
    const deadline = Date.now() + 60_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 3_000));
      await runCatalogJobs();
      api = await searchTrailsApi({ bbox, load: "0" });
      if (api.body.coverage.state === "failed" || Date.now() > deadline) break;
    }
    assert.equal(api.body.coverage.state, "failed", JSON.stringify(api.body.coverage));
    await page.getByText("Trails for this area couldn’t be loaded").waitFor({ timeout: 30_000 });
    assert.match(await page.locator("#explore-list").innerText(), /could not be loaded from OpenStreetMap right now\. Please try again later\./);
    assert.equal((await heading(page).innerText()).trim(), "Trails unavailable");
    assert.ok(await page.getByText("Trails couldn’t be loaded here").or(page.getByText(/Trails for this area could not be loaded/)).first().isVisible());
    assert.ok(await page.locator("#explore-list").getByRole("button", { name: "Try again" }).isVisible());
    const failed = (await mockRequests("overpass")).filter((r) => r.status === 400);
    assert.ok(failed.length >= 1, "the failing provider was really asked");
    assert.ok(failed.every((r) => r.tileKey in tiles), "only the Banff tiles failed");
    assert.deepEqual(pageErrors, []);
  } finally {
    await mockReset();
    await context.close();
  }
});

test("a slow tile: the area reports its loading progress, then an honest empty state when nothing is mapped", { timeout: 120_000 }, async () => {
  // "Table Rock" first geocodes to a hamlet in Pennsylvania (recorded Nominatim answer). Its ~10 km area spans
  // four tiles; the mock Overpass answers the one nearest the centre slowly and has no trails for any of them.
  const hamlet = { lng: -77.2213723, lat: 39.9134277 };
  const slowTile = tileKeyFor(hamlet.lng, hamlet.lat);
  await mockControl({ overpass: { tiles: { [slowTile]: { mode: "slow", delayMs: 12_000 } } } });
  const { context, page, pageErrors } = await openPage();
  try {
    await page.goto("/explore");
    await page.locator("#explore-q").fill("Table Rock");
    await page.getByRole("search").getByRole("button", { name: "Search" }).click();
    await page.waitForURL((u) => u.searchParams.get("q") === "Table Rock" && u.searchParams.has("bbox"));
    // Several places share the name: the first is shown, the others are offered.
    await page.getByRole("button", { name: /other places/ }).waitFor();
    assert.match(await page.getByRole("status").first().innerText(), /Showing\s+Table Rock, Pennsylvania, United States/);

    // While the slow tile loads, the pill reports progress across the area's tiles (never "no trails").
    const progress = page.locator("span", { hasText: /^ · [1-3] of 4 areas ready$/ });
    await progress.waitFor({ timeout: 30_000 });
    assert.match(await page.locator("span.lg\\:inline", { hasText: /^Loading more trails for this area/ }).innerText(), /Showing what is loaded so far\./);
    assert.equal(await page.getByText("No mapped trails in this area yet").count(), 0, "not empty while still loading");

    // Then: loaded, and honestly empty.
    await page.getByText("No mapped trails in this area yet").waitFor({ timeout: 60_000 });
    assert.equal((await heading(page).innerText()).trim(), "No trails found");
    const api = await searchTrailsApi({ bbox: bboxOf(page), load: "0" });
    assert.equal(api.body.coverage.state, "ready");
    assert.equal(api.body.coverage.tilesTotal, 4);
    const slow = (await mockRequests("overpass")).filter((r) => r.tileKey === slowTile);
    assert.ok(slow.length >= 1 && slow.every((r) => r.mode === "slow" && r.status === 200), JSON.stringify(slow));

    // Choosing another place with the same name searches there instead.
    await page.getByRole("button", { name: /other places/ }).click();
    await Promise.all([
      page.waitForURL((u) => u.searchParams.get("q") === "Table Rock" && u.searchParams.get("bbox") !== api.body.bbox.join(",")),
      page.locator("#explore-places").getByRole("button").first().click(),
    ]);
    assert.deepEqual(pageErrors, []);
  } finally {
    await mockReset();
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// API contract checks
// ---------------------------------------------------------------------------

test("API validation: trail search and geocoding reject bad input; sitemap and robots respond", { timeout: 60_000 }, async () => {
  for (const bbox of ["", "1,2,3", "10,10,5,5", "a,b,c,d", "-200,0,10,10"]) {
    const { status, body } = await searchTrailsApi(bbox ? { bbox } : {});
    assert.equal(status, 400, `bbox=${bbox} → ${status}`);
    assert.ok(body.fields.includes("bbox"), JSON.stringify(body));
  }
  const badFilter = await searchTrailsApi({ bbox: "-82.8,35,-82.7,35.1", difficulty: "impossible" });
  assert.equal(badFilter.status, 400);
  assert.deepEqual(badFilter.body.fields, ["difficulty"]);
  const range = await searchTrailsApi({ bbox: "-82.8,35,-82.7,35.1", minDistanceKm: "10", maxDistanceKm: "2" });
  assert.equal(range.status, 400);

  for (const q of ["", "a", "x".repeat(121)]) {
    const res = await fetch(`${BASE}/api/geocode?q=${encodeURIComponent(q)}`);
    assert.equal(res.status, 400, `q=${q.slice(0, 10)}… → ${res.status}`);
  }
  const ok = await (await fetch(`${BASE}/api/geocode?q=${encodeURIComponent(PLACE)}`)).json();
  assert.equal(ok.status, "ok");
  assert.match(ok.results[0].label, /Table Rock State Park/);
  assert.equal(ok.results[0].countryCode, "us");
  assert.ok(ok.attribution.some((a) => /OpenStreetMap/.test(a.name)));
  const none = await (await fetch(`${BASE}/api/geocode?q=${encodeURIComponent("Xqzv Nowhere Peak")}`)).json();
  assert.equal(none.status, "no_results");
  assert.deepEqual(none.results, []);
  const nearMe = await (await fetch(`${BASE}/api/geocode?q=${encodeURIComponent("hikes near me")}`)).json();
  assert.equal(nearMe.nearMe, true);

  const robots = await fetch(`${BASE}/robots.txt`);
  assert.equal(robots.status, 200);
  const robotsText = await robots.text();
  assert.match(robotsText, /Disallow: \/admin/);
  assert.match(robotsText, /Disallow: \/saved/);
  assert.match(robotsText, new RegExp(`Sitemap: ${BASE}/sitemap/0\\.xml`));
  const sitemap = await fetch(`${BASE}/sitemap/0.xml`);
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get("content-type") ?? "", /xml/);
  const xml = await sitemap.text();
  assert.match(xml, /<urlset/);
  assert.ok(xml.includes(`<loc>${BASE}/explore</loc>`), "the sitemap lists Explore");
});
