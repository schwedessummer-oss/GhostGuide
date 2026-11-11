/**
 * Hike slice — end-to-end spec (node:test + Playwright).
 *
 * Covers, for a customer who signs up and books their own trip (simulated
 * payment), on a phone-sized context with geolocation granted near the
 * Lantern Creek trailhead:
 *   prepare page (limitations, checklist, phone check with Test GPS accuracy,
 *   check-in setup card) → offline download verified complete → hike screen:
 *   limitations must be acknowledged → demo GPS simulator → progress grows,
 *   a story stop triggers ONCE by location and its transcript shows → detour
 *   produces an off-route prompt that can be dismissed → offline: indicator
 *   + growing queue + "I'm okay" saved → online: queue flushes, last sync
 *   updates, "I'm okay" sent → reload restores the hike → OFFLINE full-page
 *   reloads of the hike and help screens are served by the service worker →
 *   help shows coordinates / accuracy / time / tel: link / honest copy →
 *   finish → completion summary → feedback.
 * Also: /how-it-works limitations, web manifest + icons, a saved (unbooked)
 * trip cannot be downloaded, and another customer (or a signed-out visitor)
 * cannot read the trip bundle or the hike pages.
 *
 * Independent of other specs: signs up its own customers (unique emails per
 * run), books a random date weeks ahead, and sends its own X-Forwarded-For
 * per context so per-client auth rate limits are not shared with other specs.
 *
 * Run: E2E_BASE_URL=http://localhost:3203 E2E_CRON_SECRET=… node --test tests/e2e/specs/hike.spec.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BASE, newBrowser, newContext, runJobs } from "../helpers.mjs";

const TZ = "America/Los_Angeles"; // demo region (Ghost Ridge) time zone
const TRAIL_SLUG = "lantern-creek-loop";
const TRAIL_NAME = "Lantern Creek Loop";
const CUSTOMER_PASSWORD = "qa-hike-pass-12345";
const NAV = 30_000;
const UI = 15_000;
const SIM = 45_000; // simulated walking can take a while on a slow machine
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

// The limitation titles are product requirements (src/components/hike/limitations.tsx).
const LIMITATION_TITLES = [
  "GPS can pause when the screen locks",
  "Audio may stop when the screen locks",
  "Offline reminders and notifications are not guaranteed",
  "Keep the app open with the screen on",
  "Carry a backup way to navigate",
  "Ghost Guide is not an emergency service",
  "Dependable background tracking needs a native app",
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const run = randomUUID().slice(0, 8);
let ipCounter = 1;
const fakeIp = () => `10.${(parseInt(run.slice(0, 2), 16) % 250) + 1}.${(parseInt(run.slice(2, 4), 16) % 200) + 30}.${ipCounter++}`;

function regionToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Phone-sized context with geolocation near the trailhead and its own client IP. */
async function phoneContext(browser, opts = {}) {
  return newContext(browser, { extraHTTPHeaders: { "x-forwarded-for": fakeIp() }, ...opts });
}

function watchErrors(page) {
  const errors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // Expected while the context is deliberately offline.
    if (/net::ERR_INTERNET_DISCONNECTED|Failed to fetch|ERR_NETWORK_CHANGED/i.test(text)) return;
    errors.push(`${page.url()} :: ${text}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror ${page.url()} :: ${e.message}`));
  return errors;
}

