/**
 * Safety slice — end-to-end spec (node:test + Playwright).
 *
 * Covers:
 *  - /account profile edit (validation, persistence)
 *  - /account/emergency-contacts add / edit / delete with the consent
 *    attestation; a contact without consent can never be chosen for check-ins
 *  - /account/privacy retention setting, "include my last location in
 *    notices" toggle (and its effect on a real notice), delete location history
 *  - check-in lifecycle on a trip booked through the (simulated) commerce
 *    flow: setup (expected return / grace / reminders), "I'm okay", "Extend my
 *    trip", forced overdue -> exactly one SIMULATED notice per consented
 *    contact (honest wording: last coordinates + time + accuracy + STALE label,
 *    "Ghost Guide has NOT contacted emergency services", no "emergency
 *    detected" / "in danger"), visible in the trip's notice history and to
 *    safety@ in /admin/notifications and /admin/safety; "Finish trip" ends it
 *    and later job runs only add the allowed "finished" follow-up
 *  - trip share links: neutral public page, no location unless included,
 *    revoke -> unavailable, expired -> unavailable
 *  - isolation: another customer gets 404 for /trips/<id>/checkin
 *
 * Self-contained: every customer is created via /signup with a unique email
 * per run, every trip is booked by this spec on a random date, and each
 * top-level test builds the fixtures it needs (memoized), so the tests do not
 * depend on other specs or on their order. Each browser context sends its own
 * X-Forwarded-For so per-client rate limits are not shared with other specs.
 *
 * Forcing a check-in overdue and expiring a share link need direct database
 * access (psql), scoped to rows this spec created:
 *   E2E_DATABASE_URL (default postgres://postgres:postgres@127.0.0.1:54322/ghostguide_e2e_safety)
 *
 * Run: E2E_BASE_URL=http://localhost:3204 E2E_CRON_SECRET=… node --test tests/e2e/specs/safety.spec.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { BASE, login, newBrowser, runJobs } from "../helpers.mjs";

const TZ = "America/Los_Angeles"; // demo region (Ghost Ridge) time zone
const TRAIL_SLUG = "lantern-creek-loop";
const TRAIL_NAME = "Lantern Creek Loop";
const SAFETY_EMAIL = "safety@demo.ghostguide.test";
const OTHER_CUSTOMER_EMAIL = "hiker2@demo.ghostguide.test";
const CUSTOMER_PASSWORD = "qa-safety-pass-123";
const DB_URL = process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/ghostguide_e2e_safety";
const NAV = 30_000;
const UI = 15_000;
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

/** Phrases a check-in notice / safety page must never contain. */
const BANNED = [/emergency detected/i, /in danger/i, /\bSOS\b/, /rescue/i, /emergency alert/i];
const COORDS = /-?\d{1,3}\.\d{5},\s*-?\d{1,3}\.\d{5}/;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const run = randomUUID().slice(0, 8);
let ipCounter = 1;
const fakeIp = () => `10.${(parseInt(run.slice(0, 2), 16) % 200) + 30}.${parseInt(run.slice(2, 4), 16) % 250}.${ipCounter++ % 250}`;
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const uuidRe = /^[0-9a-f-]{36}$/;

/** "YYYY-MM-DD" in the region time zone, `days` from now. */
function regionDate(days) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + days * 86_400_000));
}

/** datetime-local value ("YYYY-MM-DDTHH:MM") of an instant in the region time zone. */
function regionLocalInput(d) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** "Thu, Nov 5, 1:30 AM PST" — same format as the app's check-in times. */
function checkinTime(d) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
}

