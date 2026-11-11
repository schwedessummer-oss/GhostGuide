/**
 * Admin slice — end-to-end spec (node:test + Playwright).
 *
 * Covers:
 *  - every /admin page (incl. trail edit sub-pages and detail pages) loads for admin@ with
 *    no error boundary, no console errors and no horizontal scrolling at 390 px;
 *  - RBAC: signed-out → login (with the deep link kept), a customer gets /forbidden,
 *    support@ cannot open pricing / safety and never sees restricted contacts or coordinates,
 *    admin@ can reveal them only through the audited break-glass form, operator@ cannot
 *    manage flags / staff, editor@ can approve in-review narration only once a source is set;
 *  - a closure created in admin shows on the public trail page and removes the trail from
 *    /plan results; ending it restores both;
 *  - GeoJSON route upload: a valid file (built from the trail's seeded geometry, fetched
 *    through the owner's offline bundle) validates and activates; an invalid one shows its
 *    errors and offers no activation;
 *  - a pricing-rule edit updates the live preview and the customer's checkout quote;
 *  - the addon_meal_pack flag hides the add-on at checkout and is audit-logged;
 *  - a dead job is re-queued from /admin/jobs and then runs;
 *  - marketing draft: generate (simulated weather labeled with its fetched time), submit,
 *    approve, mark published;
 *  - staff role grant + revoke (takes effect on the next request), the last admin role
 *    cannot be removed (even from a stale page), and the audit log records all of it;
 *  - admin action confirmations stay announced (aria-live) after the page re-renders.
 *
 * Independence: the spec signs up its own customer (unique email per run), mutates only
 * trails no other spec mutates (Hollow Pine Ridge, Miner's Meadow Loop), scopes its pricing
 * rule to one trail, re-activates IDENTICAL route coordinates (same geometry checksum), and
 * restores every global change (flags, closure, rule, roles, narration) in `after` even
 * when a test fails. The seeded in-review narration is only used for the refusal path
 * (nothing is approved on it); the approval itself runs on a narration this spec creates.
 *
 * Notes on the app's rendering that the helpers account for:
 *  - admin pages stream behind `src/app/admin/loading.tsx`; React reveals the real content
 *    shortly AFTER the `load` event, so every navigation waits for the page's <h1>;
 *  - admin forms are server actions; `submit()` waits for the action POST to finish;
 *  - audit metadata is jsonb (key order is not preserved), so it is parsed, not regex-matched.
 *
 * Run: E2E_BASE_URL=http://localhost:3205 E2E_CRON_SECRET=… node --test tests/e2e/specs/admin.spec.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { BASE, login, newBrowser, runJobs } from "../helpers.mjs";

const TZ = "America/Los_Angeles";
const ADMIN = "admin@demo.ghostguide.test";
const SUPPORT = "support@demo.ghostguide.test";
const OPERATOR = "operator@demo.ghostguide.test";
const EDITOR = "editor@demo.ghostguide.test";
const HIKER = "hiker@demo.ghostguide.test"; // seeded with emergency contacts
const HIKER2 = "hiker2@demo.ghostguide.test"; // seeded with a completed Hollow Pine Ridge trip
const CLOSE_TRAIL = { slug: "hollow-pine-ridge", name: "Hollow Pine Ridge" };
const PRICE_TRAIL = { slug: "miners-meadow-loop", name: "Miner's Meadow Loop" };
const SEEDED_NARRATION = "Creek insects (draft)";
const CUSTOMER_PASSWORD = "qa-admin-pass-123";
const NAV = 30_000;
const UI = 15_000;

const run = randomUUID().slice(0, 8);
let ipCounter = 1;
const fakeIp = () => `10.${(parseInt(run.slice(0, 2), 16) % 250) + 1}.${(parseInt(run.slice(2, 4), 16) % 250) + 1}.${100 + (ipCounter++ % 150)}`;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function regionToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dow = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
function nextDow(iso, target) {
  let d = iso;
  while (dow(d) !== target) d = addDays(d, 1);
  return d;
}
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function cents(text) {
  const t = text.replace(/\s/g, "");
  const neg = /^[-−]/.test(t);
  const n = Math.round(Number(t.replace(/[^0-9.]/g, "")) * 100);
  return neg ? -n : n;
}

async function newCtx(browser, viewport = { width: 1280, height: 900 }) {
  return browser.newContext({ viewport, baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": fakeIp() } });
}

function watchErrors(page) {
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${page.url()} :: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror ${page.url()} :: ${e.message}`));
  return errors;
}

/** Wait until the streamed page content (not the route's loading fallback) is shown. */
async function ready(page) {
  await page.locator("main h1").first().waitFor({ timeout: NAV });
  await page.getByRole("status").filter({ hasText: /^\s*Loading…\s*$/ }).first().waitFor({ state: "detached", timeout: NAV }).catch(() => {});
  const boundary = page.getByRole("heading", { level: 1, name: "This admin page could not load" });
  if (await boundary.count()) {
    const detail = await boundary.locator("xpath=..").innerText().catch(() => "");
    assert.fail(`${new URL(page.url()).pathname} rendered the admin error boundary (server error): ${detail.replace(/\s+/g, " ").trim()}`);
  }
}

async function gotoOk(page, path) {
  const res = await page.goto(path, { timeout: NAV });
  assert.ok(res, `no response for ${path}`);
  assert.ok(res.status() < 400, `${path} -> HTTP ${res.status()}`);
  await ready(page);
  return res;
}

async function reloadReady(page) {
  await page.reload({ timeout: NAV });
  await ready(page);
}

async function staffPage(browser, email, viewport) {
  const ctx = await newCtx(browser, viewport);
  const page = await ctx.newPage();
  await login(page, email);
  return { ctx, page };
}