async function signUp(page, label) {
  const email = `qa-hike-${label}-${run}-${Date.now()}@example.test`;
  await page.goto("/signup");
  await page.getByLabel("Full name").fill(`QA Hike ${label} ${run}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(CUSTOMER_PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: NAV }),
    page.getByRole("button", { name: "Create account" }).click(),
  ]);
  return email;
}

/** Save a Lantern Creek Loop trip from the personalized results page; returns the trip id. */
async function createSavedTrip(page, date) {
  const q = new URLSearchParams({ experience: "some", fitness: "moderate", pace: "steady", hours: "6", date, start: "08:30", party: "1", trail: TRAIL_SLUG });
  await page.goto(`/plan/results?${q}`, { timeout: NAV });
  const save = page.getByRole("button", { name: `Save this trip (${TRAIL_NAME})` }).first();
  await save.waitFor({ timeout: NAV });
  await Promise.all([page.waitForURL(/\/trips\/[0-9a-f-]{36}$/, { timeout: NAV }), save.click()]);
  return new URL(page.url()).pathname.split("/").pop();
}

/** Book a saved trip through the simulated checkout; returns when the success page confirms. */
async function bookTrip(page, tripId) {
  await page.goto(`/trips/${tripId}/checkout`, { timeout: NAV });
  await Promise.all([
    page.waitForURL(/\/checkout\/demo\/demo_cs_[0-9a-f-]{36}$/, { timeout: NAV }),
    page.getByRole("button", { name: /Continue to secure payment/ }).click(),
  ]);
  await Promise.all([
    page.waitForURL(/\/checkout\/success\?booking=/, { timeout: NAV }),
    page.getByRole("button", { name: "Simulate successful payment" }).click(),
  ]);
  await assertText(page.locator("main"), /You're booked!/, NAV);
}

async function runJobsUntilQuiet(maxRounds = 4) {
  for (let i = 0; i < maxRounds; i++) {
    const r = await runJobs();
    if (!r.claimed) return;
  }
}

async function assertText(locator, re, timeout = UI) {
  await locator.filter({ hasText: re }).first().waitFor({ timeout }).catch(async () => {
    const actual = await locator.first().innerText().catch(() => "<no element>");
    assert.fail(`Expected ${re} in:\n${actual.slice(0, 2500)}`);
  });
}

/** Poll `fn` until it returns a truthy value (or fail with `message`). */
async function waitUntil(fn, message, timeout = UI, interval = 250) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  assert.fail(`${message} (last value: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

const hikeApp = (page) => page.getByTestId("hike-app");
async function phase(page) {
  return hikeApp(page).getAttribute("data-phase");
}
async function waitPhase(page, wanted, timeout = NAV) {
  await page.locator(`[data-testid=hike-app][data-phase=${wanted}]`).waitFor({ timeout }).catch(async () => {
    assert.fail(`hike phase should be "${wanted}" but is "${await phase(page).catch(() => "?")}":\n${(await page.locator("main").innerText().catch(() => "")).slice(0, 1500)}`);
  });
}

/** "37%" from the Progress stat. */
async function progressPct(page) {
  const box = page.getByTestId("hike-progress").locator("div").filter({ hasText: /^Progress/ }).first();
  const text = await box.locator("dd").first().innerText();
  return Number(text.replace("%", ""));
}

async function queuedCount(page) {
  const t = await page.getByTestId("hike-queued").innerText();
  if (/Nothing waiting/.test(t)) return 0;
  return Number(t.match(/(\d+) items?/)?.[1] ?? NaN);
}

/** Record every hike event the page uploads (deduplicated by client event id). */
function recordSyncedEvents(page, sink) {
  page.on("request", (req) => {
    if (req.method() !== "POST" || !req.url().endsWith("/api/hike/sync")) return;
    try {
      const body = JSON.parse(req.postData() ?? "{}");
      if (body.sessionId) sink.sessionIds.add(body.sessionId);
      sink.sentAt.push(body.sentAt);
      for (const e of body.events ?? []) sink.events.set(e.id, e);
      for (const p of body.points ?? []) sink.points.set(p.id, p);
    } catch {
      /* not JSON: ignore */
    }
  });
}

// ---------------------------------------------------------------------------
// fixtures: one customer with one booked trip (their own), plus a saved trip
// ---------------------------------------------------------------------------

let browser;
let ctx;
let page;
let pageErrors;
let tripId;
let savedTripId;
let hikeDate;
const synced = { events: new Map(), points: new Map(), sessionIds: new Set(), sentAt: [] };

before(async () => {
  browser = await newBrowser();
  ctx = await phoneContext(browser);
  page = await ctx.newPage();
  pageErrors = watchErrors(page);
  recordSyncedEvents(page, synced);
  await signUp(page, "owner");
  hikeDate = addDays(regionToday(), randInt(10, 80));
  tripId = await createSavedTrip(page, hikeDate);
  await bookTrip(page, tripId);
  await runJobsUntilQuiet();
  savedTripId = await createSavedTrip(page, addDays(hikeDate, 1));
});

after(async () => {
  await ctx?.setOffline(false).catch(() => {});
  await browser?.close();
});

// ---------------------------------------------------------------------------
// 1. Public honesty pages and PWA plumbing
// ---------------------------------------------------------------------------

test("/how-it-works states the web app's limitations and the safety model plainly", { timeout: 60_000 }, async () => {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: BASE });
  try {
    const p = await c.newPage();
    const res = await p.goto("/how-it-works", { timeout: NAV });
    assert.equal(res.status(), 200);
    const main = p.locator("main");
    await p.getByRole("heading", { name: "Limitations of the web app" }).waitFor({ timeout: UI });
    const text = await main.innerText();
    for (const title of LIMITATION_TITLES) assert.ok(text.includes(title), `limitation listed: ${title}`);
    assert.match(text, /does not monitor you continuously/i);
    assert.match(text, /We never call 911 or Search and Rescue automatically/);
    assert.match(text, /No satellite SOS/);
    assert.match(text, /not proof of an emergency/);
    assert.doesNotMatch(text, /guaranteed rescue|we will rescue|continuous(ly)? monitor(ing)? (you|your)/i, "no safety over-claims");
    const scroll = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(scroll <= 0, `no horizontal scroll on mobile (overflow ${scroll}px)`);
  } finally {
    await c.close();
  }
});

test("web app manifest, icons and service worker are served", { timeout: 60_000 }, async () => {
  const res = await fetch(`${BASE}/manifest.webmanifest`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /manifest\+json|application\/json/);
  const m = await res.json();
  assert.equal(m.name, "Ghost Guide");
  assert.equal(m.display, "standalone");
  assert.ok(m.start_url, "start_url present");
  assert.ok(Array.isArray(m.icons) && m.icons.length >= 2, "icons listed");
  assert.ok(m.icons.some((i) => i.sizes === "192x192") && m.icons.some((i) => i.sizes === "512x512"), "192 and 512 icons");
  for (const icon of m.icons) {
    const r = await fetch(new URL(icon.src, BASE));
    assert.equal(r.status, 200, `icon ${icon.src} served`);
    assert.match(r.headers.get("content-type") ?? "", /^image\/png/, `icon ${icon.src} is a PNG`);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.length > 100 && buf.subarray(1, 4).toString() === "PNG", `icon ${icon.src} has PNG bytes`);
  }
  const sw = await fetch(`${BASE}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get("content-type") ?? "", /javascript/);

  // Every <link rel=manifest|icon|apple-touch-icon> on the home page resolves.
  const c = await browser.newContext({ baseURL: BASE });
  try {
    const p = await c.newPage();
    await p.goto("/", { timeout: NAV });
    const hrefs = await p.locator('link[rel="manifest"], link[rel~="icon"], link[rel="apple-touch-icon"]').evaluateAll((ls) => ls.map((l) => l.href));
    assert.ok(hrefs.some((h) => h.endsWith("/manifest.webmanifest")), `manifest linked from pages: ${hrefs.join(", ")}`);
    for (const h of hrefs) {
      const r = await fetch(h);
      assert.equal(r.status, 200, `${h} served`);
    }
  } finally {
    await c.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Access control on the hike data
// ---------------------------------------------------------------------------

test("another customer (and a signed-out visitor) cannot read the trip bundle or hike pages", { timeout: 120_000 }, async () => {
  // Signed out: 401 from the API, sign-in redirect for pages.
  const anon = await fetch(`${BASE}/api/trips/${tripId}/bundle`, { redirect: "manual" });
  assert.equal(anon.status, 401, "signed-out bundle request is refused");
  for (const sub of ["prepare", "hike", "help", "complete"]) {
    const r = await fetch(`${BASE}/trips/${tripId}/${sub}`, { redirect: "manual" });
    assert.ok([302, 303, 307, 308].includes(r.status), `signed-out /trips/<id>/${sub} redirects (got ${r.status})`);
    assert.match(r.headers.get("location") ?? "", /\/login\?next=/, `signed-out /trips/<id>/${sub} goes to sign-in`);
  }
  const anonStart = await fetch(`${BASE}/api/hike/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tripId }) });
  assert.equal(anonStart.status, 401, "signed-out hike start is refused");

  // The owner can read it (sanity check for the 404 below).
  const own = await ctx.request.get(`/api/trips/${tripId}/bundle`);
  assert.equal(own.status(), 200, "owner can read their bundle");
  const bundle = await own.json();
  assert.equal(bundle.trip.id, tripId);
  assert.equal(bundle.trip.bookedDate, hikeDate, "bundle carries the booked date");
  assert.match(bundle.ownerHint ?? "", /^[A-Za-z0-9_-]{16,}$/, "bundle is tagged with the owner's device hint");
  assert.match(own.headers()["set-cookie"] ?? "", /gg_owner=[A-Za-z0-9_-]+/, "the bundle response (re)sets the device owner cookie");
  // Starting weeks before the booked date is refused (the demo override is explicit).
  const early = await ctx.request.post("/api/hike/start", { data: { tripId } });
  assert.equal(early.status(), 409, "cannot start before the booked date");
  assert.match((await early.json()).error, /You can start it on/);
  assert.ok(bundle.narrations.length > 0 && bundle.narrations.every((n) => n.sourceCitation), "only cited narration is bundled");
  // Cookie-authenticated writes refuse other origins (CSRF), even for the owner.
  const csrf = await ctx.request.post("/api/hike/start", { data: { tripId }, headers: { origin: "https://evil.example" } });
  assert.equal(csrf.status(), 403, "cross-origin hike start is refused");

  const otherCtx = await phoneContext(browser);
  try {
    const other = await otherCtx.newPage();
    await signUp(other, "intruder");
    const r = await otherCtx.request.get(`/api/trips/${tripId}/bundle`);
    assert.equal(r.status(), 404, "another customer's bundle request is a 404, not a 403");
    const body = await r.text();
    assert.ok(!body.includes(TRAIL_NAME) && !body.includes("geometry"), "the 404 leaks nothing about the trip");

    for (const sub of ["hike", "help", "prepare", "complete"]) {
      const res = await other.goto(`/trips/${tripId}/${sub}`, { timeout: NAV });
      assert.equal(res.status(), 404, `/trips/<id>/${sub} is a 404 for another customer`);
    }
    // Writing to someone else's trip/session is refused the same way.
    const start = await otherCtx.request.post("/api/hike/start", { data: { tripId } });
    assert.equal(start.status(), 404, "cannot start someone else's hike");
    const dl = await otherCtx.request.post(`/api/trips/${tripId}/download`, {
      data: { manifestVersion: 1, manifestChecksum: "a".repeat(64), itemCount: 1, verifiedComplete: true },
    });
    assert.equal(dl.status(), 404, "cannot record a download for someone else's trip");
  } finally {
    await otherCtx.close();
  }
});

