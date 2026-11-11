/**
 * Commerce slice — end-to-end spec (node:test + Playwright).
 *
 * Covers: sign-up → saved trip → checkout price transparency (weekday vs
 * Saturday, group discount, add-ons) → simulated checkout (clearly labeled)
 * → success page shows the REAL booking status → duplicate webhook
 * redelivery is a no-op → background jobs → per-partner add-on statuses
 * (locker code for the owner, shuttle awaiting explicit confirmation) →
 * receipt → cancellation with policy/refund preview → refund after jobs;
 * declined payments; another customer gets 404s; an admin-blocked date is
 * refused at checkout with a clear message; locker gear held in one
 * customer's checkout is not offered to another, and a staff-cancelled
 * pending checkout frees it and says no payment had been completed.
 *
 * Independent of other specs: it signs up its own customers (unique emails
 * per run), uses dates chosen at random from a wide window (so re-runs on a
 * dirty database do not collide on capacity), and restores any availability
 * block it creates. Each browser context sends its own X-Forwarded-For so the
 * per-client auth rate limits of a shared suite run are not exhausted by this
 * spec (and vice versa).
 *
 * Run: E2E_BASE_URL=http://localhost:3202 E2E_CRON_SECRET=… node --test tests/e2e/specs/commerce.spec.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BASE, login, newBrowser, runJobs } from "../helpers.mjs";

const TZ = "America/Los_Angeles"; // demo region (Ghost Ridge) time zone
const TRAIL_SLUG = "lantern-creek-loop";
const TRAIL_NAME = "Lantern Creek Loop";
const ADMIN_EMAIL = "admin@demo.ghostguide.test";
const CUSTOMER_PASSWORD = "qa-commerce-pass-123";
const NAV = 30_000;
const UI = 15_000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const run = randomUUID().slice(0, 8);
let ipCounter = 1;
const fakeIp = () => `10.${(parseInt(run.slice(0, 2), 16) % 250) + 1}.${parseInt(run.slice(2, 4), 16) % 250}.${ipCounter++}`;

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
/** "Sat, Nov 21" style label (UTC formatting of a calendar date, like the app). */
const shortDay = (iso) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
const longDay = (iso) => new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
/** Seeded latest-finish estimates for the demo region (app_settings.latest_finish_by_month). */
const LATEST_FINISH = { 1: "15:45", 2: "16:30", 3: "17:15", 4: "19:00", 5: "19:45", 6: "20:15", 7: "20:00", 8: "19:00", 9: "18:15", 10: "17:15", 11: "15:45", 12: "15:45" };
const latestFinishFor = (iso) => LATEST_FINISH[Number(iso.slice(5, 7))];

/** "$1,234.50" / "-$7.60" / "−$7.60" → cents */
function cents(text) {
  const t = text.replace(/\s/g, "");
  const neg = /^[-−]/.test(t);
  const n = Math.round(Number(t.replace(/[^0-9.]/g, "")) * 100);
  return neg ? -n : n;
}

async function newCustomerContext(browser, viewport = { width: 390, height: 844 }) {
  return browser.newContext({ viewport, baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": fakeIp() } });
}

/** Collect console errors / page errors so flows can assert a clean console. */
function watchErrors(page) {
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${page.url()} :: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror ${page.url()} :: ${e.message}`));
  return errors;
}

async function signUp(page, label) {
  const email = `qa-commerce-${label}-${run}-${Date.now()}@example.test`;
  await page.goto("/signup");
  await page.getByLabel("Full name").fill(`QA ${label} ${run}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(CUSTOMER_PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: NAV }),
    page.getByRole("button", { name: "Create account" }).click(),
  ]);
  return email;
}

/** Save a trip for the Lantern Creek Loop from the personalized results page. */
async function createSavedTrip(page, { date, party = 2 }) {
  const q = new URLSearchParams({ experience: "some", fitness: "moderate", pace: "steady", hours: "6", date, start: "08:30", party: String(party), trail: TRAIL_SLUG });
  await page.goto(`/plan/results?${q}`, { timeout: NAV });
  const save = page.getByRole("button", { name: `Save this trip (${TRAIL_NAME})` }).first();
  await save.waitFor({ timeout: NAV });
  await Promise.all([page.waitForURL(/\/trips\/[0-9a-f-]{36}$/, { timeout: NAV }), save.click()]);
  const tripId = new URL(page.url()).pathname.split("/").pop();
  await assertText(page.locator("main"), /This hike is saved but not booked yet/);
  return tripId;
}

async function assertText(locator, re, timeout = UI) {
  await locator.filter({ hasText: re }).first().waitFor({ timeout }).catch(async () => {
    const actual = await locator.first().innerText().catch(() => "<no element>");
    assert.fail(`Expected ${re} in:\n${actual.slice(0, 2000)}`);
  });
}

async function mainText(page) {
  return page.locator("main").innerText();
}

/** Parse the price table into [{label, cents, kind}] plus total. */
async function readQuote(page, tableName = "Price quote") {
  const table = page.getByRole("table", { name: tableName });
  await table.waitFor({ timeout: UI });
  const rows = await table.locator("tbody tr").evaluateAll((trs) =>
    trs.map((tr) => {
      const th = tr.querySelector("th");
      const td = tr.querySelector("td");
      const sub = th?.querySelector("span")?.textContent ?? "";
      const label = (th?.textContent ?? "").replace(sub, "").trim();
      return { label, sub: sub.trim(), amount: (td?.textContent ?? "").trim() };
    }),
  );
  const totalText = await table.locator("tfoot tr").first().locator("td").innerText();
  return { lines: rows.map((r) => ({ label: r.label, kind: r.sub, cents: cents(r.amount) })), totalCents: cents(totalText) };
}

