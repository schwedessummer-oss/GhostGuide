/**
 * Admin slice — end-to-end spec (node:test + Playwright).
 *
 * Covers:
 *  - every /admin page (incl. trail edit sub-pages and detail pages) loads for admin@ with
 *    no error boundary, no console errors and no horizontal scrolling at 390 px;
 *  - RBAC: signed-out → login, a customer gets /forbidden, support@ cannot open pricing /
 *    safety and never sees restricted contacts or coordinates, operator@ cannot manage
 *    flags / staff, editor@ can approve in-review narration only once a source is set;
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
 *    cannot be removed (even from a stale page), and the audit log records all of it.
 *
 * Independence: the spec signs up its own customer (unique email per run), mutates only
 * trails no other spec uses (Hollow Pine Ridge, Miner's Meadow Loop), scopes its pricing
 * rule to one trail, re-activates IDENTICAL route coordinates (same geometry checksum), and
 * restores every global change (flags, closure, rule, roles, narration) in `after` even
 * when a test fails. The seeded in-review narration is only used for the refusal path
 * (nothing is approved on it); the approval itself runs on a narration this spec creates.
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

async function assertText(locator, re, timeout = UI) {
  await locator
    .filter({ hasText: re })
    .first()
    .waitFor({ timeout })
    .catch(async () => {
      const actual = await locator.first().innerText().catch(() => "<no element>");
      assert.fail(`Expected ${re} in:\n${actual.slice(0, 2500)}`);
    });
}

/** Click a submit button and wait for the admin form result (role=status) to show `re`. */
async function submitAndExpect(scope, buttonName, re, timeout = UI) {
  const form = scope.locator("form").filter({ has: scope.page().getByRole("button", { name: buttonName, exact: true }) }).first();
  await form.getByRole("button", { name: buttonName, exact: true }).click();
  await assertText(form.getByRole("status"), re, timeout);
}

async function gotoOk(page, path) {
  const res = await page.goto(path, { timeout: NAV });
  assert.ok(res, `no response for ${path}`);
  assert.ok(res.status() < 400, `${path} -> HTTP ${res.status()}`);
  return res;
}

