/**
 * Discover slice e2e: landing, trail browsing + filters, map fallback, trail
 * detail (facts, provenance, sources, permits, closures, demo labels),
 * planning questionnaire validation, ranked results + score breakdown +
 * itinerary + AI label, exclusions, no-match + relax suggestions, and the
 * signed-out "Save" -> sign in -> back to results -> Save -> /trips/<id> flow
 * with cross-customer isolation (404).
 *
 * Self-contained: creates its own customers via /signup (unique per run), does
 * not depend on other specs or on test order, and only reads the seeded
 * demonstration catalog.
 *
 * Run: E2E_BASE_URL=http://localhost:3201 E2E_CRON_SECRET=... node --test tests/e2e/specs/discover.spec.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { BASE, newBrowser } from "../helpers.mjs";

const REGION_TZ = "America/Los_Angeles"; // seeded demo region (Ghost Ridge)
const TIMEOUT = 20_000;
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const CUSTOMER_PASSWORD = "discover-e2e-password";

let browser;
before(async () => {
  browser = await newBrowser();
});
after(async () => {
  await browser?.close();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let ipCounter = 0;
/**
 * Each context gets its own client IP so auth rate limits (keyed on
 * x-forwarded-for) are not shared with other specs/runs on the same server.
 */
function uniqueIp() {
  ipCounter += 1;
  const n = parseInt(RUN_ID.slice(-4), 36) % 250;
  return `10.${(n % 250) + 1}.${ipCounter % 250}.${Math.floor(Math.random() * 250) + 1}`;
}

async function openPage(viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ baseURL: BASE, viewport, extraHTTPHeaders: { "x-forwarded-for": uniqueIp() } });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  page.setDefaultNavigationTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  return { context, page, pageErrors };
}

/** Region-local calendar date (YYYY-MM-DD) `days` from now. */
function regionDate(days) {
  const d = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: REGION_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function resultsUrl(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const x of v) q.append(k, x);
    else if (v !== undefined) q.set(k, v);
  }
  return `/plan/results?${q}`;
}

/** Results pages stream behind a loading state: wait for the real H1. */
async function gotoResults(page, params) {
  await page.goto(resultsUrl(params));
  await page.getByRole("heading", { level: 1, name: /suggestions|No trail fits|Check your answers/ }).waitFor();
}

async function signUp(page, email, name = "Discover QA") {
  await page.goto("/signup");
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(CUSTOMER_PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: 30_000 }),
    page.getByRole("button", { name: "Create account" }).click(),
  ]);
}

/** Facts on a trail card: { distanceMi, gainFt, difficulty, terrain[] } read from the rendered card. */
async function readTrailCards(page) {
  return page.locator("section[aria-labelledby=results-heading] article").evaluateAll((articles) =>
    articles.map((a) => {
      const facts = {};
      for (const dt of a.querySelectorAll("dt")) facts[dt.textContent.trim().toLowerCase()] = dt.nextElementSibling?.textContent.trim() ?? "";
      const mi = /([\d.]+)\s*mi/.exec(facts["distance"] ?? "");
      const ft = /([\d,]+)\s*ft/.exec(facts["elevation gain"] ?? "");
      return {
        name: a.querySelector("h2, h3")?.textContent.trim() ?? "",
        distanceMi: mi ? Number(mi[1]) : NaN,
        gainFt: ft ? Number(ft[1].replace(/,/g, "")) : NaN,
        badges: [...a.querySelectorAll("span")].map((s) => s.textContent.trim()),
        terrain: [...a.querySelectorAll('ul[aria-label="Terrain"] li')].map((li) => li.textContent.trim().toLowerCase()),
      };
    }),
  );
}

async function resultsCount(page) {
  const text = await page.locator("#results-heading").innerText();
  const m = /^(\d+)\s+trails?/.exec(text.trim());
  assert.ok(m, `unexpected results heading: ${text}`);
  return Number(m[1]);
}

/** Apply /trails filters through the visible (desktop sidebar) GET form. */
async function applyFilters(page, fn) {
  const form = page.getByRole("form", { name: "Filter trails" });
  await fn(form);
  await Promise.all([page.waitForURL(/\/trails\?/), form.getByRole("button", { name: "Apply filters" }).click()]);
  await page.locator("#results-heading").waitFor();
}

const SEEDED = {
  all: ["Echo Basin Traverse", "Hollow Pine Ridge", "Lantern Creek Loop", "Miner's Meadow Loop", "Old Signal Summit", "Whisper Falls Trail"],
};

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

