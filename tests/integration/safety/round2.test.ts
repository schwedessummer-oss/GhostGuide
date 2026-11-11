/**
 * Round-2 safety fixes: stale offline "I'm okay" (SAFETY-1), device
 * extensions (contract A), staff resolution (contract B), contact-side
 * opt-out links (REQUIREMENTS-7) and the job-runner delay warning.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { prerenderToNodeStream } from "react-dom/static";
import { closeDb, sql, withSystem, withUser } from "@/server/db";
import { signSession } from "@/server/auth/tokens";
import type { SessionUser } from "@/server/auth";
import { onCheckinConfirmedFromDevice, onCheckinExtendedFromDevice, staffResolveCheckin } from "@/server/checkins/service";
import { processOverdueJob } from "@/server/checkins/jobs";
import { confirmOkByUser, finishTripByUser } from "@/server/checkins/manage";
import { listContacts } from "@/server/account/contacts";
import { lookupOptOutLink, optOutWithLink } from "@/server/account/contact-optout";
import { OK_AUTO_EXTEND_MIN, formatClock } from "@/domain/checkin";
import { SMS_MAX_CHARS } from "@/domain/notification-messages";
import { createCustomer, demoUser } from "../../helpers/db";
import { TZ, addLastLocation, addMin, bookedTrip, checkinRow, consentedContact, jobsFor, notificationsFor, optIn, runCheckinJobs, setFullName } from "./helpers";

const jar = vi.hoisted(() => ({ token: undefined as string | undefined, ip: "198.51.100.20" }));
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

// Notice sends are rate limited per recipient address: unique details per contact.
let seq = 0;
const uniquePhone = () => `+1555${String(Date.now() % 10_000_000).padStart(7, "0").slice(0, 5)}${String(seq++ % 100).padStart(2, "0")}`;
const uniqueEmail = () => `r2-${Date.now().toString(36)}-${seq++}@example.com`;
const reachable = () => ({ phone: uniquePhone(), email: uniqueEmail() });

const OPT_OUT_LINK = /\/contact\/opt-out\/([A-Za-z0-9_-]{16,64})/;

/**
 * A check-in whose expected return (3:00 PM in the test's terms) is
 * `returnMinAgo` minutes in the past (grace 30), driven overdue and its
 * contact notice sent, at real time (device hooks use the server clock).
 */
async function notifiedCheckin(label: string, opts: { returnMinAgo?: number; deliver?: boolean } = {}) {
  const user = await createCustomer(label);
  await setFullName(user, "Alex Hiker");
  const trip = await bookedTrip(user, { status: "active" });
  const contact = await consentedContact(user, reachable());
  const c = await optIn(user, trip.id, contact, { graceMinutes: 30 });
  // as if the hiker had opted in hours ago (device events are compared with when changes were made)
  await sql()`update public.checkin_events set created_at = created_at - interval '6 hours' where checkin_id = ${c.id}`;
  await sql()`update public.trip_checkins set expected_return_at = now() - make_interval(mins => ${opts.returnMinAgo ?? 120}) where id = ${c.id}`;
  expect(await processOverdueJob({ checkinId: c.id, version: c.version }, new Date())).toMatchObject({ outcome: "done" });
  if (opts.deliver !== false) {
    await runCheckinJobs(c.id, new Date(), { kinds: ["notifications.send"] });
    expect((await checkinRow(trip.id)).status).toBe("contact_notified");
  }
  const row = await checkinRow(trip.id);
  return { user, trip, contact, c: row };
}