async function expectForbidden(page, path) {
  await page.goto(path, { timeout: NAV });
  await page.waitForURL((u) => u.pathname === "/forbidden", { timeout: NAV }).catch(() => assert.fail(`${path} should redirect to /forbidden, got ${page.url()}`));
  await assertText(page.locator("main"), /You don't have access to this page/);
}

/** Admin trail id from the admin trails list. */
async function adminTrailId(page, name) {
  await gotoOk(page, "/admin/trails");
  const href = await page.getByRole("link", { name, exact: true }).first().getAttribute("href");
  assert.match(href, /^\/admin\/trails\/[0-9a-f-]{36}$/);
  return href.split("/").pop();
}

function planUrl(date, slug) {
  const q = new URLSearchParams({ experience: "some", fitness: "moderate", pace: "steady", hours: "8", date, start: "08:30", party: "2", trail: slug });
  return `/plan/results?${q}`;
}

/** Audit rows (text) for an action + entity id, newest first. */
async function auditRows(page, { action, entityId, entityType }) {
  const q = new URLSearchParams();
  if (action) q.set("action", action);
  if (entityId) q.set("entityId", entityId);
  if (entityType) q.set("entityType", entityType);
  await gotoOk(page, `/admin/audit?${q}`);
  const rows = page.locator("main table tbody tr");
  const n = await rows.count();
  const out = [];
  for (let i = 0; i < n; i++) out.push(await rows.nth(i).innerText());
  return out;
}

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
  return rows.map((r) => ({ label: r.label, cents: cents(r.amount) }));
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

/** Seeded route coordinates for Hollow Pine Ridge: via hiker2's offline bundle, else psql. */
async function seededGeometry(browser) {
  try {
    const { ctx, page } = await staffPage(browser, HIKER2);
    try {
      await gotoOk(page, "/trips");
      const href = await page.locator('main a[href^="/trips/"]').filter({ hasText: CLOSE_TRAIL.name }).first().getAttribute("href", { timeout: UI });
      const res = await ctx.request.get(`/api/trips/${href.split("/")[2]}/bundle`);
      if (res.ok()) {
        const b = await res.json();
        const g = JSON.parse(b.geometryJson);
        if (g?.type === "LineString" && g.coordinates?.length > 1) return g;
      }
    } finally {
      await ctx.close();
    }
  } catch {
    /* fall back to psql */
  }
  const url = process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/ghostguide_e2e";
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
      await page.getByRole("heading", { level: 1, name: h1 }).first().waitFor({ timeout: UI });
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
    ]) {
      await gotoOk(page, list);
      const link = page.locator(sel).first();
      await link.waitFor({ timeout: UI });
      const href = await link.getAttribute("href");
      await gotoOk(page, href);
      await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: UI });
      assert.equal(await page.getByText("This admin page could not load").count(), 0, `${href} rendered the admin error boundary`);
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
  await t.test("signed-out visitor is sent to login with a return path", async () => {
    const ctx = await newCtx(browser);
    const page = await ctx.newPage();
    await page.goto("/admin/pricing");
    await page.waitForURL((u) => u.pathname === "/login", { timeout: NAV });
    assert.equal(new URL(page.url()).searchParams.get("next"), "/admin/pricing");
    await ctx.close();
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

  await t.test("admin@ (safety.sensitive) does get the audited reveal control on the same customer", async () => {
    await gotoOk(admin, `/admin/customers?q=${encodeURIComponent(HIKER)}`);
    const link = admin.locator('main a[href^="/admin/customers/"]').first();
    await link.waitFor({ timeout: UI });
    await Promise.all([admin.waitForURL(/\/admin\/customers\/[0-9a-f-]{36}$/, { timeout: NAV }), link.click()]);
    await admin.getByRole("button", { name: "Show restricted details" }).waitFor({ timeout: UI });
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
  try {
    await t.test("seeded in-review narration without a source cannot be approved (browser and server)", async () => {
      await gotoOk(page, "/admin/content?status=in_review");
      const link = page.getByRole("link", { name: SEEDED_NARRATION, exact: true });
      await link.waitFor({ timeout: UI });
      await Promise.all([page.waitForURL(/\/admin\/content\/[0-9a-f-]{36}$/, { timeout: NAV }), link.click()]);
      await assertText(page.locator("main"), /None — required for approval/);
      const source = page.locator("#ap-source");
      assert.equal(await source.inputValue(), "", "no source preselected");
      // Browser validation blocks the empty submit.
      await page.getByRole("button", { name: "Approve narration" }).click();
      assert.equal(await source.evaluate((el) => el.validity.valueMissing), true);
      // Bypass the browser check: the server must still refuse.
      await page.evaluate(() => document.querySelectorAll("#review form [required]").forEach((el) => el.removeAttribute("required")));
      await submitAndExpect(page.locator("#review"), "Approve narration", /Choose the source this narration is based on/);
      await page.reload();
      await assertText(page.locator("header"), /In review/i);
    });

    const title = `QA narration ${run}`;
    let narrationId;
    await t.test("own narration: submitted without source → approve with source → approved", async () => {
      await gotoOk(page, "/admin/content");
      await page.locator("#n-trail").selectOption({ label: CLOSE_TRAIL.name });
      await page.locator("#n-title").fill(title);
      await page.locator("#n-transcript").fill(`Demonstration narration written by the admin e2e spec (${run}). Pines here are fictional.`);
      await page.locator("#n-submit").check();
      await submitAndExpect(page.locator("#new"), "Save narration", /Narration submitted for review/);

      await gotoOk(page, "/admin/content?status=in_review");
      const link = page.getByRole("link", { name: title, exact: true });
      await link.waitFor({ timeout: UI });
      await Promise.all([page.waitForURL(/\/admin\/content\/[0-9a-f-]{36}$/, { timeout: NAV }), link.click()]);
      narrationId = page.url().split("/").pop();
      cleanups.push([
        "retire QA narration",
        async (p) => {
          await gotoOk(p, `/admin/content/${narrationId}`);
          if ((await p.locator("#rt-confirm").count()) === 0) return;
          await p.locator("#rt-confirm").check();
          await submitAndExpect(p.locator("#retire"), "Retire narration", /retired|Retired/);
        },
      ]);

      const sourceOptions = await page.locator("#ap-source option").evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
      assert.ok(sourceOptions.length > 0, "at least one source to cite");
      await page.locator("#ap-source").selectOption(sourceOptions[0]);
      await page.locator("#ap-cite").fill(`QA citation ${run}`);
      await submitAndExpect(page.locator("#review"), "Approve narration", /Approved\. Customers can now hear this narration/);
      await page.reload();
      await assertText(page.locator("header"), /Approved/);
    });

    await t.test("the approved, cited narration is listed on the public trail page", async () => {
      await gotoOk(customer, `/trails/${CLOSE_TRAIL.slug}`);
      const stops = customer.locator("section", { has: customer.getByRole("heading", { name: /Audio narration stops/ }) });
      await assertText(stops.locator("li"), new RegExp(`${esc(title)}[\\s\\S]*Source: QA citation ${run}`));
    });

    await t.test("audit log records the approval with the actor", async () => {
      const rows = await auditRows(admin, { action: "narration.approved", entityId: narrationId });
      assert.ok(rows.length >= 1 && rows[0].includes(EDITOR), `narration.approved by editor@ expected: ${rows.join("\n")}`);
    });

    // Retire now (also registered as a cleanup in case this step fails).
    await t.test("retiring removes it from the public trail page", async () => {
      await gotoOk(page, `/admin/content/${narrationId}`);
      await page.locator("#rt-confirm").check();
      await submitAndExpect(page.locator("#retire"), "Retire narration", /.+/);
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
  const closureCard = () => admin.locator("li").filter({ hasText: reason });

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
        const card = p.locator("li").filter({ hasText: reason }).filter({ has: p.getByRole("button", { name: "End now" }) });
        if (await card.count()) await submitAndExpect(card.first(), "End now", /Closure ended/);
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
    await submitAndExpect(closureCard().filter({ has: admin.getByRole("button", { name: "End now" }) }).first(), "End now", /Closure ended/);
    await gotoOk(customer, `/trails/${CLOSE_TRAIL.slug}`);
    assert.equal(await customer.getByText(reason).count(), 0, "ended closure no longer shown publicly");
    await gotoOk(customer, planUrl(date, CLOSE_TRAIL.slug));
    await assertText(customer.locator("main"), new RegExp(`${esc(CLOSE_TRAIL.name)} fits your answers`));
  });

  await t.test("closure.created and closure.ended are audit-logged for the trail", async () => {
    const rows = await auditRows(admin, { action: "closure.", entityId: trailId });
    assert.ok(rows.some((r) => r.includes("closure.created") && r.includes(ADMIN)), `closure.created missing:\n${rows.join("\n")}`);
    assert.ok(rows.some((r) => r.includes("closure.ended")), `closure.ended missing:\n${rows.join("\n")}`);
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

  await gotoOk(admin, `/admin/trails/${trailId}/geometry`);
  const checksumBefore = await admin.locator("#current dd.font-mono").getAttribute("title");

  await t.test("valid Feature (seeded coordinates) → Valid → Activate → active, same geometry checksum", async () => {
    const valid = Buffer.from(JSON.stringify({ type: "Feature", properties: { name: `QA route ${run}` }, geometry }, null, 1));
    await admin.locator('#upload input[type="file"]').setInputFiles({ name: `qa-${run}.geojson`, mimeType: "application/geo+json", buffer: valid });
    await submitAndExpect(admin.locator("#upload"), "Upload and validate", /Valid route \(\d+\.\d{2} km\)\. Review it, then activate it/, NAV);
    const row = fileRow(sha(valid));
    await assertText(row, /Valid/);
    await submitAndExpect(row, "Activate", /Route activated \(\d+\.\d{2} km\)/, NAV);
    await admin.reload();
    await assertText(fileRow(sha(valid)), /Active[\s\S]*In use/);
    const checksumAfter = await admin.locator("#current dd.font-mono").getAttribute("title");
    assert.match(checksumAfter, /^[0-9a-f]{64}$/);
    if (checksumBefore && /^[0-9a-f]{64}$/.test(checksumBefore)) assert.equal(checksumAfter, checksumBefore, "same coordinates → same geometry checksum");
  });

  await t.test("invalid LineString → Invalid with errors, no Activate button", async () => {
    const [lng, lat] = geometry.coordinates[0];
    const invalid = Buffer.from(JSON.stringify({ type: "LineString", coordinates: [[lng, lat], [lng + 0.2, lat + 0.1]], qa: run }));
    await admin.locator('#upload input[type="file"]').setInputFiles({ name: `qa-bad-${run}.geojson`, mimeType: "application/geo+json", buffer: invalid });
    await submitAndExpect(admin.locator("#upload"), "Upload and validate", /INVALID and cannot be activated/, NAV);
    const row = fileRow(sha(invalid));
    await assertText(row, /Invalid/);
    await assertText(row, /Cannot be activated/);
    assert.equal(await row.getByRole("button", { name: "Activate" }).count(), 0, "invalid files offer no activation");
    assert.ok((await row.locator("li").count()) >= 1, "validation errors are listed");
  });

  await t.test("a file that is not JSON is rejected with a clear error", async () => {
    await admin.locator('#upload input[type="file"]').setInputFiles({ name: `qa-junk-${run}.geojson`, mimeType: "application/geo+json", buffer: Buffer.from(`not json ${run}`) });
    await submitAndExpect(admin.locator("#upload"), "Upload and validate", /not valid JSON/, NAV);
  });

  await t.test("uploads and activation are audit-logged", async () => {
    const rows = await auditRows(admin, { action: "route_file.", entityId: trailId });
    assert.ok(rows.some((r) => r.includes("route_file.activated")), `route_file.activated missing:\n${rows.join("\n")}`);
    assert.ok(rows.filter((r) => r.includes("route_file.uploaded")).length >= 2, "both uploads recorded");
  });
});

// ---------------------------------------------------------------------------
// 6. Pricing rule edit → live preview + customer checkout quote
// ---------------------------------------------------------------------------
test("pricing rule edit changes the live preview and the customer's checkout quote", { timeout: 240_000 }, async (t) => {
  const ruleName = `QA fee ${run}`;
  const date = nextDow(addDays(today, randInt(21, 70)), 2); // a Tuesday 3–10 weeks out
  const ruleDetails = () => admin.locator("#rules details").filter({ has: admin.locator("summary", { hasText: ruleName }) });
  const previewLine = async () => {
    const lines = await readQuote(admin, "Every line of the quote");
    return lines.find((l) => l.label.startsWith(ruleName));
  };
  let tripId;

  await t.test("admin creates a flat fee scoped to one trail", async () => {
    await gotoOk(admin, "/admin/pricing");
    cleanups.push([
      "delete QA pricing rule",
      async (p) => {
        await gotoOk(p, "/admin/pricing");
        const d = p.locator("#rules details").filter({ has: p.locator("summary", { hasText: ruleName }) });
        if (!(await d.count())) return;
        await d.locator("summary").click();
        await d.getByLabel(/Delete permanently/).check();
        await submitAndExpect(d, "Delete rule", /.+/);
      },
    ]);
    await admin.locator("#rule-new-name").fill(ruleName);
    await admin.locator("#rule-new-kind").selectOption("flat_fee");
    await admin.locator("#rule-new-value").fill("700");
    await admin.locator("#rule-new-scope").selectOption("trail");
    await admin.locator("#rule-new-trail").selectOption({ label: PRICE_TRAIL.name });
    await submitAndExpect(admin.locator("#rules"), "Create rule", /Pricing rule created/);
    await ruleDetails().waitFor({ timeout: UI });
  });

  await t.test("live preview shows the rule, then the edited value without a reload", async () => {
    await admin.getByLabel("Trail", { exact: true }).selectOption({ label: new RegExp(`^${esc(PRICE_TRAIL.name)} \\(`) });
    await admin.getByLabel("Hike date", { exact: true }).fill(date);
    await admin.getByLabel("Party size", { exact: true }).fill("2");
    await assertText(admin.getByRole("table", { name: "Every line of the quote" }), new RegExp(esc(ruleName)));
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
    await admin.getByLabel("Trail", { exact: true }).selectOption({ label: new RegExp(`^${esc(CLOSE_TRAIL.name)} \\(`) });
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
    const rows = await auditRows(admin, { action: "pricing.rule_updated" });
    const row = rows.find((r) => r.includes(ruleName));
    assert.ok(row, `pricing.rule_updated for ${ruleName} missing`);
    assert.match(row, /"value":\s*700[\s\S]*"value":\s*1234/);
  });

  await t.test("deleting the rule removes the fee from checkout", async () => {
    await gotoOk(admin, "/admin/pricing");
    await ruleDetails().locator("summary").click();
    await ruleDetails().getByLabel(/Delete permanently/).check();
    await submitAndExpect(ruleDetails(), "Delete rule", /.+/);
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
        if (await card.getByRole("button", { name: "Turn on" }).count()) await submitAndExpect(card, "Turn on", /turned on/);
      },
    ]);
    await gotoOk(admin, "/admin/flags");
    await assertText(flagCard(), /On/);
    await submitAndExpect(flagCard(), "Turn off", /addon_meal_pack turned off/);
    await flagCard().getByRole("button", { name: "Turn on" }).waitFor({ timeout: UI });
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
    assert.match(rows[0], /"from":\s*false[\s\S]*"to":\s*true/);
    assert.match(rows[1], /"from":\s*true[\s\S]*"to":\s*false/);
    assert.ok(rows[0].includes(ADMIN) && rows[1].includes(ADMIN));
  });
});

// ---------------------------------------------------------------------------
// 8. Dead job retry
// ---------------------------------------------------------------------------
test("a dead job is re-queued from /admin/jobs, then runs", { timeout: 180_000 }, async (t) => {
  await gotoOk(admin, "/admin/jobs"); // default filter: dead
  const deadRows = admin.locator("#queue tr").filter({ has: admin.getByRole("button", { name: "Retry" }) }).filter({ hasText: /Dead/ });
  if (!(await deadRows.count())) {
    t.skip("no dead job in this database (the seed provides one; it may have been retried by an earlier run)");
    return;
  }
  const row = deadRows.first();
  const [, jobId, kind] = (await row.innerText()).match(/#(\d+)\s+([a-z0-9_.:-]+)/i);
  await assertText(row, /3 \/ 3|(\d+) \/ \1/);
  await row.getByRole("button", { name: "Retry" }).click();
  // The row leaves the dead list once re-queued.
  await admin.locator("#queue tr").filter({ hasText: `#${jobId} ${kind}` }).waitFor({ state: "detached", timeout: UI });

  await gotoOk(admin, `/admin/jobs?status=all&kind=${encodeURIComponent(kind)}`);
  const jobRow = () => admin.locator("#queue tr").filter({ hasText: `#${jobId} ${kind}` });
  await assertText(jobRow(), /Queued|Succeeded|Running/);

  await runJobs();
  await gotoOk(admin, `/admin/jobs?status=all&kind=${encodeURIComponent(kind)}`);
  await assertText(jobRow(), /Succeeded/);

  const rows = await auditRows(admin, { action: "job.retried", entityId: jobId });
  assert.ok(rows.length >= 1 && rows[0].includes(ADMIN) && /"from":\s*"dead"/.test(rows[0]), `job.retried audit missing:\n${rows.join("\n")}`);
});

// ---------------------------------------------------------------------------
// 9. Marketing draft workflow
// ---------------------------------------------------------------------------
test("marketing draft: generate (simulated weather labeled with fetched time) → submit → approve → mark published", { timeout: 240_000 }, async () => {
  await gotoOk(admin, "/admin/marketing");
  await admin.locator("#mk-trail").selectOption({ label: `${CLOSE_TRAIL.name} (demo)` });
  await admin.locator("#mk-channel").selectOption("newsletter");
  await Promise.all([admin.waitForURL(/\/admin\/marketing\/[0-9a-f-]{36}\?generated=1$/, { timeout: NAV }), admin.getByRole("button", { name: "Generate draft" }).click()]);
  const draftId = new URL(admin.url()).pathname.split("/").pop();
  const main = admin.locator("main");
  await assertText(main, /Draft generated from sourced facts/);

  // Honesty: simulated weather is labeled, with the fetched time; demo trail warning shown.
  const weather = admin.locator("#provenance");
  await assertText(weather, /Simulated weather/);
  await assertText(weather, /fetched/);
  assert.equal(await weather.locator("time").count() >= 1, true, "fetched time is rendered as <time>");
  await assertText(admin.locator("#text"), /SIMULATED demo data, not a real forecast \(generated [^)]+\)/);
  await assertText(main, /Demonstration trail \(fictional\): do not publish as a real place/);
  await assertText(admin.locator("header"), /Draft/);

  await submitAndExpect(admin.locator("#edit"), "Submit for review", /Submitted for review/);
  await assertText(admin.locator("header"), /In review/i);

  // Approval requires acknowledging the warnings (server also refuses without it).
  await admin.locator("#md-ack").check();
  await submitAndExpect(admin.locator("#review"), "Approve draft", /Approved\. It can now be marked as published/);
  await assertText(admin.locator("header"), /Approved/);

  await admin.locator("#md-pub").check();
  await submitAndExpect(admin.locator("#review"), "Mark as published", /Marked as published/);
  await admin.reload();
  await assertText(admin.locator("header"), /Published/);
  assert.equal(await admin.locator("#edit").count(), 0, "published drafts are no longer editable");
  await assertText(main, /Marked published/);

  const rows = await auditRows(admin, { entityId: draftId });
  for (const a of ["marketing.draft_generated", "marketing.draft_submitted", "marketing.draft_approved", "marketing.draft_published"]) {
    assert.ok(rows.some((r) => r.includes(a)), `${a} missing from audit:\n${rows.join("\n")}`);
  }
});

// ---------------------------------------------------------------------------
// 10. Staff roles
// ---------------------------------------------------------------------------
test("staff roles: grant then revoke (effective on the next request); the last admin cannot be removed", { timeout: 240_000 }, async (t) => {
  const memberCard = (page, email) => page.locator("#staff li").filter({ has: page.getByText(email, { exact: true }) }).first();
  const roleRow = (page, email, role) => memberCard(page, email).locator("li").filter({ hasText: new RegExp(`^${role}\\b`) });
  const revoke = async (page, email, role) => {
    const row = roleRow(page, email, role);
    await row.locator("summary", { hasText: "Revoke" }).click();
    await row.getByRole("checkbox").check();
    await submitAndExpect(row, `Revoke ${role}`, new RegExp(`Revoked ${role}`));
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
        const row = roleRow(p, customerEmail, role);
        if (await row.count()) await revoke(p, customerEmail, role);
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
    const href = await admin.locator('main a[href^="/admin/customers/"]').first().getAttribute("href");
    const userId = href.split("/").pop();
    const rows = await auditRows(admin, { action: "staff.role_", entityId: userId });
    const has = (action, role) => rows.some((r) => r.includes(action) && new RegExp(`"role":\\s*"${role}"`).test(r));
    assert.ok(has("staff.role_granted", "support"), `grant support missing:\n${rows.join("\n")}`);
    assert.ok(has("staff.role_revoked", "support"), "revoke support missing");
    assert.ok(has("staff.role_granted", "admin"), "grant admin missing");
    assert.ok(has("staff.role_revoked", "admin"), "revoke admin missing");
    assert.deepEqual(adminErrors, [], `admin console errors:\n${adminErrors.join("\n")}`);
  });
});