test("landing page explains the product honestly; its search, map and demo-region links lead to Explore, /trails and planning", { timeout: 90_000 }, async () => {
  const { context, page, pageErrors } = await openPage({ width: 390, height: 844 });
  try {
    const res = await page.goto("/");
    assert.equal(res.status(), 200);
    await page.getByRole("heading", { level: 1, name: "Find a hike. Plan the day. Get home safely." }).waitFor();
    // What the product does today, stated honestly.
    for (const t of ["Real trails, honest numbers", "Plan the day", "Save trails, set a check-in"]) {
      assert.equal(await page.getByRole("heading", { level: 3, name: t }).count(), 1, `missing value card: ${t}`);
    }
    const main = await page.locator("main").innerText();
    assert.match(main, /Trails worldwide come from OpenStreetMap/);
    assert.match(main, /clearly marked as estimates/);
    assert.match(main, /Ghost Guide is not an emergency service\./);
    assert.equal(await page.getByRole("link", { name: /How it works & its limits/ }).getAttribute("href"), "/how-it-works");
    // The site-wide demo banner says what is real and what is simulated.
    assert.match(await page.locator("body").innerText(), /Demo: trail, map, weather and place data are real; payments, notifications, partner services and AI\s+text are simulated\./);

    // The fictional demo region is a clearly labeled development fixture (SHOW_DEMO_FIXTURES).
    const demo = page.getByRole("region", { name: /Demo region \(fictional\)/ });
    assert.match(await demo.innerText(), /Development fixtures/);
    assert.match(await demo.innerText(), /These trails do not exist\./);
    const cards = demo.getByRole("article");
    assert.ok((await cards.count()) >= 1, "expected demo trail cards");
    assert.match(await cards.first().getByRole("link").first().getAttribute("href"), /^\/trails\/[a-z0-9-]+$/);
    assert.equal(await demo.getByRole("link", { name: /All demo trails/ }).getAttribute("href"), "/trails");

    // "Explore the map" and "Trails near me" are offered next to the search.
    assert.equal(await page.getByRole("link", { name: "Explore the map" }).getAttribute("href"), "/explore");
    assert.ok(await page.getByRole("button", { name: "Trails near me" }).isVisible());

    // The search is a plain GET form to Explore (works without JavaScript).
    const search = page.getByRole("search");
    await search.getByLabel("Where do you want to hike?").fill("Table Rock State Park");
    await Promise.all([
      page.waitForURL((u) => u.pathname === "/explore" && u.searchParams.get("q") === "Table Rock State Park"),
      search.getByRole("button", { name: "Find trails" }).click(),
    ]);
    await page.getByRole("heading", { level: 1, name: "Explore trails" }).waitFor({ state: "attached" });

    // Demo region list → planning questionnaire.
    await page.goto("/trails");
    await page.getByRole("heading", { level: 1, name: "Find a trail" }).waitFor();
    await Promise.all([page.waitForURL("**/plan"), page.getByRole("link", { name: "Plan my hike" }).first().click()]);
    await page.getByRole("heading", { level: 1, name: "Plan your hike" }).waitFor();
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("navigation: Explore, Trips, Hike, Saved and Profile in the desktop header and the phone tab bar", { timeout: 60_000 }, async () => {
  const desktop = await openPage();
  try {
    const { page } = desktop;
    await page.goto("/");
    const header = page.getByRole("navigation", { name: "Main" });
    const links = header.getByRole("link");
    const labels = (await links.allInnerTexts()).map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(labels.slice(0, 7), ["Ghost Guide", "Explore", "Trips", "Hike", "Saved", "Profile", "Sign in"]);
    const hrefs = await links.evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    assert.deepEqual(hrefs.slice(0, 7), ["/", "/explore", "/trips", "/hike", "/saved", "/login", "/login"]);
    // The phone tab bar is hidden on desktop.
    assert.equal(await page.getByRole("navigation", { name: "Primary" }).isVisible(), false);
    // The current destination is marked.
    await page.goto("/trails");
    assert.equal(await header.getByRole("link", { name: "Explore", exact: true }).getAttribute("aria-current"), "page");
  } finally {
    await desktop.context.close();
  }

  const phone = await openPage({ width: 390, height: 844 });
  try {
    const { page } = phone;
    await page.goto("/how-it-works");
    const tabs = page.getByRole("navigation", { name: "Primary" });
    assert.ok(await tabs.isVisible(), "phones get the bottom tab bar");
    assert.deepEqual((await tabs.getByRole("link").allInnerTexts()).map((s) => s.trim()), ["Explore", "Trips", "Hike", "Saved", "Profile"]);
    assert.equal(await tabs.getByRole("link", { name: "Explore" }).getAttribute("aria-current"), null, "no tab is current on /how-it-works");
    const box = await tabs.boundingBox();
    assert.ok(Math.abs(box.y + box.height - 844) <= 1, `fixed to the bottom of the screen (bottom at ${box.y + box.height})`);
    for (const link of await tabs.getByRole("link").all()) {
      const b = await link.boundingBox();
      assert.ok(b.height >= 44, `tab target ${await link.innerText()} is ${b.height}px tall`);
    }
    // Secondary items live in the header's "More" menu.
    await page.getByRole("navigation", { name: "Main" }).locator("details > summary", { hasText: "More" }).click();
    assert.ok(await page.getByRole("link", { name: "How it works & limits" }).isVisible());
    assert.ok(await page.getByRole("link", { name: "Create an account" }).isVisible());
    // Tabs navigate and mark the destination.
    await Promise.all([page.waitForURL("**/explore"), tabs.getByRole("link", { name: "Explore" }).click()]);
    assert.equal(await tabs.getByRole("link", { name: "Explore" }).getAttribute("aria-current"), "page");
    // Saved needs an account: signed out, it leads to sign-in (part of Profile).
    await Promise.all([page.waitForURL((u) => u.pathname === "/login" && u.searchParams.get("next") === "/saved"), tabs.getByRole("link", { name: "Saved" }).click()]);
    assert.equal(await tabs.getByRole("link", { name: "Profile" }).getAttribute("aria-current"), "page");
  } finally {
    await phone.context.close();
  }
});

// ---------------------------------------------------------------------------
// /trails list + filters
// ---------------------------------------------------------------------------

test("/trails lists the published catalog with demo labeling and hides drafts", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage();
  try {
    await page.goto("/trails");
    await page.locator("#results-heading").waitFor();
    const cards = await readTrailCards(page);
    const names = cards.map((c) => c.name);
    for (const n of SEEDED.all) assert.ok(names.includes(n), `missing seeded trail ${n}`);
    assert.ok(!names.some((n) => /Cinder Spur/.test(n)), "draft trail must not be listed");
    assert.equal(await resultsCount(page), cards.length);
    assert.ok(await page.getByText("Demonstration region").isVisible());
    // Each card is labeled as demo and shows an estimated duration
    for (const c of cards.filter((c) => SEEDED.all.includes(c.name))) assert.ok(c.badges.includes("Demo trail"), `${c.name} lacks Demo trail badge`);
    const firstCardText = await page.locator("section[aria-labelledby=results-heading] article").first().innerText();
    assert.match(firstCardText, /\d+ (h|min).* est\./s);
    // Closure badges for seeded closures
    const old = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Old Signal Summit" }) });
    assert.match(await old.innerText(), /Partial closure/i);
    const whisper = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Whisper Falls Trail" }) });
    assert.match(await whisper.innerText(), /Advisory/i);
  } finally {
    await context.close();
  }
});

test("difficulty filter keeps only the chosen difficulties", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage();
  try {
    await page.goto("/trails");
    const total = await resultsCount(page);
    await applyFilters(page, (form) => form.getByRole("checkbox", { name: "Easy" }).check());
    assert.equal(new URL(page.url()).searchParams.getAll("difficulty").join(), "easy");
    const cards = await readTrailCards(page);
    assert.ok(cards.length > 0 && cards.length < total, `expected fewer results (${cards.length} of ${total})`);
    for (const c of cards) assert.ok(c.badges.includes("Easy"), `${c.name} is not easy`);
    const names = cards.map((c) => c.name);
    assert.ok(names.includes("Lantern Creek Loop") && names.includes("Miner's Meadow Loop"));
    assert.ok(!names.includes("Echo Basin Traverse") && !names.includes("Old Signal Summit"));
    assert.match(await page.locator("#results-heading").innerText(), /match your filters|matches your filters/);
    assert.match(await page.locator("section[aria-labelledby=results-heading]").innerText(), /Difficulty: easy/);
    // The checkbox stays checked after the GET round trip
    assert.ok(await page.getByRole("form", { name: "Filter trails" }).getByRole("checkbox", { name: "Easy" }).isChecked());
  } finally {
    await context.close();
  }
});

test("maximum distance filter removes longer trails", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage();
  try {
    await page.goto("/trails");
    const total = await resultsCount(page);
    await applyFilters(page, (form) => form.getByLabel("Maximum distance").selectOption("5"));
    assert.equal(new URL(page.url()).searchParams.get("maxMi"), "5");
    const cards = await readTrailCards(page);
    assert.ok(cards.length > 0 && cards.length < total);
    for (const c of cards) assert.ok(c.distanceMi <= 5, `${c.name} is ${c.distanceMi} mi`);
    const names = cards.map((c) => c.name);
    assert.ok(!names.includes("Echo Basin Traverse") && !names.includes("Old Signal Summit"));
    assert.ok(names.includes("Hollow Pine Ridge") && names.includes("Lantern Creek Loop"));
    assert.equal(await page.getByRole("form", { name: "Filter trails" }).getByLabel("Maximum distance").inputValue(), "5");
  } finally {
    await context.close();
  }
});