async function setCheckoutChoices(page, { date, party }) {
  const dateInput = page.locator("#hikeDate");
  await dateInput.waitFor({ timeout: UI });
  if ((await dateInput.inputValue()) !== date) {
    await dateInput.fill(date);
    await page.waitForURL((u) => u.searchParams.get("date") === date, { timeout: UI });
  }
  const partySelect = page.getByLabel("Number of hikers");
  if ((await partySelect.inputValue()) !== String(party)) {
    await partySelect.selectOption(String(party));
    await page.waitForURL((u) => u.searchParams.get("party") === String(party), { timeout: UI });
  }
  await page.getByText("Updating price…").waitFor({ state: "detached", timeout: UI }).catch(() => {});
  await page.getByRole("table", { name: "Price quote" }).getByText(`Self-guided experience × ${party}`).waitFor({ timeout: UI });
}

async function toggleAddon(page, name, code, on = true) {
  const box = page.getByRole("checkbox", { name: new RegExp(name) });
  if (on) await box.check();
  else await box.uncheck();
  await page.waitForURL((u) => ((u.searchParams.get("addons") ?? "").split(",").includes(code)) === on, { timeout: UI });
  await page.getByText("Updating price…").waitFor({ state: "detached", timeout: UI }).catch(() => {});
}

/** Submit the checkout form and land on the simulated provider page. */
async function continueToPayment(page) {
  await Promise.all([
    page.waitForURL(/\/checkout\/demo\/demo_cs_[0-9a-f-]{36}$/, { timeout: NAV }),
    page.getByRole("button", { name: /Continue to secure payment/ }).click(),
  ]);
  return new URL(page.url()).pathname.split("/").pop();
}

async function bookingBadgeText(page) {
  const badge = page.locator("span", { hasText: /^Booking status: / }).first();
  await badge.waitFor({ timeout: UI });
  return (await badge.textContent()).replace("Booking status:", "").trim();
}

async function runJobsUntilQuiet(maxRounds = 4) {
  for (let i = 0; i < maxRounds; i++) {
    const r = await runJobs();
    if (!r.claimed) return;
  }
}

/** Admin: find a customer's booking id (optionally by status) via the admin bookings search. */
async function adminFindBookingId(adminPage, email, status) {
  const qs = new URLSearchParams({ q: email });
  if (status) qs.set("status", status);
  await adminPage.goto(`/admin/bookings?${qs}`, { timeout: NAV });
  const link = adminPage.locator('main a[href^="/admin/bookings/"]').filter({ hasText: TRAIL_NAME }).first();
  await link.waitFor({ timeout: UI });
  const href = await link.getAttribute("href");
  return href.split("/").pop();
}

// ---------------------------------------------------------------------------
// shared fixtures (each test creates its own trips)
// ---------------------------------------------------------------------------

let browser;
let ownerCtx;
let owner;
let ownerEmail;
let ownerErrors;
let adminCtx;
let admin;
const today = regionToday();

before(async () => {
  browser = await newBrowser();
  ownerCtx = await newCustomerContext(browser);
  owner = await ownerCtx.newPage();
  ownerErrors = watchErrors(owner);
  ownerEmail = await signUp(owner, "owner");

  adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": fakeIp() } });
  admin = await adminCtx.newPage();
  await login(admin, ADMIN_EMAIL);
});

after(async () => {
  await browser?.close();
});

// ---------------------------------------------------------------------------
// 1. Transparent pricing on the checkout page
// ---------------------------------------------------------------------------

test("checkout shows transparent, server-computed price lines: weekday vs Saturday, group discount and add-ons", { timeout: 180_000 }, async () => {
  const weekday = nextDow(addDays(today, 7 * randInt(6, 20)), 3); // a Wednesday 6–20 weeks out
  const saturday = nextDow(weekday, 6);
  const tripId = await createSavedTrip(owner, { date: weekday, party: 2 });

  await owner.goto(`/trips/${tripId}`);
  const fromText = await owner.getByText(/From \$[\d.,]+ per person/).innerText();
  const perPerson = cents(fromText.match(/\$[\d.,]+/)[0]);
  assert.ok(perPerson > 0, "trip page shows a per-person base price");

  await owner.getByRole("link", { name: "Book this hike" }).click();
  await owner.waitForURL(new RegExp(`/trips/${tripId}/checkout`), { timeout: NAV });
  await assertText(owner.locator("main"), /Book your hike/i);
  // Simulation is labeled before the customer continues.
  await assertText(owner.locator("main"), /Simulated payment/);
  await assertText(owner.locator("main"), /next page is a simulated checkout\. No real payment is taken/);
  await assertText(owner.locator("main"), /Cancellation policy/);

  // Weekday, 2 hikers: base only, no weekend / group lines.
  await setCheckoutChoices(owner, { date: weekday, party: 2 });
  let q = await readQuote(owner);
  assert.deepEqual(q.lines.find((l) => /Self-guided experience × 2/.test(l.label))?.cents, perPerson * 2);
  assert.ok(!q.lines.some((l) => /weekend/i.test(l.label)), `no weekend line on a weekday: ${JSON.stringify(q.lines)}`);
  assert.ok(!q.lines.some((l) => /group/i.test(l.label)), "no group discount for 2 hikers");
  assert.equal(q.totalCents, q.lines.reduce((s, l) => s + l.cents, 0), "total is the sum of the listed lines");
  const weekdayTotal = q.totalCents;

  // Saturday, 4 hikers: weekend surcharge AND group discount, each labeled with its percentage.
  await setCheckoutChoices(owner, { date: saturday, party: 4 });
  q = await readQuote(owner);
  const base4 = perPerson * 4;
  assert.equal(q.lines.find((l) => /Self-guided experience × 4/.test(l.label))?.cents, base4);
  const weekend = q.lines.find((l) => /weekend/i.test(l.label));
  const group = q.lines.find((l) => /group/i.test(l.label));
  assert.ok(weekend, `weekend surcharge line present on Saturday: ${JSON.stringify(q.lines)}`);
  assert.ok(group, "group discount line present for 4 hikers");
  assert.equal(weekend.kind, "Pricing rule");
  assert.equal(group.kind, "Pricing rule");
  const pct = (label) => Number(label.match(/\(([+-−]?\d+(?:\.\d+)?)%\)/)?.[1].replace("−", "-"));
  assert.ok(pct(weekend.label) > 0 && weekend.cents === Math.round((base4 * pct(weekend.label)) / 100), `weekend amount matches its % (${weekend.label} = ${weekend.cents})`);
  assert.ok(pct(group.label) < 0 && group.cents === Math.round((base4 * pct(group.label)) / 100), `group amount matches its % (${group.label} = ${group.cents})`);
  assert.equal(q.totalCents, q.lines.reduce((s, l) => s + l.cents, 0));
  assert.notEqual(q.totalCents, weekdayTotal);

  // Add-ons are separate, labeled lines (per-person add-on × party size).
  await toggleAddon(owner, "Trailhead gear locker kit", "gear-poles-pack", true);
  await toggleAddon(owner, "Trailhead shuttle", "shuttle-trailhead", true);
  q = await readQuote(owner);
  const gear = q.lines.find((l) => /gear locker kit × 4/i.test(l.label));
  const shuttle = q.lines.find((l) => /Trailhead shuttle/.test(l.label));
  assert.ok(gear && gear.kind === "Add-on" && gear.cents > 0, `gear add-on line: ${JSON.stringify(q.lines)}`);
  assert.ok(shuttle && shuttle.kind === "Add-on" && shuttle.cents > 0, "shuttle add-on line");
  assert.equal(q.totalCents, q.lines.reduce((s, l) => s + l.cents, 0));
  // Shuttle pickup is chosen here but confirmed (time + price) only after booking.
  await assertText(owner.locator("main"), /confirm the exact pickup time and price before any ride is requested/i);

  // A satellite rental must not imply SOS from Ghost Guide — and the disclaimer is stated once, not twice.
  await assertText(owner.locator("main"), /does not provide SOS/);
  const sosMentions = ((await mainText(owner)).match(/does not provide SOS/g) ?? []).length;
  assert.equal(sosMentions, 1, "the SOS disclaimer appears exactly once");

  // An impossible date in the URL renders the form with a clear message (no 500), and payment is disabled.
  for (const bad of ["2026-13-45", "2026-12-32", "2027-02-30"]) {
    const res = await owner.goto(`/trips/${tripId}/checkout?date=${bad}&party=2`);
    assert.equal(res.status(), 200, `${bad} must not be a server error`);
    await assertText(owner.locator("main"), /Choose a valid date\./);
    assert.ok(await owner.getByRole("button", { name: /Continue to secure payment/ }).isDisabled(), `payment disabled for ${bad}`);
  }

  // Nothing is held or booked by just looking at prices.
  await owner.goto(`/trips/${tripId}`);
  await assertText(owner.locator("main"), /This hike is saved but not booked yet/);
});

