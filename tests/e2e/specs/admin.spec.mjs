/**
 * Admin shell — end-to-end spec (node:test + Playwright).
 *
 * Covers:
 *  - every /admin page (incl. the customer detail page) loads for admin@ with no error
 *    boundary, no console errors and no horizontal scrolling at 390 px;
 *  - RBAC: signed-out → login (with the deep link kept), a customer gets /forbidden,
 *    support@ and operator@ only see and open the sections their permissions allow;
 *  - a dead job is re-queued from /admin/jobs and then runs;
 *  - staff role grant + revoke (takes effect on the next request), the last admin role
 *    cannot be removed (even from a stale page), and the audit log records all of it;
 *  - admin action confirmations stay announced (aria-live) after the page re-renders
 *    without the form that sent them (a revoked role);
 *  - overview shows the background job runner's health; the audit filter lists the exact
 *    action codes.
 *
 * Independence: the spec signs up its own customer (unique email per run) and restores
 * every global change (staff roles) in `after` even when a test fails.
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
import { randomUUID } from "node:crypto";
import { BASE, login, newBrowser, runJobs } from "../helpers.mjs";

const ADMIN = "admin@demo.ghostguide.test";
const SUPPORT = "support@demo.ghostguide.test";
const OPERATOR = "operator@demo.ghostguide.test";
const HIKER = "hiker@demo.ghostguide.test";
const CUSTOMER_PASSWORD = "qa-admin-pass-123";
const NAV = 30_000;
const UI = 15_000;

const run = randomUUID().slice(0, 8);
let ipCounter = 1;
const fakeIp = () => `10.${(parseInt(run.slice(0, 2), 16) % 250) + 1}.${(parseInt(run.slice(2, 4), 16) % 250) + 1}.${100 + (ipCounter++ % 150)}`;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// fixtures + cleanup registry
// ---------------------------------------------------------------------------
let browser;
let admin; // desktop admin page
let customerCtx;
let customer;
let customerEmail;
const cleanups = []; // [label, async fn(adminPage)]

before(async () => {
  browser = await newBrowser();
  ({ page: admin } = await staffPage(browser, ADMIN));
  customerCtx = await newCtx(browser, { width: 390, height: 844 });
  customer = await customerCtx.newPage();
  customerEmail = await signUp(customer, "cust");
});

after(async () => {
  // Restore global state even if tests failed (other specs share this database).
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
    const paths = [
      ["/admin", "Overview"],
      ["/admin/customers", "Customers"],
      ["/admin/support", "Support tickets"],
      ["/admin/jobs", "Jobs & integrations"],
      ["/admin/flags", "Feature flags"],
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

    // The customer detail page, reached through the list.
    await gotoOk(page, `/admin/customers?q=${encodeURIComponent(HIKER)}`);
    const link = page.locator('main a[href^="/admin/customers/"]').first();
    await link.waitFor({ timeout: UI });
    await visit(await link.getAttribute("href"));
    await assertText(page.locator("main"), /Support tickets/);

    // No flags are defined in this version: the page says so instead of showing an empty list.
    await gotoOk(page, "/admin/flags");
    await assertText(page.locator("main"), /No feature flags are defined/);

    // Mobile admin menu exposes every section to an admin.
    await gotoOk(page, "/admin");
    await page.getByText("Admin menu").click();
    const nav = page.getByRole("navigation", { name: "Admin sections" }).first();
    for (const label of ["Overview", "Customers", "Support", "Jobs & integrations", "Feature flags", "Staff roles", "Audit log"]) {
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
      await page.goto("/admin/staff");
      await page.waitForURL((u) => u.pathname === "/login", { timeout: NAV });
      assert.equal(new URL(page.url()).searchParams.get("next"), "/admin/staff", "the deep link must survive the login redirect");
    } finally {
      await ctx.close();
    }
  });

  await t.test("a customer gets /forbidden for /admin and admin sub-pages", async () => {
    await expectForbidden(customer, "/admin");
    await expectForbidden(customer, "/admin/staff");
    await expectForbidden(customer, "/admin/customers");
  });

  await t.test("support@ cannot open flags, staff, audit or jobs and never sees phone numbers or coordinates", async () => {
    const { ctx, page } = await staffPage(browser, SUPPORT);
    const errors = watchErrors(page);
    try {
      await gotoOk(page, "/admin");
      await page.getByRole("heading", { level: 1, name: "Overview" }).waitFor({ timeout: UI });
      const nav = page.getByRole("navigation", { name: "Admin sections" }).last();
      for (const label of ["Customers", "Support"]) await nav.getByRole("link", { name: label, exact: true }).waitFor({ timeout: UI });
      for (const label of ["Feature flags", "Staff roles", "Audit log", "Jobs & integrations"]) {
        assert.equal(await nav.getByRole("link", { name: label, exact: true }).count(), 0, `support@ should not see "${label}" in the admin menu`);
      }
      for (const p of ["/admin/flags", "/admin/staff", "/admin/audit", "/admin/jobs"]) await expectForbidden(page, p);

      // Customer detail: no phone numbers / precise coordinates in the page.
      await gotoOk(page, `/admin/customers?q=${encodeURIComponent(HIKER)}`);
      const link = page.locator('main a[href^="/admin/customers/"]').first();
      await link.waitFor({ timeout: UI });
      await Promise.all([page.waitForURL(/\/admin\/customers\/[0-9a-f-]{36}$/, { timeout: NAV }), link.click()]);
      await ready(page);
      await assertText(page.locator("main"), /Support tickets/);
      const text = await page.locator("main").innerText();
      assert.doesNotMatch(text, /-?\d{2,3}\.\d{4,}/, "no precise coordinates on the customer page for support@");
      assert.doesNotMatch(text, /\+?\d[\d\s().-]{8,}\d/, "no phone numbers on the customer page for support@");
      assert.deepEqual(errors, [], `console errors:\n${errors.join("\n")}`);
    } finally {
      await ctx.close();
    }
  });

  await t.test("operator@ cannot manage flags, staff or the audit log, but can run jobs", async () => {
    const { ctx, page } = await staffPage(browser, OPERATOR);
    try {
      await gotoOk(page, "/admin");
      const nav = page.getByRole("navigation", { name: "Admin sections" }).last();
      await nav.getByRole("link", { name: "Jobs & integrations", exact: true }).waitFor({ timeout: UI });
      for (const label of ["Feature flags", "Staff roles", "Audit log"]) {
        assert.equal(await nav.getByRole("link", { name: label, exact: true }).count(), 0, `operator@ should not see "${label}"`);
      }
      for (const p of ["/admin/flags", "/admin/staff", "/admin/audit"]) await expectForbidden(page, p);
      await gotoOk(page, "/admin/jobs");
      await page.getByRole("heading", { level: 1, name: "Jobs & integrations" }).waitFor({ timeout: UI });
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Dead job retry
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
// 4. Staff roles (and confirmations that outlive their form)
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
    await expectForbidden(customer, "/admin/flags"); // support only
  });

  await t.test("unknown emails are refused", async () => {
    await grant(`nobody-${run}@example.test`, "support", /No account with that email/);
  });

  await t.test("revoking support takes /admin away again; the confirmation outlives the removed form", async () => {
    await gotoOk(admin, "/admin/staff");
    await revoke(admin, customerEmail, "support");
    await memberCard(admin, customerEmail).waitFor({ state: "detached", timeout: UI });
    // The revoke form is gone with the role, but the success is still announced (aria-live).
    await expectStatus(admin, /Revoked support\./, 5_000);
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
// 5. Overview job-runner health, audit filter labels
// ---------------------------------------------------------------------------
test("overview shows job-runner health; audit filter shows exact codes", { timeout: 120_000 }, async () => {
  await gotoOk(admin, "/admin");
  const runnerRow = admin.locator("main li").filter({ hasText: "Background job runner" });
  await assertText(runnerRow, /On schedule|Delayed/);
  if ((await runnerRow.innerText()).includes("Delayed")) {
    await assertText(admin.locator("#alerts"), /Background jobs have not run (for \d+ min|yet in this deployment) — background work is delayed/);
  }
  assert.doesNotMatch(await admin.locator("#alerts").innerText(), /\(s\)/, "alert titles are pluralized properly");

  await gotoOk(admin, "/admin/audit");
  const options = await admin.locator("#au-action option").evaluateAll((os) => os.filter((o) => o.value).map((o) => [o.value, o.textContent.trim()]));
  assert.ok(options.length > 0, "the audit action filter lists actions");
  for (const [value, label] of options) assert.equal(label, value, "audit filter options show the exact action code");
});