test("maximum elevation gain filter removes hillier trails", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage();
  try {
    await page.goto("/trails");
    const total = await resultsCount(page);
    await applyFilters(page, (form) => form.getByLabel("Maximum elevation gain").selectOption("1000"));
    assert.equal(new URL(page.url()).searchParams.get("maxGainFt"), "1000");
    const cards = await readTrailCards(page);
    assert.ok(cards.length > 0 && cards.length < total);
    for (const c of cards) assert.ok(c.gainFt <= 1000, `${c.name} gains ${c.gainFt} ft`);
    const names = cards.map((c) => c.name);
    assert.ok(names.includes("Whisper Falls Trail") && names.includes("Lantern Creek Loop"));
    assert.ok(!names.includes("Hollow Pine Ridge") && !names.includes("Echo Basin Traverse"));
  } finally {
    await context.close();
  }
});

test("terrain filter shows trails with any selected terrain", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage();
  try {
    await page.goto("/trails");
    const total = await resultsCount(page);
    await applyFilters(page, (form) => form.getByRole("checkbox", { name: "Lake" }).check());
    const lake = await readTrailCards(page);
    assert.ok(lake.length > 0 && lake.length < total);
    for (const c of lake) assert.ok(c.terrain.includes("lake"), `${c.name} has no lake terrain`);
    assert.ok(lake.map((c) => c.name).includes("Echo Basin Traverse"));

    // Adding a second terrain widens (OR semantics) and every card has one of them.
    await applyFilters(page, (form) => form.getByRole("checkbox", { name: "River" }).check());
    assert.deepEqual(new URL(page.url()).searchParams.getAll("terrain").sort(), ["lake", "river"]);
    const either = await readTrailCards(page);
    assert.ok(either.length > lake.length);
    for (const c of either) assert.ok(c.terrain.includes("lake") || c.terrain.includes("river"), `${c.name} matches neither terrain`);
    assert.ok(!either.map((c) => c.name).includes("Hollow Pine Ridge"));
  } finally {
    await context.close();
  }
});

test("results heading agrees in number: '1 trail matches your filters'", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage();
  try {
    await page.goto("/trails?terrain=lake");
    const heading = (await page.locator("#results-heading").innerText()).trim();
    const count = await resultsCount(page);
    assert.equal(heading, count === 1 ? "1 trail matches your filters" : `${count} trails match your filters`);
  } finally {
    await context.close();
  }
});

test("accessibility filter requires every selected feature", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage();
  try {
    await page.goto("/trails");
    const total = await resultsCount(page);
    await applyFilters(page, (form) => form.getByRole("checkbox", { name: "Shade" }).check());
    let names = (await readTrailCards(page)).map((c) => c.name);
    assert.ok(names.length > 0 && names.length < total);
    assert.ok(names.includes("Lantern Creek Loop") && names.includes("Whisper Falls Trail"));
    for (const n of ["Echo Basin Traverse", "Hollow Pine Ridge", "Miner's Meadow Loop", "Old Signal Summit"]) assert.ok(!names.includes(n), `${n} has no shade`);

    // AND semantics: shade + step-free start narrows further.
    await applyFilters(page, (form) => form.getByRole("checkbox", { name: "Step-free start" }).check());
    names = (await readTrailCards(page)).map((c) => c.name);
    assert.ok(names.includes("Lantern Creek Loop"));
    assert.ok(!names.includes("Whisper Falls Trail"), "Whisper Falls has no step-free start");
    assert.match(await page.locator("section[aria-labelledby=results-heading]").innerText(), /Accessibility: .*Step-free start|Accessibility: .*Shade/);
  } finally {
    await context.close();
  }
});

test("dogs filter keeps only dog-friendly trails and an impossible combination shows an empty state", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage();
  try {
    await page.goto("/trails");
    const total = await resultsCount(page);
    await applyFilters(page, (form) => form.getByRole("checkbox", { name: "Dogs allowed" }).check());
    assert.equal(new URL(page.url()).searchParams.get("dogs"), "yes");
    const names = (await readTrailCards(page)).map((c) => c.name);
    assert.ok(names.length > 0 && names.length < total);
    for (const n of ["Hollow Pine Ridge", "Lantern Creek Loop", "Miner's Meadow Loop"]) assert.ok(names.includes(n), `${n} allows dogs`);
    for (const n of ["Echo Basin Traverse", "Old Signal Summit", "Whisper Falls Trail"]) assert.ok(!names.includes(n), `${n} does not allow dogs`);

    // Strenuous + dogs: nothing in the seeded catalog.
    await page.goto("/trails?difficulty=strenuous&dogs=yes");
    await page.getByText("No trails match these filters").waitFor();
    assert.equal(await resultsCount(page), 0);
    await Promise.all([page.waitForURL(/\/trails$/), page.getByRole("link", { name: "Clear filters" }).click()]);
    assert.equal(await resultsCount(page), total);
  } finally {
    await context.close();
  }
});

test("mobile: filters live in a disclosure and still apply", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage({ width: 390, height: 844 });
  try {
    await page.goto("/trails");
    const total = await resultsCount(page);
    const disclosure = page.locator("details").filter({ has: page.getByRole("form", { name: "Filter trails", includeHidden: true }) });
    await disclosure.locator("summary").click();
    const form = page.getByRole("form", { name: "Filter trails" });
    await form.getByRole("checkbox", { name: "Moderate" }).check();
    await Promise.all([page.waitForURL(/difficulty=moderate/), form.getByRole("button", { name: "Apply filters" }).click()]);
    const cards = await readTrailCards(page);
    assert.ok(cards.length > 0 && cards.length < total);
    for (const c of cards) assert.ok(c.badges.includes("Moderate"));
    // Disclosure is open when filters are active, and reports the count.
    assert.match(await disclosure.locator("summary").innerText(), /1 active/);
    assert.ok(await disclosure.evaluate((d) => d.open), "disclosure open while filters are active");
  } finally {
    await context.close();
  }
});