/** Run SQL against the e2e database; returns rows as arrays of strings. */
function sql(query) {
  const out = execFileSync("psql", [DB_URL, "-X", "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8", env: { ...process.env, PGCONNECT_TIMEOUT: "10" } });
  return out
    .split("\n")
    .filter((l) => l.length && !/^(UPDATE|INSERT|DELETE) \d+/.test(l))
    .map((l) => l.split("\t"));
}
/** Run an UPDATE and return the affected row count. */
function sqlUpdate(query) {
  const out = execFileSync("psql", [DB_URL, "-X", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8" });
  return Number(out.match(/UPDATE (\d+)/)?.[1] ?? 0);
}
const assertUuid = (id) => assert.match(id, uuidRe, `expected a uuid, got ${id}`);

async function newCtx(browser, viewport = MOBILE) {
  const context = await browser.newContext({ viewport, baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": fakeIp() } });
  return context;
}

/** Collect console errors / page errors. */
function watchErrors(page, sink) {
  page.on("console", (m) => {
    if (m.type() === "error") sink.push(`${page.url()} :: ${m.text()}`);
  });
  page.on("pageerror", (e) => sink.push(`pageerror ${page.url()} :: ${e.message}`));
}

async function assertText(locator, re, timeout = UI) {
  await locator
    .filter({ hasText: re })
    .first()
    .waitFor({ timeout })
    .catch(async () => {
      const actual = await locator
        .first()
        .innerText()
        .catch(() => "<no element>");
      assert.fail(`Expected ${re} in:\n${actual.slice(0, 2500)}`);
    });
}

async function signUp(page, label, fullName) {
  const email = `qa-safety-${label}-${run}-${Date.now()}@example.test`;
  await page.goto("/signup");
  await page.getByLabel("Full name").fill(fullName);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(CUSTOMER_PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: NAV }),
    page.getByRole("button", { name: "Create account" }).click(),
  ]);
  return email;
}

/** Save a Lantern Creek Loop trip, then book it with the simulated payment provider. Returns the trip id. */
async function bookTrip(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const date = regionDate(randInt(10, 80));
    const q = new URLSearchParams({ experience: "some", fitness: "moderate", pace: "steady", hours: "6", date, start: "08:30", party: "1", trail: TRAIL_SLUG });
    await page.goto(`/plan/results?${q}`, { timeout: NAV });
    const save = page.getByRole("button", { name: `Save this trip (${TRAIL_NAME})` }).first();
    await save.waitFor({ timeout: NAV });
    await Promise.all([page.waitForURL(/\/trips\/[0-9a-f-]{36}$/, { timeout: NAV }), save.click()]);
    const tripId = new URL(page.url()).pathname.split("/").pop();
    await page.goto(`/trips/${tripId}/checkout?date=${date}&party=1`);
    const cont = page.getByRole("button", { name: /Continue to secure payment/ });
    await cont.waitFor({ timeout: UI });
    await page.getByText("Updating price…").waitFor({ state: "detached", timeout: UI }).catch(() => {});
    if (await cont.isDisabled()) continue; // date unavailable (blocked / full) — try another
    await Promise.all([page.waitForURL(/\/checkout\/demo\/demo_cs_[0-9a-f-]{36}$/, { timeout: NAV }), cont.click()]);
    await Promise.all([
      page.waitForURL(/\/checkout\/success\?booking=/, { timeout: NAV }),
      page.getByRole("button", { name: "Simulate successful payment" }).click(),
    ]);
    await assertText(page.locator("main"), /You're booked!/, NAV);
    return tripId;
  }
  throw new Error("could not book a trip on any of 4 random dates");
}

/** Add an emergency contact through the UI. */
async function addContact(page, { name, phone = "", email = "", relationship = "", consent }) {
  await page.goto("/account/emergency-contacts");
  const add = page.locator("section", { has: page.getByRole("heading", { name: "Add a contact", level: 2 }) }).last();
  await add.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  if (phone) await add.getByRole("textbox", { name: "Mobile phone", exact: true }).fill(phone);
  if (email) await add.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  if (relationship) await add.getByRole("textbox", { name: "Relationship", exact: true }).fill(relationship);
  const box = add.getByRole("checkbox", { name: /I confirm this person has agreed/ });
  if (consent) await box.check();
  else await box.uncheck();
  await add.getByRole("button", { name: "Add contact" }).click();
  await assertText(add.getByRole("status"), new RegExp(`${name} was added`));
  return add;
}

/** The card for a saved contact on /account/emergency-contacts. */
function contactCard(page, name) {
  return page.locator("li", { has: page.getByText(name, { exact: true }) }).first();
}

function contactId(userEmail, name) {
  const rows = sql(`select ec.id from public.emergency_contacts ec join auth.users u on u.id = ec.user_id
                    where u.email = '${userEmail.replace(/'/g, "''")}' and ec.name = '${name.replace(/'/g, "''")}'`);
  assert.equal(rows.length, 1, `one contact named ${name} for ${userEmail} in ${DB_URL} (set E2E_DATABASE_URL to the server's database)`);
  return rows[0][0];
}

/** Turn on check-ins from /trips/<id>/checkin. */
async function setupCheckin(page, tripId, { contactName, expectedReturn, grace = "30", reminders = ["1 hour before", "30 min before"] }) {
  await page.goto(`/trips/${tripId}/checkin`);
  const form = page.locator("form", { has: page.getByRole("button", { name: "Turn on check-ins" }) });
  await form.waitFor({ timeout: UI });
  await form.getByRole("radio", { name: new RegExp(contactName) }).check();
  await form.getByLabel(/Expected return/).fill(regionLocalInput(expectedReturn));
  await form.getByLabel(/Grace period/).selectOption(grace);
  for (const box of await form.getByRole("checkbox", { name: / before$/ }).all()) {
    const label = (await box.evaluate((el) => el.closest("label").innerText)).trim();
    if (reminders.includes(label)) await box.check();
    else await box.uncheck();
  }
  await form.getByRole("checkbox", { name: /I understand/ }).check();
  await form.getByRole("button", { name: "Turn on check-ins" }).click();
  await page.getByRole("heading", { name: "Status", level: 2 }).waitFor({ timeout: UI });
}

const statusCard = (page) => page.locator("section", { has: page.getByRole("heading", { name: "Status", level: 2 }) });
const historyCard = (page) => page.locator("section", { has: page.getByRole("heading", { name: "Notices and reminders", level: 2 }) });
const timelineCard = (page) => page.locator("section", { has: page.getByRole("heading", { name: "Check-in activity", level: 2 }) });

/** Start a hike through the hike API (as the signed-in owner) and upload one location fix. */
async function startHikeWithFix(page, tripId, { minutesAgo, lat = 47.50521, lng = -121.70213, accuracyM = 12.4 }) {
  const start = await page.request.post("/api/hike/start", { data: { tripId } });
  assert.equal(start.status(), 200, `hike start: ${await start.text()}`);
  const sessionId = (await start.json()).session.id;
  const recordedAt = new Date(Date.now() - minutesAgo * 60_000);
  const sync = await page.request.post("/api/hike/sync", {
    data: { sessionId, points: [{ id: `qa-${run}-${Date.now()}`, lat, lng, accuracyM, altitudeM: 300, recordedAt: recordedAt.toISOString() }] },
  });
  assert.equal(sync.status(), 200, `hike sync: ${await sync.text()}`);
  assert.equal((await sync.json()).acceptedPointIds.length, 1);
  return { sessionId, recordedAt, lat, lng, accuracyM };
}

/** The lead-specified way to force a check-in overdue. */
function forceOverdue(tripId) {
  assertUuid(tripId);
  const n = sqlUpdate(`update public.trip_checkins set expected_return_at = now() - interval '3 hours' where trip_id = '${tripId}'`);
  assert.equal(n, 1, `forced exactly one check-in overdue in ${DB_URL} (set E2E_DATABASE_URL to the server's database)`);
}

function notices(tripId) {
  assertUuid(tripId);
  return sql(`select id, template, status, channel, recipient_kind, coalesce(recipient_ref::text, ''), recipient_masked
              from public.notifications where trip_id = '${tripId}' order by created_at, id`).map(([id, template, status, channel, recipientKind, recipientRef, masked]) => ({
    id,
    template,
    status,
    channel,
    recipientKind,
    recipientRef,
    masked,
  }));
}
function noticeBody(id) {
  assertUuid(id);
  return execFileSync("psql", [DB_URL, "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", `select body from public.notifications where id = '${id}'`], { encoding: "utf8" }).trimEnd();
}
function checkinStatus(tripId) {
  assertUuid(tripId);
  return sql(`select status from public.trip_checkins where trip_id = '${tripId}'`)[0]?.[0];
}

async function runJobsTwice() {
  const a = await runJobs();
  const b = await runJobs();
  return [a, b];
}

/**
 * Run the cron job endpoint until `done()` holds, like the real once-a-minute
 * cron. The overdue safety net (`checkins.scan_overdue`) is a periodic job
 * with one run per minute bucket, so when another cron call already used
 * this minute's run, recovering a forced-overdue check-in can take up to a
 * minute. Then run twice more so duplicates would show up.
 */
async function runJobsUntil(done, what, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await runJobs();
    if (done()) break;
    if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs / 1000}s of job runs waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
  await runJobsTwice();
}

/** Open each "Show message" disclosure in the notice history and return the visible text of each entry. */
async function historyEntries(page) {
  const items = historyCard(page).locator("ol > li");
  const n = await items.count();
  const out = [];
  for (let i = 0; i < n; i++) {
    const item = items.nth(i);
    await item.locator("summary", { hasText: "Show message" }).click();
    out.push(await item.innerText());
  }
  return out;
}

// ---------------------------------------------------------------------------
// fixtures (memoized; each test calls what it needs)
// ---------------------------------------------------------------------------

let browser;
const consoleErrors = [];
const contexts = [];

async function customer(label, fullName, viewport = MOBILE) {
  const context = await newCtx(browser, viewport);
  contexts.push(context);
  const page = await context.newPage();
  watchErrors(page, consoleErrors);
  const email = await signUp(page, label, fullName);
  return { context, page, email };
}

let safetyStaffP;
function safetyStaff() {
  safetyStaffP ??= (async () => {
    const context = await newCtx(browser, DESKTOP);
    contexts.push(context);
    const page = await context.newPage();
    watchErrors(page, consoleErrors);
    await login(page, SAFETY_EMAIL);
    return { context, page };
  })();
  return safetyStaffP;
}

before(async () => {
  browser = await newBrowser();
});

after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
});

// ---------------------------------------------------------------------------
// 1. Profile
// ---------------------------------------------------------------------------

test("account profile: edit name, phone and units; invalid phone is rejected; values persist", { timeout: 120_000 }, async () => {
  const { page, email } = await customer("profile", `Pat Profile ${run}`);
  await page.goto("/account");
  await assertText(page.locator("main"), new RegExp(`Signed in as\\s*${email.replace(/[.+]/g, "\\$&")}`));
  const name = page.getByRole("textbox", { name: "Full name" });
  const phone = page.getByRole("textbox", { name: "Mobile phone" });
  assert.equal(await name.inputValue(), `Pat Profile ${run}`, "name from sign-up is prefilled");

  // Invalid phone → field error, nothing saved.
  await name.fill(`Pat Q. Profile ${run}`);
  await phone.fill("call me maybe");
  await page.getByRole("button", { name: "Save profile" }).click();
  await assertText(page.getByRole("status"), /Please fix the highlighted fields/);
  await assertText(page.locator("main"), /Enter a phone number with country code/);
  await page.reload();
  assert.equal(await page.getByRole("textbox", { name: "Full name" }).inputValue(), `Pat Profile ${run}`, "invalid submission saved nothing");

  // Valid edit: phone is normalized to E.164, units persist.
  await page.getByRole("textbox", { name: "Full name" }).fill(`Pat Q. Profile ${run}`);
  await page.getByRole("textbox", { name: "Mobile phone" }).fill("(555) 555-0142");
  await page.getByRole("radio", { name: /Metric/ }).check();
  await page.getByRole("button", { name: "Save profile" }).click();
  await assertText(page.getByRole("status"), /Profile saved\./);
  await page.reload();
  assert.equal(await page.getByRole("textbox", { name: "Full name" }).inputValue(), `Pat Q. Profile ${run}`);
  assert.equal(await page.getByRole("textbox", { name: "Mobile phone" }).inputValue(), "+15555550142");
  assert.ok(await page.getByRole("radio", { name: /Metric/ }).isChecked(), "metric units persisted");
  // Empty name is refused.
  await page.getByRole("textbox", { name: "Full name" }).fill("   ");
  await page.getByRole("button", { name: "Save profile" }).click();
  await assertText(page.locator("main"), /Enter your name\./);
});