test("a saved but unbooked trip cannot be prepared, downloaded or started", { timeout: 60_000 }, async () => {
  const r = await ctx.request.get(`/api/trips/${savedTripId}/bundle`);
  assert.equal(r.status(), 409, "bundle for an unbooked trip is a 409");
  await page.goto(`/trips/${savedTripId}/prepare`, { timeout: NAV });
  await assertText(page.locator("main"), /This trip isn't booked/);
  assert.equal(await page.getByTestId("download-trip").count(), 0, "no download button for an unbooked trip");
  const start = await ctx.request.post("/api/hike/start", { data: { tripId: savedTripId } });
  assert.equal(start.status(), 409, "starting an unbooked trip is refused");
});

test("the hike screen of an unbooked trip explains why it can't open (and does not claim you're offline)", { timeout: 60_000 }, async () => {
  const p = await ctx.newPage(); // separate tab: the expected 409 must not count as a journey console error
  try {
    await p.goto(`/trips/${savedTripId}/hike`, { timeout: NAV });
    await p.locator("[data-testid=hike-app][data-phase=no_bundle], [data-testid=hike-app][data-phase=error]").waitFor({ timeout: NAV });
    assert.equal(await p.evaluate(() => navigator.onLine), true, "the browser is online");
    const text = await p.locator("main").innerText();
    assert.match(text, /This hike can't open here/);
    assert.doesNotMatch(text, /appear to be offline/i, `must not blame the connection while online:\n${text.slice(0, 600)}`);
    assert.match(text, /book/i, "explains that the trip has to be booked first");
  } finally {
    await p.close();
  }
});

// ---------------------------------------------------------------------------
// 3. The hike journey (ordered subtests on the same phone)
// ---------------------------------------------------------------------------

test("hike journey: prepare → download → simulated hike → offline → help → finish → feedback", { timeout: 600_000 }, async (t) => {
  const firstHeard = { name: null, title: null };

  await t.test("trip page links to the preparation page; prepare shows limitations, checklist, phone check and check-in setup", async () => {
    await page.goto(`/trips/${tripId}`, { timeout: NAV });
    await page.getByRole("heading", { name: "Next steps for your hike" }).waitFor({ timeout: UI });
    await Promise.all([
      page.waitForURL(new RegExp(`/trips/${tripId}/prepare$`), { timeout: NAV }),
      page.getByRole("link", { name: /Prepare & download for offline use/ }).click(),
    ]);
    const main = page.locator("main");
    await page.getByRole("heading", { level: 1, name: `Get ready for ${TRAIL_NAME}` }).waitFor({ timeout: UI });
    await assertText(main, /Read before you start/);
    await assertText(main, /Web apps can't run reliably in the background/);
    await page.getByRole("heading", { name: "Limitations to know before you start" }).waitFor();
    const text = await main.innerText();
    for (const title of LIMITATION_TITLES) assert.ok(text.includes(title), `prepare page lists limitation: ${title}`);
    assert.ok(await page.getByText("Demonstration trail").first().isVisible(), "demo trail is labeled");

    // Checklist: ticking is remembered on this device.
    await page.getByRole("heading", { name: "Pack & plan checklist" }).waitFor();
    await assertText(main, /0 of 8 ready/);
    await page.getByRole("checkbox", { name: /^Water/ }).check();
    await page.getByRole("checkbox", { name: /^First-aid kit/ }).check();
    await assertText(main, /2 of 8 ready/);
    await page.reload();
    await assertText(page.locator("main"), /2 of 8 ready/);
    assert.ok(await page.getByRole("checkbox", { name: /^Water/ }).isChecked(), "checklist tick persisted across reload");

    // Phone check: location permission granted, Test GPS reports accuracy.
    await page.getByRole("heading", { name: "Check your phone" }).waitFor();
    await page.getByTestId("perm-test-gps").click();
    const gps = page.getByTestId("perm-gps-result");
    await gps.waitFor({ timeout: UI });
    assert.match(await gps.innerText(), /Got a fix in [\d.]+ s with accuracy ± 10 m \(good\)/);
    await assertText(main, /Notifications \(optional\)/);
    await assertText(main, /never relies on them for safety/);

    // Check-in setup card (safety slice contract) is present and labeled as simulated in demo.
    await page.getByRole("heading", { name: "Trip check-ins" }).waitFor({ timeout: UI });
    assert.ok(await page.getByText("Simulated notices (demo)").first().isVisible(), "check-in notices are labeled as simulated");

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `prepare page has no horizontal scroll on mobile (overflow ${overflow}px)`);
  });

  await t.test("download for offline use → completeness verified on the device and recorded on the server", async () => {
    const status = page.getByTestId("download-status");
    await assertText(status, /Not downloaded on this device yet/);
    await page.getByTestId("download-trip").click();
    await assertText(status, /Downloaded and verified on this device \(\d+ items, checked /, 90_000);
    await assertText(page.locator("main"), /Your trip is downloaded and verified for offline use/);

    await page.getByTestId("verify-download").click();
    await assertText(page.locator("main"), /Everything is still on this device/);

    // A fresh visit re-verifies the cache and shows the server-side record.
    await page.reload();
    await assertText(page.getByTestId("download-status"), /Downloaded and verified on this device/, NAV);
    await assertText(page.locator("main"), /Last recorded download \(any device\): .+ — verified complete/);

    // The trip cache holds the hike + help pages and the bundle; never Mapbox.
    const cached = await page.evaluate(async (id) => {
      const out = [];
      for (const name of await caches.keys()) {
        if (!name.includes(id)) continue;
        for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname + "@" + new URL(req.url).host);
      }
      return out;
    }, tripId);
    for (const p of [`/trips/${tripId}/hike`, `/trips/${tripId}/help`, `/api/trips/${tripId}/bundle`]) {
      assert.ok(cached.some((c) => c.startsWith(p + "@")), `${p} is in the trip cache: ${cached.join(", ")}`);
    }
    assert.ok(!cached.some((c) => /mapbox/i.test(c)), "no Mapbox resources cached");

    // Narration audio is stored under stable keys (narration id + version), not the signed URL.
    const bundle = await (await ctx.request.get(`/api/trips/${tripId}/bundle`)).json();
    for (const item of bundle.manifest.items.filter((i) => i.kind === "audio")) {
      assert.match(item.cacheAs, /^\/__gg\/audio\/[0-9a-f-]{36}\/v\d+$/);
      assert.ok(cached.some((c) => c.startsWith(item.cacheAs + "@")), `audio stored under its stable key ${item.cacheAs}`);
    }
    // The download carries the booking details and permit status for offline use.
    assert.ok(bundle.logistics && Array.isArray(bundle.logistics.addons) && Array.isArray(bundle.logistics.permits), "bundle has booking logistics");

    // The trip dashboard reflects the verified download.
    await page.goto(`/trips/${tripId}`);
    await assertText(page.locator("main"), /Last download .+ — verified complete/);
    // Booked weeks ahead: the dashboard shows the booked date instead of offering "Start hike".
    await assertText(page.getByTestId("hike-actions-booked-date"), /Hike booked for \w{3}, \w{3} \d{1,2}, \d{4}/);
    assert.equal(await page.getByTestId("hike-actions-start").count(), 0, "no 'Start hike' for a hike weeks away");
  });

  await t.test("hike screen: limitations must be acknowledged; start with the demo GPS simulator (labeled as simulated)", async () => {
    await page.goto(`/trips/${tripId}/hike`, { timeout: NAV });
    await waitPhase(page, "ready");
    const main = page.locator("main");
    await assertText(main, /Downloaded and verified for offline use on this device/);
    await page.getByRole("heading", { name: /Before you start: what this web app can.t do/ }).waitFor();
    const start = page.getByTestId("hike-start");
    assert.ok(await start.isDisabled(), "Start is disabled until the limitations are acknowledged");
    await assertText(main, /Tick the box above to start/);
    // The ready screen shows the booked date; the trip is booked weeks ahead, so a real start must wait for that day.
    const booked = page.getByTestId("hike-booked-date");
    assert.match(await booked.innerText(), /^\w+day, \w+ \d{1,2}, \d{4}$/, "booked date shown in words");
    await assertText(page.getByTestId("hike-date-notice"), /You can start on \w{3}, \w{3} \d{1,2}\./);
    // Booking details (add-ons, permit status) are on the pre-start screen, from the download.
    await assertText(page.getByTestId("trip-logistics"), /Gear, shuttle & meals[\s\S]*Permits/);
    await page.getByTestId("limitations-ack").check();
    assert.ok(await start.isDisabled(), "Start stays disabled before the booked date");
    // Demo mode only: an explicit, labelled start-anyway.
    const demoStart = page.getByTestId("hike-start-demo");
    await assertText(page.getByTestId("hike-demo-start"), /Demo only/);
    assert.ok(await demoStart.isEnabled(), "Start anyway (demo) enabled after acknowledging");
    assert.equal((await demoStart.innerText()).trim(), "Start anyway (demo)");

    await page.getByTestId("sim-toggle").check();
    await page.getByTestId("sim-speedup").selectOption("10");
    await demoStart.click();
    await waitPhase(page, "active", UI);
    assert.ok(await page.locator("header").getByText("Simulated GPS").first().isVisible(), "the hike header labels simulated GPS");
    await assertText(page.getByTestId("hike-accuracy"), /± \d+ m/, UI);

    // The start reaches the server and is marked as simulated.
    await waitUntil(() => [...synced.events.values()].some((e) => e.kind === "start"), "start event synced", NAV);
    const startEvt = [...synced.events.values()].find((e) => e.kind === "start");
    assert.equal(startEvt.payload?.simulated, true, "start event is marked simulated");
    assert.ok([...synced.events.values()].some((e) => e.kind === "simulator_on"), "simulator_on event synced");
    assert.ok(synced.sessionIds.size === 1, "one server session");
    assert.match([...synced.sessionIds][0], UUID_RE);
    // Every sync carries the device's clock so the server can correct a wrong phone clock.
    assert.ok(synced.sentAt.length > 0 && synced.sentAt.every((t) => typeof t === "string" && !Number.isNaN(Date.parse(t))), "sync requests carry sentAt");
    // No check-in was set up, so the check-in / extend card is not shown.
    assert.equal(await page.getByTestId("hike-checkin").count(), 0, "no check-in card without a check-in");
  });

  await t.test("progress increases and the first story stop triggers by location with its transcript", async () => {
    const before = await progressPct(page);
    const transcript = page.getByTestId("narration-transcript");
    await transcript.waitFor({ timeout: SIM });
    const article = page.locator("article").filter({ has: transcript });
    await assertText(article, /Triggered by your location/);
    const t1 = (await transcript.innerText()).trim();
    assert.ok(t1.length > 40, "transcript text is shown");
    firstHeard.title = (await article.getByRole("heading").innerText()).trim();
    assert.ok(firstHeard.title, "story title shown");
    // The stop is listed as heard.
    const stops = page.getByRole("list", { name: "Stops on this route" });
    const heardItem = stops.locator("li").filter({ hasText: new RegExp(`Heard · ${firstHeard.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
    await heardItem.waitFor({ timeout: UI });
    firstHeard.name = (await heardItem.locator("p.font-semibold").first().innerText()).trim();
    await assertText(article, /Source: \S+/); // approved narration carries a cited source

    await waitUntil(async () => (await progressPct(page)) > before, "progress increases while walking", SIM);
    await waitUntil(async () => (await progressPct(page)) >= 3, "progress reaches a few percent", SIM);
  });

  await t.test("wandering off the route shows an off-route prompt the hiker can see without scrolling", async () => {
    // The hiker is further down the page (here: at the simulator panel) when they drift off route.
    await page.getByTestId("sim-detour").click();
    const prompt = page.getByTestId("deviation-prompt");
    await prompt.waitFor({ timeout: SIM });
    await sleep(500);
    const box = await prompt.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
    });
    assert.ok(box.bottom > 0 && box.top < box.vh, `off-route prompt should be in the viewport when it appears (rect top ${box.top}, bottom ${box.bottom}, viewport ${box.vh})`);
    assert.ok(await prompt.evaluate((el) => el === document.activeElement || el.contains(document.activeElement)), "focus moves to the off-route prompt");
    assert.equal(await prompt.getAttribute("aria-live"), "assertive");
  });

  await t.test("the off-route prompt is worded carefully and can be dismissed", async () => {
    const prompt = page.getByTestId("deviation-prompt");
    await prompt.waitFor({ timeout: SIM });
    assert.equal(await prompt.getAttribute("role"), "alert");
    const text = await prompt.innerText();
    assert.match(text, /You may be off the route/);
    assert.match(text, /about \d+ m from the planned route/);
    assert.match(text, /GPS can be wrong/);
    assert.match(text, /If you are lost, stay where you are/);
    assert.equal(await prompt.getByRole("link", { name: "Open Help" }).getAttribute("href"), `/trips/${tripId}/help`);
    // "Show route" respects reduced motion: the jump to the map is instant, not an animated scroll.
    await page.emulateMedia({ reducedMotion: "reduce" });
    try {
      await page.evaluate(() => window.scrollTo(0, 0));
      await prompt.getByRole("button", { name: "Show route" }).click();
      const y1 = await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(window.scrollY))));
      await sleep(800);
      const y2 = await page.evaluate(() => window.scrollY);
      // (small layout shifts from the live screen are tolerated; an animated scroll moves hundreds of px)
      assert.ok(y1 > 0 && Math.abs(y2 - y1) <= 40, `reduced motion: no animated scroll (scrollY ${y1} right after, ${y2} later)`);
    } finally {
      await page.emulateMedia({ reducedMotion: null });
    }
    await page.getByTestId("deviation-fine").click();
    await prompt.waitFor({ state: "detached", timeout: UI });
    await waitUntil(() => [...synced.events.values()].some((e) => e.kind === "deviation_prompt"), "deviation prompt event synced", NAV);
    await waitUntil(() => [...synced.events.values()].some((e) => e.kind === "deviation_dismissed" && e.payload?.reason === "fine"), "dismissal synced", NAV);
    for (const e of synced.events.values()) {
      assert.ok(!("lat" in (e.payload ?? {})) && !("lng" in (e.payload ?? {})), `event payloads carry no coordinates (${e.kind})`);
    }
    // Back on the route for the rest of the walk; the prompt stays dismissed.
    await page.getByRole("button", { name: "Return to route" }).click();
    await sleep(2000);
    assert.equal(await prompt.count(), 0, "dismissed prompt does not come straight back");
  });

  await t.test("offline: indicator shows Offline, queued items grow and \"I'm okay\" is saved on the device", async () => {
    await waitUntil(async () => (await queuedCount(page)) === 0, "queue empty before going offline", NAV);
    await ctx.setOffline(true);
    await assertText(page.getByTestId("hike-connection"), /Offline/);
    assert.ok(await page.locator("header").getByText("Offline").isVisible(), "header shows an Offline badge");

    await page.getByTestId("hike-ok").click();
    const ok = page.getByTestId("hike-ok-status");
    await assertText(ok, /"I'm okay" from .+ is saved on this device and will be sent when you're back online/);
    assert.equal(await ok.getAttribute("data-sent"), "false");

    const q1 = await waitUntil(async () => (await queuedCount(page)) || false, "items queue while offline", UI);
    await waitUntil(async () => (await queuedCount(page)) > q1, "queued count keeps growing while walking offline", SIM);
    await waitUntil(async () => !/just now/.test(await page.getByTestId("hike-last-sync").innerText()), "last sync ages while offline", UI);
  });

  await t.test("back online: the queue flushes, last sync updates and \"I'm okay\" is sent", async () => {
    const eventsBefore = synced.events.size;
    await ctx.setOffline(false);
    await assertText(page.getByTestId("hike-connection"), /Online/);
    await waitUntil(async () => (await queuedCount(page)) === 0, "queue flushes after reconnecting", NAV);
    await waitUntil(async () => /just now/.test(await page.getByTestId("hike-last-sync").innerText()), "last sync is 'just now'", NAV);
    // "Sent" only once the server acknowledged the tap (not merely because a sync happened).
    await assertText(page.getByTestId("hike-ok-status"), /"I'm okay" from .+ reached Ghost Guide/, NAV);
    assert.ok(synced.events.size > eventsBefore, "queued events were uploaded");
    assert.ok([...synced.events.values()].some((e) => e.kind === "checkin_ok"), "the I'm okay tap reached the server");
  });

  await t.test("reloading mid-hike restores the hike from the device", async () => {
    const pct = await progressPct(page);
    assert.ok(pct > 0, "some progress before the reload");
    await page.reload({ timeout: NAV });
    await waitPhase(page, "active");
    const after = await progressPct(page);
    // State is saved on the device as you go and synchronously when the page unloads: progress never goes backwards.
    assert.ok(after > 0 && after >= pct - 1, `progress restored, not reset (before ${pct}%, after ${after}%)`);
    assert.ok(await page.getByTestId("sim-toggle").isChecked(), "simulator setting restored");
    const stops = page.getByRole("list", { name: "Stops on this route" });
    await assertText(stops.locator("li").filter({ hasText: firstHeard.name }), /Heard/);
    // The server agrees the hike is in progress.
    const res = await ctx.request.get(`/api/trips/${tripId}/bundle`);
    const b = await res.json();
    assert.equal(b.trip.status, "active");
    assert.equal(b.session?.status, "active");
  });

  await t.test("a story played right before a reload stays heard (the device does not forget it and replay it)", async () => {
    const stops = page.getByRole("list", { name: "Stops on this route" });
    const upcoming = stops.locator("li").filter({ hasText: /Upcoming · / }).first();
    await upcoming.waitFor({ timeout: UI });
    const name = (await upcoming.locator("p.font-semibold").first().innerText()).trim();
    await upcoming.getByRole("button", { name: /^Play / }).click();
    const article = page.locator("article").filter({ has: page.getByTestId("narration-transcript") });
    await assertText(article, /Played by you/);
    await assertText(stops.locator("li").filter({ hasText: name }), /Heard/);
    // Reload straight away (e.g. the hiker refreshes because audio did not start, or opens Help and comes back).
    await page.reload({ timeout: NAV });
    await waitPhase(page, "active");
    await assertText(
      page.getByRole("list", { name: "Stops on this route" }).locator("li").filter({ hasText: name }),
      /Heard/,
      5_000,
    );
  });

  await t.test("offline full-page reloads of the hike and help screens are served from the downloaded trip", async () => {
    await waitUntil(async () => (await queuedCount(page)) === 0, "queue empty", NAV);
    await ctx.setOffline(true);
    const res = await page.reload({ timeout: NAV });
    assert.ok(res, "offline reload produced a response");
    assert.ok(res.ok(), `offline hike page response: ${res.status()}`);
    assert.ok(res.fromServiceWorker(), "the offline hike page was answered by the service worker");
    await waitPhase(page, "active");
    assert.ok(!(await page.locator("body").innerText()).includes("You're offline\nThis page isn't saved"), "not the generic offline page");
    await assertText(page.getByTestId("hike-connection"), /Offline/);
    const stops = page.getByRole("list", { name: "Stops on this route" });
    await assertText(stops.locator("li").filter({ hasText: firstHeard.name }), /Heard/);

    // Help via the bottom bar (a full page load), still offline.
    await Promise.all([
      page.waitForURL(new RegExp(`/trips/${tripId}/help$`), { timeout: NAV }),
      page.getByRole("link", { name: "Help", exact: true }).click(),
    ]);
    await page.getByRole("heading", { level: 1, name: `Need help on ${TRAIL_NAME}?` }).waitFor({ timeout: NAV });
    const coords = page.getByTestId("help-coords");
    await coords.waitFor({ timeout: UI });
    assert.match(await coords.innerText(), /^4\d\.\d{6}, -12\d\.\d{6}$/);
    const main = page.locator("main");
    const text = await main.innerText();
    assert.match(text, /accuracy ± \d+ m \((good|fair)\)/, "accuracy shown");
    assert.match(text, /recorded \d{1,2}:\d{2}:\d{2} [AP]M/, "timestamp shown");
    assert.match(text, /saved on this device/);
    assert.match(text, /You're offline — this page is working from your downloaded trip/);
    assert.equal(await page.getByTestId("help-call").getAttribute("href"), "tel:911");
    assert.match(text, /Call 911 if you have any signal/);
    assert.match(text, /try texting 911/);
    assert.match(text, /Ghost Guide cannot send an SOS/);
    assert.match(text, /If you are lost, stay where you are/);
    assert.match(text, /cannot see your location in real time/);
    assert.match(text, /cannot contact 911, Search and Rescue or anyone else for you/);
    assert.doesNotMatch(text, /help is on the way|we will (alert|notify) (rescue|911|search)/i, "no rescue over-claims");
    // Booking details (add-ons, permit status) are available offline on the help screen.
    await assertText(page.getByTestId("trip-logistics"), /Gear, shuttle & meals[\s\S]*No add-ons on this booking[\s\S]*Permits/);

    // A full reload of help while offline still works.
    await page.reload({ timeout: NAV });
    await page.getByTestId("help-coords").waitFor({ timeout: UI });
    assert.equal(await page.getByTestId("help-call").getAttribute("href"), "tel:911");

    // The installed app's start page (/trips) is not cached: the offline fallback lists the downloaded trip.
    await page.goto("/trips", { timeout: NAV });
    await page.getByRole("heading", { level: 1, name: "You're offline" }).waitFor({ timeout: NAV });
    const item = page.locator("li").filter({ hasText: TRAIL_NAME }).filter({ has: page.getByRole("link", { name: "Hike screen" }) });
    await item.waitFor({ timeout: UI });
    const itemText = await item.innerText();
    assert.doesNotMatch(itemText, /\d{4}-\d{2}-\d{2}/, `date is formatted, not raw ISO: ${itemText}`);
    assert.match(itemText, /\w{3}, \w{3} \d{1,2}, \d{4}/);
    assert.equal(await item.getByRole("link", { name: "Hike screen" }).getAttribute("href"), `/trips/${tripId}/hike`);
    assert.equal(await item.getByRole("link", { name: "Help" }).getAttribute("href"), `/trips/${tripId}/help`);
    assert.equal(await page.getByRole("link", { name: "Call 911" }).getAttribute("href"), "tel:911");
    await Promise.all([page.waitForURL(new RegExp(`/trips/${tripId}/help$`), { timeout: NAV }), item.getByRole("link", { name: "Help" }).click()]);
    await page.getByTestId("help-coords").waitFor({ timeout: UI });

    // Back to the hike screen (offline) and tap "I'm okay" there again.
    await Promise.all([
      page.waitForURL(new RegExp(`/trips/${tripId}/hike$`), { timeout: NAV }),
      page.getByRole("link", { name: "Back to the hike screen" }).click(),
    ]);
    await waitPhase(page, "active");
    await page.getByTestId("hike-ok").click();
    await assertText(page.getByTestId("hike-ok-status"), /will be sent when you're back online/);
    await ctx.setOffline(false);
    await assertText(page.getByTestId("hike-ok-status"), /reached Ghost Guide/, NAV);
    await waitUntil(async () => (await queuedCount(page)) === 0, "queue flushes again", NAV);
  });

  await t.test("finish → server confirms → completion summary → feedback", async () => {
    await page.getByTestId("hike-finish").click();
    const dialog = page.getByRole("dialog", { name: "Finish your hike?" });
    await dialog.waitFor({ timeout: UI });
    await assertText(dialog, /any check-in reminders for this trip stop too/);
    await Promise.all([
      page.waitForURL(new RegExp(`/trips/${tripId}/complete$`), { timeout: NAV }),
      page.getByTestId("hike-finish-confirm").click(),
    ]);
    const main = page.locator("main");
    await page.getByRole("heading", { level: 1, name: new RegExp(`Nice work on ${TRAIL_NAME}`) }).waitFor({ timeout: NAV });
    const text = await main.innerText();
    // (stat labels are upper-cased by CSS, so match case-insensitively)
    assert.match(text, /Distance along route\s*\n?\s*[\d.]+ mi/i);
    assert.match(text, /Moving time\s*\n?\s*\d+ (min|h)/i);
    const heardCount = Number(text.match(/Stories heard\s*\n?\s*(\d+)/i)?.[1]);
    assert.ok(heardCount >= 1, `at least one story heard (got ${heardCount})`);
    assert.ok(text.includes(firstHeard.name), `the triggered stop (${firstHeard.name}) is listed`);

    // Each story stop was auto-triggered at most once in this session.
    const triggers = [...synced.events.values()].filter((e) => e.kind === "poi_triggered");
    assert.ok(triggers.length >= 1, "at least one GPS trigger uploaded");
    const perPoi = new Map();
    for (const e of triggers) perPoi.set(e.payload.poiId, (perPoi.get(e.payload.poiId) ?? 0) + 1);
    for (const [poi, n] of perPoi) assert.equal(n, 1, `stop ${poi} auto-triggered exactly once (got ${n})`);
    assert.ok([...synced.events.values()].some((e) => e.kind === "finish"), "finish event uploaded");

    // Feedback.
    await page.getByRole("heading", { name: "Tell us how it went" }).waitFor();
    await page.locator("label").filter({ has: page.locator('input[name="rating"][value="4"]') }).click();
    await page.getByRole("checkbox", { name: "Battery drained quickly" }).check();
    await page.getByLabel("Comments (optional)").fill(`QA hike ${run}: stories were great.`);
    await page.getByRole("button", { name: "Send feedback" }).click();
    await assertText(main, /Thank you!/, NAV);
    await page.reload();
    await page.getByRole("heading", { name: "Thanks for your feedback" }).waitFor({ timeout: NAV });
    await assertText(page.locator("main"), /You rated this hike 4 of 5/);
    assert.ok(await page.getByRole("checkbox", { name: "Battery drained quickly" }).isChecked(), "issue remembered");
    assert.equal(await page.getByLabel("Comments (optional)").inputValue(), `QA hike ${run}: stories were great.`);
  });

  await t.test("after finishing: trip shows completed; the hike screen shows it finished; a restart is refused", async () => {
    await page.goto(`/trips/${tripId}`, { timeout: NAV });
    await page.getByRole("heading", { name: "Your hike", exact: true }).waitFor({ timeout: UI });
    await assertText(page.locator("main"), /Hike summary \(you rated it 4\/5\)/);
    await page.goto(`/trips/${tripId}/hike`, { timeout: NAV });
    await waitPhase(page, "finished");
    await assertText(page.locator("main"), /Your finish reached Ghost Guide/);
    const start = await ctx.request.post("/api/hike/start", { data: { tripId, demoStartAnyway: true } });
    assert.equal(start.status(), 409, "a completed trip cannot be started again");

    // The offline fallback no longer offers the finished trip.
    await ctx.setOffline(true);
    try {
      await page.goto("/trips", { timeout: NAV });
      await page.getByRole("heading", { level: 1, name: "You're offline" }).waitFor({ timeout: NAV });
      await assertText(page.locator("main"), /No downloaded trips on this device|Call 911/);
      await sleep(500);
      assert.equal(await page.locator("li").filter({ hasText: TRAIL_NAME }).count(), 0, "finished trip not listed offline");
    } finally {
      await ctx.setOffline(false);
    }
  });

  await t.test("no unexpected console errors during the journey", async () => {
    assert.deepEqual(pageErrors, [], `console errors:\n${pageErrors.join("\n")}`);
  });

  await t.test("after signing out, this browser no longer shows the hiker's trip or location to the next person", async () => {
    // Sign out the way the header's "Sign out" button does (a form POST navigation): the sign-out
    // page wipes this device's trip data and the service worker's trip caches, then goes home.
    await page.goto("/trips", { timeout: NAV });
    await Promise.all([
      page.waitForURL((u) => new URL(u).pathname === "/", { timeout: NAV }),
      page.evaluate(() => {
        const f = document.createElement("form");
        f.method = "post";
        f.action = "/auth/logout";
        document.body.append(f);
        f.submit();
      }),
    ]);
    await sleep(500);
    assert.equal((await ctx.request.get(`/api/trips/${tripId}/bundle`)).status(), 401, "signed out");
    assert.equal(await page.evaluate(() => document.cookie.includes("gg_owner=")), false, "device owner tag cleared");
    for (const sub of ["help", "hike"]) {
      await page.goto(`/trips/${tripId}/${sub}`, { timeout: NAV });
      await sleep(1500); // let the page read on-device data if it renders
      const url = new URL(page.url());
      const coords = await page.getByTestId("help-coords").count();
      // A cached copy may still open, but only to ask for sign-in: never with the previous hiker's trip.
      const hikePhase = await page.getByTestId("hike-app").getAttribute("data-phase", { timeout: 1000 }).catch(() => null);
      const hikeShown = hikePhase !== null && hikePhase !== "no_bundle" && hikePhase !== "loading";
      const text = await page.locator("main").innerText().catch(() => "");
      assert.ok(
        url.pathname.startsWith("/login") || (coords === 0 && !hikeShown && /Sign in again to use this trip offline/.test(text)),
        `/trips/<id>/${sub} after sign-out should ask to sign in, not show the previous hiker's data (url ${url.pathname}, coordinates shown: ${coords > 0}, hike phase: ${hikePhase})`,
      );
    }
    // Nothing of the trip is left on the device.
    const left = await page.evaluate(async (id) => {
      const cacheNames = (await caches.keys()).filter((n) => n.startsWith("gg-trip-"));
      const mirror = Object.keys(localStorage).filter((k) => k.startsWith("gg-hike-"));
      const dbs = (await indexedDB.databases?.()) ?? [];
      let bundles = 0;
      if (dbs.some((d) => d.name === "ghostguide")) {
        bundles = await new Promise((resolve) => {
          const open = indexedDB.open("ghostguide");
          open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains("bundles")) return resolve(0);
            const r = db.transaction("bundles").objectStore("bundles").count();
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => resolve(-1);
          };
          open.onerror = () => resolve(-1);
        });
      }
      return { cacheNames, mirror, bundles, id };
    }, tripId);
    assert.deepEqual(left.cacheNames, [], "trip caches removed after sign-out");
    assert.deepEqual(left.mirror, [], "hike state mirror removed after sign-out");
    assert.equal(left.bundles, 0, "downloaded bundles removed after sign-out");
  });
});