test("?view=map shows the routes on the MapLibre map (keyless basemap) plus a text list, keeping filters", { timeout: 60_000 }, async () => {
  const { context, page, pageErrors } = await openPage();
  try {
    await page.goto("/trails?dogs=yes");
    await Promise.all([page.waitForURL(/view=map/), page.getByRole("navigation", { name: "Results view" }).getByRole("link", { name: "Map", exact: true }).click()]);
    const url = new URL(page.url());
    assert.equal(url.searchParams.get("view"), "map");
    assert.equal(url.searchParams.get("dogs"), "yes", "toggle must keep filters");
    assert.equal(await page.getByRole("navigation", { name: "Results view" }).getByRole("link", { name: "Map", exact: true }).getAttribute("aria-current"), "page");

    // MapLibre (style from the configured URL; in e2e a blank local style), never Mapbox.
    const count = await resultsCount(page);
    const map = page.getByRole("region", { name: new RegExp(`^Map of ${count} fictional trail routes in `) });
    await map.waitFor();
    await page.locator("canvas.maplibregl-canvas").waitFor();
    assert.equal(await page.locator(".mapboxgl-map, canvas.mapboxgl-canvas").count(), 0, "no Mapbox map");
    assert.match(await page.locator("figure figcaption").innerText(), /Demonstration routes drawn on a real basemap: the trails are fictional and not for navigation\./);
    await page.getByText("Map loaded. Trailhead markers are buttons; the trail list below has the same information.").waitFor({ state: "attached" });

    // Text alternative lists the same (filtered) trails with links.
    await page.getByRole("heading", { name: "Trails on the map" }).waitFor();
    const list = page.locator("ol").filter({ has: page.locator('a[href^="/trails/"]') }).last();
    const linkNames = (await list.getByRole("link").allInnerTexts()).map((t) => t.replace(/^\d+\.\s*/, "").trim());
    assert.equal(linkNames.length, count);
    assert.ok(linkNames.includes("Lantern Creek Loop"));
    assert.ok(!linkNames.includes("Echo Basin Traverse"), "filtered-out trail must not be listed");

    // Each trailhead is a labeled, keyboard-reachable marker button; its popup links to the trail.
    const markers = map.getByRole("button", { name: /^\d+\. .+ trailhead( \(closed\))?: show details$/ });
    assert.equal(await markers.count(), count);
    const first = markers.first();
    const label = await first.getAttribute("aria-label");
    const name = /^1\. (.+?) trailhead/.exec(label)?.[1];
    assert.ok(name && linkNames.includes(name), `marker 1 (${label}) is in the list`);
    await first.click();
    const popup = page.locator(".maplibregl-popup");
    await popup.waitFor();
    assert.match(await popup.innerText(), new RegExp(`1\\. ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(await popup.getByRole("link", { name: "View trail details" }).getAttribute("href"), /^\/trails\/[a-z0-9-]+$/);

    // Filters submitted from map view stay on the map view.
    const form = page.getByRole("form", { name: "Filter trails" });
    await form.getByRole("checkbox", { name: "Easy" }).check();
    await Promise.all([page.waitForURL(/difficulty=easy/), form.getByRole("button", { name: "Apply filters" }).click()]);
    assert.equal(new URL(page.url()).searchParams.get("view"), "map");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("mobile map overview: 44 px marker targets, collapsed attribution, no horizontal scroll, list names each trail", { timeout: 60_000 }, async () => {
  const { context, page, pageErrors } = await openPage({ width: 390, height: 844 });
  try {
    await page.goto("/trails?view=map");
    const count = await resultsCount(page);
    const map = page.getByRole("region", { name: /^Map of \d+ fictional trail routes in / });
    await map.waitFor();
    const markers = map.getByRole("button", { name: /trailhead( \(closed\))?: show details$/ });
    await markers.first().waitFor();
    assert.equal(await markers.count(), count);
    for (const box of await markers.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ w: r.width, h: r.height })))) {
      assert.ok(box.w >= 44 && box.h >= 44, `marker touch target ${box.w}×${box.h}`);
    }
    // Phones start with the map attribution collapsed (the page credits sources in text too).
    const attrib = page.locator(".maplibregl-ctrl-attrib");
    await attrib.waitFor({ state: "attached" });
    assert.equal(await attrib.evaluate((el) => el.classList.contains("maplibregl-compact-show")), false, "attribution starts collapsed");
    const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
    assert.ok(sw <= w, `scrolls horizontally (${sw} > ${w})`);
    // The numbered text list stays the accessible way in.
    assert.equal(await page.getByRole("heading", { name: "Trails on the map" }).count(), 1);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// /trails/[slug]
// ---------------------------------------------------------------------------

test("trail detail shows facts, estimate-labeled duration, provenance, sources + freshness, permits and demo label", { timeout: 60_000 }, async () => {
  const { context, page, pageErrors } = await openPage();
  try {
    const res = await page.goto("/trails/echo-basin-traverse");
    assert.equal(res.status(), 200);
    await page.getByRole("heading", { level: 1, name: "Echo Basin Traverse" }).waitFor();
    assert.match(await page.title(), /Echo Basin Traverse \(demo trail\)/);

    // Demo label
    const note = page.getByRole("note");
    assert.match(await note.innerText(), /Demonstration trail — fictional, not for navigation\./);

    // Facts
    const facts = page.getByRole("region", { name: "Trail facts" });
    const factText = await facts.innerText();
    assert.match(factText, /Distance\s*8\.0 mi \(12\.8 km\)/i);
    assert.match(factText, /Elevation gain\s*3,232 ft \(985 m\)/i);
    assert.match(factText, /Difficulty\s*Hard/i);
    assert.match(factText, /Terrain\s*Ridge, Rocky, Lake, Meadow/i);
    assert.match(factText, /Estimated duration\s*4 h 29 min est\.\s*Estimate, not a guarantee/i);
    assert.match(factText, /How the duration is estimated:.*Not a guarantee/s);

    // Provenance: each fact has a kind badge; legend explains verified vs estimate vs demo.
    const sources = page.getByRole("region", { name: "Sources & information freshness" });
    const provList = sources.locator("ul").first();
    const provText = await provList.innerText();
    assert.match(provText, /Estimated duration\s*Estimate/);
    assert.match(provText, /Distance\s*Demonstration/);
    assert.match(provText, /Difficulty rating\s*Operator note/);
    assert.ok(!/\bVerified\b/.test(provText), "no seeded demo fact is verified, so none may carry a Verified badge");
    assert.match(await sources.innerText(), /Verified = confirmed against a source · Estimate = calculated, not measured · Operator note = .* · Demonstration = invented for the demo\./);
    // Sources + freshness: demo facts are "reviewed", never described as verified.
    const sourcesText = await sources.innerText();
    assert.match(sourcesText, /Trail facts were last reviewed .*(today|\d+ days? ago)/);
    assert.match(sourcesText, /demonstration facts, invented for this demo: none of them is verified against a real source/);
    assert.ok(!/last verified/.test(sourcesText), "demo facts must not be described as verified");
    assert.ok((await sources.getByText("Demo source").count()) >= 1, "demo sources are labeled");
    assert.match(await sources.innerText(), /Retrieved [A-Z][a-z]{2} \d{1,2}, \d{4}/);

    // Permits with official link
    const permits = page.getByRole("region", { name: "Permits" });
    assert.match(await permits.innerText(), /Echo Basin day-use permit \(fictional\)/);
    assert.match(await permits.innerText(), /Lead time: apply at least 7 days ahead/);
    const official = permits.getByRole("link", { name: /Official permit page/ });
    assert.equal(await official.getAttribute("href"), "https://example.org/demo-permits/echo-basin");
    assert.equal(await official.getAttribute("target"), "_blank");
    assert.match(await official.getAttribute("rel"), /noopener/);
    assert.match(await permits.innerText(), /Demo: this link points to a placeholder page\./);
    assert.match(await permits.innerText(), /don't buy permits or automate permit queues/);

    // Route on the MapLibre map, labeled as a fictional demonstration route; narration stops are approved/cited
    const route = page.getByRole("region", { name: "Route", exact: true });
    assert.match(await route.innerText(), /Demonstration route drawn on a real basemap: fictional, not for navigation\./);
    await route.getByRole("region", { name: /^Map of the Echo Basin Traverse route with \d+ stops$/ }).waitFor();
    await route.getByRole("button", { name: "Start of route" }).waitFor();
    assert.match(await page.getByRole("region", { name: /Audio narration stops/ }).innerText(), /Source: /);

    // Personalize CTA carries the slug to /plan
    await Promise.all([page.waitForURL(/\/plan\?trail=echo-basin-traverse/), page.getByRole("link", { name: /Personalize this hike/ }).first().click()]);
    await page.getByText("We'll check Echo Basin Traverse first").waitFor();
    assert.equal(await page.locator('input[type=hidden][name=trail]').inputValue(), "echo-basin-traverse");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("trail detail shows active closures: partial (Old Signal Summit) and advisory (Whisper Falls)", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage({ width: 390, height: 844 });
  try {
    await page.goto("/trails/old-signal-summit");
    const closures = page.getByRole("region", { name: "Closures and advisories" });
    const oldText = await closures.innerText();
    assert.match(oldText, /Partial closure/);
    assert.match(oldText, /Upper switchbacks closed/);
    assert.match(oldText, /Since [A-Z][a-z]{2} \d{1,2}, \d{4}, expected until [A-Z][a-z]{2} \d{1,2}, \d{4}/);
    assert.ok(!/Trail closed/.test(oldText), "a partial closure is not a full closure");

    await page.goto("/trails/whisper-falls");
    const adv = await page.getByRole("region", { name: "Closures and advisories" }).innerText();
    assert.match(adv, /Advisory/);
    assert.match(adv, /stepping-stone crossing can be slippery/i);
    assert.ok(!/Partial closure/.test(adv));

    // A trail without closures has no closures region.
    await page.goto("/trails/lantern-creek-loop");
    await page.getByRole("heading", { level: 1, name: "Lantern Creek Loop" }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Closures and advisories" }).count(), 0);
    assert.match(await page.getByRole("region", { name: "Permits" }).innerText(), /lists no permit requirement/);
  } finally {
    await context.close();
  }
});

test("draft and unknown trail slugs return 404 with a helpful page", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage();
  try {
    for (const slug of ["cinder-spur-draft", "no-such-trail", "UPPER_case"]) {
      const res = await page.goto(`/trails/${slug}`);
      assert.equal(res.status(), 404, `${slug} should 404`);
      await page.getByText("We couldn't find that trail").waitFor();
      assert.equal(await page.getByText("Cinder Spur").count(), 0, "draft name must not leak");
    }
    // The planner does not reveal the draft either.
    await page.goto("/plan?trail=cinder-spur-draft");
    await page.getByText("We couldn't find the trail you linked to").waitFor();
    assert.equal(await page.locator('input[type=hidden][name=trail]').count(), 0);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// /plan validation
// ---------------------------------------------------------------------------

async function expectFieldError(page, id, message) {
  const input = page.locator(`#${id}`);
  assert.equal(await input.getAttribute("aria-invalid"), "true", `#${id} should be aria-invalid`);
  assert.match((await input.getAttribute("aria-describedby")) ?? "", new RegExp(`\\b${id}-error\\b`), `#${id} should reference its error`);
  assert.match(await page.locator(`#${id}-error`).innerText(), message);
  // Error summary links to the field
  const summary = page.getByRole("alert").filter({ hasText: /Please fix/ });
  assert.ok((await summary.locator(`a[href="#${id}"]`).count()) === 1, `summary should link to #${id}`);
}

test("plan validation: a past date is rejected accessibly", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage({ width: 390, height: 844 });
  try {
    await page.goto("/plan");
    await page.getByLabel(/^Date/).fill(regionDate(-2));
    await Promise.all([page.waitForURL(/\/plan\/results\?/), page.getByRole("button", { name: "See my suggestions" }).click()]);
    await page.getByRole("heading", { level: 1, name: "Check your answers" }).waitFor();
    const summary = page.getByRole("alert").filter({ hasText: /Please fix 1 answer/ });
    assert.match(await summary.innerText(), /Date: Choose today or a later date\./);
    // The title says something is wrong, and focus moves to the error summary (GOV.UK pattern).
    assert.match(await page.title(), /^Error: Check your answers/);
    await page.waitForFunction(() => document.activeElement?.id === "plan-errors");
    assert.match(await page.evaluate(() => document.activeElement.innerText), /Please fix 1 answer/);
    await expectFieldError(page, "date", /Choose today or a later date\./);
    // The rest of the answers are preserved in the form.
    assert.equal(await page.locator("#hours").inputValue(), "4");
    assert.ok(await page.locator("#experience-some").isChecked());
  } finally {
    await context.close();
  }
});

test("plan validation: minimum distance above maximum is rejected", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage();
  try {
    await page.goto("/plan");
    await page.getByLabel("Shortest distance (miles)").fill("6");
    await page.getByLabel("Longest distance (miles)").fill("3");
    await page.getByLabel(/^Date/).fill(regionDate(10));
    await Promise.all([page.waitForURL(/\/plan\/results\?/), page.getByRole("button", { name: "See my suggestions" }).click()]);
    await page.getByRole("heading", { level: 1, name: "Check your answers" }).waitFor();
    await expectFieldError(page, "maxMi", /Minimum distance must not be more than the maximum\./);
    assert.equal(await page.locator("#minMi").inputValue(), "6");

    // Out-of-range distances are explained in miles, on the field that caused them.
    await gotoResults(page, { experience: "some", fitness: "moderate", pace: "steady", hours: "4", minMi: "60", date: regionDate(10), start: "08:30", party: "2" });
    await expectFieldError(page, "minMi", /Minimum distance must be between 0 and 50 miles\./);
    assert.equal(await page.locator("#maxMi-error").count(), 0, "a minimum-distance problem is not reported on the maximum field");
  } finally {
    await context.close();
  }
});

test("plan validation: missing required answers are each reported", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage();
  try {
    await page.goto("/plan");
    await page.getByLabel(/^Time available/).fill("");
    await page.getByLabel(/^Date/).fill("");
    await page.getByLabel(/^Start time/).fill("");
    await page.getByLabel(/^Group size/).fill("");
    await Promise.all([page.waitForURL(/\/plan\/results\?/), page.getByRole("button", { name: "See my suggestions" }).click()]);
    await page.getByRole("heading", { level: 1, name: "Check your answers" }).waitFor();
    assert.match(await page.getByRole("alert").filter({ hasText: /Please fix/ }).innerText(), /Please fix 4 answers/);
    await expectFieldError(page, "hours", /Enter the hours you have available\./);
    await expectFieldError(page, "date", /date/i);
    await expectFieldError(page, "start", /time/i);
    await expectFieldError(page, "party", /Group size/);

    // Missing radio answers (e.g. a hand-edited link) are reported on their fieldsets.
    await gotoResults(page, { pace: "steady", hours: "4", date: regionDate(10), start: "08:30", party: "2" });
    const summary = page.getByRole("alert").filter({ hasText: /Please fix/ });
    assert.match(await summary.innerText(), /Hiking experience: Choose your hiking experience\./);
    assert.match(await summary.innerText(), /Fitness: Choose your fitness level\./);
    assert.equal(await summary.locator('a[href="#experience-new"]').count(), 1);
    assert.equal(await page.locator("#experience-error").innerText(), "Choose your hiking experience.");
    assert.equal(await page.locator("#experience-new").getAttribute("aria-invalid"), "true");
  } finally {
    await context.close();
  }
});

test("plan validation: the full advertised distance range (up to 50 miles) is accepted", { timeout: 60_000 }, async () => {
  // The form says 0.5–50 miles (max=50); 50 mi must not be rejected with a km-based error.
  const { context, page } = await openPage();
  try {
    for (const field of ["maxMi", "minMi"]) {
      await gotoResults(page, { experience: "some", fitness: "moderate", pace: "steady", hours: "4", [field]: "50", date: regionDate(10), start: "08:30", party: "2" });
      const h1 = await page.getByRole("heading", { level: 1 }).innerText();
      const errorText = (await page.locator(`#${field}-error`).count()) ? await page.locator(`#${field}-error`).innerText() : "";
      assert.notEqual(h1, "Check your answers", `${field}=50 was rejected: "${errorText}"`);
    }
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const STRONG_HIKER = { experience: "regular", fitness: "high", pace: "brisk", hours: "8", start: "07:00", party: "2" };

test("results: ranked suggestions with score breakdown, itinerary and simulated-AI label", { timeout: 90_000 }, async () => {
  const { context, page, pageErrors } = await openPage();
  try {
    await page.goto("/plan");
    await page.getByLabel("Regular hiker").check();
    await page.getByLabel(/^High/).check();
    await page.getByLabel(/^Brisk/).check();
    await page.getByLabel(/^Time available/).fill("8");
    await page.getByLabel(/^Date/).fill(regionDate(14));
    await page.getByLabel(/^Start time/).fill("07:00");
    await Promise.all([page.waitForURL(/\/plan\/results\?/), page.getByRole("button", { name: "See my suggestions" }).click()]);
    await page.getByRole("heading", { level: 1, name: "Your hike suggestions" }).waitFor();

    const howItWorks = await page.getByText("How suggestions work").locator("..").innerText();
    assert.match(howItWorks, /no AI decides anything/);
    assert.match(await page.locator("main").innerText(), /Demonstration results/);
    assert.match(await page.title(), /^Your hike suggestions/);
    // The latest-finish estimate names the planned month (the date may be in a different month from today).
    const plannedMonth = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(`${regionDate(14)}T12:00:00Z`));
    assert.match(await page.locator("main").innerText(), new RegExp(`Plan to be off the trail by \\d{2}:\\d{2} in ${plannedMonth}:`));
    assert.ok(!/off the trail by \d{2}:\d{2} this month/.test(await page.locator("main").innerText()));

    const articles = page.locator("main article");
    const n = await articles.count();
    assert.ok(n >= 3, `expected several suggestions, got ${n}`);
    let prevScore = Infinity;
    for (let i = 0; i < n; i++) {
      const card = articles.nth(i);
      const text = await card.innerText();
      assert.match(text, new RegExp(`#${i + 1} suggestion`), "ranks are sequential");
      const score = Number(/(\d+)\s*\/\s*100/.exec(text)[1]);
      assert.ok(score <= prevScore, "ranked by descending score");
      prevScore = score;

      // Score breakdown table sums to the score.
      const details = card.locator("details").filter({ hasText: `How the score of ${score} was calculated` });
      await details.locator("summary").click();
      const table = details.getByRole("table");
      const rows = await table.locator("tbody tr").evaluateAll((trs) =>
        trs.map((tr) => ({ factor: tr.querySelector("th").textContent.trim(), points: tr.querySelector("td").textContent.trim() })),
      );
      const factors = rows.map((r) => r.factor);
      for (const f of ["Terrain match", "Distance fit", "Elevation fit", "Difficulty fit", "Time buffer", "Closures & advisories", "Accessibility", "Narration stops"]) {
        assert.ok(factors.includes(f), `breakdown missing ${f}`);
      }
      const sum = rows.reduce((s, r) => s + Number(/^-?\d+/.exec(r.points)[0]), 0);
      assert.equal(Math.max(0, Math.min(100, sum)), score, `breakdown for card ${i + 1} sums to ${sum}, score ${score}`);

      // Itinerary with estimate labels
      const itin = card.getByRole("region", { name: /Suggested itinerary/ });
      const itinText = await itin.innerText();
      assert.match(itinText, /\(all times est\.( for the full route)?\)/);
      assert.match(itinText, /07:00 · Start at /);
      assert.match(itinText, /≈ \d{2}:\d{2} · Finish \(about .+\)/);
      assert.match(itinText, /Reminders are general prompts, not medical advice\./);

      // AI label: template, clearly simulated
      const ai = card.getByRole("region", { name: /Simulated AI \(template\)/ });
      assert.match(await ai.innerText(), /Simulated/);
      assert.match(await ai.innerText(), /no AI model was used/);

      // Save CTA for signed-out visitors
      assert.equal(await card.getByRole("button", { name: /Sign in to save this trip/ }).count(), 1);
    }

    // Partial closure lowers the score, is surfaced as a note, AND appears in the itinerary itself
    // before the turnaround, which must not imply continuing to the (closed) far end.
    const old = articles.filter({ has: page.getByRole("heading", { name: "Old Signal Summit" }) });
    assert.equal(await old.count(), 1, "Old Signal Summit fits a strong hiker 14 days out");
    assert.match(await old.innerText(), /Partial closure: Upper switchbacks closed/);
    const oldItin = await old.getByRole("region", { name: /Suggested itinerary/ }).innerText();
    assert.match(oldItin, /\(all times est\. for the full route\)/);
    assert.match(oldItin, /Partial closure on your date\s+Upper switchbacks closed.*Turn around at the Signal Tower\./s);
    assert.match(oldItin, /Turn around by \d{2}:\d{2} at the latest, or earlier where the closure requires it/);
    assert.ok(!/even if you haven't reached the far end/.test(oldItin), "itinerary must not imply continuing into the closed section");
    assert.ok(oldItin.indexOf("Partial closure on your date") < oldItin.indexOf("Turn around by"), "closure is shown before the turnaround");
    assert.match(oldItin, /Finish \(about .+ for the full route\)/);
    // Permit trail links to the official page from the results.
    const echo = articles.filter({ has: page.getByRole("heading", { name: "Echo Basin Traverse" }) });
    assert.equal(await echo.count(), 1, "Echo Basin fits a strong hiker 14 days out");
    assert.equal(
      await echo.getByRole("link", { name: /Official page: Echo Basin day-use permit/ }).getAttribute("href"),
      "https://example.org/demo-permits/echo-basin",
    );

    // Edit answers returns to a prefilled questionnaire.
    await Promise.all([page.waitForURL(/\/plan\?/), page.getByRole("link", { name: "Edit answers" }).click()]);
    assert.equal(await page.locator("#hours").inputValue(), "8");
    assert.ok(await page.locator("#experience-regular").isChecked());
    assert.equal(await page.locator("#date").inputValue(), regionDate(14));
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("results: excluded trails are listed with their reasons (time, experience, permit lead time)", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage();
  try {
    // Defaults (some experience, 4 h): Echo Basin needs more time; Old Signal is strenuous.
    await gotoResults(page, { experience: "some", fitness: "moderate", pace: "steady", hours: "4", date: regionDate(14), start: "08:30", party: "2", trail: "echo-basin-traverse" });
    await page.getByRole("heading", { level: 1, name: "Your hike suggestions" }).waitFor();
    const focus = page.getByRole("status").filter({ hasText: "Echo Basin Traverse doesn't fit your answers" });
    assert.match(await focus.innerText(), /longer than your available 4 h/);

    const excluded = page.getByRole("region", { name: /Trails we excluded \(\d+\) and why/ });
    await excluded.locator("summary").click();
    const exText = await excluded.innerText();
    assert.match(exText, /Echo Basin Traverse[\s\S]*longer than your available 4 h/);
    assert.match(exText, /Old Signal Summit[\s\S]*Rated strenuous/);
    // Excluded trails are never also suggested.
    const suggested = await page.locator("main article h2").allInnerTexts();
    assert.ok(!suggested.includes("Echo Basin Traverse") && !suggested.includes("Old Signal Summit"));
    assert.equal(await excluded.getByRole("link", { name: "Echo Basin Traverse" }).getAttribute("href"), "/trails/echo-basin-traverse");

    // Permit lead time: a strong hiker 3 days out cannot get the 7-day permit.
    await gotoResults(page, { ...STRONG_HIKER, date: regionDate(3), trail: "echo-basin-traverse" });
    const permitFocus = page.getByRole("status").filter({ hasText: "Echo Basin Traverse doesn't fit your answers" });
    assert.match(await permitFocus.innerText(), /Echo Basin day-use permit \(fictional\) usually needs about 7 days' lead time; your date is [2-4] days away\./);
  } finally {
    await context.close();
  }
});

const NO_MATCH = {
  experience: "new",
  fitness: "low",
  pace: "leisurely",
  hours: "1",
  start: "08:30",
  party: "2",
  dog: "yes",
  needs: ["step_free", "avoid_exposure"],
};

test("results: a no-match plan says so plainly and offers relax suggestions", { timeout: 60_000 }, async () => {
  const { context, page } = await openPage({ width: 390, height: 844 });
  try {
    await gotoResults(page, { ...NO_MATCH, date: regionDate(14) });
    await page.getByRole("heading", { level: 1, name: "No trail fits all of your answers" }).waitFor();
    assert.match(await page.title(), /^No matching trails/);
    assert.equal(await page.locator("main article").count(), 0, "no suggestion cards");
    const main = await page.locator("main").innerText();
    assert.match(main, /None of the \d+ trails in our catalog meets every constraint/);
    assert.match(main, /never invent one/);
    assert.ok(!/verified catalog/.test(main), "the demo catalog is not verified");
    assert.match(main, /What you could change/);
    assert.match(main, /Allow at least 1\.5 h to include Lantern Creek Loop/);
    // Excluded list is expanded by default and explains each trail.
    const excluded = page.getByRole("region", { name: /Trails we excluded \(\d+\) and why/ });
    assert.ok(await excluded.locator("details").evaluate((d) => d.open), "excluded list open on no-match");
    assert.match(await excluded.innerText(), /Lantern Creek Loop[\s\S]*longer than your available 1 h/);
    assert.match(await excluded.innerText(), /Accessibility need not met: Step-free start/);
    // Adjust answers keeps the answers.
    await Promise.all([page.waitForURL(/\/plan\?/), page.getByRole("link", { name: "Adjust my answers" }).click()]);
    assert.equal(await page.locator("#hours").inputValue(), "1");
    assert.ok(await page.locator("#dog").isChecked());
  } finally {
    await context.close();
  }
});

test("results: relax suggestions only name trails that the suggested change would actually include", { timeout: 60_000 }, async () => {
  // A new, low-fitness hiker must not be nudged toward a strenuous summit (still excluded by
  // the experience rule) or told that leaving the dog home includes trails still blocked by time.
  const { context, page } = await openPage();
  try {
    await gotoResults(page, { ...NO_MATCH, date: regionDate(14) });
    await page.getByRole("heading", { level: 1, name: "No trail fits all of your answers" }).waitFor();
    const relax = page.getByRole("heading", { name: "What you could change" }).locator("xpath=..").locator("ul");
    const items = await relax.locator("li").allInnerTexts();
    assert.ok(items.length > 0);
    for (const item of items) {
      assert.ok(
        !/Old Signal Summit|Echo Basin Traverse|Whisper Falls Trail|Miner's Meadow Loop|Hollow Pine Ridge/.test(item),
        `relax suggestion names a trail still excluded for other reasons: "${item}"`,
      );
    }
    // Lantern Creek Loop is blocked only by time, so that is the one trail named.
    assert.ok(items.some((i) => /^Allow at least 1\.5 h to include Lantern Creek Loop\b/.test(i)), items.join(" | "));
    // Experience/fitness and accessibility exclusions are explained without naming trails.
    assert.ok(items.some((i) => /rated above what we suggest for your experience and fitness, so we won't suggest them/.test(i)));
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Save trip flow + isolation
// ---------------------------------------------------------------------------

test("save while signed out -> sign in -> back to results -> save -> /trips/<id>; other customers get 404", { timeout: 150_000 }, async () => {
  const ownerEmail = `discover-owner-${RUN_ID}@example.test`;
  const otherEmail = `discover-other-${RUN_ID}@example.test`;
  const date = regionDate(16);
  const plan = { experience: "some", fitness: "moderate", pace: "steady", hours: "4", date, start: "08:30", party: "2", trail: "whisper-falls" };

  // Create the owner account, then continue in a fresh signed-out context.
  {
    const { context, page } = await openPage();
    try {
      await signUp(page, ownerEmail, "Discover Owner");
    } finally {
      await context.close();
    }
  }

  const { context, page, pageErrors } = await openPage({ width: 390, height: 844 });
  let tripPath;
  try {
    await gotoResults(page, plan);
    await page.getByRole("heading", { level: 1, name: "Your hike suggestions" }).waitFor();
    assert.match(await page.getByRole("status").filter({ hasText: "Whisper Falls Trail fits your answers" }).innerText(), /ranks #\d+ of \d+/);
    const card = page.locator("main article").filter({ has: page.getByRole("heading", { name: "Whisper Falls Trail" }) });
    const cardId = await card.getAttribute("id");
    assert.match(cardId, /^trail-[0-9a-f-]{36}$/);
    await Promise.all([page.waitForURL(/\/login\?next=/), card.getByRole("button", { name: /Sign in to save this trip/ }).click()]);
    const next = new URL(page.url()).searchParams.get("next");
    assert.ok(next.startsWith("/plan/results?"), `next should return to results, got ${next}`);
    const nextUrl = new URL(next, BASE);
    assert.equal(nextUrl.searchParams.get("trail"), "whisper-falls");
    assert.equal(nextUrl.searchParams.get("date"), date);
    assert.equal(nextUrl.hash, `#${cardId}`, "next returns to the chosen card");
    await page.getByText("we'll take you back to the trail you chose").waitFor();

    await page.getByLabel("Email").fill(ownerEmail);
    await page.getByLabel("Password").fill(CUSTOMER_PASSWORD);
    await Promise.all([page.waitForURL(/\/plan\/results\?/, { timeout: 30_000 }), page.getByRole("button", { name: "Sign in" }).click()]);
    await page.getByRole("heading", { level: 1, name: "Your hike suggestions" }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("date"), date, "same answers after sign-in");
    assert.equal(new URL(page.url()).hash, `#${cardId}`, "back at the chosen card");

    const card2 = page.locator("main article").filter({ has: page.getByRole("heading", { name: "Whisper Falls Trail" }) });
    const save = card2.getByRole("button", { name: /^Save this trip/ });
    assert.equal(await save.count(), 1, "signed-in visitors see Save this trip");
    // Focus lands on that card's Save button, and the card is on screen.
    await page.waitForFunction((id) => document.activeElement?.closest("article")?.id === id && document.activeElement.tagName === "BUTTON", cardId);
    const box = await card2.boundingBox();
    assert.ok(box && box.y < 844 && box.y + box.height > 0, "the chosen card is scrolled into view");
    await Promise.all([page.waitForURL(/\/trips\/[0-9a-f-]{36}$/, { timeout: 30_000 }), save.click()]);
    tripPath = new URL(page.url()).pathname;

    await page.getByRole("heading", { level: 1, name: "Whisper Falls Trail" }).waitFor();
    const main = await page.locator("main").innerText();
    assert.match(main, /Saved/);
    assert.match(main, /start 08:30/);
    assert.match(main, /2 hikers/);
    const expectedDay = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
    assert.ok(main.includes(expectedDay), `trip date should read ${expectedDay}`);
    assert.equal(await page.getByRole("link", { name: "Book this hike" }).getAttribute("href"), `${tripPath}/checkout`);

    // It is listed in My trips.
    await page.goto("/trips");
    assert.ok((await page.locator(`a[href="${tripPath}"]`).count()) >= 1, "saved trip appears in My trips");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }

  // Another customer cannot open it.
  {
    const { context: c2, page: p2 } = await openPage();
    try {
      await signUp(p2, otherEmail, "Discover Other");
      const res = await p2.goto(tripPath);
      assert.equal(res.status(), 404, "another customer's trip must 404");
      assert.equal(await p2.getByRole("heading", { level: 1, name: "Whisper Falls Trail" }).count(), 0);
      await p2.goto("/trips");
      assert.equal(await p2.locator(`a[href="${tripPath}"]`).count(), 0, "not in the other customer's list");
    } finally {
      await c2.close();
    }
  }

  // Signed-out visitors are sent to sign in, not shown the trip.
  {
    const { context: c3, page: p3 } = await openPage();
    try {
      await p3.goto(tripPath);
      assert.match(p3.url(), /\/login\?next=/);
    } finally {
      await c3.close();
    }
  }
});

test("sign-in `next` (used by Save) never redirects off-site", { timeout: 90_000 }, async () => {
  const email = `discover-redirect-${RUN_ID}@example.test`;
  {
    const { context, page } = await openPage();
    try {
      await signUp(page, email, "Discover Redirect");
    } finally {
      await context.close();
    }
  }
  for (const next of ["//evil.example/x", "/\\evil.example/x", "/\t/evil.example/x", "/\n/evil.example/x"]) {
    const { context, page } = await openPage();
    try {
      const offsite = [];
      await page.route("**/*", (route) => {
        const host = new URL(route.request().url()).hostname;
        if (host === "evil.example") {
          offsite.push(route.request().url());
          return route.fulfill({ status: 200, contentType: "text/html", body: "<h1>offsite</h1>" });
        }
        return route.continue();
      });
      await page.goto(`/login?next=${encodeURIComponent(next)}`);
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill(CUSTOMER_PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL((u) => !u.pathname.startsWith("/login") || u.hostname !== new URL(BASE).hostname, { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(1000);
      assert.equal(new URL(page.url()).hostname, new URL(BASE).hostname, `next=${JSON.stringify(next)} sent the user to ${page.url()}`);
      assert.deepEqual(offsite, [], `next=${JSON.stringify(next)} requested an off-site page`);
      // An unsafe `next` falls back to My trips (and never crashes the sign-in action).
      assert.equal(new URL(page.url()).pathname, "/trips", `next=${JSON.stringify(next)} should fall back to /trips`);
    } finally {
      await context.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Mobile layout smoke
// ---------------------------------------------------------------------------

test("mobile (390px): discover pages have no horizontal scrolling and no page errors", { timeout: 120_000 }, async () => {
  const { context, page, pageErrors } = await openPage({ width: 390, height: 844 });
  try {
    const paths = [
      "/",
      "/trails",
      "/trails?view=map",
      "/trails/echo-basin-traverse",
      "/trails/old-signal-summit",
      "/plan",
      resultsUrl({ ...STRONG_HIKER, date: regionDate(14) }),
      resultsUrl({ ...NO_MATCH, date: regionDate(14) }),
    ];
    for (const p of paths) {
      await page.goto(p, { waitUntil: "networkidle" });
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
      assert.ok(sw <= w, `${p} scrolls horizontally (${sw} > ${w})`);
    }
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});