describe("SAFETY-1: an old offline “I'm okay” never clears an overdue check-in", () => {
  it("a tap from before the expected return, synced after the notice: stays contact_notified, records last_ok_at, no 'okay' follow-up", async () => {
    const { user, trip, c } = await notifiedCheckin("stale-ok");
    const tappedAt = addMin(c.expectedReturnAt, -120); // 1:00 PM vs a 3:00 PM deadline
    await withSystem((tx) => onCheckinConfirmedFromDevice(tx, trip.id, user.id, tappedAt, `ok-${c.id}`));
    const after = await checkinRow(trip.id);
    expect(after.status).toBe("contact_notified");
    expect(after.version).toBe(c.version);
    expect(after.expectedReturnAt).toEqual(c.expectedReturnAt);
    expect(after.lastOkAt).toEqual(tappedAt);
    const notices = await notificationsFor(c.id);
    expect(notices.filter((n) => n.template.startsWith("checkin_followup"))).toEqual([]);
    expect(notices.find((n) => n.template === "checkin_overdue_contact")?.status).toBe("simulated");
    const [ev] = await sql()<{ kind: string; details: Record<string, unknown> }[]>`
      select kind, details from public.checkin_events where checkin_id = ${c.id} and details ->> 'clientEventId' = ${`ok-${c.id}`}`;
    expect(ev.kind).toBe("ok_recorded_late");
    expect(ev.details.tappedAt).toBe(tappedAt.toISOString());
    // replay is a no-op
    await withSystem((tx) => onCheckinConfirmedFromDevice(tx, trip.id, user.id, tappedAt, `ok-${c.id}`));
    expect((await checkinRow(trip.id)).status).toBe("contact_notified");
  });

  it("while the notice is still undelivered (status overdue), an old tap does not suppress it", async () => {
    const { user, trip, c } = await notifiedCheckin("stale-ok-pending", { deliver: false });
    expect(c.status).toBe("overdue");
    await withSystem((tx) => onCheckinConfirmedFromDevice(tx, trip.id, user.id, addMin(c.expectedReturnAt, -60), `okp-${c.id}`));
    expect((await checkinRow(trip.id)).status).toBe("overdue");
    const contactNotice = (await notificationsFor(c.id)).find((n) => n.template === "checkin_overdue_contact")!;
    expect(contactNotice.status).toBe("queued");
    await runCheckinJobs(c.id, new Date(), { kinds: ["notifications.send"] });
    expect((await notificationsFor(c.id)).find((n) => n.id === contactNotice.id)?.status).toBe("simulated");
    expect((await checkinRow(trip.id)).status).toBe("contact_notified");
  });

  it("a tap after the expected return resolves it; the follow-up states the tap time and when it reached Ghost Guide", async () => {
    const { user, trip, c } = await notifiedCheckin("late-ok", { returnMinAgo: 60 });
    const tappedAt = addMin(new Date(), -40); // 20 min after the deadline, synced 40 min later
    await withSystem((tx) => onCheckinConfirmedFromDevice(tx, trip.id, user.id, tappedAt, `okl-${c.id}`));
    const after = await checkinRow(trip.id);
    expect(after.status).toBe("confirmed_ok");
    expect(after.version).toBe(c.version + 1);
    expect(after.expectedReturnAt.getTime()).toBe(tappedAt.getTime() + OK_AUTO_EXTEND_MIN * 60_000);
    const followUps = (await notificationsFor(c.id)).filter((n) => n.template === "checkin_followup_ok");
    expect(followUps.length).toBeGreaterThan(0);
    for (const f of followUps) {
      expect(f.body).toMatch(/tapped “I'm okay” at /);
      expect(f.body).toContain(formatClock(tappedAt, TZ));
      expect(f.body).toMatch(/it reached Ghost Guide at/);
      expect(f.body).not.toMatch(/has now confirmed/);
      expect(f.body).toMatch(OPT_OUT_LINK);
    }
    expect((await jobsFor(c.id)).some((j) => j.dedupKey === `checkin:${c.id}:v${c.version + 1}:overdue` && j.status === "queued")).toBe(true);
  });

  it("a live “I'm okay” from the web still resolves an overdue check-in at once", async () => {
    const { user, trip, c } = await notifiedCheckin("live-ok");
    expect(await confirmOkByUser(user, trip.id)).toMatchObject({ ok: true, message: expect.stringMatching(/letting your contact know/) });
    expect((await checkinRow(trip.id)).status).toBe("confirmed_ok");
    expect((await notificationsFor(c.id)).some((n) => n.template === "checkin_followup_ok")).toBe(true);
  });
});

describe("contract A: onCheckinExtendedFromDevice", () => {
  it("applies an extension: version++, old jobs cancelled, new ones scheduled, user/device event; idempotent per clientEventId", async () => {
    const user = await createCustomer("dev-ext");
    const trip = await bookedTrip(user, { status: "active" });
    const contact = await consentedContact(user, reachable());
    const c = await optIn(user, trip.id, contact, { minutesAhead: 60 });
    const occurredAt = new Date(); // made on the phone after the check-in was set up
    const newReturn = addMin(c.expectedReturnAt, 90);
    const r = await withSystem((tx) => onCheckinExtendedFromDevice(tx, trip.id, user.id, occurredAt, newReturn, `ext-${c.id}`));
    expect(r).toEqual({ applied: true });
    const after = await checkinRow(trip.id);
    expect(after.version).toBe(c.version + 1);
    expect(after.expectedReturnAt).toEqual(newReturn);
    const jobs = await jobsFor(c.id);
    expect(jobs.filter((j) => j.dedupKey.includes(`:v${c.version}:`)).every((j) => j.status === "cancelled")).toBe(true);
    expect(jobs.some((j) => j.dedupKey === `checkin:${c.id}:v${c.version + 1}:overdue` && j.status === "queued")).toBe(true);
    const [ev] = await sql()<{ kind: string; actor: string; actorId: string; details: Record<string, unknown> }[]>`
      select kind, actor, actor_id, details from public.checkin_events where checkin_id = ${c.id} and details ->> 'clientEventId' = ${`ext-${c.id}`}`;
    expect(ev).toMatchObject({ kind: "extended", actor: "user", actorId: user.id });
    expect(ev.details).toMatchObject({ source: "device", occurredAt: occurredAt.toISOString() });

    expect(await withSystem((tx) => onCheckinExtendedFromDevice(tx, trip.id, user.id, occurredAt, newReturn, `ext-${c.id}`))).toEqual({
      applied: true,
      reason: "duplicate",
    });
    expect((await checkinRow(trip.id)).version).toBe(c.version + 1);
  });

  it("rejects bad times, other users, ended check-ins, and stale extensions that would move the time backwards", async () => {
    const user = await createCustomer("dev-ext-bad");
    const other = await createCustomer("dev-ext-other");
    const trip = await bookedTrip(user, { status: "active" });
    const contact = await consentedContact(user, reachable());
    const c = await optIn(user, trip.id, contact, { minutesAhead: 60 });
    const now = new Date();
    const call = (occ: Date, until: Date, id: string, who = user.id) => withSystem((tx) => onCheckinExtendedFromDevice(tx, trip.id, who, occ, until, id));
    expect(await call(now, addMin(now, -1), "bad-1")).toMatchObject({ applied: false });
    expect(await call(now, addMin(now, 24 * 60 + 1), "bad-2")).toMatchObject({ applied: false });
    expect(await call(now, addMin(now, 60), "bad 3")).toMatchObject({ applied: false, reason: "invalid client event id" });
    expect(await call(now, addMin(now, 120), "other-1", other.id)).toMatchObject({ applied: false });

    // a web extension at "now", then an older device extension to an earlier time arrives
    await withSystem((tx) => onCheckinExtendedFromDevice(tx, trip.id, user.id, now, addMin(now, 240), "newer-1"));
    const stale = await call(addMin(now, -20), addMin(now, 90), "stale-1");
    expect(stale).toMatchObject({ applied: false, reason: expect.stringMatching(/stale/) });
    expect((await checkinRow(trip.id)).expectedReturnAt).toEqual(addMin(now, 240));
    const ignored = await sql()`select kind from public.checkin_events where checkin_id = ${c.id} and details ->> 'clientEventId' = 'stale-1'`;
    expect(ignored.map((e) => e.kind)).toEqual(["extend_ignored"]);

    await finishTripByUser(user, trip.id);
    expect(await call(new Date(), addMin(new Date(), 60), "after-finish")).toMatchObject({ applied: false, reason: "check-in is completed" });
  });

  it("an extension made before the deadline but synced after the notice resolves it and tells the contact when it was made", async () => {
    const { user, trip, c } = await notifiedCheckin("dev-ext-late", { returnMinAgo: 60 });
    const madeAt = addMin(c.expectedReturnAt, -30);
    const r = await withSystem((tx) => onCheckinExtendedFromDevice(tx, trip.id, user.id, madeAt, addMin(new Date(), 60), `extl-${c.id}`));
    expect(r).toEqual({ applied: true });
    expect((await checkinRow(trip.id)).status).toBe("active");
    const followUps = (await notificationsFor(c.id)).filter((n) => n.template === "checkin_followup_extended");
    expect(followUps.length).toBeGreaterThan(0);
    for (const f of followUps) expect(f.body).toContain(formatClock(madeAt, TZ));
  });
});

describe("contract B: staffResolveCheckin", () => {
  it("requires trips.monitor", async () => {
    const { c } = await notifiedCheckin("staff-perm");
    const support = await demoUser("support");
    const customer = await createCustomer("not-staff");
    for (const who of [support, customer]) {
      expect(await withSystem((tx) => staffResolveCheckin(tx, c.id, who, { outcome: "note_only", note: "x" }))).toMatchObject({ ok: false });
    }
    expect(await sql()`select 1 from public.checkin_events where checkin_id = ${c.id} and actor = 'staff'`).toHaveLength(0);
  });

  it("note_only records a staff event without changing state", async () => {
    const { trip, c } = await notifiedCheckin("staff-note");
    const safety = await demoUser("safety");
    expect(await withSystem((tx) => staffResolveCheckin(tx, c.id, safety, { outcome: "note_only", note: "  Called the hiker, no answer yet.  " }))).toEqual({
      ok: true,
    });
    expect(await withSystem((tx) => staffResolveCheckin(tx, c.id, safety, { outcome: "note_only", note: "   " }))).toMatchObject({ ok: false });
    const after = await checkinRow(trip.id);
    expect(after.status).toBe("contact_notified");
    expect(after.version).toBe(c.version);
    const [ev] = await sql()<{ kind: string; actor: string; actorId: string; details: Record<string, unknown> }[]>`
      select kind, actor, actor_id, details from public.checkin_events where checkin_id = ${c.id} and actor = 'staff'`;
    expect(ev).toMatchObject({ kind: "staff_note", actor: "staff", actorId: safety.id, details: { outcome: "note_only", note: "Called the hiker, no answer yet." } });
  });

  it("hiker_confirmed_safe completes the check-in, cancels jobs, follows up with the notified contact, and the hiker sees who closed it", async () => {
    const { user, trip, c } = await notifiedCheckin("staff-safe");
    const safety = await demoUser("safety");
    expect(await withSystem((tx) => staffResolveCheckin(tx, c.id, safety, { outcome: "hiker_confirmed_safe", note: "Hiker called us: home safe." }))).toEqual({
      ok: true,
    });
    const after = await checkinRow(trip.id);
    expect(after.status).toBe("completed");
    expect((await jobsFor(c.id)).filter((j) => j.status === "queued" && j.kind.startsWith("checkins."))).toEqual([]);
    const followUps = (await notificationsFor(c.id)).filter((n) => n.template === "checkin_followup_finished");
    expect(followUps.length).toBeGreaterThan(0);
    for (const f of followUps) {
      expect(f.body).toMatch(/our team has confirmed that Alex is safe/);
      expect(f.body).toMatch(OPT_OUT_LINK);
    }
    const [ev] = await sql()<{ kind: string; details: Record<string, unknown> }[]>`
      select kind, details from public.checkin_events where checkin_id = ${c.id} and kind = 'staff_resolved'`;
    expect(ev.details).toMatchObject({ outcome: "hiker_confirmed_safe", note: "Hiker called us: home safe." });
    // repeat is refused, nothing doubles
    expect(await withSystem((tx) => staffResolveCheckin(tx, c.id, safety, { outcome: "hiker_confirmed_safe", note: "again" }))).toMatchObject({ ok: false });

    signIn(user);
    const { default: Page } = await import("@/app/trips/[id]/checkin/page");
    const html = await render(await Page({ params: params({ id: trip.id }), searchParams: params({}) } as never));
    expect(html).toContain("Check-in closed by Ghost Guide staff");
    expect(html).toContain("Ghost Guide staff recorded that you&#x27;re safe and closed this check-in");
  });

  it("is refused for a check-in that hasn't started", async () => {
    const user = await createCustomer("staff-sched");
    const trip = await bookedTrip(user);
    const c = await optIn(user, trip.id, await consentedContact(user, reachable()));
    const safety = await demoUser("safety");
    expect(await withSystem((tx) => staffResolveCheckin(tx, c.id, safety, { outcome: "hiker_confirmed_safe", note: "?" }))).toMatchObject({ ok: false });
    expect((await checkinRow(trip.id)).status).toBe("scheduled");
  });
});

describe("REQUIREMENTS-7: contact opt-out links", () => {
  it("every notice to the contact has its own link; only a hash is stored; customers can't read tokens", async () => {
    const { user, c, contact } = await notifiedCheckin("optout-links");
    const notices = (await notificationsFor(c.id)).filter((n) => n.recipientKind === "emergency_contact");
    expect(notices.length).toBe(2); // SMS + email
    const tokens = notices.map((n) => OPT_OUT_LINK.exec(n.body)?.[1]);
    expect(tokens.every(Boolean)).toBe(true);
    expect(new Set(tokens).size).toBe(2);
    const sms = notices.find((n) => n.channel === "sms")!;
    expect(sms.body.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(sms.body).toMatch(/Stop these notices: http/);
    const stored = await sql()<{ tokenHash: string; contactId: string }[]>`select token_hash, contact_id from public.contact_optout_tokens where contact_id = ${contact}`;
    expect(stored).toHaveLength(2);
    for (const t of tokens) expect(stored.some((s) => s.tokenHash === t)).toBe(false);
    await expect(withUser(user, (tx) => tx`select * from public.contact_optout_tokens`)).rejects.toThrow(/permission denied/);
    await expect(
      withUser(user, (tx) => tx`update public.emergency_contacts set contact_opted_out_at = now() where id = ${contact}`),
    ).rejects.toThrow(/permission denied/);
  });

  it("opting out withdraws consent at once, suppresses undelivered notices, records events/audit and tells the hiker", async () => {
    const { user, trip, c, contact } = await notifiedCheckin("optout-do", { deliver: false });
    const notices = await notificationsFor(c.id);
    const token = OPT_OUT_LINK.exec(notices.find((n) => n.recipientKind === "emergency_contact" && n.channel === "sms")!.body)![1];

    const look = await lookupOptOutLink(token, "203.0.113.50");
    expect(look).toEqual({ rateLimited: false, view: { state: "ready", hikerFirstName: "Alex" } });
    const res = await optOutWithLink(token, "203.0.113.50");
    expect(res).toEqual({ ok: true, alreadyOptedOut: false, hikerFirstName: "Alex" });

    const [ec] = await sql()<{ consentConfirmedAt: Date | null; consentStatement: string | null; contactOptedOutAt: Date | null }[]>`
      select consent_confirmed_at, consent_statement, contact_opted_out_at from public.emergency_contacts where id = ${contact}`;
    expect(ec.consentConfirmedAt).toBeNull();
    expect(ec.consentStatement).toBeNull();
    expect(ec.contactOptedOutAt).toBeInstanceOf(Date);
    const after = await notificationsFor(c.id);
    for (const n of after.filter((x) => x.recipientKind === "emergency_contact")) {
      expect(n.status).toBe("suppressed");
      expect(n.error).toMatch(/opted out/);
    }
    const hikerNotice = after.find((n) => n.template === "checkin_contact_opted_out");
    expect(hikerNotice?.recipientKind).toBe("user");
    expect(hikerNotice?.body).toMatch(/Casey Contact used the link in one of our notices to stop receiving check-in notices/);
    const events = await sql()`select kind, actor, details from public.checkin_events where checkin_id = ${c.id} and kind = 'contact_opted_out'`;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: "system", details: { contactId: contact, via: "opt_out_link" } });
    expect(await sql()`select 1 from public.audit_logs where action = 'emergency_contact.opted_out' and entity_id = ${contact}`).toHaveLength(1);

    // the hiker sees it on the contacts page data and the check-in page
    const [view] = (await listContacts(user)).filter((x) => x.id === contact);
    expect(view.hasConsent).toBe(false);
    expect(view.contactOptedOutAt).toBeInstanceOf(Date);
    signIn(user);
    const { default: Page } = await import("@/app/trips/[id]/checkin/page");
    const html = await render(await Page({ params: params({ id: trip.id }), searchParams: params({}) } as never));
    expect(html).toContain("Casey Contact opted out of Ghost Guide notices");
    expect(html).toContain("/contact/opt-out/…"); // tokens are masked in the hiker's history
    expect(html).not.toContain(token);

    // idempotent; the pending send job delivers nothing
    expect(await optOutWithLink(token, "203.0.113.50")).toEqual({ ok: true, alreadyOptedOut: true, hikerFirstName: "Alex" });
    await runCheckinJobs(c.id, new Date(), { kinds: ["notifications.send"] });
    expect((await notificationsFor(c.id)).filter((n) => n.recipientKind === "emergency_contact" && n.status !== "suppressed")).toEqual([]);
    expect(await sql()`select 1 from public.audit_logs where action = 'emergency_contact.opted_out' and entity_id = ${contact}`).toHaveLength(1);
  });

  it("the public page works without sign-in, never shows a location, and the button (not the link) opts out", async () => {
    const { user, trip, c, contact } = await notifiedCheckin("optout-page");
    await addLastLocation(user, trip.id, { lat: 47.51234, lng: -121.65432, accuracyM: 9, recordedAt: new Date() });
    const token = OPT_OUT_LINK.exec((await notificationsFor(c.id)).find((n) => n.recipientKind === "emergency_contact" && n.channel === "email")!.body)![1];
    const { default: Page } = await import("@/app/contact/opt-out/[token]/page");
    jar.ip = "198.51.100.21";
    const html = await render(await Page({ params: params({ token }), searchParams: params({}) } as never));
    expect(html).toContain("Stop check-in notices");
    expect(html).toContain("Alex");
    expect(html).toContain("Stop sending me notices");
    expect(html).not.toMatch(/47\.51|121\.65|Lantern|overdue|\bexpected\b/i);
    // viewing changed nothing
    expect((await sql()`select consent_confirmed_at from public.emergency_contacts where id = ${contact}`)[0].consentConfirmedAt).not.toBeNull();

    const { contactOptOutAction } = await import("@/app/contact/opt-out/[token]/actions");
    const fd = new FormData();
    fd.set("token", token);
    expect(await thrownDigest(contactOptOutAction(fd))).toMatch(new RegExp(`NEXT_REDIRECT;.*/contact/opt-out/${token}\\?result=done`));
    expect((await sql()`select consent_confirmed_at from public.emergency_contacts where id = ${contact}`)[0].consentConfirmedAt).toBeNull();
    const done = await render(await Page({ params: params({ token }), searchParams: params({ result: "done" }) } as never));
    expect(done).toContain("Done — you won&#x27;t get any more notices");

    const bad = await render(await Page({ params: params({ token: "AAAAAAAAAAAAAAAAAAAA" }), searchParams: params({}) } as never));
    expect(bad).toContain("This link isn&#x27;t valid or has expired");
  });

  it("is rate limited per client", async () => {
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) limited = (await lookupOptOutLink("ZZZZZZZZZZZZZZZZ", "192.0.2.99")).rateLimited;
    expect(limited).toBe(true);
    expect(await optOutWithLink("ZZZZZZZZZZZZZZZZ", "192.0.2.99")).toMatchObject({ ok: false, rateLimited: true });
  });

  it("an expired or unknown token is invalid", async () => {
    const { contact } = await notifiedCheckin("optout-expired");
    const token = "ExpiredTokenAAAA";
    const { sha256 } = await import("@/server/auth/tokens");
    const [ec] = await sql()<{ userId: string }[]>`select user_id from public.emergency_contacts where id = ${contact}`;
    await sql()`insert into public.contact_optout_tokens (contact_id, user_id, token_hash, expires_at) values (${contact}, ${ec.userId}, ${sha256(token)}, now() - interval '1 minute')`;
    expect(await lookupOptOutLink(token, "192.0.2.10")).toEqual({ rateLimited: false, view: { state: "invalid" } });
    expect(await optOutWithLink(token, "192.0.2.10")).toMatchObject({ ok: false });
  });
});