test("account forms keep what the customer typed when the server rejects a field", { timeout: 90_000 }, async () => {
  // React 19 resets uncontrolled forms after every action; a validation error must not wipe the customer's input.
  const { page } = await customer("formkeep", `Fran Keep ${run}`);
  await page.goto("/account");
  await page.getByRole("textbox", { name: "Full name" }).fill(`Fran Edited ${run}`);
  await page.getByRole("textbox", { name: "Mobile phone" }).fill("12");
  await page.getByRole("button", { name: "Save profile" }).click();
  await assertText(page.getByRole("status"), /Please fix the highlighted fields/);
  assert.equal(await page.getByRole("textbox", { name: "Full name" }).inputValue(), `Fran Edited ${run}`, "profile: typed name kept after a phone error");
  assert.equal(await page.getByRole("textbox", { name: "Mobile phone" }).inputValue(), "12", "profile: typed phone kept so it can be corrected");

  await page.goto("/account/emergency-contacts");
  const add = page.locator("section", { has: page.getByRole("heading", { name: "Add a contact", level: 2 }) }).last();
  await add.getByRole("textbox", { name: "Name", exact: true }).fill("Typo Tess");
  await add.getByRole("textbox", { name: "Mobile phone", exact: true }).fill("55");
  await add.getByRole("checkbox", { name: /I confirm this person has agreed/ }).check();
  await add.getByRole("button", { name: "Add contact" }).click();
  await assertText(add.getByRole("status"), /Please fix the highlighted fields/);
  await assertText(add, /Enter a mobile number with country code/);
  assert.equal(await add.getByRole("textbox", { name: "Name", exact: true }).inputValue(), "Typo Tess", "contact: typed name kept after a phone error");
  assert.equal(await add.getByRole("textbox", { name: "Mobile phone", exact: true }).inputValue(), "55", "contact: typed phone kept so it can be corrected");
});

// ---------------------------------------------------------------------------
// 2. Emergency contacts + consent
// ---------------------------------------------------------------------------

