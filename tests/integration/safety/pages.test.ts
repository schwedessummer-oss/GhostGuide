/**
 * Render smoke tests for the safety pages, cards and server actions,
 * outside Next.js: cookies are mocked with a real signed demo session,
 * refresh() is a no-op, and redirect()/notFound() are read from the thrown
 * error digest. Pages are async server components rendered with React's
 * Node prerenderer against the test database.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { prerenderToNodeStream } from "react-dom/static";
import { closeDb, sql } from "@/server/db";
import { signSession } from "@/server/auth/tokens";
import type { SessionUser } from "@/server/auth";
import { createShare } from "@/server/sharing/shares";
import { createCustomer } from "../../helpers/db";
import { addLastLocation, addMin, bookedTrip, checkinRow, consentedContact, optIn, runCheckinJobs, setFullName } from "./helpers";

const jar = vi.hoisted(() => ({ token: undefined as string | undefined, ip: "203.0.113.7" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "gg_session" && jar.token ? { name, value: jar.token } : undefined),
    getAll: () => [],
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers({ "x-forwarded-for": jar.ip }),
}));
vi.mock("next/cache", () => ({ refresh: () => {}, revalidatePath: () => {} }));

afterAll(closeDb);
beforeEach(() => {
  jar.token = undefined;
});

function signIn(user: SessionUser) {
  jar.token = signSession(process.env.AUTH_SECRET!, { sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600 });
}

async function render(el: ReactElement): Promise<string> {
  const { prelude } = await prerenderToNodeStream(el);
  let html = "";
  for await (const chunk of prelude) html += chunk.toString();
  return html.replaceAll("<!-- -->", "");
}

async function thrownDigest(p: Promise<unknown>): Promise<string> {
  const err = (await p.then(
    () => null,
    (e: unknown) => e,
  )) as { digest?: string } | null;
  return err?.digest ?? `no digest: ${String(err)}`;
}

const params = <T,>(v: T) => Promise.resolve(v);

function form(fields: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
}

describe("check-in page and cards", () => {
  it("renders the setup card for a booked trip without a check-in, and the opt-in action works with the form's field names", async () => {
    const user = await createCustomer("ui");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user);
    signIn(user);
    const { default: Page } = await import("@/app/trips/[id]/checkin/page");
    const html = await render(await Page({ params: params({ id: trip.id }), searchParams: params({}) } as never));
    expect(html).toContain("Trip check-ins");
    expect(html).toContain("Turn on check-ins");
    expect(html).toContain("not continuous monitoring and not a rescue service");
    expect(html).toContain('name="expectedReturn"');
    expect(html).toContain(`value="${contact}"`);

    const { setupCheckinAction } = await import("@/components/checkin/actions");
    const missing = await setupCheckinAction(trip.id, undefined, form({ contactId: contact, expectedReturn: "2026-01-01T10:00", graceMinutes: "30" }));
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/understand/) });
    const { toLocalInputValue } = await import("@/domain/checkin");
    const ok = await setupCheckinAction(
      trip.id,
      undefined,
      form({
        contactId: contact,
        expectedReturn: toLocalInputValue(addMin(new Date(), 180), "America/Los_Angeles"),
        graceMinutes: "45",
        reminders: ["60", "15"],
        understand: "on",
      }),
    );
    expect(ok).toMatchObject({ ok: true });
    const row = await checkinRow(trip.id);
    expect(row).toMatchObject({ status: "scheduled", graceMinutes: 45 });

    const after = await render(await Page({ params: params({ id: trip.id }), searchParams: params({}) } as never));
    expect(after).toContain("Check-ins are on");
    expect(after).toContain("I&#x27;m okay");
    expect(after).toContain("+1•••••0123");
    expect(after).toContain("Change check-in details");
  });

  it("quick actions: I'm okay, extend and finish via the server actions; history shows simulated notices", async () => {
    const user = await createCustomer("ui2");
    await setFullName(user, "Hana Hiker");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user, { email: "" });
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 20, graceMinutes: 15, reminders: [] });
    await addLastLocation(user, trip.id, { lat: 47.5, lng: -121.7, accuracyM: 8, recordedAt: addMin(now, 10) });
    await runCheckinJobs(c.id, addMin(now, 40));
    signIn(user);
    const { default: Page } = await import("@/app/trips/[id]/checkin/page");
    const html = await render(await Page({ params: params({ id: trip.id }), searchParams: params({}) } as never));
    expect(html).toContain("Your contact was sent a notice");
    expect(html).toContain("Simulated — not delivered");
    expect(html).toContain("Check-in notice to your contact");
    expect(html).not.toMatch(/emergency detected|in danger/i);

    const actions = await import("@/components/checkin/actions");
    expect(await actions.confirmOkAction(trip.id, undefined, form({}))).toMatchObject({ ok: true, message: expect.stringMatching(/letting your contact know/) });
    expect(await actions.extendAction(trip.id, undefined, form({ minutes: "30" }))).toMatchObject({ ok: true });
    expect(await actions.extendAction(trip.id, undefined, form({ minutes: "31" }))).toMatchObject({ ok: false });
    expect(await actions.finishAction(trip.id, undefined, form({}))).toMatchObject({ ok: false });
    expect(await actions.finishAction(trip.id, undefined, form({ confirmFinish: "yes" }))).toMatchObject({ ok: true });
    expect((await checkinRow(trip.id)).status).toBe("completed");
    const done = await render(await Page({ params: params({ id: trip.id }), searchParams: params({}) } as never));
    expect(done).toContain("Trip finished");
  });

  it("another customer gets a 404 for the check-in page and their actions are rejected", async () => {
    const alice = await createCustomer("alice-ui");
    const bob = await createCustomer("bob-ui");
    const trip = await bookedTrip(alice);
    await optIn(alice, trip.id, await consentedContact(alice));
    signIn(bob);
    const { default: Page } = await import("@/app/trips/[id]/checkin/page");
    expect(await thrownDigest(Page({ params: params({ id: trip.id }), searchParams: params({}) } as never))).toMatch(/NEXT_HTTP_ERROR_FALLBACK;404/);
    const actions = await import("@/components/checkin/actions");
    expect(await actions.confirmOkAction(trip.id, undefined, form({}))).toMatchObject({ ok: false, error: "Trip not found." });
    expect(await actions.createShareAction(trip.id, undefined, form({ hours: "24" }))).toMatchObject({ ok: false, error: "Trip not found." });
    // signed out -> redirect to login
    jar.token = undefined;
    expect(await thrownDigest(actions.confirmOkAction(trip.id, undefined, form({})))).toMatch(/NEXT_REDIRECT;.*\/login/);
  });

  it("the status card (trip dashboard) renders status, quick actions and share management", async () => {
    const user = await createCustomer("card");
    const trip = await bookedTrip(user);
    await optIn(user, trip.id, await consentedContact(user));
    signIn(user);
    const actions = await import("@/components/checkin/actions");
    const created = await actions.createShareAction(trip.id, undefined, form({ hours: "6" }));
    expect(created).toMatchObject({ ok: true, url: expect.stringMatching(/\/share\//) });
    const { CheckinStatusCard } = await import("@/components/checkin/checkin-status-card");
    const html = await render((await CheckinStatusCard({ tripId: trip.id }))!);
    expect(html).toContain("Check-ins are on");
    expect(html).toContain("Share your trip");
    expect(html).toContain("Works until");
    expect(html).toContain("Include my last reported location");
    const { CheckinSetupCard } = await import("@/components/checkin/checkin-setup-card");
    const setup = await render((await CheckinSetupCard({ tripId: trip.id }))!);
    expect(setup).toContain("Change contact, time or reminders");
    // not signed in / not owner -> renders nothing
    jar.token = undefined;
    expect(await CheckinStatusCard({ tripId: trip.id })).toBeNull();
  });
});

describe("public share page", () => {
  it("shows neutral status and the last location only when included; unknown tokens 404", async () => {
    const user = await createCustomer("sharepage");
    await setFullName(user, "Hana Hiker");
    const trip = await bookedTrip(user, { status: "active" });
    await optIn(user, trip.id, await consentedContact(user));
    await addLastLocation(user, trip.id, { lat: 47.512345, lng: -121.684321, accuracyM: 11, recordedAt: addMin(new Date(), -40) });
    const withLoc = await createShare(user, trip.id, 24, true);
    const without = await createShare(user, trip.id, 24, false);
    if (!withLoc.ok || !without.ok) throw new Error("share failed");
    const { default: SharePage } = await import("@/app/share/[token]/page");
    jar.ip = `198.51.100.${Math.floor(Math.random() * 200)}`;
    const a = await render(await SharePage({ params: params({ token: withLoc.token }), searchParams: params({}) } as never));
    expect(a).toContain("Hana&#x27;s hike: Lantern Creek Loop");
    expect(a).toContain("No confirmation received yet");
    expect(a).toContain("47.51235, -121.68432");
    expect(a).toContain("STALE — 40 min old");
    expect(a).toContain("not live tracking");
    expect(a).toContain("not an emergency service");
    const b = await render(await SharePage({ params: params({ token: without.token }), searchParams: params({}) } as never));
    expect(b).not.toContain("47.51235");
    expect(b).not.toContain("Last reported location");
    expect(await thrownDigest(SharePage({ params: params({ token: "x".repeat(32) }), searchParams: params({}) } as never))).toMatch(/404/);
  });
});

describe("account pages", () => {
  it("render profile, contacts and privacy pages and run their actions", async () => {
    const user = await createCustomer("acct");
    signIn(user);
    const { default: AccountPage } = await import("@/app/account/page");
    expect(await render(await AccountPage())).toContain("Save profile");
    const acct = await import("@/app/account/actions");
    expect(await acct.updateProfileAction(undefined, form({ fullName: "Hana Hiker", phone: "555 555 0100", units: "metric" }))).toMatchObject({ ok: true });
    expect(await acct.updateProfileAction(undefined, form({ fullName: "", phone: "nope", units: "metric" }))).toMatchObject({
      ok: false,
      fieldErrors: { fullName: expect.any(String), phone: expect.any(String) },
    });

    const contactsActions = await import("@/app/account/emergency-contacts/actions");
    expect(
      await contactsActions.createContactAction(undefined, form({ name: "Casey", phone: "+1 555 555 0123", email: "", relationship: "Friend", consent: "on" })),
    ).toMatchObject({ ok: true });
    expect(await contactsActions.createContactAction(undefined, form({ name: "Pat", phone: "", email: "", relationship: "" }))).toMatchObject({ ok: false });
    const { default: ContactsPage } = await import("@/app/account/emergency-contacts/page");
    const contactsHtml = await render(await ContactsPage({ params: params({}), searchParams: params({}) } as never));
    expect(contactsHtml).toContain("Casey");
    expect(contactsHtml).toContain("Consent confirmed");
    expect(contactsHtml).toContain("agreed to receive Ghost Guide check-in notices");
    const [{ id }] = await sql()`select id from public.emergency_contacts where user_id = ${user.id}`;
    expect(await contactsActions.deleteContactAction(id, undefined, form({}))).toMatchObject({ ok: false });
    expect(await contactsActions.deleteContactAction(id, undefined, form({ confirmDelete: "yes" }))).toMatchObject({ ok: true });

    const { default: PrivacyPage } = await import("@/app/account/privacy/page");
    const privacyHtml = await render(await PrivacyPage());
    expect(privacyHtml).toContain("Who can see your precise location");
    expect(privacyHtml).toContain("Ghost Guide safety staff, only when needed");
    expect(await acct.updatePrivacyAction(undefined, form({ locationRetentionDays: "400" }))).toMatchObject({ ok: false });
    expect(await acct.updatePrivacyAction(undefined, form({ locationRetentionDays: "14" }))).toMatchObject({ ok: true });
    const [p] = await sql()`select location_retention_days, share_location_with_contacts from public.profiles where id = ${user.id}`;
    expect(p).toEqual({ locationRetentionDays: 14, shareLocationWithContacts: false });
    expect(await acct.deleteLocationHistoryAction(undefined, form({}))).toMatchObject({ ok: false });
    expect(await acct.deleteLocationHistoryAction(undefined, form({ confirmDelete: "on" }))).toMatchObject({ ok: true });
  });
});