async function signUp(page, label) {
  const email = `qa-admin-${label}-${run}-${Date.now()}@example.test`;
  await page.goto("/signup");
  await page.getByLabel("Full name").fill(`QA Admin ${label} ${run}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(CUSTOMER_PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: NAV }),
    page.getByRole("button", { name: "Create account" }).click(),
  ]);
  return email;
}

/** Waits until some element matched by `locator` contains `re`; fails with what is there. */
async function assertText(locator, re, timeout = UI) {
  await locator
    .filter({ hasText: re })
    .first()
    .waitFor({ timeout })
    .catch(async () => {
      const actual = await locator.first().innerText({ timeout: 2_000 }).catch(() => "<no element>");
      assert.fail(`Expected ${re} in:\n${actual.slice(0, 2500)}`);
    });
}

/**
 * A status badge (or any element) whose text is exactly `text`. (Playwright matches `hasText`
 * against textContent, where adjacent table cells run together, so `\b` regexes are unreliable.)
 */
async function badge(scope, text, timeout = UI) {
  await scope
    .getByText(text, { exact: true })
    .first()
    .waitFor({ timeout })
    .catch(async () => assert.fail(`Expected a "${text}" badge in:\n${(await scope.first().innerText({ timeout: 2_000 }).catch(() => "<no element>")).slice(0, 1500)}`));
}

/** The page's AdminHeader (title + status badge). */
const pageHeader = (page) => page.locator("main header").filter({ has: page.locator("h1") }).first();

const isActionPost = (r) => r.request().method() === "POST" && Boolean(r.request().headers()["next-action"]);

/**
 * Click a server-action submit button inside `scope` and wait for the action round trip
 * (the POST and React's commit of its result). Returns once the page has settled.
 */
async function submit(scope, buttonName) {
  const page = scope.page();
  const button = scope.getByRole("button", { name: buttonName, exact: true }).first();
  await button.waitFor({ timeout: UI });
  const [res] = await Promise.all([page.waitForResponse(isActionPost, { timeout: NAV }), button.click()]);
  // (Response.finished() never resolves for streamed action responses; the form's aria-busy
  // flag drops once React has committed the action result and the refreshed page.)
  await page.waitForFunction(() => !document.querySelector('form[aria-busy="true"]'), null, { timeout: NAV }).catch(() => {});
  await page.waitForTimeout(150);
  return res;
}

/** An aria-live form result (role=status) somewhere on the page that matches `re`. */
async function expectStatus(page, re, timeout = UI) {
  await page
    .getByRole("status")
    .filter({ hasText: re })
    .first()
    .waitFor({ timeout })
    .catch(async () => {
      const all = (await page.getByRole("status").allInnerTexts().catch(() => [])).map((s) => s.trim()).filter(Boolean);
      assert.fail(`Expected a status message matching ${re}; status regions on the page: ${JSON.stringify(all)}`);
    });
}

/** Submit a form whose result stays on screen and expect its confirmation / error message. */
async function submitAndExpect(scope, buttonName, re, timeout = UI) {
  await submit(scope, buttonName);
  await expectStatus(scope.page(), re, timeout);
}

async function expectForbidden(page, path) {
  await page.goto(path, { timeout: NAV });
  await page.waitForURL((u) => u.pathname === "/forbidden", { timeout: NAV }).catch(() => assert.fail(`${path} should redirect to /forbidden, got ${page.url()}`));
  await assertText(page.locator("main"), /You don't have access to this page/);
}

/** Admin trail id from the admin trails list. */
async function adminTrailId(page, name) {
  await gotoOk(page, "/admin/trails");
  const href = await page.getByRole("link", { name, exact: true }).first().getAttribute("href", { timeout: UI });
  assert.match(href, /^\/admin\/trails\/[0-9a-f-]{36}$/);
  return href.split("/").pop();
}

function planUrl(date, slug) {
  const q = new URLSearchParams({ experience: "some", fitness: "moderate", pace: "steady", hours: "8", date, start: "08:30", party: "2", trail: slug });
  return `/plan/results?${q}`;
}

/**
 * Audit rows for the given filters, newest first, parsed from /admin/audit:
 * { action, actor, entityType, entityId, metadata }.
 */
async function auditRows(page, filters) {
  const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
  await gotoOk(page, `/admin/audit?${q}`);
  await page.getByRole("table", { name: "Audit entries, newest first" }).or(page.getByText("No audit entries match.")).first().waitFor({ timeout: UI });
  return page.locator("main table tbody tr").evaluateAll((trs) =>
    trs.map((tr) => {
      const td = [...tr.querySelectorAll("td")];
      const entityId = td[3]?.querySelector(".font-mono")?.textContent?.trim() ?? null;
      const entityType = (td[3]?.textContent ?? "").replace(entityId ?? "", "").trim();
      let metadata = null;
      try {
        metadata = JSON.parse(td[4]?.textContent ?? "null");
      } catch {
        metadata = td[4]?.textContent ?? null;
      }
      return { action: td[1]?.textContent?.trim(), actor: td[2]?.textContent?.trim() ?? "", entityType, entityId, metadata };
    }),
  );
}
const fmtRows = (rows) => rows.map((r) => `${r.action} ${r.actor} ${r.entityType}:${r.entityId} ${JSON.stringify(r.metadata)}`).join("\n");

async function readQuote(page, tableName = "Price quote") {
  const table = page.getByRole("table", { name: tableName });
  await table.waitFor({ timeout: UI });
  const rows = await table.locator("tbody tr").evaluateAll((trs) =>
    trs.map((tr) => {
      const th = tr.querySelector("th");
      const td = tr.querySelector("td");
      const sub = th?.querySelector("span")?.textContent ?? "";
      return { label: (th?.textContent ?? "").replace(sub, "").trim(), amount: (td?.textContent ?? "").trim() };
    }),
  );
  return rows.filter((r) => r.label !== "Total").map((r) => ({ label: r.label, cents: cents(r.amount) }));
}

/** Select the <option> whose text starts with `prefix`. */
async function selectByTextStart(select, prefix) {
  const value = await select.locator("option").evaluateAll((os, p) => os.find((o) => o.textContent.trim().startsWith(p))?.value ?? null, prefix);
  assert.ok(value, `no option starting with "${prefix}"`);
  await select.selectOption(value);
}

/** Save a trip for `trail` from the personalized results and return its id. */
async function saveTrip(page, trail, date) {
  await gotoOk(page, planUrl(date, trail.slug));
  const save = page.getByRole("button", { name: `Save this trip (${trail.name})` }).first();
  await save.waitFor({ timeout: NAV });
  await Promise.all([page.waitForURL(/\/trips\/[0-9a-f-]{36}$/, { timeout: NAV }), save.click()]);
  return new URL(page.url()).pathname.split("/").pop();
}

async function openCheckout(page, tripId, { date, party = 2, addons = "" }) {
  const q = new URLSearchParams({ date, party: String(party) });
  if (addons) q.set("addons", addons);
  await gotoOk(page, `/trips/${tripId}/checkout?${q}`);
  await page.getByRole("table", { name: "Price quote" }).getByText(`Self-guided experience × ${party}`).waitFor({ timeout: UI });
}

/** Seeded route coordinates for Hollow Pine Ridge: via hiker2's offline bundle, else psql (only against E2E_DATABASE_URL). */
async function seededGeometry(browser) {
  try {
    const { ctx, page } = await staffPage(browser, HIKER2);
    try {
      await gotoOk(page, "/trips");
      const href = await page.locator('main a[href^="/trips/"]').filter({ hasText: CLOSE_TRAIL.name }).first().getAttribute("href", { timeout: UI });
      const res = await ctx.request.get(`/api/trips/${href.split("/")[2]}/bundle`);
      if (res.ok()) {
        const b = await res.json();
        const g = typeof b.geometryJson === "string" ? JSON.parse(b.geometryJson) : b.geometry;
        if (g?.type === "LineString" && g.coordinates?.length > 1) return g;
      }
    } finally {
      await ctx.close();
    }
  } catch {
    /* fall back to psql */
  }
  const url = process.env.E2E_DATABASE_URL;
  assert.ok(url, "the offline bundle did not return geometry and E2E_DATABASE_URL is not set for the psql fallback");
  const r = spawnSync("psql", [url, "-Atc", `select geometry::text from public.trails where slug = '${CLOSE_TRAIL.slug}'`], { encoding: "utf8" });
  assert.equal(r.status, 0, `psql fallback failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

// ---------------------------------------------------------------------------
// fixtures + cleanup registry
// ---------------------------------------------------------------------------
let browser;
let admin; // desktop admin page
let adminErrors;
let customerCtx;
let customer;
let customerEmail;
const cleanups = []; // [label, async fn(adminPage)]
const today = regionToday();

before(async () => {
  browser = await newBrowser();
  ({ page: admin } = await staffPage(browser, ADMIN));
  adminErrors = watchErrors(admin);
  customerCtx = await newCtx(browser, { width: 390, height: 844 });
  customer = await customerCtx.newPage();
  customerEmail = await signUp(customer, "cust");
});

after(async () => {
  // Restore global state even if tests failed (other slice specs share this database).
  for (const [label, fn] of cleanups.reverse()) {
    try {
      await fn(admin);
    } catch (err) {
      console.error(`cleanup "${label}" failed: ${err.message}`);
    }
  }
  await browser?.close();
});

// ---------------------------------------------------------------------------
// 1. Every admin page loads for admin@
// ---------------------------------------------------------------------------
test("every /admin page loads for admin@ (mobile 390px): no error boundary, no console errors, no horizontal scroll", { timeout: 300_000 }, async () => {
  const { ctx, page } = await staffPage(browser, ADMIN, { width: 390, height: 844 });
  const errors = watchErrors(page);
  try {
    const trailId = await adminTrailId(page, CLOSE_TRAIL.name);
    const paths = [
      ["/admin", "Overview"],
      ["/admin/trails", "Trails"],
      ["/admin/trails/new", "New draft trail"],
      [`/admin/trails/${trailId}`, CLOSE_TRAIL.name],
      [`/admin/trails/${trailId}/geometry`, CLOSE_TRAIL.name],
      [`/admin/trails/${trailId}/sources`, CLOSE_TRAIL.name],
      [`/admin/trails/${trailId}/closures`, CLOSE_TRAIL.name],
      [`/admin/trails/${trailId}/pois`, CLOSE_TRAIL.name],
      [`/admin/trails/${trailId}/permits`, CLOSE_TRAIL.name],
      ["/admin/content", "Narration review"],
      ["/admin/customers", "Customers"],
      ["/admin/bookings", "Bookings"],
      ["/admin/gear", "Gear lockers"],
      ["/admin/fulfillment", "Partner fulfillment"],
      ["/admin/safety", "Safety monitor"],
      ["/admin/notifications", "Notification delivery log"],
      ["/admin/jobs", "Jobs & integrations"],
      ["/admin/pricing", "Pricing"],
      ["/admin/availability", "Availability"],
      ["/admin/flags", "Feature flags"],
      ["/admin/marketing", "Marketing drafts"],
      ["/admin/permits", "Permits"],
      ["/admin/support", "Support tickets"],
      ["/admin/staff", "Staff roles"],
      ["/admin/audit", "Audit log"],
    ];
    const visit = async (path, h1) => {
      await gotoOk(page, path);
      if (h1) await page.getByRole("heading", { level: 1, name: h1 }).first().waitFor({ timeout: UI });
      assert.equal(await page.getByText("This admin page could not load").count(), 0, `${path} rendered the admin error boundary`);
      const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      assert.ok(sw <= iw, `${path} scrolls horizontally at 390px (${sw} > ${iw})`);
    };
    for (const [path, h1] of paths) await visit(path, h1);

    // Detail pages reached through the lists.
    for (const [list, sel] of [
      ["/admin/bookings", 'main a[href^="/admin/bookings/"]'],
      ["/admin/customers", 'main a[href^="/admin/customers/"]'],
      ["/admin/content", 'main a[href^="/admin/content/"]'],
      ["/admin/support", 'main a[href^="/admin/support/"]'],
    ]) {
      await gotoOk(page, list);
      const link = page.locator(sel).first();
      if (list === "/admin/support" && !(await link.count())) continue; // tickets may be handled inline
      await link.waitFor({ timeout: UI });
      await visit(await link.getAttribute("href"));
    }

    // Mobile admin menu exposes every section to an admin.
    await gotoOk(page, "/admin");
    await page.getByText("Admin menu").click();
    const nav = page.getByRole("navigation", { name: "Admin sections" }).first();
    for (const label of ["Overview", "Safety monitor", "Bookings", "Trails", "Pricing", "Jobs & integrations", "Feature flags", "Staff roles", "Audit log"]) {
      await nav.getByRole("link", { name: label, exact: true }).waitFor({ timeout: UI });
    }
    // Simulated integrations are labeled on the overview.
    await assertText(page.locator("main"), /Integration status/);
    await assertText(page.locator("main"), /Simulated/);
    assert.deepEqual(errors, [], `console errors:\n${errors.join("\n")}`);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 2. RBAC
// ---------------------------------------------------------------------------
test("RBAC: signed-out → login, customers get /forbidden, support@ and operator@ are limited to their permissions", { timeout: 240_000 }, async (t) => {
  await t.test("signed-out visitor is sent to login and returned to the page they asked for", async () => {
    const ctx = await newCtx(browser);
    const page = await ctx.newPage();
    try {
      await page.goto("/admin/pricing");
      await page.waitForURL((u) => u.pathname === "/login", { timeout: NAV });
      assert.equal(new URL(page.url()).searchParams.get("next"), "/admin/pricing", "the deep link must survive the login redirect");
    } finally {
      await ctx.close();
    }
  });

  await t.test("a customer gets /forbidden for /admin and admin sub-pages", async () => {
    await expectForbidden(customer, "/admin");
    await expectForbidden(customer, "/admin/pricing");
    await expectForbidden(customer, "/admin/customers");
  });

  await t.test("support@ cannot open pricing/safety/flags and never sees contacts or coordinates", async () => {
    const { ctx, page } = await staffPage(browser, SUPPORT);
    const errors = watchErrors(page);
    try {
      await gotoOk(page, "/admin");
      await page.getByRole("heading", { level: 1, name: "Overview" }).waitFor({ timeout: UI });
      const nav = page.getByRole("navigation", { name: "Admin sections" }).last();
      for (const label of ["Customers", "Bookings", "Support"]) await nav.getByRole("link", { name: label, exact: true }).waitFor({ timeout: UI });
      for (const label of ["Pricing", "Safety monitor", "Notifications", "Feature flags", "Staff roles", "Audit log", "Jobs & integrations"]) {
        assert.equal(await nav.getByRole("link", { name: label, exact: true }).count(), 0, `support@ should not see "${label}" in the admin menu`);
      }
      for (const p of ["/admin/pricing", "/admin/safety", "/admin/notifications", "/admin/flags", "/admin/staff", "/admin/audit"]) await expectForbidden(page, p);

      // Customer detail: restricted, no reveal control, no phone numbers / precise coordinates in the page.
      await gotoOk(page, `/admin/customers?q=${encodeURIComponent(HIKER)}`);
      const link = page.locator('main a[href^="/admin/customers/"]').first();
      await link.waitFor({ timeout: UI });
      await Promise.all([page.waitForURL(/\/admin\/customers\/[0-9a-f-]{36}$/, { timeout: NAV }), link.click()]);
      await ready(page);
      await assertText(page.locator("main"), /emergency contacts and precise location are visible to safety staff and admins only/);
      assert.equal(await page.getByRole("button", { name: "Show restricted details" }).count(), 0, "support@ must not get a reveal button");
      const text = await page.locator("main").innerText();
      assert.doesNotMatch(text, /-?\d{2,3}\.\d{4,}/, "no precise coordinates on the customer page for support@");
      assert.doesNotMatch(text, /\+?\d[\d\s().-]{8,}\d/, "no phone numbers on the customer page for support@");
      assert.deepEqual(errors, [], `console errors:\n${errors.join("\n")}`);
    } finally {
      await ctx.close();
    }
  });

  await t.test("admin@ (safety.sensitive) reveals the same customer's contacts only with a reason, and the access is audited", async () => {
    await gotoOk(admin, `/admin/customers?q=${encodeURIComponent(HIKER)}`);
    const link = admin.locator('main a[href^="/admin/customers/"]').first();
    await link.waitFor({ timeout: UI });
    await Promise.all([admin.waitForURL(/\/admin\/customers\/[0-9a-f-]{36}$/, { timeout: NAV }), link.click()]);
    await ready(admin);
    const customerId = admin.url().split("/").pop();
    const reason = `QA admin spec ${run}: verifying audited access`;
    await admin.getByLabel("Reason for access (recorded in the audit log)").fill(reason);
    await submitAndExpect(admin.locator("main"), "Show restricted details", /This access was recorded in the audit log/);
    await assertText(admin.locator("main"), /Emergency contacts/);
    const rows = await auditRows(admin, { action: "customer.view_emergency_contacts", entityId: customerId });
    assert.ok(rows.some((r) => r.actor.includes(ADMIN) && r.metadata?.reason === reason), `audited reveal missing:\n${fmtRows(rows)}`);
  });

  await t.test("operator@ cannot manage flags, staff, pricing or the audit log, but can run jobs", async () => {
    const { ctx, page } = await staffPage(browser, OPERATOR);
    try {
      await gotoOk(page, "/admin");
      const nav = page.getByRole("navigation", { name: "Admin sections" }).last();
      await nav.getByRole("link", { name: "Jobs & integrations", exact: true }).waitFor({ timeout: UI });
      for (const label of ["Feature flags", "Staff roles", "Pricing", "Audit log"]) {
        assert.equal(await nav.getByRole("link", { name: label, exact: true }).count(), 0, `operator@ should not see "${label}"`);
      }
      for (const p of ["/admin/flags", "/admin/staff", "/admin/pricing", "/admin/audit"]) await expectForbidden(page, p);
      await gotoOk(page, "/admin/jobs");
      await page.getByRole("heading", { level: 1, name: "Jobs & integrations" }).waitFor({ timeout: UI });
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Narration approval requires a source (editor@)
// ---------------------------------------------------------------------------
test("editor@ can approve in-review narration only after a source is set; approved narration reaches the public trail page", { timeout: 240_000 }, async (t) => {
  const { ctx, page } = await staffPage(browser, EDITOR);
  const errors = watchErrors(page);
  const openNarration = async (title) => {
    await gotoOk(page, "/admin/content?status=in_review");
    const link = page.getByRole("link", { name: title, exact: true });
    await link.waitFor({ timeout: UI });
    await Promise.all([page.waitForURL(/\/admin\/content\/[0-9a-f-]{36}$/, { timeout: NAV }), link.click()]);
    await ready(page);
    return page.url().split("/").pop();
  };
  /** Bypass the browser's required-field check so the server's own validation is exercised. */
  const dropRequired = () => page.evaluate(() => document.querySelectorAll("#review form [required]").forEach((el) => el.removeAttribute("required")));
  try {
    await t.test("seeded in-review narration without a source cannot be approved (browser and server)", async () => {
      await openNarration(SEEDED_NARRATION);
      await assertText(page.locator("main"), /None — required for approval/);
      const source = page.locator("#ap-source");
      assert.equal(await source.inputValue(), "", "no source preselected");
      // Browser validation blocks the empty submit.
      await page.getByRole("button", { name: "Approve narration" }).click();
      assert.equal(await source.evaluate((el) => el.validity.valueMissing), true);
      // Bypass the browser check: the server must still refuse.
      await dropRequired();
      await submitAndExpect(page.locator("#review"), "Approve narration", /Choose the source this narration is based on/);
      await reloadReady(page);
      await assertText(pageHeader(page), /in review/i);
    });

    const title = `QA narration ${run}`;
    let narrationId;
    await t.test("own narration: submitted without source → refused without one → approved with source", async () => {
      await gotoOk(page, "/admin/content");
      await page.locator("#n-trail").selectOption({ label: CLOSE_TRAIL.name });
      await page.locator("#n-title").fill(title);
      await page.locator("#n-transcript").fill(`Demonstration narration written by the admin e2e spec (${run}). Pines here are fictional.`);
      await page.locator("#n-submit").check();
      // Saving redirects to the new narration's detail page.
      await Promise.all([page.waitForURL(/\/admin\/content\/[0-9a-f-]{36}$/, { timeout: NAV }), page.getByRole("button", { name: "Save narration", exact: true }).click()]);
      await ready(page);
      narrationId = page.url().split("/").pop();
      cleanups.push([
        "retire QA narration",
        async (p) => {
          await gotoOk(p, `/admin/content/${narrationId}`);
          if ((await p.locator("#rt-confirm").count()) === 0) return;
          await p.locator("#rt-confirm").check();
          await submit(p.locator("#retire"), "Retire narration");
        },
      ]);
      await assertText(pageHeader(page), /in review/i);
      await assertText(page.locator("main"), /None — required for approval/);

      // No source yet → the server refuses even with the browser check bypassed.
      await page.locator("#ap-cite").fill(`QA citation ${run}`);
      await dropRequired();
      await submitAndExpect(page.locator("#review"), "Approve narration", /Choose the source this narration is based on/);
      await reloadReady(page);
      await assertText(pageHeader(page), /in review/i);

      // With a source → approved.
      const sourceOptions = await page.locator("#ap-source option").evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
      assert.ok(sourceOptions.length > 0, "at least one source to cite");
      await page.locator("#ap-source").selectOption(sourceOptions[0]);
      await page.locator("#ap-cite").fill(`QA citation ${run}`);
      await submit(page.locator("#review"), "Approve narration");
      await assertText(pageHeader(page), /approved/i);
      await reloadReady(page);
      await assertText(pageHeader(page), /approved/i);
      assert.equal(await page.locator("#review").count(), 0, "approved narration offers no approve form");
    });

    await t.test("the approved, cited narration is listed on the public trail page", async () => {
      await gotoOk(customer, `/trails/${CLOSE_TRAIL.slug}`);
      const stops = customer.locator("section", { has: customer.getByRole("heading", { name: /Audio narration stops/ }) });
      await assertText(stops.locator("li"), new RegExp(`${esc(title)}[\\s\\S]*Source: QA citation ${run}`));
    });

    await t.test("audit log records the approval with the actor", async () => {
      const rows = await auditRows(admin, { action: "narration.approved", entityId: narrationId });
      assert.ok(rows.length >= 1 && rows[0].actor.includes(EDITOR), `narration.approved by editor@ expected:\n${fmtRows(rows)}`);
    });

    // Retire now (also registered as a cleanup in case this step fails).
    await t.test("retiring removes it from the public trail page", async () => {
      await gotoOk(page, `/admin/content/${narrationId}`);
      await page.locator("#rt-confirm").check();
      await submit(page.locator("#retire"), "Retire narration");
      await assertText(pageHeader(page), /retired/i);
      await gotoOk(customer, `/trails/${CLOSE_TRAIL.slug}`);
      assert.equal(await customer.getByText(title).count(), 0, "retired narration is no longer public");
    });
    assert.deepEqual(errors, [], `console errors:\n${errors.join("\n")}`);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Closures affect the public trail page and /plan
// ---------------------------------------------------------------------------
test("a closure created in admin shows on the public trail page and excludes the trail from /plan; ending it restores both", { timeout: 240_000 }, async (t) => {
  const trailId = await adminTrailId(admin, CLOSE_TRAIL.name);
  const date = nextDow(addDays(today, randInt(10, 40)), 3); // a Wednesday a few weeks out
  const reason = `QA closure ${run}: footbridge out (demonstration)`;
  const closureCard = () => admin.locator("#list li").filter({ hasText: reason });

  await t.test("before: the trail fits and can be saved", async () => {
    await gotoOk(customer, planUrl(date, CLOSE_TRAIL.slug));
    await assertText(customer.locator("main"), new RegExp(`${esc(CLOSE_TRAIL.name)} fits your answers`));
    await customer.getByRole("button", { name: `Save this trip (${CLOSE_TRAIL.name})` }).first().waitFor({ timeout: UI });
  });

  await t.test("admin creates an open-ended 'closed' closure", async () => {
    await gotoOk(admin, `/admin/trails/${trailId}/closures`);
    await admin.locator("#cl-new-sev").selectOption("closed");
    await admin.locator("#cl-new-reason").fill(reason);
    cleanups.push([
      "end QA closure",
      async (p) => {
        await gotoOk(p, `/admin/trails/${trailId}/closures`);
        const card = p.locator("#list li").filter({ hasText: reason }).filter({ has: p.getByRole("button", { name: "End now" }) });
        if (await card.count()) await submit(card.first(), "End now");
      },
    ]);
    await submitAndExpect(admin.locator("#new"), "Save closure", /Closure saved\. The trail is unavailable for recommendations and new bookings/);
    await assertText(closureCard(), /active/i);
  });

  await t.test("public trail page shows the closure and its reason", async () => {
    await gotoOk(customer, `/trails/${CLOSE_TRAIL.slug}`);
    const alert = customer.getByRole("region", { name: "Closures and advisories" });
    await assertText(alert, new RegExp(`Closed[\\s\\S]*${esc(reason)}`));
    await assertText(customer.locator("main"), /Currently closed: personalize for a date after the closure ends/);
  });

  await t.test("/plan excludes the closed trail with the closure reason and offers no save button", async () => {
    await gotoOk(customer, planUrl(date, CLOSE_TRAIL.slug));
    await assertText(customer.locator("main"), new RegExp(`${esc(CLOSE_TRAIL.name)} doesn't fit your answers`));
    await assertText(customer.locator("main"), new RegExp(`Fully closed on ${date}: ${esc(reason)}`));
    assert.equal(await customer.getByRole("button", { name: `Save this trip (${CLOSE_TRAIL.name})` }).count(), 0);
  });

  await t.test("ending the closure restores the trail page and /plan", async () => {
    await gotoOk(admin, `/admin/trails/${trailId}/closures`);
    await submit(closureCard().filter({ has: admin.getByRole("button", { name: "End now" }) }).first(), "End now");
    await assertText(closureCard(), /ended/i);
    assert.equal(await closureCard().getByRole("button", { name: "End now" }).count(), 0, "an ended closure offers no End now button");
    await gotoOk(customer, `/trails/${CLOSE_TRAIL.slug}`);
    assert.equal(await customer.getByText(reason).count(), 0, "ended closure no longer shown publicly");
    await gotoOk(customer, planUrl(date, CLOSE_TRAIL.slug));
    await assertText(customer.locator("main"), new RegExp(`${esc(CLOSE_TRAIL.name)} fits your answers`));
  });

  await t.test("closure.created and closure.ended are audit-logged for the trail", async () => {
    const rows = await auditRows(admin, { action: "closure.", entityId: trailId });
    assert.ok(rows.some((r) => r.action === "closure.created" && r.actor.includes(ADMIN)), `closure.created missing:\n${fmtRows(rows)}`);
    assert.ok(rows.some((r) => r.action === "closure.ended"), `closure.ended missing:\n${fmtRows(rows)}`);
  });
});

// ---------------------------------------------------------------------------
// 5. GeoJSON route upload
// ---------------------------------------------------------------------------
test("GeoJSON route upload: a valid file validates and activates; an invalid one shows errors and cannot be activated", { timeout: 240_000 }, async (t) => {
  const trailId = await adminTrailId(admin, CLOSE_TRAIL.name);
  const geometry = await seededGeometry(browser);
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  const fileRow = (checksum) => admin.locator("#files tr").filter({ hasText: `${checksum.slice(0, 12)}…` });
  const upload = async (name, buffer) => {
    await admin.locator('#upload input[type="file"]').setInputFiles({ name, mimeType: "application/geo+json", buffer });
    const [res] = await Promise.all([
      admin.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/admin/trails/${trailId}/geometry/upload`), { timeout: NAV }),
      admin.locator("#upload").getByRole("button", { name: "Upload and validate" }).click(),
    ]);
    return res;
  };

  await gotoOk(admin, `/admin/trails/${trailId}/geometry`);
  const checksumBefore = await admin.locator("#current dd.font-mono").getAttribute("title");

  await t.test("valid Feature (seeded coordinates) → valid → Activate → active, same geometry checksum", async () => {
    const valid = Buffer.from(JSON.stringify({ type: "Feature", properties: { name: `QA route ${run}` }, geometry }, null, 1));
    await upload(`qa-${run}.geojson`, valid);
    await expectStatus(admin, /Valid route \(\d+\.\d{2} km\)\. Review it, then activate it/, NAV);
    const row = fileRow(sha(valid));
    await badge(row, "valid");
    await submit(row, "Activate");
    await assertText(fileRow(sha(valid)), /Active[\s\S]*In use/);
    await reloadReady(admin);
    await assertText(fileRow(sha(valid)), /Active[\s\S]*In use/);
    const checksumAfter = await admin.locator("#current dd.font-mono").getAttribute("title");
    assert.match(checksumAfter, /^[0-9a-f]{64}$/);
    if (checksumBefore && /^[0-9a-f]{64}$/.test(checksumBefore)) assert.equal(checksumAfter, checksumBefore, "same coordinates → same geometry checksum");
  });

  await t.test("invalid LineString → invalid with errors, no Activate button", async () => {
    const [lng, lat] = geometry.coordinates[0];
    const invalid = Buffer.from(JSON.stringify({ type: "LineString", coordinates: [[lng, lat], [lng + 0.2, lat + 0.1]], qa: run }));
    await upload(`qa-bad-${run}.geojson`, invalid);
    await expectStatus(admin, /INVALID and cannot be activated/, NAV);
    const row = fileRow(sha(invalid));
    await badge(row, "invalid");
    await assertText(row, /Cannot be activated/);
    assert.equal(await row.getByRole("button", { name: "Activate" }).count(), 0, "invalid files offer no activation");
    assert.ok((await row.locator("li").count()) >= 1, "validation errors are listed");
    await assertText(row.locator("li"), /Gap of \d+ m between vertices|differs from declared/);
  });

  await t.test("a file that is not JSON is rejected with a clear error", async () => {
    await upload(`qa-junk-${run}.geojson`, Buffer.from(`not json ${run}`));
    await expectStatus(admin, /not valid JSON/, NAV);
  });

  await t.test("uploads and activation are audit-logged", async () => {
    const rows = await auditRows(admin, { action: "route_file.", entityId: trailId });
    assert.ok(rows.some((r) => r.action === "route_file.activated"), `route_file.activated missing:\n${fmtRows(rows)}`);
    const uploads = rows.filter((r) => r.action === "route_file.uploaded");
    assert.ok(uploads.some((r) => r.metadata?.status === "valid") && uploads.some((r) => r.metadata?.status === "invalid"), `valid + invalid uploads expected:\n${fmtRows(rows)}`);
  });
});

// ---------------------------------------------------------------------------
// 6. Pricing rule edit → live preview + customer checkout quote
// ---------------------------------------------------------------------------
test("pricing rule edit changes the live preview and the customer's checkout quote", { timeout: 240_000 }, async (t) => {
  const ruleName = `QA fee ${run}`;
  const date = nextDow(addDays(today, randInt(21, 70)), 2); // a Tuesday 3–10 weeks out
  const ruleDetails = () => admin.locator("#rules details").filter({ has: admin.locator("summary", { hasText: ruleName }) });
  const previewTable = () => admin.getByRole("table", { name: "Every line of the quote" });
  const previewLine = async () => (await readQuote(admin, "Every line of the quote")).find((l) => l.label.startsWith(ruleName));
  const deleteRule = async (p) => {
    const d = p.locator("#rules details").filter({ has: p.locator("summary", { hasText: ruleName }) });
    if (!(await d.count())) return;
    if (!(await d.evaluate((el) => el.open))) await d.locator("summary").click();
    await d.getByLabel(/Delete permanently/).check();
    await submit(d, "Delete rule");
  };
  let tripId;

  await t.test("admin creates a flat fee scoped to one trail", async () => {
    await gotoOk(admin, "/admin/pricing");
    cleanups.push([
      "delete QA pricing rule",
      async (p) => {
        await gotoOk(p, "/admin/pricing");
        await deleteRule(p);
      },
    ]);
    await admin.locator("#rule-new-name").fill(ruleName);
    await admin.locator("#rule-new-kind").selectOption("flat_fee");
    await admin.locator("#rule-new-value").fill("700");
    await admin.locator("#rule-new-scope").selectOption("trail");
    await admin.locator("#rule-new-trail").selectOption({ label: PRICE_TRAIL.name });
    await submitAndExpect(admin.locator("#rules"), "Create rule", /Pricing rule created/);
    await ruleDetails().waitFor({ timeout: UI });
    await assertText(ruleDetails().locator("summary"), new RegExp(`\\$7\\.00 per booking · trail: ${esc(PRICE_TRAIL.name)}`));
  });

  await t.test("live preview shows the rule, then the edited value without a reload", async () => {
    await selectByTextStart(admin.getByLabel("Trail", { exact: true }), `${PRICE_TRAIL.name} (`);
    await admin.getByLabel("Hike date", { exact: true }).fill(date);
    await admin.getByLabel("Party size", { exact: true }).fill("2");
    await assertText(previewTable(), new RegExp(esc(ruleName)));
    assert.equal((await previewLine())?.cents, 700);

    await ruleDetails().locator("summary").click();
    await ruleDetails().getByLabel("Value (% or cents for flat fee)").fill("1234");
    await submitAndExpect(ruleDetails(), "Save rule", /Pricing rule saved/);
    // Preview state (trail/date) is kept and the new value is applied.
    await admin.waitForFunction(
      (name) => [...document.querySelectorAll("table tr")].some((tr) => tr.textContent.includes(name) && tr.textContent.includes("$12.34")),
      ruleName,
      { timeout: UI },
    );
    assert.equal((await previewLine())?.cents, 1234);
    // Other trails are not affected.
    await selectByTextStart(admin.getByLabel("Trail", { exact: true }), `${CLOSE_TRAIL.name} (`);
    await previewTable().waitFor({ timeout: UI });
    assert.equal(await previewLine(), undefined, "a trail-scoped rule does not apply to other trails");
  });

  await t.test("customer checkout quote for that trail shows the edited fee and the total adds up", async () => {
    tripId = await saveTrip(customer, PRICE_TRAIL, date);
    await openCheckout(customer, tripId, { date, party: 2 });
    const lines = await readQuote(customer);
    const fee = lines.find((l) => l.label.startsWith(ruleName));
    assert.ok(fee, `fee line missing: ${JSON.stringify(lines)}`);
    assert.equal(fee.cents, 1234);
    const totalText = await customer.getByRole("table", { name: "Price quote" }).locator("tfoot tr").first().locator("td").innerText();
    assert.equal(cents(totalText), lines.reduce((s, l) => s + l.cents, 0), "total equals the sum of the lines");
  });

  await t.test("pricing changes are audit-logged with before/after", async () => {
    const rows = await auditRows(admin, { action: "pricing.rule_" });
    const created = rows.find((r) => r.action === "pricing.rule_created" && r.metadata?.name === ruleName);
    assert.ok(created, `pricing.rule_created for ${ruleName} missing:\n${fmtRows(rows)}`);
    const updated = rows.find((r) => r.action === "pricing.rule_updated" && r.entityId === created.entityId);
    assert.ok(updated, `pricing.rule_updated for ${ruleName} missing:\n${fmtRows(rows)}`);
    assert.equal(updated.metadata?.before?.value, 700, "audit keeps the value before the edit");
    assert.equal(updated.metadata?.after?.value, 1234, "audit keeps the value after the edit");
    assert.ok(updated.actor.includes(ADMIN));
  });

  await t.test("deleting the rule removes it and its fee from checkout", async () => {
    await gotoOk(admin, "/admin/pricing");
    await deleteRule(admin);
    await ruleDetails().waitFor({ state: "detached", timeout: UI });
    await openCheckout(customer, tripId, { date, party: 2 });
    assert.ok(!(await readQuote(customer)).some((l) => l.label.startsWith(ruleName)), "fee line gone after delete");
  });
});

// ---------------------------------------------------------------------------
// 7. Feature flag: addon_meal_pack
// ---------------------------------------------------------------------------
test("turning addon_meal_pack off hides the meal pack at checkout; the toggle is audit-logged", { timeout: 240_000 }, async (t) => {
  const date = nextDow(addDays(today, randInt(21, 70)), 4); // a Thursday
  const flagCard = () => admin.locator("li").filter({ has: admin.locator("code", { hasText: /^addon_meal_pack$/ }) });
  const tripId = await saveTrip(customer, PRICE_TRAIL, date);
  const mealBox = () => customer.getByRole("checkbox", { name: /Trail meal pack/ });

  await t.test("with the flag on, the meal pack is offered", async () => {
    await openCheckout(customer, tripId, { date });
    await mealBox().waitFor({ timeout: UI });
  });

  await t.test("admin turns the flag off", async () => {
    cleanups.push([
      "turn addon_meal_pack back on",
      async (p) => {
        await gotoOk(p, "/admin/flags");
        const card = p.locator("li").filter({ has: p.locator("code", { hasText: /^addon_meal_pack$/ }) });
        if (await card.getByRole("button", { name: "Turn on" }).count()) await submit(card, "Turn on");
      },
    ]);
    await gotoOk(admin, "/admin/flags");
    await badge(flagCard(), "On");
    await submitAndExpect(flagCard(), "Turn off", /addon_meal_pack turned off/);
    await flagCard().getByRole("button", { name: "Turn on" }).waitFor({ timeout: UI });
    await badge(flagCard(), "Off");
    await assertText(flagCard(), new RegExp(`Last changed[\\s\\S]*by ${esc(ADMIN)}`));
  });

  await t.test("checkout no longer offers or prices the meal pack, even when requested in the URL", async () => {
    await openCheckout(customer, tripId, { date, addons: "meal-pack" });
    assert.equal(await mealBox().count(), 0, "meal pack checkbox hidden");
    assert.ok(!(await readQuote(customer)).some((l) => /meal pack/i.test(l.label)), "no meal pack line in the quote");
    await customer.getByRole("checkbox", { name: /gear locker/i }).waitFor({ timeout: UI }); // other add-ons still offered
  });

  await t.test("turning it back on restores the offer", async () => {
    await gotoOk(admin, "/admin/flags");
    await submitAndExpect(flagCard(), "Turn on", /addon_meal_pack turned on/);
    await openCheckout(customer, tripId, { date });
    await mealBox().waitFor({ timeout: UI });
  });

  await t.test("both toggles are in the audit log with from/to and the actor", async () => {
    const rows = await auditRows(admin, { action: "flag.toggled", entityId: "addon_meal_pack" });
    assert.ok(rows.length >= 2, `expected 2 flag.toggled rows, got ${rows.length}`);
    assert.deepEqual(rows[0].metadata, { from: false, to: true }, `newest toggle should be off → on:\n${fmtRows(rows)}`);
    assert.deepEqual(rows[1].metadata, { from: true, to: false }, `previous toggle should be on → off:\n${fmtRows(rows)}`);
    assert.ok(rows[0].actor.includes(ADMIN) && rows[1].actor.includes(ADMIN));
  });
});

// ---------------------------------------------------------------------------
// 8. Dead job retry
// ---------------------------------------------------------------------------
test("a dead job is re-queued from /admin/jobs, then runs", { timeout: 180_000 }, async (t) => {
  await gotoOk(admin, "/admin/jobs"); // default filter: dead
  await admin.getByRole("table", { name: "Jobs (dead)" }).or(admin.getByText("No jobs match.")).first().waitFor({ timeout: UI });
  const deadRows = admin.locator("#queue tr").filter({ has: admin.getByRole("button", { name: "Retry" }) }).filter({ has: admin.getByText("dead", { exact: true }) });
  if (!(await deadRows.count())) {
    t.skip("no dead job in this database (the seed provides one; it may have been retried by an earlier run)");
    return;
  }
  // Prefer the seeded housekeeping job (its handler succeeds on retry); other specs sharing the
  // database could leave dead jobs whose handlers legitimately fail again.
  const seeded = deadRows.filter({ hasText: "ops.purge_rate_limits" });
  const row = (await seeded.count()) ? seeded.first() : deadRows.first();
  const [, jobId, kind] = (await row.innerText()).match(/#(\d+)\s+([a-z0-9_.:-]+)/i);
  await assertText(row, /(\d+) \/ \1/); // attempts exhausted
  await submit(row, "Retry");
  // The row leaves the dead list once re-queued.
  await admin.locator("#queue tr").filter({ hasText: `#${jobId} ${kind}` }).waitFor({ state: "detached", timeout: UI });

  const jobRow = () => admin.locator("#queue tr").filter({ hasText: `#${jobId} ${kind}` });
  await gotoOk(admin, `/admin/jobs?status=all&kind=${encodeURIComponent(kind)}`);
  await assertText(jobRow(), /queued|succeeded|running/i);

  await runJobs();
  await gotoOk(admin, `/admin/jobs?status=all&kind=${encodeURIComponent(kind)}`);
  await assertText(jobRow(), /succeeded/i);

  const rows = await auditRows(admin, { action: "job.retried", entityId: jobId });
  assert.ok(rows.length >= 1 && rows[0].actor.includes(ADMIN) && rows[0].metadata?.from === "dead", `job.retried audit missing:\n${fmtRows(rows)}`);
});

// ---------------------------------------------------------------------------
// 9. Marketing draft workflow
// ---------------------------------------------------------------------------
test("marketing draft: generate (simulated weather labeled with fetched time) → submit → approve → mark published", { timeout: 240_000 }, async () => {
  await gotoOk(admin, "/admin/marketing");
  await admin.locator("#mk-trail").selectOption({ label: `${CLOSE_TRAIL.name} (demo)` });
  await admin.locator("#mk-channel").selectOption("newsletter");
  await Promise.all([admin.waitForURL(/\/admin\/marketing\/[0-9a-f-]{36}\?generated=1$/, { timeout: NAV }), admin.getByRole("button", { name: "Generate draft" }).click()]);
  await ready(admin);
  const draftId = new URL(admin.url()).pathname.split("/").pop();
  const main = admin.locator("main");
  await assertText(main, /Draft generated from sourced facts/);

  // Honesty: simulated weather is labeled, with the fetched time; demo trail warning shown.
  const weather = admin.locator("#provenance");
  await assertText(weather, /Simulated weather/);
  await assertText(weather, /fetched/);
  assert.ok((await weather.locator("time").count()) >= 1, "fetched time is rendered as <time>");
  await assertText(admin.locator("#text"), /SIMULATED demo data, not a real forecast \(generated [^)]+\)/);
  await assertText(main, /Demonstration trail \(fictional\): do not publish as a real place/);
  await badge(pageHeader(admin), "draft");

  await submit(admin.locator("#edit"), "Submit for review");
  await assertText(pageHeader(admin), /in review/i);

  // Approval requires acknowledging the warnings (server also refuses without it).
  await admin.evaluate(() => document.querySelector("#md-ack")?.removeAttribute("required"));
  await submitAndExpect(admin.locator("#review"), "Approve draft", /Review the warnings and tick the acknowledgement before approving/);
  await admin.locator("#md-ack").check();
  await submit(admin.locator("#review"), "Approve draft");
  await assertText(pageHeader(admin), /approved/i);

  await admin.locator("#md-pub").check();
  await submit(admin.locator("#review"), "Mark as published");
  await assertText(pageHeader(admin), /published/i);
  await reloadReady(admin);
  await assertText(pageHeader(admin), /published/i);
  assert.equal(await admin.locator("#edit").count(), 0, "published drafts are no longer editable");
  await assertText(main, /Marked published/);

  const rows = await auditRows(admin, { entityId: draftId });
  for (const a of ["marketing.draft_generated", "marketing.draft_submitted", "marketing.draft_approved", "marketing.draft_published"]) {
    assert.ok(rows.some((r) => r.action === a), `${a} missing from audit:\n${fmtRows(rows)}`);
  }
  const generated = rows.find((r) => r.action === "marketing.draft_generated");
  assert.equal(generated.metadata?.weather, "simulated", "the audit records that the weather was simulated");
});

// ---------------------------------------------------------------------------
// 10. Staff roles
// ---------------------------------------------------------------------------
test("staff roles: grant then revoke (effective on the next request); the last admin cannot be removed", { timeout: 240_000 }, async (t) => {
  const memberCard = (page, email) => page.locator("#staff > ul > li").filter({ has: page.getByText(email, { exact: true }) }).first();
  const roleRow = (page, email, role) => memberCard(page, email).locator("ul li").filter({ has: page.locator("span.font-semibold", { hasText: new RegExp(`^${role.replace("_", " ")}$`) }) });
  const revoke = async (page, email, role) => {
    const row = roleRow(page, email, role);
    await row.locator("summary", { hasText: "Revoke" }).click();
    await row.getByRole("checkbox").check();
    await submit(row, `Revoke ${role}`);
  };
  const grant = async (email, role, re) => {
    await gotoOk(admin, "/admin/staff");
    await admin.locator("#sr-email").fill(email);
    await admin.locator("#sr-role").selectOption(role);
    await submitAndExpect(admin.locator("#grant"), "Grant role", re);
  };
  cleanups.push([
    "revoke QA customer staff roles",
    async (p) => {
      await gotoOk(p, "/admin/staff");
      for (const role of ["admin", "support"]) {
        if (await roleRow(p, customerEmail, role).count()) await revoke(p, customerEmail, role);
      }
    },
  ]);

  await t.test("granting support to the customer opens /admin for them on their next request", async () => {
    await grant(customerEmail, "support", /Granted support/);
    await assertText(memberCard(admin, customerEmail), /support[\s\S]*granted[\s\S]*by admin@demo\.ghostguide\.test/);
    await gotoOk(customer, "/admin");
    await customer.getByRole("heading", { level: 1, name: "Overview" }).waitFor({ timeout: UI });
    await expectForbidden(customer, "/admin/pricing"); // support only
  });

  await t.test("unknown emails are refused", async () => {
    await grant(`nobody-${run}@example.test`, "support", /No account with that email/);
  });

  await t.test("revoking support takes /admin away again", async () => {
    await gotoOk(admin, "/admin/staff");
    await revoke(admin, customerEmail, "support");
    await memberCard(admin, customerEmail).waitFor({ state: "detached", timeout: UI });
    await expectForbidden(customer, "/admin");
  });

  await t.test("the only admin role shows no revoke control", async () => {
    await gotoOk(admin, "/admin/staff");
    await assertText(roleRow(admin, ADMIN, "admin"), /Last admin — cannot be revoked/);
    assert.equal(await roleRow(admin, ADMIN, "admin").locator("summary").count(), 0);
  });

  await t.test("a stale page cannot remove the last admin either (server-side guard)", async () => {
    await grant(customerEmail, "admin", /Granted admin/);
    const stale = await admin.context().newPage();
    try {
      await gotoOk(stale, "/admin/staff");
      // With two admins, the stale page offers a revoke form for admin@'s admin role.
      await roleRow(stale, ADMIN, "admin").locator("summary", { hasText: "Revoke" }).waitFor({ timeout: UI });
      // Remove the second admin in the main tab...
      await gotoOk(admin, "/admin/staff");
      await revoke(admin, customerEmail, "admin");
      await memberCard(admin, customerEmail).waitFor({ state: "detached", timeout: UI });
      // ...then try to revoke admin@'s admin role from the stale tab.
      const row = roleRow(stale, ADMIN, "admin");
      await row.locator("summary", { hasText: "Revoke" }).click();
      await row.getByRole("checkbox").check();
      await submitAndExpect(row, "Revoke admin", /cannot remove the last remaining admin role/i);
    } finally {
      await stale.close();
    }
    await gotoOk(admin, "/admin/staff");
    await assertText(roleRow(admin, ADMIN, "admin"), /Last admin — cannot be revoked/);
    await gotoOk(admin, "/admin/flags"); // admin@ still has admin
    await admin.getByRole("heading", { level: 1, name: "Feature flags" }).waitFor({ timeout: UI });
  });

  await t.test("the audit log shows the grants and revokes for the customer", async () => {
    await gotoOk(admin, `/admin/customers?q=${encodeURIComponent(customerEmail)}`);
    const href = await admin.locator('main a[href^="/admin/customers/"]').first().getAttribute("href", { timeout: UI });
    const userId = href.split("/").pop();
    const rows = await auditRows(admin, { action: "staff.role_", entityId: userId });
    const has = (action, role) => rows.some((r) => r.action === action && r.metadata?.role === role && r.actor.includes(ADMIN));
    assert.ok(has("staff.role_granted", "support"), `grant support missing:\n${fmtRows(rows)}`);
    assert.ok(has("staff.role_revoked", "support"), `revoke support missing:\n${fmtRows(rows)}`);
    assert.ok(has("staff.role_granted", "admin"), `grant admin missing:\n${fmtRows(rows)}`);
    assert.ok(has("staff.role_revoked", "admin"), `revoke admin missing:\n${fmtRows(rows)}`);
    const adminRows = await auditRows(admin, { action: "staff.role_revoked", actor: ADMIN });
    assert.ok(!adminRows.some((r) => r.metadata?.role === "admin" && r.metadata?.self === true), "admin@'s own admin role was never revoked");
  });
});

// ---------------------------------------------------------------------------
// 11. Confirmations survive the re-render (a11y: aria-live feedback for every action)
// ---------------------------------------------------------------------------
test("admin action confirmations stay announced after the page re-renders (closure end)", { timeout: 120_000 }, async () => {
  const trailId = await adminTrailId(admin, CLOSE_TRAIL.name);
  const reason = `QA advisory ${run}: confirmation probe (demonstration)`;
  await gotoOk(admin, `/admin/trails/${trailId}/closures`);
  await admin.locator("#cl-new-sev").selectOption("advisory");
  await admin.locator("#cl-new-reason").fill(reason);
  const card = () => admin.locator("#list li").filter({ hasText: reason });
  cleanups.push([
    "end QA advisory",
    async (p) => {
      await gotoOk(p, `/admin/trails/${trailId}/closures`);
      const c = p.locator("#list li").filter({ hasText: reason }).filter({ has: p.getByRole("button", { name: "End now" }) });
      if (await c.count()) await submit(c.first(), "End now");
    },
  ]);
  await submitAndExpect(admin.locator("#new"), "Save closure", /Closure saved/);
  await submit(card().filter({ has: admin.getByRole("button", { name: "End now" }) }).first(), "End now");
  await assertText(card(), /ended/i);
  // Correct behavior: the success message is still announced in an aria-live region even
  // though the End-now form is no longer rendered for an ended closure.
  await expectStatus(admin, /Closure ended/, 5_000);
});