test("emergency contacts: add / edit / delete with the consent attestation; only consented contacts can be chosen for check-ins", { timeout: 240_000 }, async (t) => {
  const { page, email } = await customer("contacts", `Cam Contacts ${run}`);
  const tripId = await bookTrip(page);

  await t.test("no contacts yet: check-in setup asks for a consented contact first", async () => {
    await page.goto(`/trips/${tripId}/checkin`);
    await assertText(page.locator("main"), /Add an emergency contact first/);
    assert.equal(await page.getByRole("button", { name: "Turn on check-ins" }).count(), 0, "cannot turn on check-ins without a contact");
    await Promise.all([page.waitForURL(new RegExp(`/account/emergency-contacts\\?trip=${tripId}`), { timeout: NAV }), page.getByRole("link", { name: "Add or update an emergency contact" }).click()]);
    await assertText(page.locator("main"), new RegExp(`Back to check-ins for ${TRAIL_NAME}`));
    await assertText(page.locator("main"), /No emergency contacts yet/);
  });

  await t.test("validation: a contact needs a name and a phone or email", async () => {
    const add = page.locator("section", { has: page.getByRole("heading", { name: "Add a contact", level: 2 }) }).last();
    await add.getByRole("textbox", { name: "Name", exact: true }).fill("Nobody Reachable");
    await add.getByRole("button", { name: "Add contact" }).click();
    await assertText(add, /Add a mobile number or an email address/);
    await add.getByRole("textbox", { name: "Name", exact: true }).fill("Bad Email");
    await add.getByRole("textbox", { name: "Email", exact: true }).fill("not-an-email");
    await add.getByRole("button", { name: "Add contact" }).click();
    await assertText(add, /Enter a valid email address/);
    await page.reload();
    await assertText(page.locator("main"), /No emergency contacts yet/);
  });

  await t.test("add one contact without consent and one with consent", async () => {
    await addContact(page, { name: "Nora Noconsent", email: `nora@${run}.example.com`, consent: false });
    await assertText(page.locator("main"), /Confirm their consent before choosing them for check-ins/);
    await addContact(page, { name: "Casey Consent", phone: "+1 555 555 0177", relationship: "friend", consent: true });
    await page.reload();
    const nora = contactCard(page, "Nora Noconsent");
    const casey = contactCard(page, "Casey Consent");
    await assertText(nora, /Consent needed/);
    await assertText(nora, /Can't be chosen for check-ins until you confirm they agreed/);
    await assertText(casey, /Consent confirmed/);
    await assertText(casey, /You confirmed their consent on/);
    await assertText(casey, /\+15555550177/); // normalized to E.164
    await page.goto("/account");
    await assertText(page.locator("main"), /2 saved · 1 with consent/);
  });

  await t.test("check-in setup offers only the consented contact; the server refuses a non-consented one", async () => {
    await page.goto(`/trips/${tripId}/checkin`);
    const form = page.locator("form", { has: page.getByRole("button", { name: "Turn on check-ins" }) });
    await form.waitFor({ timeout: UI });
    const options = await form.getByRole("radio").evaluateAll((els) => els.map((e) => e.closest("label").innerText));
    assert.equal(options.length, 1, `only one selectable contact: ${JSON.stringify(options)}`);
    assert.match(options[0], /Casey Consent/);
    assert.match(options[0], /\+1•••••0177/, "contact reach is masked");
    assert.ok(!options.join(" ").includes("Nora"), "the contact without consent is not offered");

    // Tamper with the form: point the radio at Nora's id. The server must refuse.
    const noraId = contactId(email, "Nora Noconsent");
    await form.getByRole("radio").first().evaluate((el, id) => {
      el.value = id;
    }, noraId);
    await form.getByLabel(/Expected return/).fill(regionLocalInput(new Date(Date.now() + 3 * 3_600_000)));
    await form.getByRole("checkbox", { name: /I understand/ }).check();
    await form.getByRole("button", { name: "Turn on check-ins" }).click();
    await assertText(form.getByRole("status"), /hasn't agreed to receive notices yet/);
    assert.equal(sql(`select count(*) from public.trip_checkins where trip_id = '${tripId}' and status <> 'cancelled'`)[0][0], "0", "no check-in was created");
  });

  await t.test("edit: confirming Nora's consent makes her selectable; edits persist", async () => {
    await page.goto("/account/emergency-contacts");
    const nora = contactCard(page, "Nora Noconsent");
    await nora.locator("summary", { hasText: "Edit Nora Noconsent" }).click();
    await nora.getByRole("textbox", { name: "Relationship", exact: true }).fill("sister");
    await nora.getByRole("checkbox", { name: /I confirm this person has agreed/ }).check();
    await nora.getByRole("button", { name: "Save contact" }).click();
    await assertText(nora.getByRole("status"), /Contact saved\./);
    await page.reload();
    await assertText(contactCard(page, "Nora Noconsent"), /sister/);
    await assertText(contactCard(page, "Nora Noconsent"), /Consent confirmed/);
    await page.goto(`/trips/${tripId}/checkin`);
    const radios = page.locator("form", { has: page.getByRole("button", { name: "Turn on check-ins" }) }).getByRole("radio");
    assert.equal(await radios.count(), 2, "both consented contacts are now selectable");
  });

  await t.test("edit: withdrawing consent removes the contact from check-in choices again", async () => {
    await page.goto("/account/emergency-contacts");
    const nora = contactCard(page, "Nora Noconsent");
    await nora.locator("summary", { hasText: "Edit Nora Noconsent" }).click();
    await nora.getByRole("checkbox", { name: /I confirm this person has agreed/ }).uncheck();
    await nora.getByRole("button", { name: "Save contact" }).click();
    await assertText(nora.getByRole("status"), /Contact saved\./);
    await page.reload();
    await assertText(contactCard(page, "Nora Noconsent"), /Consent needed/);
    await page.goto(`/trips/${tripId}/checkin`);
    const radios = page.locator("form", { has: page.getByRole("button", { name: "Turn on check-ins" }) }).getByRole("radio");
    assert.equal(await radios.count(), 1);
  });

  await t.test("delete: two-step confirmation, 'Keep contact' cancels, 'Yes, delete' removes", async () => {
    await page.goto("/account/emergency-contacts");
    let nora = contactCard(page, "Nora Noconsent");
    await nora.getByRole("button", { name: "Delete Nora Noconsent" }).click();
    await assertText(nora, /Delete Nora Noconsent\?/);
    await nora.getByRole("button", { name: "Keep contact" }).click();
    assert.ok(await nora.getByRole("button", { name: "Delete Nora Noconsent" }).isVisible(), "cancelled delete");
    await nora.getByRole("button", { name: "Delete Nora Noconsent" }).click();
    await nora.getByRole("button", { name: "Yes, delete" }).click();
    await page.getByText("Nora Noconsent", { exact: true }).waitFor({ state: "detached", timeout: UI });
    await page.reload();
    assert.equal(await page.getByText("Nora Noconsent", { exact: true }).count(), 0, "contact deleted");
    assert.equal(sql(`select count(*) from public.emergency_contacts where id = '${contactId(email, "Casey Consent")}'`)[0][0], "1", "other contact kept");
    nora = null;
  });
});

test("emergency contacts: changing a consented contact's phone or email requires confirming consent again", { timeout: 120_000 }, async () => {
  // The form says "If you change their phone or email, confirm again." The pre-ticked box must not silently carry consent over to a new address.
  const { page, email } = await customer("reconsent", `Rae Reconsent ${run}`);
  await addContact(page, { name: "Quinn Original", email: `quinn@${run}.example.com`, consent: true });
  await page.reload();
  let quinn = contactCard(page, "Quinn Original");
  await quinn.locator("summary", { hasText: "Edit Quinn Original" }).click();
  const box = quinn.getByRole("checkbox", { name: /I confirm this person has agreed/ });
  assert.equal(await box.isChecked(), true, "consent is shown as confirmed for the saved address");
  await quinn.getByRole("textbox", { name: "Email", exact: true }).fill(`someone-else@${run}.example.com`);
  assert.equal(await box.isChecked(), false, "changing the email clears the consent box");
  await assertText(quinn, /You changed their phone or email, so the consent box was cleared/);
  await quinn.getByRole("button", { name: "Save contact" }).click();
  await assertText(quinn.getByRole("status"), /Contact saved/);
  const stored = () =>
    sql(`select email, coalesce(consent_confirmed_at::text, '') from public.emergency_contacts where id = '${contactId(email, "Quinn Original")}'`)[0];
  let [storedEmail, consentAt] = stored();
  assert.equal(storedEmail, `someone-else@${run}.example.com`, "new email saved");
  assert.equal(consentAt, "", "a new email address must not inherit consent without an explicit re-confirmation");
  await page.reload();
  quinn = contactCard(page, "Quinn Original");
  await assertText(quinn, /Consent needed/);

  // ticking the box again for the new address re-attests consent
  await quinn.locator("summary", { hasText: "Edit Quinn Original" }).click();
  await quinn.getByRole("checkbox", { name: /I confirm this person has agreed/ }).check();
  await quinn.getByRole("button", { name: "Save contact" }).click();
  await assertText(quinn.getByRole("status"), /Contact saved\./);
  [storedEmail, consentAt] = stored();
  assert.notEqual(consentAt, "", "consent re-confirmed for the new address");
});

// ---------------------------------------------------------------------------
// 3. Privacy
// ---------------------------------------------------------------------------

test("privacy: retention setting, location-sharing toggle (honoured in a real notice), delete location history", { timeout: 300_000 }, async (t) => {
  const { page, email } = await customer("privacy", `Pia Privacy ${run}`);
  const tripId = await bookTrip(page);
  await addContact(page, { name: "Sam Sms", phone: "+1 555 555 0161", consent: true });
  await setupCheckin(page, tripId, { contactName: "Sam Sms", expectedReturn: new Date(Date.now() + 2 * 3_600_000), grace: "15", reminders: [] });
  await startHikeWithFix(page, tripId, { minutesAgo: 2 });

  await t.test("defaults and what is stored are explained", async () => {
    await page.goto("/account/privacy");
    const main = page.locator("main");
    await assertText(main, /does not monitor you continuously/);
    await assertText(main, /Only staff with the safety or administrator role can open precise locations/);
    assert.equal(await page.getByLabel(/Keep my precise location history for/).inputValue(), "30", "default retention is 30 days");
    // location in notices is ON by default, and the copy says so (not "if you opt in")
    assert.equal(await page.getByRole("checkbox", { name: /Include my last reported location in check-in notices/ }).isChecked(), true);
    await assertText(main, /it is on by default/);
    assert.doesNotMatch(await main.innerText(), /if you opt in/i);
    await assertText(main, /You have 1 stored location point .* and 1 last-known location/);
  });

  await t.test("retention: out-of-range values are refused; a valid value persists", async () => {
    const days = page.getByLabel(/Keep my precise location history for/);
    await days.fill("0");
    await page.getByRole("button", { name: "Save privacy settings" }).click();
    await assertText(page.locator("main"), /Keep location history for at least 1 day/);
    await days.fill("400");
    await page.getByRole("button", { name: "Save privacy settings" }).click();
    await assertText(page.locator("main"), /Keep location history for at most 365 days/);
    await page.reload();
    assert.equal(await page.getByLabel(/Keep my precise location history for/).inputValue(), "30", "invalid values were not saved");

    await page.getByLabel(/Keep my precise location history for/).fill("7");
    await page.getByRole("button", { name: "Save privacy settings" }).click();
    await assertText(page.getByRole("status"), /Privacy settings saved\./);
    await page.reload();
    assert.equal(await page.getByLabel(/Keep my precise location history for/).inputValue(), "7");
  });

  await t.test("location sharing toggle: off persists and is reflected on the account page", async () => {
    const share = page.getByRole("checkbox", { name: /Include my last reported location in check-in notices/ });
    await share.uncheck();
    await page.getByRole("button", { name: "Save privacy settings" }).click();
    await assertText(page.getByRole("status"), /Privacy settings saved\./);
    await page.reload();
    assert.equal(await page.getByRole("checkbox", { name: /Include my last reported location in check-in notices/ }).isChecked(), false);
    await page.goto("/account");
    await assertText(page.locator("main"), /Location history kept 7 days · last location in notices:\s*off/);
    // toggle on and off again to prove both directions persist
    await page.goto("/account/privacy");
    await page.getByRole("checkbox", { name: /Include my last reported location/ }).check();
    await page.getByRole("button", { name: "Save privacy settings" }).click();
    await assertText(page.getByRole("status"), /Privacy settings saved\./);
    await page.goto("/account");
    await assertText(page.locator("main"), /last location in notices:\s*on/);
    await page.goto("/account/privacy");
    await page.getByRole("checkbox", { name: /Include my last reported location/ }).uncheck();
    await page.getByRole("button", { name: "Save privacy settings" }).click();
    await assertText(page.getByRole("status"), /Privacy settings saved\./);
  });

  await t.test("delete location history: needs the confirmation tick, then removes points and last-known location", async () => {
    await page.goto("/account/privacy");
    const delCard = page.locator("section", { has: page.getByRole("heading", { name: "Delete my location history now" }) });
    const btn = delCard.getByRole("button", { name: "Delete my location history now" });
    await btn.click(); // required checkbox → browser blocks the submit
    await page.waitForTimeout(500);
    assert.match(await delCard.innerText(), /You have 1 stored location point/, "nothing deleted without the tick");
    await delCard.getByRole("checkbox", { name: /I understand this permanently deletes/ }).check();
    await btn.click();
    await assertText(delCard.getByRole("status"), /Deleted 1 location point and 1 last-known location\./);
    await page.reload();
    await assertText(page.locator("main"), /No location history is stored for your account\./);
    assert.ok(await page.getByRole("button", { name: "No location history stored" }).isDisabled());
    const [[points, fixes]] = sql(`select (select count(*) from public.location_points lp join auth.users u on u.id = lp.user_id where u.email = '${email}'),
                                          (select count(*) from public.hike_last_locations l join auth.users u on u.id = l.user_id where u.email = '${email}')`);
    assert.deepEqual([points, fixes], ["0", "0"]);
  });

  await t.test("with sharing off, an overdue notice says no location was reported (no coordinates), SMS-length, simulated", async () => {
    // a fresh fix after the deletion — it must still NOT appear because sharing is off
    const sessionRows = sql(`select id from public.hike_sessions where trip_id = '${tripId}' and status in ('active','paused')`);
    const sync = await page.request.post("/api/hike/sync", {
      data: { sessionId: sessionRows[0][0], points: [{ id: `qa-${run}-after`, lat: 47.5061, lng: -121.7033, accuracyM: 8, altitudeM: 310, recordedAt: new Date().toISOString() }] },
    });
    assert.equal(sync.status(), 200);
    forceOverdue(tripId);
    await runJobsUntil(() => checkinStatus(tripId) === "contact_notified", "the overdue notice to the contact");
    const contactNotices = notices(tripId).filter((n) => n.template === "checkin_overdue_contact");
    assert.equal(contactNotices.length, 1, `exactly one notice for the one consented contact (SMS only): ${JSON.stringify(notices(tripId))}`);
    const [n] = contactNotices;
    assert.equal(n.channel, "sms");
    assert.equal(n.status, "simulated");
    assert.equal(n.masked, "+1•••••0161");
    const body = noticeBody(n.id);
    assert.match(body, /No location has been reported/);
    assert.doesNotMatch(body, COORDS, "no coordinates when the hiker turned location sharing off");
    assert.match(body, /Ghost Guide has NOT contacted emergency services/);
    for (const re of BANNED) assert.doesNotMatch(body, re);
    assert.ok(body.length <= 600, `SMS body within 600 chars (${body.length})`);
    // clean up: finish the trip's check-in
    await page.goto(`/trips/${tripId}/checkin`);
    await page.getByRole("button", { name: "Finish trip" }).first().click();
    await page.getByRole("button", { name: /Yes, I'm back/ }).click();
    await assertText(statusCard(page), /Trip finished/);
  });
});

// ---------------------------------------------------------------------------
// 4. Check-in lifecycle → overdue notice → staff visibility → finish
// ---------------------------------------------------------------------------

test("check-in lifecycle: setup, I'm okay, extend, overdue → one simulated notice per consented contact, staff visibility, finish", { timeout: 420_000 }, async (t) => {
  const { page, email } = await customer("lifecycle", `Robin Lifecycle${run}`);
  const errorsBefore = consoleErrors.length;
  const tripId = await bookTrip(page);
  const caseyEmail = `casey@${run}.example.com`;
  const caseyMasked = `c•••@${run}.example.com`;
  await addContact(page, { name: "Casey Consent", email: caseyEmail, relationship: "friend", consent: true });
  await addContact(page, { name: "Nora Noconsent", email: `nora@${run}.example.com`, consent: false });
  const caseyId = contactId(email, "Casey Consent");
  const noraId = contactId(email, "Nora Noconsent");
  let expectedReturn = new Date(Math.ceil((Date.now() + 3 * 3_600_000) / 300_000) * 300_000);
  let fix;
  let staffPage;

  await t.test("trip dashboard invites check-in setup; setup saves contact, expected return, grace and reminders", async () => {
    await page.goto(`/trips/${tripId}`);
    const card = page.locator("section", { has: page.getByRole("heading", { name: "Check-ins", level: 2 }) });
    await assertText(card, /Check-ins are off/);
    assert.ok(await card.getByText("Simulated notices").isVisible(), "simulated notices are labeled on the dashboard");
    await Promise.all([page.waitForURL(new RegExp(`/trips/${tripId}/checkin$`), { timeout: NAV }), card.getByRole("link", { name: "Set up check-ins" }).click()]);
    await assertText(page.locator("main"), /Demo: notices are simulated, nothing is sent/);

    await setupCheckin(page, tripId, { contactName: "Casey Consent", expectedReturn, grace: "30", reminders: ["1 hour before", "30 min before"] });
    const status = statusCard(page);
    await assertText(status, /Check-ins are on/);
    const text = await status.innerText();
    assert.ok(text.includes(checkinTime(expectedReturn)), `expected return ${checkinTime(expectedReturn)} shown:\n${text}`);
    assert.ok(text.includes(checkinTime(new Date(expectedReturn.getTime() + 30 * 60_000))), "notice deadline = expected return + grace");
    assert.match(text, /Grace period: 30 minutes/);
    assert.match(text, /1 hour, 30 min before your expected return/);
    assert.match(text, /Casey Consent/);
    assert.match(text, new RegExp(caseyMasked.replace(/[.]/g, "\\.")));
    assert.match(await timelineCard(page).innerText(), /Check-ins turned on/);
    for (const re of BANNED) assert.doesNotMatch(text, re);
    assert.doesNotMatch(await page.locator("main").innerText(), /emergency detected|in danger/i);
  });

  await t.test("hike starts (location fix uploaded) → waiting for confirmation", async () => {
    fix = await startHikeWithFix(page, tripId, { minutesAgo: 40 });
    await page.goto(`/trips/${tripId}/checkin`);
    await assertText(statusCard(page), /Waiting for your confirmation/);
    await assertText(timelineCard(page), /Hike started/);
  });

  await t.test("\"I'm okay\" before the expected return keeps the plan", async () => {
    await page.getByRole("button", { name: "I'm okay" }).click();
    await assertText(page.locator("main"), /Thanks — you're confirmed okay\. Please still tap “Finish trip” when you're back\./);
    await assertText(statusCard(page), /You confirmed you're okay at/);
    const text = await statusCard(page).innerText();
    assert.ok(text.includes(checkinTime(expectedReturn)), "expected return unchanged");
    assert.doesNotMatch(text, /Last “I'm okay”\s*Not yet/);
    await assertText(timelineCard(page), /You confirmed you're okay/);
  });

  await t.test("\"Extend my trip\" +30 min moves the expected return and the notice deadline", async () => {
    await page.getByRole("button", { name: "+30 min" }).click();
    await assertText(page.locator("main"), /Your expected return time is updated\./);
    expectedReturn = new Date(expectedReturn.getTime() + 30 * 60_000);
    await page.waitForFunction((s) => document.querySelector("main").innerText.includes(s), checkinTime(expectedReturn), { timeout: UI });
    const text = await statusCard(page).innerText();
    assert.ok(text.includes(checkinTime(expectedReturn)), `new expected return ${checkinTime(expectedReturn)}:\n${text}`);
    assert.ok(text.includes(checkinTime(new Date(expectedReturn.getTime() + 30 * 60_000))));
    await assertText(timelineCard(page), new RegExp(`Expected return changed[\\s\\S]*new expected return ${checkinTime(expectedReturn)}`));
    // Pick-a-time extension refuses a time in the past.
    await page.locator("summary", { hasText: "Pick a new return time" }).first().click();
    const until = page.getByLabel(/New expected return/).first();
    await until.evaluate((el) => el.removeAttribute("min"));
    await until.fill(regionLocalInput(new Date(Date.now() - 3_600_000)));
    await page.getByRole("button", { name: "Set new return time" }).first().click();
    await assertText(page.locator("main"), /must be at least 5 minutes from now/);
    assert.equal(notices(tripId).length, 0, "no notices before the deadline");
  });

  await t.test("forced overdue + job runs → exactly one simulated notice to the consented contact, none to the other", async () => {
    forceOverdue(tripId);
    await runJobsUntil(() => checkinStatus(tripId) === "contact_notified", "the overdue notice to the contact");
    const all = notices(tripId);
    const contactNotices = all.filter((n) => n.template === "checkin_overdue_contact");
    assert.equal(contactNotices.length, 1, `exactly one contact notice after forcing overdue and running jobs twice: ${JSON.stringify(all)}`);
    const [n] = contactNotices;
    assert.equal(n.recipientRef, caseyId, "sent to the consented contact");
    assert.equal(n.channel, "email");
    assert.equal(n.status, "simulated", "demo provider: simulated, not delivered");
    assert.equal(n.masked, caseyMasked, "only the masked address is stored");
    assert.ok(!all.some((x) => x.recipientRef === noraId), "the contact without consent got nothing");
    assert.equal(checkinStatus(tripId), "contact_notified");
    // the hiker gets a "we haven't heard from you" notice too
    assert.equal(all.filter((x) => x.template === "checkin_overdue_user").length, 1);

    const body = noticeBody(n.id);
    assert.match(body, /Ghost Guide check-in notice about Robin\./);
    assert.match(body, /Ghost Guide has NOT received their “I'm okay” or “Finish trip” confirmation/);
    assert.match(body, /does not necessarily mean anything is wrong/);
    const coords = `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}`;
    assert.ok(body.includes(`Last reported location: ${coords}`), `last coordinates in the notice:\n${body}`);
    assert.ok(body.includes(checkinTime(fix.recordedAt)), `timestamp of the fix (${checkinTime(fix.recordedAt)}) in the notice`);
    assert.match(body, /accuracy ±12 m/);
    assert.match(body, /\[STALE — 4\d min old\]/, "a 40-minute-old fix is labeled STALE");
    assert.match(body, /Ghost Guide has NOT contacted emergency services\./);
    assert.match(body, /contact local emergency services \(911\)/);
    for (const re of BANNED) assert.doesNotMatch(body, re);
  });

  await t.test("the owner sees the notice, with its exact text and a 'Simulated' label, in the trip's notice history", async () => {
    await page.goto(`/trips/${tripId}/checkin`);
    await assertText(statusCard(page), /A simulated notice was recorded for your contact|We haven't received your confirmation/);
    const entries = await historyEntries(page);
    const contactEntries = entries.filter((e) => /Check-in notice to your contact/.test(e));
    assert.equal(contactEntries.length, 1, `one contact notice in history:\n${entries.join("\n---\n")}`);
    assert.match(contactEntries[0], /Email to your contact/);
    assert.ok(contactEntries[0].includes(caseyMasked), "masked recipient shown");
    assert.match(contactEntries[0], /Simulated — not delivered/);
    assert.match(contactEntries[0], /Ghost Guide has NOT contacted emergency services/);
    assert.match(contactEntries[0], /STALE/);
    assert.ok(!(await page.locator("main").innerText()).includes(caseyEmail), "the full contact address is not shown in the history");
    // Quick actions remain available while overdue; opting out is not offered.
    assert.ok(await page.getByRole("button", { name: "I'm okay" }).isVisible());
    assert.equal(await page.getByRole("button", { name: "Turn off check-ins for this trip" }).count(), 0);
  });

  await t.test("demo mode: the status and activity never claim the simulated notice was delivered", async () => {
    // Honesty rule: a simulated notice must not be presented as sent/delivered anywhere on the page.
    await page.goto(`/trips/${tripId}/checkin`);
    const status = await statusCard(page).innerText();
    const activity = await timelineCard(page).innerText();
    assert.doesNotMatch(status, /Your contact was sent a notice|we notified your contact/i, `status claims delivery of a simulated notice:\n${status}`);
    assert.doesNotMatch(activity, /Notice delivered to your contact|Notice sent to your contact/, `activity claims delivery of a simulated notice:\n${activity}`);
    assert.match(status, /simulated/i, "the status says the notice was simulated");
    assert.match(activity, /Simulated notice to your contact recorded/);
  });

  await t.test("safety@ sees the notice in /admin/notifications and the check-in in /admin/safety", async () => {
    ({ page: staffPage } = await safetyStaff());
    await staffPage.goto("/admin/notifications?status=simulated&channel=email");
    const table = staffPage.getByRole("table", { name: /Notifications/ });
    await table.waitFor({ timeout: UI });
    const row = table.locator("tbody tr", { hasText: caseyMasked });
    await row.first().waitFor({ timeout: UI });
    assert.equal(await row.count(), 1, "exactly one delivery-log row for the contact");
    const rowText = await row.innerText();
    assert.match(rowText, /simulated/);
    assert.match(rowText, /checkin overdue contact/);
    assert.match(rowText, /emergency contact/);
    assert.ok(!(await staffPage.locator("main").innerText()).includes(caseyEmail), "recipient is masked for staff too");

    await staffPage.goto("/admin/safety");
    const item = staffPage.locator("li", { hasText: email });
    await item.first().waitFor({ timeout: UI });
    const text = await item.first().innerText();
    assert.match(text, /No confirmation · contact notified/);
    assert.match(text, new RegExp(TRAIL_NAME));
    assert.match(text, /contact notified/);
    const main = await staffPage.locator("main").innerText();
    assert.match(main, /It is not proof of an emergency/);
    assert.match(main, /does not contact emergency services automatically/);
    for (const re of BANNED) assert.doesNotMatch(text, re, "the check-in entry never calls an overdue check-in an emergency");
  });

  await t.test("\"Finish trip\" completes the check-in; later job runs only add the allowed 'finished' follow-up", async () => {
    const before = notices(tripId);
    await page.goto(`/trips/${tripId}/checkin`);
    await page.getByRole("button", { name: "Finish trip" }).first().click();
    await assertText(page.locator("main"), /Are you back from your hike\?/);
    // focus follows the two-step confirmation (not lost to <body>, and not on "Yes" so a double Enter can't finish by accident)
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Are you back from your hike?");
    await page.getByRole("button", { name: "Not yet" }).first().click();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Finish trip", "focus returns to the trigger on cancel");
    await page.getByRole("button", { name: "Finish trip" }).first().click();
    await page.getByRole("button", { name: /Yes, I'm back — finish trip/ }).click();
    await assertText(statusCard(page), /Trip finished/);
    await assertText(statusCard(page), /No more check-in notices will be sent for this trip/);
    assert.equal(checkinStatus(tripId), "completed");
    assert.equal(await page.getByRole("button", { name: "I'm okay" }).count(), 0, "no more quick actions");

    await runJobsTwice();
    forceOverdue(tripId); // even a stale expected return must not trigger anything now
    await runJobsTwice();
    const afterAll = notices(tripId);
    const added = afterAll.filter((n) => !before.some((b) => b.id === n.id));
    assert.ok(
      added.every((n) => n.template === "checkin_followup_finished"),
      `only a 'finished' follow-up may be added after finishing: ${JSON.stringify(added)}`,
    );
    assert.ok(added.length <= 1, "at most one follow-up per contact/channel");
    if (added.length) {
      assert.equal(added[0].recipientRef, caseyId);
      assert.equal(added[0].status, "simulated");
      assert.match(noticeBody(added[0].id), /has now confirmed they finished their hike/);
    }
    assert.ok(afterAll.filter((n) => n.template === "checkin_overdue_contact").length <= 1, "no second overdue notice after finishing");
    await page.reload();
    await assertText(timelineCard(page), /Trip finished/);
    // safety monitor no longer lists it as unconfirmed
    staffPage ??= (await safetyStaff()).page;
    await staffPage.goto("/admin/safety");
    await staffPage.getByRole("heading", { name: /Check-ins without confirmation/ }).waitFor({ timeout: UI });
    assert.equal(await staffPage.locator("li", { hasText: email }).count(), 0, "finished check-in left the attention list");
  });

  await t.test("\"Finish trip\" also ends the hike: the trip is no longer shown as on the trail", async () => {
    await page.goto(`/trips/${tripId}`);
    const main = page.locator("main");
    await main.waitFor({ timeout: UI });
    const text = await main.innerText();
    assert.doesNotMatch(text, /On the trail|Hike in progress|Resume hike/, "after 'Yes, I'm back — finish trip' the dashboard must not still say the hike is in progress");
    const [[tripStatus]] = sql(`select status from public.trips where id = '${tripId}'`);
    assert.equal(tripStatus, "completed", "trip completed by 'Finish trip'");
    const [[sessionStatus]] = sql(`select status from public.hike_sessions where trip_id = '${tripId}' order by started_at desc limit 1`);
    assert.equal(sessionStatus, "finished", "hike session closed by 'Finish trip'");
  });

  await t.test("\"Delete my location history now\" also removes the coordinates stored in the sent notice", async () => {
    const [contactNotice] = notices(tripId).filter((n) => n.template === "checkin_overdue_contact");
    assert.match(noticeBody(contactNotice.id), COORDS, "the stored notice had coordinates");
    await page.goto("/account/privacy");
    const delCard = page.locator("section", { has: page.getByRole("heading", { name: "Delete my location history now" }) });
    await assertText(delCard, /stored check-in notice contains a location/);
    await delCard.getByRole("checkbox", { name: /I understand this permanently deletes/ }).check();
    await delCard.getByRole("button", { name: "Delete my location history now" }).click();
    await assertText(delCard.getByRole("status"), /Removed the location from 1 stored notice\./);
    const body = noticeBody(contactNotice.id);
    assert.doesNotMatch(body, COORDS, `coordinates survived the deletion:\n${body}`);
    assert.doesNotMatch(body, /openstreetmap/);
    assert.match(body, /\[location removed\]/);
    assert.match(body, /Ghost Guide has NOT contacted emergency services/, "the rest of the notice is kept");
    await page.goto(`/trips/${tripId}/checkin`);
    assert.doesNotMatch(await historyCard(page).innerText(), COORDS);
  });

  await t.test("another customer cannot open this trip's check-ins (404)", async () => {
    const other = await newCtx(browser, MOBILE);
    contexts.push(other);
    const op = await other.newPage();
    await login(op, OTHER_CUSTOMER_EMAIL);
    const res = await op.goto(`/trips/${tripId}/checkin`);
    assert.equal(res.status(), 404, "another customer's check-in page is a 404");
    assert.ok(!(await op.locator("body").innerText()).includes("Casey Consent"), "no contact data leaked");
    const res2 = await op.goto(`/trips/${tripId}`);
    assert.equal(res2.status(), 404);
    await op.goto(`/account/emergency-contacts?trip=${tripId}`);
    assert.equal(await op.getByText(new RegExp(`Back to check-ins for ${TRAIL_NAME}`)).count(), 0, "foreign trip id is ignored on the contacts page");
    // signed-out visitors are sent to sign in
    const anon = await newCtx(browser, MOBILE);
    contexts.push(anon);
    const ap = await anon.newPage();
    await ap.goto(`/trips/${tripId}/checkin`);
    assert.match(new URL(ap.url()).pathname, /^\/login/);
  });

  await t.test("no console errors during the lifecycle", async () => {
    const mine = consoleErrors.slice(errorsBefore).filter((e) => !/favicon|Failed to load resource: the server responded with a status of 404/.test(e));
    assert.deepEqual(mine, []);
  });
});

test("withdrawn consent after setup: nobody else is notified, and every message says so", { timeout: 240_000 }, async (t) => {
  const { page, email } = await customer("withdrawn", `Wes Withdrawn${run}`);
  const tripId = await bookTrip(page);
  await addContact(page, { name: "Casey Consent", email: `casey-w@${run}.example.com`, consent: true });
  await setupCheckin(page, tripId, { contactName: "Casey Consent", expectedReturn: new Date(Date.now() + 2 * 3_600_000), grace: "15", reminders: [] });

  await t.test("withdrawing consent shows a warning on the check-in", async () => {
    await page.goto("/account/emergency-contacts");
    const casey = contactCard(page, "Casey Consent");
    await assertText(casey, /Used for an upcoming or active check-in/);
    await casey.locator("summary", { hasText: "Edit Casey Consent" }).click();
    await casey.getByRole("checkbox", { name: /I confirm this person has agreed/ }).uncheck();
    await casey.getByRole("button", { name: "Save contact" }).click();
    await assertText(casey.getByRole("status"), /Contact saved\./);
    await page.goto(`/trips/${tripId}/checkin`);
    await assertText(statusCard(page), /Casey Consent has no consent on file/);
    await assertText(statusCard(page), /They won't be notified/);
  });

  await t.test("forced overdue: no contact notice; the hiker is told nobody else is being notified", async () => {
    forceOverdue(tripId);
    await runJobsUntil(() => notices(tripId).some((n) => n.template === "checkin_overdue_user" && n.status !== "queued"), "the hiker's own overdue notice");
    const all = notices(tripId);
    assert.equal(all.filter((n) => n.recipientKind === "emergency_contact").length, 0, `no notice to a contact without consent: ${JSON.stringify(all)}`);
    const own = all.filter((n) => n.template === "checkin_overdue_user");
    assert.equal(own.length, 1, `exactly one "we haven't heard from you" notice to the hiker after forcing overdue: ${JSON.stringify(all)}`);
    assert.match(noticeBody(own[0].id), /no one else is being notified/);
    assert.equal(checkinStatus(tripId), "overdue");
    await page.goto(`/trips/${tripId}/checkin`);
    await assertText(timelineCard(page), /Your contact was not notified/);
    const status = await statusCard(page).innerText();
    assert.doesNotMatch(status, /We're sending your contact a notice|simulated notice to your contact/, `status must not promise a notice that will never be sent:\n${status}`);
    assert.match(status, /nobody else is being notified/);
    // safety staff still see the unconfirmed check-in, flagged as without a reachable contact
    const { page: staff } = await safetyStaff();
    await staff.goto("/admin/safety");
    const item = staff.locator("li", { hasText: email }).first();
    await item.waitFor({ timeout: UI });
    assert.match(await item.innerText(), /No confirmation received/);
  });

  await t.test("\"I'm okay\" after the deadline counts as confirmation and moves the expected return 60 minutes ahead", async () => {
    const before = Date.now();
    await page.getByRole("button", { name: "I'm okay" }).click();
    await assertText(page.locator("main"), /We've extended your expected return by 60 minutes/);
    assert.equal(checkinStatus(tripId), "confirmed_ok");
    const [[epoch]] = sql(`select extract(epoch from expected_return_at) from public.trip_checkins where trip_id = '${tripId}'`);
    const ms = Number(epoch) * 1000;
    assert.ok(ms >= before + 59 * 60_000 && ms <= Date.now() + 61 * 60_000, "expected return ≈ now + 60 min");
    await page.getByRole("button", { name: "Finish trip" }).first().click();
    await page.getByRole("button", { name: /Yes, I'm back/ }).click();
    await assertText(statusCard(page), /Trip finished/);
  });
});

// ---------------------------------------------------------------------------
// 5. Trip share links
// ---------------------------------------------------------------------------

test("trip share links: neutral public view, location only when included, revoke and expiry make the link unavailable", { timeout: 300_000 }, async (t) => {
  const { page } = await customer("share", `Sky Share${run}`);
  const tripId = await bookTrip(page);
  await addContact(page, { name: "Casey Consent", email: `casey-share@${run}.example.com`, consent: true });
  await setupCheckin(page, tripId, { contactName: "Casey Consent", expectedReturn: new Date(Date.now() + 4 * 3_600_000), grace: "60", reminders: [] });
  const fix = await startHikeWithFix(page, tripId, { minutesAgo: 3, lat: 47.50734, lng: -121.70412, accuracyM: 9 });
  const anonCtx = await newCtx(browser, MOBILE);
  contexts.push(anonCtx);
  const anon = await anonCtx.newPage();
  const anonErrors = [];
  watchErrors(anon, anonErrors);
  let plainUrl;
  let locUrl;

  async function createLink({ hours, includeLocation }) {
    await page.goto(`/trips/${tripId}`);
    const card = page.locator("section", { has: page.getByRole("heading", { name: "Check-ins", level: 2 }) });
    await card.getByRole("radio", { name: `${hours} h` }).check();
    const loc = card.getByRole("checkbox", { name: /Include my last reported location/ });
    assert.equal(await loc.isChecked(), false, "location is off by default");
    if (includeLocation) await loc.check();
    await card.getByRole("button", { name: "Create share link" }).click();
    await assertText(card.getByRole("status"), /Link created\. Copy it now/);
    // same zone-labeled format as the list ("Works until Thu, Nov 5, 3:30 AM PST"), not the browser's zone
    await assertText(card, /Your new link \(works until [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M P[SD]T\)/);
    const url = await card.getByLabel(/Your new link/).inputValue();
    assert.match(url, /\/share\/[A-Za-z0-9_-]{20,64}$/);
    return url;
  }

  await t.test("create a link without location → fresh anonymous visitor sees a neutral status and no location", async () => {
    plainUrl = await createLink({ hours: 24, includeLocation: false });
    const res = await anon.goto(plainUrl);
    assert.equal(res.status(), 200);
    const main = anon.locator("main");
    await assertText(main, new RegExp(`Sky's hike: ${TRAIL_NAME}`));
    await assertText(main, /Demonstration trail \(fictional\)/);
    await assertText(main, /No confirmation received yet/);
    await assertText(main, /Expected back by/);
    await assertText(main, /not live tracking/);
    await assertText(main, /does not contact emergency services/);
    const text = await main.innerText();
    assert.equal(await anon.getByRole("heading", { name: "Last reported location" }).count(), 0, "no location section");
    assert.doesNotMatch(text, COORDS, "no coordinates on a link without location");
    assert.ok(!text.includes("casey-share"), "no contact details on the share page");
    for (const re of BANNED) assert.doesNotMatch(text, re);
    assert.equal(await anon.locator('meta[name="robots"]').getAttribute("content"), "noindex, nofollow");
  });

  await t.test("a link that includes location shows the last fix with time, accuracy and freshness", async () => {
    locUrl = await createLink({ hours: 6, includeLocation: true });
    await anon.goto(locUrl);
    const section = anon.locator("section", { has: anon.getByRole("heading", { name: "Last reported location" }) });
    await section.waitFor({ timeout: UI });
    const text = await section.innerText();
    assert.ok(text.includes(`${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}`), `coordinates shown:\n${text}`);
    assert.match(text, /±9 m/);
    assert.match(text, /Updated \d+ min ago/);
    // owner's list shows both links with their location badges
    await page.goto(`/trips/${tripId}`);
    const list = page.getByRole("list", { name: "Your share links" });
    await assertText(list, /Includes last location/);
    await assertText(list, /No location/);
  });

  await t.test("\"I'm okay\" shows up on the share page as a neutral status", async () => {
    await page.goto(`/trips/${tripId}/checkin`);
    await page.getByRole("button", { name: "I'm okay" }).click();
    await assertText(page.locator("main"), /Thanks — you're confirmed okay/);
    await anon.goto(plainUrl);
    await assertText(anon.locator("main"), /Confirmed okay at/);
  });

  await t.test("revoke → the link shows 'not available' (404) for everyone", async () => {
    await page.goto(`/trips/${tripId}`);
    const list = page.getByRole("list", { name: "Your share links" });
    const item = list.locator("li", { hasText: "No location" }).filter({ hasText: "Active" });
    await item.getByRole("button", { name: "Turn off" }).click();
    await assertText(list.locator("li", { hasText: "No location" }), /Turned off/);
    const res = await anon.goto(plainUrl);
    assert.equal(res.status(), 404);
    await assertText(anon.locator("main"), /This trip link isn't available/);
    assert.doesNotMatch(await anon.locator("main").innerText(), new RegExp(TRAIL_NAME));
  });

  await t.test("expired link (expires_at in the past) → 'not available'", async () => {
    const token = locUrl.split("/share/")[1];
    const hash = createHash("sha256").update(token).digest("hex");
    assert.match(hash, /^[0-9a-f]{64}$/);
    const n = sqlUpdate(`update public.trip_shares set expires_at = now() - interval '1 minute' where token_hash = '${hash}'`);
    assert.equal(n, 1, `expired exactly one share in ${DB_URL}`);
    const res = await anon.goto(locUrl);
    assert.equal(res.status(), 404);
    await assertText(anon.locator("main"), /This trip link isn't available/);
    assert.doesNotMatch(await anon.locator("main").innerText(), COORDS);
    await page.goto(`/trips/${tripId}`);
    await assertText(page.getByRole("list", { name: "Your share links" }), /Expired/);
  });

  await t.test("unknown token → same 'not available' page", async () => {
    const res = await anon.goto(`/share/${"x".repeat(32)}`);
    assert.equal(res.status(), 404);
    await assertText(anon.locator("main"), /This trip link isn't available/);
  });

  await t.test("after 'Finish trip', a location link no longer reveals the last position", async () => {
    const url = await createLink({ hours: 6, includeLocation: true });
    await page.goto(`/trips/${tripId}/checkin`);
    await page.getByRole("button", { name: "Finish trip" }).first().click();
    await page.getByRole("button", { name: /Yes, I'm back — finish trip/ }).click();
    await assertText(statusCard(page), /Trip finished/);
    const res = await anon.goto(url);
    if (res.status() === 200) {
      const text = await anon.locator("main").innerText();
      assert.match(text, /Finished the trip/);
      assert.doesNotMatch(text, COORDS, `a finished hike must not expose the last position on a share link:\n${text}`);
      assert.match(text, /The hike has ended, so location is no longer shown/);
      assert.doesNotMatch(text, /“No confirmation” only means/, "the no-confirmation caveat is only shown when there is no confirmation");
    }
    // no new links for a finished trip
    await page.goto(`/trips/${tripId}`);
    const card = page.locator("section", { has: page.getByRole("heading", { name: "Check-ins", level: 2 }) });
    await assertText(card, /Trip finished/);
    assert.equal(await card.getByRole("button", { name: "Create share link" }).count(), 0, "sharing is not offered after finishing");
    assert.deepEqual(anonErrors, []);
  });
});

// ---------------------------------------------------------------------------
// 6. Layout / a11y smoke for the safety pages (mobile)
// ---------------------------------------------------------------------------

test("safety pages at 390px: no horizontal scroll, one h1, labeled controls", { timeout: 180_000 }, async () => {
  const { page } = await customer("a11y", `Ally Eleven ${run}`);
  const tripId = await bookTrip(page);
  await addContact(page, { name: "Casey Consent", email: `casey-a11y@${run}.example.com`, consent: true });
  for (const path of ["/account", "/account/emergency-contacts", "/account/privacy", `/trips/${tripId}/checkin`, `/trips/${tripId}`]) {
    await page.goto(path);
    const r = await page.evaluate(() => {
      const visible = (el) => {
        const b = el.getBoundingClientRect();
        // closed <details> content keeps its box in Chromium but is not rendered
        const shown = el.checkVisibility ? el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }) : true;
        return shown && !el.closest("details:not([open]) > :not(summary)") && b.width > 0 && b.height > 0;
      };
      const unlabeled = [...document.querySelectorAll("main input:not([type=hidden]), main select, main textarea")]
        .filter(visible)
        .filter((el) => !((el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest("label") || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")))
        .map((el) => el.outerHTML.slice(0, 100));
      const nameless = [...document.querySelectorAll("main button, main a[href]")]
        .filter(visible)
        .filter((el) => !(el.innerText.trim() || el.getAttribute("aria-label")))
        .map((el) => el.outerHTML.slice(0, 100));
      const small = [...document.querySelectorAll("main button, main summary, main input[type=text], main input[type=email], main input[type=tel], main select")]
        .filter(visible)
        .filter((el) => el.getBoundingClientRect().height < 43.5)
        .map((el) => `${el.tagName} ${el.innerText?.slice(0, 30)} ${Math.round(el.getBoundingClientRect().height)}px`);
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        h1: document.querySelectorAll("h1").length,
        unlabeled,
        nameless,
        small,
      };
    });
    assert.ok(r.overflow <= 1, `${path}: horizontal scroll of ${r.overflow}px at 390px`);
    assert.equal(r.h1, 1, `${path}: exactly one h1`);
    assert.deepEqual(r.unlabeled, [], `${path}: every input has a label`);
    assert.deepEqual(r.nameless, [], `${path}: every button/link has an accessible name`);
    assert.deepEqual(r.small, [], `${path}: touch targets are at least 44px tall`);
  }
});