describe("job-runner health on check-in screens", () => {
  async function setHeartbeat(minutesAgo: number) {
    await sql()`
      insert into public.app_settings (key, value, description)
      values ('job_runner_heartbeat', ${sql().json({ at: addMin(new Date(), -minutesAgo).toISOString(), summary: {} })}, 'test')
      on conflict (key) do update set value = excluded.value`;
  }

  it("warns honestly when background checks are delayed, and not when they run", async () => {
    const user = await createCustomer("runner");
    const trip = await bookedTrip(user);
    await optIn(user, trip.id, await consentedContact(user, reachable()));
    signIn(user);
    const { default: Page } = await import("@/app/trips/[id]/checkin/page");
    const { CheckinSetupCard } = await import("@/components/checkin/checkin-setup-card");
    const trip2 = await bookedTrip(user);
    await consentedContact(user, reachable());

    await setHeartbeat(30);
    const stalePage = await render(await Page({ params: params({ id: trip.id }), searchParams: params({}) } as never));
    expect(stalePage).toContain("Background checks are delayed right now; notices may be late");
    expect(stalePage).toContain("haven&#x27;t run for 30 minutes");
    expect(await render((await CheckinSetupCard({ tripId: trip2.id }))!)).toContain("Background checks are delayed right now");

    await setHeartbeat(1);
    expect(await render(await Page({ params: params({ id: trip.id }), searchParams: params({}) } as never))).not.toContain("Background checks are delayed");
    expect(await render((await CheckinSetupCard({ tripId: trip2.id }))!)).not.toContain("Background checks are delayed");
  });
});