// ---------------------------------------------------------------------------
// 2. The full paid journey
// ---------------------------------------------------------------------------

test("booking journey: simulated payment, real status, idempotent webhook, add-on fulfillment, shuttle confirmation, receipt, cancellation + refund", { timeout: 420_000 }, async (t) => {
  const saturday = nextDow(addDays(today, 7 * randInt(6, 40)), 6);
  const plannedDate = addDays(saturday, -3); // the customer plans one date, then books another at checkout
  const tripId = await createSavedTrip(owner, { date: plannedDate, party: 2 });
  let sessionId;
  let bookingId;
  let totalCents;
  let receiptNumber;

  await t.test("checkout with Saturday, 4 hikers, gear locker + shuttle → simulated checkout page clearly labeled", async () => {
    await owner.goto(`/trips/${tripId}/checkout`);
    await setCheckoutChoices(owner, { date: saturday, party: 4 });
    await toggleAddon(owner, "Trailhead gear locker kit", "gear-poles-pack", true);
    await toggleAddon(owner, "Trailhead shuttle", "shuttle-trailhead", true);
    const quote = await readQuote(owner);
    totalCents = quote.totalCents;

    sessionId = await continueToPayment(owner);
    const main = owner.locator("main");
    await assertText(main, /Simulated checkout — no real payment/);
    await assertText(main, /No card details are collected and no money moves/);
    assert.ok(await owner.getByText("Simulated provider").isVisible());
    // Amount due equals the quote the customer saw.
    const due = await owner.getByRole("row", { name: /Amount due/ }).locator("td").innerText();
    assert.equal(cents(due), totalCents, "amount due matches the checkout quote");
    assert.equal(await bookingBadgeText(owner), "Awaiting payment");
    assert.ok(await owner.getByRole("button", { name: "Re-deliver last webhook" }).isDisabled(), "re-delivery only after an outcome");
  });

  await t.test("while unpaid, the success URL shows the real (pending) status and never confirms by itself", async () => {
    bookingId = await adminFindBookingId(admin, ownerEmail, "pending_payment");
    await owner.goto(`/checkout/success?booking=${bookingId}`);
    await assertText(owner.locator("main"), /Confirming your payment/);
    assert.equal(await bookingBadgeText(owner), "Awaiting payment");
    assert.ok(!(await mainText(owner)).includes("You're booked"), "success page must not claim a booking before the webhook");
    // The trip page agrees: not booked yet, payment can be completed.
    await owner.goto(`/trips/${tripId}`);
    assert.equal(await bookingBadgeText(owner), "Awaiting payment");
    await assertText(owner.locator("main"), /Complete payment/);
  });

  await t.test("simulate successful payment → success page shows Confirmed with receipt number (webhook processed)", async () => {
    await owner.goto(`/checkout/demo/${sessionId}`);
    await Promise.all([
      owner.waitForURL(/\/checkout\/success\?booking=/, { timeout: NAV }),
      owner.getByRole("button", { name: "Simulate successful payment" }).click(),
    ]);
    assert.equal(new URL(owner.url()).searchParams.get("booking"), bookingId);
    const main = owner.locator("main");
    await assertText(main, /You're booked!/);
    const text = await mainText(owner);
    assert.match(text, new RegExp(`${TRAIL_NAME} on ${longDay(saturday)} for 4 hikers`));
    receiptNumber = text.match(/GG-\d{8}-[A-Z0-9]{6}/)?.[0];
    assert.ok(receiptNumber, "receipt number shown");
    assert.match(text, /Simulated payment — nothing was charged/);
    assert.ok(text.includes(new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(totalCents / 100)), "paid amount shown");
  });

  await t.test("re-delivering the last webhook is recognized as a duplicate (no second payment or confirmation)", async () => {
    await owner.goto(`/checkout/demo/${sessionId}`);
    await assertText(owner.locator("main"), /This simulated payment is complete/);
    assert.equal(await owner.getByRole("button", { name: "Simulate successful payment" }).count(), 0, "cannot pay twice");
    for (let i = 0; i < 2; i++) {
      await owner.getByRole("button", { name: "Re-deliver last webhook" }).click();
      await assertText(owner.locator("main"), /recognized as a duplicate and ignored/, NAV);
    }
    // Admin view: exactly one payment, one processed webhook event, still one confirmed booking.
    await admin.goto(`/admin/bookings/${bookingId}`);
    const payments = admin.getByRole("table", { name: "Payments" });
    await payments.waitFor({ timeout: UI });
    assert.equal(await payments.locator("tbody tr").count(), 1, "exactly one payment recorded");
    const hooks = admin.getByRole("table", { name: "Webhook events" });
    assert.equal(await hooks.locator("tbody tr").count(), 1, "one webhook event row (redeliveries deduplicated)");
    assert.match(await hooks.locator("tbody tr").first().innerText(), /checkout\.session\.completed/);
    assert.match(await admin.locator("main").innerText(), new RegExp(`Receipt ${receiptNumber}`));
    await admin.goto(`/admin/bookings?${new URLSearchParams({ q: ownerEmail, status: "confirmed" })}`);
    const confirmedRows = admin.locator('main a[href^="/admin/bookings/"]').filter({ hasText: TRAIL_NAME });
    await confirmedRows.first().waitFor({ timeout: UI });
    assert.equal(await confirmedRows.count(), 1, "only one confirmed booking for this customer");

    await owner.goto(`/trips/${tripId}`);
    assert.equal(await bookingBadgeText(owner), "Confirmed");
  });

  await t.test("after booking, My trips shows the booked date and party size (not the originally planned ones)", async () => {
    await owner.goto("/trips");
    const card = owner.locator("li").filter({ has: owner.locator(`a[href="/trips/${tripId}"]`) }).first();
    await card.waitFor({ timeout: UI });
    const text = await card.innerText();
    assert.match(text, /Booking status:\s*Confirmed/);
    assert.ok(text.includes(shortDay(saturday)), `My trips card should show the booked hike date ${shortDay(saturday)}, got:\n${text}`);
    assert.match(text, /4 hikers/, "My trips card should show the booked party size");
  });

  await t.test("after booking, the trip itself is re-planned for the booked date and group (itinerary, summary, labels)", async () => {
    await owner.goto(`/trips/${tripId}`);
    const text = await mainText(owner);
    assert.match(text, new RegExp(`${longDay(saturday)}, \\d{4} · start 08:30 · 4 hikers`), "header shows the booked date and group");
    assert.ok(text.includes(`Plan to be off the trail by ${latestFinishFor(saturday)}`), `itinerary uses the booked month's latest-finish estimate (${latestFinishFor(saturday)})`);
    if (latestFinishFor(saturday) !== latestFinishFor(plannedDate)) {
      assert.ok(!text.includes(`Plan to be off the trail by ${latestFinishFor(plannedDate)}`), "no stale latest-finish estimate from the planned month");
    }
    // The template summary names the booked date and is labeled as simulated, not "AI-generated".
    assert.ok(text.includes(`on ${saturday}`), "trip summary names the booked date");
    assert.ok(!text.includes(`on ${plannedDate}.`), "trip summary no longer names the originally planned date");
    assert.ok(text.includes("Simulated AI (template)"));
    assert.ok(!text.includes("AI-generated"), "template text is not labeled AI-generated");
    // The prepare page agrees.
    await owner.goto(`/trips/${tripId}/prepare`);
    assert.ok((await mainText(owner)).includes(longDay(saturday)), "Prepare shows the booked date");
    // A stale "cancel" return URL for a paid booking does not say the checkout failed.
    await owner.goto(`/checkout/cancelled?booking=${bookingId}`);
    assert.equal(await owner.getByRole("heading", { level: 1 }).innerText(), "Your booking is confirmed");
  });

  await t.test("jobs run → each add-on shows its own partner status; locker code visible to the owner; shuttle awaits confirmation", async () => {
    await runJobsUntilQuiet();
    await owner.goto(`/trips/${tripId}`);
    const addons = owner.locator("section, div").filter({ has: owner.getByRole("heading", { name: "Add-ons and partner services" }) }).last();
    await assertText(owner.locator("main"), /Gear locker: confirmed — code ready/, NAV);
    await assertText(owner.locator("main"), /Shuttle: awaiting your confirmation/);
    assert.ok(await addons.getByText("Simulated partner").first().isVisible(), "partner integrations are labeled as simulated");
    await owner.getByText("Show locker access code").click();
    const code = owner.locator('[aria-label^="Access code "]');
    await code.waitFor({ timeout: UI });
    assert.match((await code.innerText()).trim(), /^[0-9A-Z]{4,8}$/);
    // The booking itself stays Confirmed regardless of add-on states.
    assert.equal(await bookingBadgeText(owner), "Confirmed");
  });

  await t.test("shuttle: explicit confirmation of pickup location, time and price is required before the ride request", async () => {
    await owner.goto(`/trips/${tripId}`);
    await Promise.all([
      owner.waitForURL(new RegExp(`/trips/${tripId}/shuttle/[0-9a-f-]{36}$`), { timeout: NAV }),
      owner.getByRole("link", { name: "Review and confirm shuttle" }).click(),
    ]);
    const main = owner.locator("main");
    await assertText(main, /No ride is requested until you confirm the pickup location, time and price/);
    const text = await mainText(owner);
    assert.match(text, /Pickup location\s*\n?\s*\S+/);
    assert.match(text, /Pickup time\s*\n?\s*\w+day, \w+ \d+/, "pickup time shown");
    assert.match(text, /Price\s*\n?\s*\$[\d.]+/, "price shown");
    assert.ok(await owner.getByText("Simulated partner").isVisible());

    // Without ticking the box: browser validation blocks, and the server refuses too.
    const confirmBtn = owner.getByRole("button", { name: "Confirm and request ride" });
    await confirmBtn.click();
    await owner.waitForTimeout(500);
    assert.match(owner.url(), /\/shuttle\//, "still on the shuttle page");
    const box = owner.getByRole("checkbox", { name: /I confirm the pickup location, pickup time and price/ });
    assert.equal(await box.evaluate((el) => el.validity.valueMissing), true);
    await box.evaluate((el) => el.removeAttribute("required"));
    await confirmBtn.click();
    await assertText(main, /Tick the box to confirm the pickup location, pickup time and price/);
    await assertText(main, /Shuttle: awaiting your confirmation/);

    // Explicit confirmation → request sent.
    await box.check();
    await Promise.all([owner.waitForURL(new RegExp(`/trips/${tripId}\\?shuttle=`), { timeout: NAV }), confirmBtn.click()]);
    // Honest copy: the confirmation was received and the ride is being requested (not "confirmed" yet).
    await assertText(owner.locator("main"), /Shuttle confirmation received/);
    await assertText(owner.locator("main"), /now requesting your ride from the shuttle partner \(simulated in this demo\)/);
    await assertText(owner.locator("main"), /Shuttle: (requested|ride confirmed)/);
    await runJobsUntilQuiet();
    await owner.reload();
    await assertText(owner.locator("main"), /Shuttle: ride confirmed/, NAV);
  });

  await t.test("receipt lists the transparent lines and exactly one simulated payment", async () => {
    await owner.goto(`/trips/${tripId}`);
    await Promise.all([owner.waitForURL(/\/bookings\/[0-9a-f-]{36}\/receipt$/, { timeout: NAV }), owner.getByRole("link", { name: "View receipt" }).click()]);
    assert.equal(new URL(owner.url()).pathname, `/bookings/${bookingId}/receipt`);
    const main = owner.locator("main");
    await assertText(main, new RegExp(receiptNumber));
    await assertText(main, /Simulated payment — no money was charged/);
    await assertText(main, /This receipt documents a simulated demo transaction/);
    const lines = await readQuote(owner, "Receipt line items");
    assert.equal(lines.totalCents, totalCents);
    assert.ok(lines.lines.some((l) => /weekend/i.test(l.label)) && lines.lines.some((l) => /group/i.test(l.label)), "receipt keeps adjustment lines");
    const payments = owner.getByRole("table").filter({ has: owner.getByRole("columnheader", { name: "Method" }) }).first();
    assert.equal(await payments.locator("tbody tr").count(), 1, "one payment on the receipt");
    assert.match(await payments.locator("tbody tr").first().innerText(), /Simulated provider/);
    // Nothing refunded yet: "$0.00", never "−$0.00"; the paid time names its zone.
    const summary = await owner.getByRole("region", { name: "Summary" }).innerText();
    assert.match(summary, /Refunded\s*\$0\.00/);
    assert.ok(!/[−-]\$0\.00/.test(summary), `no negative zero: ${summary}`);
    assert.match(await mainText(owner), /Paid \w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s[AP]M\sP[SD]T/);
  });

  await t.test("cancel: policy and refund are shown before confirming; booking ends refunded after jobs", async () => {
    await owner.goto(`/trips/${tripId}`);
    await Promise.all([owner.waitForURL(new RegExp(`/trips/${tripId}/cancel$`), { timeout: NAV }), owner.getByRole("link", { name: "Cancel booking" }).click()]);
    const main = owner.locator("main");
    await assertText(main, /Your refund/);
    await assertText(main, /Cancellation policy/);
    await assertText(main, /Full refund if you cancel at least \d+ hours before your start time/);
    await assertText(main, /These add-ons will be cancelled too/);
    const text = await mainText(owner);
    const paid = cents(text.match(/You paid\s*\n?\s*(\$[\d,.]+)/)[1]);
    const refund = cents(text.match(/Refund if you cancel now\s*\n?\s*(\$[\d,.]+)/)[1]);
    assert.equal(paid, totalCents);
    assert.equal(refund, totalCents, "far-future hike: full refund");
    assert.match(text, /Full refund/);
    assert.match(text, /In demo mode refunds are simulated/);

    const cancelBtn = owner.getByRole("button", { name: /^Cancel and refund \$/ });
    await cancelBtn.click(); // not acknowledged yet → nothing happens
    await owner.waitForTimeout(500);
    assert.match(owner.url(), /\/cancel$/);
    await owner.getByRole("checkbox", { name: /I understand this cancels my booking/ }).check();
    await Promise.all([owner.waitForURL(new RegExp(`/trips/${tripId}\\?cancelled=1`), { timeout: NAV }), cancelBtn.click()]);
    await assertText(owner.locator("main"), /Your trip was cancelled/);
    assert.equal(await bookingBadgeText(owner), "Refund pending");
    await assertText(owner.locator("main"), /Processing/);

    await runJobsUntilQuiet();
    await owner.reload();
    assert.equal(await bookingBadgeText(owner), "Refunded");
    await assertText(owner.locator("main"), /Gear locker: cancelled/);
    await assertText(owner.locator("main"), /Shuttle: cancelled/);
    assert.equal(await owner.getByText("Show locker access code").count(), 0, "locker code no longer offered");

    await owner.goto(`/bookings/${bookingId}/receipt`);
    await assertText(owner.locator("main"), /Refunds/);
    const summary = await owner.getByRole("region", { name: "Summary" }).innerText();
    assert.match(summary, /Net\s*\$0\.00/, `net is zero after a full refund: ${summary}`);
    // The cancel page now explains there is nothing left to do.
    await owner.goto(`/trips/${tripId}/cancel`);
    await assertText(owner.locator("main"), /already cancelled/);
  });
});

// ---------------------------------------------------------------------------
// 2b. A held checkout shows what is held and can be released to change details
// ---------------------------------------------------------------------------

test("checkout in progress: shows what is held, refuses silently switching details, and can be released", { timeout: 240_000 }, async () => {
  const day = nextDow(addDays(today, 7 * randInt(6, 40)), 1); // a Monday
  const tripId = await createSavedTrip(owner, { date: day, party: 2 });
  await owner.goto(`/trips/${tripId}/checkout`);
  await setCheckoutChoices(owner, { date: day, party: 2 });
  await continueToPayment(owner);

  // Back to the checkout: the held date, group and total are spelled out, with continue AND release.
  await owner.goto(`/trips/${tripId}/checkout`);
  const main = owner.locator("main");
  await assertText(main, /Checkout in progress/);
  await assertText(main, /What is held for you/);
  const held = await mainText(owner);
  assert.ok(held.includes(longDay(day)), `held date shown: ${held}`);
  assert.match(held, /2 hikers/);
  assert.match(held, /Total\s*\n?\s*\$[\d,.]+/);
  assert.ok(await owner.getByRole("button", { name: "Continue to payment" }).isVisible());

  // Release → back on the form, pre-filled with what was held, nothing booked.
  await Promise.all([
    owner.waitForURL((u) => u.pathname === `/trips/${tripId}/checkout` && u.searchParams.get("released") === "1", { timeout: NAV }),
    owner.getByRole("button", { name: "Release these spots and change details" }).click(),
  ]);
  await assertText(main, /Your held spots were released/);
  assert.equal(await owner.locator("#hikeDate").inputValue(), day);
  assert.ok(!(await mainText(owner)).includes("Checkout in progress"));

  // New details now go through: 3 hikers.
  await setCheckoutChoices(owner, { date: day, party: 3 });
  await continueToPayment(owner);
  assert.match(await mainText(owner), /3 hikers/, "the simulated checkout is for the NEW group size");
  // Clean up: cancel and return (releases this hold too).
  await Promise.all([owner.waitForURL(/\/checkout\/cancelled/, { timeout: NAV }), owner.getByRole("button", { name: "Cancel and return" }).click()]);
  await assertText(main, /Checkout not completed/);
});

// ---------------------------------------------------------------------------
// 3. Declined payment
// ---------------------------------------------------------------------------

test("declined payment: clear message, nothing booked, spots released, customer can try again", { timeout: 180_000 }, async () => {
  const day = nextDow(addDays(today, 7 * randInt(6, 40)), 2); // a Tuesday
  const tripId = await createSavedTrip(owner, { date: day, party: 1 });
  await owner.goto(`/trips/${tripId}/checkout`);
  await setCheckoutChoices(owner, { date: day, party: 1 });
  await continueToPayment(owner);
  await Promise.all([
    owner.waitForURL(/\/checkout\/cancelled\?booking=[0-9a-f-]{36}.*reason=declined/, { timeout: NAV }),
    owner.getByRole("button", { name: "Simulate declined payment" }).click(),
  ]);
  const declinedId = new URL(owner.url()).searchParams.get("booking");
  await assertText(owner.locator("main"), /Payment declined/);
  assert.equal(await bookingBadgeText(owner), "Payment failed");
  await assertText(owner.locator("main"), /You were not charged/);

  // The success URL cannot be used to claim a booking.
  await owner.goto(`/checkout/success?booking=${declinedId}`);
  const text = await mainText(owner);
  assert.ok(!text.includes("You're booked"), "success page must not show a confirmation for a declined payment");
  assert.equal(await bookingBadgeText(owner), "Payment failed");

  // No receipt for an unpaid booking.
  const r = await owner.goto(`/bookings/${declinedId}/receipt`);
  assert.equal(r.status(), 404);

  // Trip stays saved and bookable again.
  await owner.goto(`/trips/${tripId}`);
  await assertText(owner.locator("main"), /The payment did not go through/);
  await owner.getByRole("link", { name: "Book this hike" }).click();
  await owner.waitForURL(new RegExp(`/trips/${tripId}/checkout`), { timeout: NAV });
  await owner.getByRole("button", { name: /Continue to secure payment/ }).waitFor({ timeout: UI });
  assert.ok(!(await mainText(owner)).includes("Checkout in progress"));
});

// ---------------------------------------------------------------------------
// 4. Isolation between customers
// ---------------------------------------------------------------------------

test("another customer gets 404 for someone else's trip, checkout, receipt and related pages", { timeout: 240_000 }, async () => {
  // Owner books and pays for a trip.
  const day = nextDow(addDays(today, 7 * randInt(6, 40)), 4); // a Thursday
  const tripId = await createSavedTrip(owner, { date: day, party: 2 });
  await owner.goto(`/trips/${tripId}/checkout`);
  await setCheckoutChoices(owner, { date: day, party: 2 });
  await toggleAddon(owner, "Trailhead shuttle", "shuttle-trailhead", true);
  const sessionId = await continueToPayment(owner);
  await Promise.all([owner.waitForURL(/\/checkout\/success\?booking=/, { timeout: NAV }), owner.getByRole("button", { name: "Simulate successful payment" }).click()]);
  const bookingId = new URL(owner.url()).searchParams.get("booking");
  await runJobsUntilQuiet();
  await owner.goto(`/trips/${tripId}`);
  const shuttleHref = await owner.getByRole("link", { name: "Review and confirm shuttle" }).getAttribute("href");

  const otherCtx = await newCustomerContext(browser);
  try {
    const other = await otherCtx.newPage();
    await signUp(other, "intruder");
    const urls = [
      `/trips/${tripId}`,
      `/trips/${tripId}/checkout`,
      `/trips/${tripId}/cancel`,
      shuttleHref,
      `/bookings/${bookingId}/receipt`,
      `/checkout/success?booking=${bookingId}`,
      `/checkout/cancelled?booking=${bookingId}`,
      `/checkout/demo/${sessionId}`,
    ];
    for (const url of urls) {
      const res = await other.goto(url);
      assert.equal(res.status(), 404, `${url} must be 404 for another customer (got ${res.status()})`);
      const body = await other.locator("body").innerText();
      assert.ok(!body.includes(bookingId) && !/GG-\d{8}-[A-Z0-9]{6}/.test(body), `${url} must not leak booking details`);
    }
  } finally {
    await otherCtx.close();
  }
  // The owner still sees everything.
  const ok = await owner.goto(`/bookings/${bookingId}/receipt`);
  assert.equal(ok.status(), 200);
});

// ---------------------------------------------------------------------------
// 5. Capacity: an admin-blocked date is refused
// ---------------------------------------------------------------------------

test("capacity: a date blocked in /admin/availability is refused at checkout with a clear message", { timeout: 240_000 }, async () => {
  // Admin availability lists the next 30 days; pick a weekday 15–28 days out.
  let blockDay = addDays(today, randInt(15, 28));
  while ([0, 6].includes(dow(blockDay))) blockDay = addDays(blockDay, 1);
  const tripId = await createSavedTrip(owner, { date: blockDay, party: 2 });

  // Customer opens checkout for that date while it is still available.
  await owner.goto(`/trips/${tripId}/checkout?date=${blockDay}&party=2`);
  await owner.getByRole("table", { name: "Price quote" }).waitFor({ timeout: UI });
  assert.match(await owner.locator("#availability").innerText(), /spots left/);
  const continueBtn = owner.getByRole("button", { name: /Continue to secure payment/ });
  assert.ok(await continueBtn.isEnabled());

  let defaultCapacity = null;
  /** Edit the day in /admin/availability like an operator would. capacity "" = use the trail default. */
  const setDay = async ({ blocked, capacity = "" }) => {
    await admin.goto("/admin/availability");
    await admin.getByLabel("Trail").selectOption({ label: TRAIL_NAME });
    await Promise.all([admin.waitForURL(/\/admin\/availability\?trail=/, { timeout: NAV }), admin.getByRole("button", { name: "Apply filters" }).click()]);
    const caption = await admin.locator("caption").first().innerText();
    defaultCapacity = Number(caption.match(/default capacity (\d+)/)?.[1]);
    const box = admin.locator(`#av-${blockDay}-blk`);
    const details = admin.locator("details", { has: box });
    await details.locator("summary").click();
    await admin.locator(`#av-${blockDay}-cap`).fill(capacity);
    if (blocked) await box.check();
    else await box.uncheck();
    await admin.locator(`#av-${blockDay}-note`).fill(blocked ? `QA commerce block ${run}` : "");
    await details.getByRole("button", { name: "Save day" }).click();
    const result = details.getByRole("status");
    await result.filter({ hasText: /blocked for new bookings|saved|!/ }).waitFor({ timeout: NAV });
    return result.innerText();
  };

  const blockedMsg = await setDay({ blocked: true });
  assert.match(blockedMsg, new RegExp(`${blockDay} blocked for new bookings`));
  let unblockedMsg = "";
  try {
    // Submitting the stale page is refused server-side with a clear message; no booking is created.
    await continueBtn.click();
    await assertText(owner.locator("main"), /That date is not available\. Please choose another date\./, NAV);
    assert.match(owner.url(), /\/checkout\?/, "stays on the checkout page");

    // Reloading shows the date as unavailable and disables payment.
    await owner.reload();
    assert.match(await owner.locator("#availability").innerText(), /Not available on this date/);
    assert.ok(await owner.getByRole("button", { name: /Continue to secure payment/ }).isDisabled());

    await owner.goto(`/trips/${tripId}`);
    await assertText(owner.locator("main"), /This hike is saved but not booked yet/);
  } finally {
    // Unblock with an EMPTY capacity override ("Empty = default").
    unblockedMsg = await setDay({ blocked: false, capacity: "" });
  }
  await owner.goto(`/trips/${tripId}/checkout?date=${blockDay}&party=2`);
  const availability = await owner.locator("#availability").innerText();
  if (!/spots left/.test(availability)) {
    // Do not leave a zero-capacity day behind for other specs: set the default explicitly, then report.
    await setDay({ blocked: false, capacity: String(defaultCapacity) });
  }
  assert.match(unblockedMsg, new RegExp(`capacity ${defaultCapacity}\\)`), `unblocking with an empty override should restore the default capacity: "${unblockedMsg}"`);
  assert.match(availability, new RegExp(`\\d+ of ${defaultCapacity} spots left`), "the unblocked day is bookable again at default capacity");
});

test("checkout refuses a date on which the trail has a scheduled closure", { timeout: 240_000 }, async () => {
  // Far-future weekday (avoids other specs' dates); the trip itself is planned on an open day.
  let closedDay = addDays(today, randInt(200, 320));
  while ([0, 6].includes(dow(closedDay))) closedDay = addDays(closedDay, 1);
  const tripId = await createSavedTrip(owner, { date: addDays(closedDay, 2), party: 2 });
  const reason = `QA scheduled closure ${run} (bridge repair)`;

  // Admin schedules a full-day "closed" closure for that day.
  await admin.goto("/admin/availability");
  await admin.getByLabel("Trail").selectOption({ label: TRAIL_NAME });
  await Promise.all([admin.waitForURL(/\/admin\/availability\?trail=/, { timeout: NAV }), admin.getByRole("button", { name: "Apply filters" }).click()]);
  const trailId = new URL(admin.url()).searchParams.get("trail");
  await admin.goto(`/admin/trails/${trailId}/closures`);
  await admin.locator("#cl-new-sev").selectOption("closed");
  await admin.locator("#cl-new-reason").fill(reason);
  await admin.locator("#cl-new-start").fill(`${closedDay}T00:00`);
  await admin.locator("#cl-new-end").fill(`${addDays(closedDay, 1)}T00:00`);
  await admin.getByRole("button", { name: "Save closure" }).click();
  await admin.getByRole("status").filter({ hasText: /✓|saved|created|scheduled/i }).first().waitFor({ timeout: NAV });

  let reachedPayment = false;
  try {
    await owner.goto(`/trips/${tripId}/checkout?date=${closedDay}&party=2`);
    await owner.getByLabel("Hike date").waitFor({ timeout: UI });
    const btn = owner.getByRole("button", { name: /Continue to secure payment/ });
    if (await btn.isEnabled()) {
      await btn.click();
      reachedPayment = await owner
        .waitForURL(/\/checkout\/demo\//, { timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
    }
    if (reachedPayment) {
      // Release the hold we just created so the test leaves nothing behind.
      await Promise.all([owner.waitForURL(/\/checkout\/cancelled/, { timeout: NAV }), owner.getByRole("button", { name: "Cancel and return" }).click()]);
    }
    assert.equal(reachedPayment, false, `checkout must not take payment for ${closedDay}, when the trail is scheduled to be closed`);
    await assertText(owner.locator("main"), /closed/i);
  } finally {
    // Remove the closure record.
    await admin.goto(`/admin/trails/${trailId}/closures`);
    const card = admin.locator("li").filter({ hasText: reason }).first();
    await card.locator("summary", { hasText: "Edit" }).click();
    await card.getByLabel("Delete this closure record entirely.").check();
    await card.getByRole("button", { name: "Delete (entered by mistake)" }).click();
    await admin.locator("li").filter({ hasText: reason }).waitFor({ state: "detached", timeout: NAV });
  }
});

// ---------------------------------------------------------------------------
// 5b. Locker gear held in a checkout is not sold twice; staff cancel of a
//     pending checkout frees it and reports honestly that nothing was paid
// ---------------------------------------------------------------------------

test("locker gear held in another customer's checkout is not sold again; a staff-cancelled checkout frees it", { timeout: 300_000 }, async () => {
  const day = nextDow(addDays(today, 7 * randInt(6, 45)), 3); // a Wednesday
  const ctxB = await newCustomerContext(browser);
  const buyerB = await ctxB.newPage();
  try {
    await signUp(buyerB, "gearB");
    const tripB = await createSavedTrip(buyerB, { date: day, party: 2 });
    const tripA = await createSavedTrip(owner, { date: day, party: 4 });

    /** Kits left for the gear add-on on `day`, as customer B's checkout page states it (asked for 12 hikers, so the count is always shown). */
    const kitsLeft = async () => {
      await buyerB.goto(`/trips/${tripB}/checkout?${new URLSearchParams({ date: day, party: "12", addons: "gear-poles-pack" })}`, { timeout: NAV });
      const desc = buyerB.locator("#addon-gear-poles-pack-desc");
      await desc.waitFor({ timeout: UI });
      const text = await desc.innerText();
      const m = text.match(/\((\d+) kits? left\)/);
      assert.ok(m, `kits-left note expected for 12 hikers: ${text}`);
      return Number(m[1]);
    };
    const before = await kitsLeft();
    assert.ok(before >= 4, `this flow needs at least 4 free kits on ${day} (found ${before})`);

    // Customer A holds a checkout for 4 hikers with the gear kit (not paid yet).
    await owner.goto(`/trips/${tripA}/checkout`);
    await setCheckoutChoices(owner, { date: day, party: 4 });
    await toggleAddon(owner, "Trailhead gear locker kit", "gear-poles-pack");
    const sessionA = await continueToPayment(owner);

    // The hold already takes A's kits: B is never offered them (COMMERCE-7).
    assert.equal(await kitsLeft(), before - 4, "held kits count against the locker stock");
    if (before - 4 < 2) {
      await buyerB.goto(`/trips/${tripB}/checkout?${new URLSearchParams({ date: day, party: "2", addons: "gear-poles-pack" })}`, { timeout: NAV });
      await assertText(buyerB.locator("main"), /Not enough locker gear for 2 hikers on this date/);
      assert.ok(await buyerB.getByRole("button", { name: /Continue to secure payment/ }).isDisabled());
    }

    // Staff cancel A's pending checkout: the message says no payment had been completed (COMMERCE-1).
    const bookingA = await adminFindBookingId(admin, ownerEmail, "pending_payment");
    await admin.goto(`/admin/bookings/${bookingA}`, { timeout: NAV });
    assert.ok((await admin.locator("main").innerText()).includes(TRAIL_NAME));
    await admin.getByLabel("Reason (shared with the customer)").fill(`QA commerce: locker maintenance ${run}`);
    await admin.getByLabel(/I understand this cancels the booking/).check();
    await admin.getByRole("button", { name: "Cancel booking" }).click();
    await assertText(admin.locator("body"), /No payment had been completed/, NAV);
    assert.ok(!(await admin.locator("body").innerText()).includes("nothing was charged"), "no unverified 'nothing was charged' claim");

    // The provider session can no longer be paid, and the kits are free again.
    await owner.goto(`/checkout/demo/${sessionA}`);
    await assertText(owner.locator("main"), /This simulated checkout has ended/);
    assert.equal(await owner.getByRole("button", { name: "Simulate successful payment" }).count(), 0, "an ended checkout cannot be paid");
    await owner.goto(`/trips/${tripA}`);
    assert.equal(await bookingBadgeText(owner), "Checkout expired");
    await assertText(owner.locator("main"), /This hike is saved but not booked yet/);
    assert.equal(await kitsLeft(), before, "the cancelled hold released its kits");
  } finally {
    await ctxB.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Hygiene
// ---------------------------------------------------------------------------

test("no uncaught page errors during the customer flows", () => {
  const relevant = ownerErrors.filter((e) => /pageerror/.test(e) || !/Failed to load resource: the server responded with a status of 404/.test(e));
  assert.deepEqual(relevant, []);
});
