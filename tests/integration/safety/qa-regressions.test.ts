/**
 * Regression tests for the safety-slice QA findings (e2e-safety.json):
 * overdue scan recovery, safety-notice retry cap, "Finish trip" ending the
 * hike, share links after finishing, re-consent on changed contact details,
 * and redaction of coordinates stored inside notice bodies.
 */
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, sql, withSystem } from "@/server/db";
import { finishTripByUser } from "@/server/checkins/manage";
import { onTripFinished } from "@/server/checkins/service";
import { SAFETY_RETRY_MAX_DELAY_SEC, scanOverdue } from "@/server/checkins/jobs";
import { createShare, resolveShare } from "@/server/sharing/shares";
import { consentCoversDetails, listContacts, updateContact } from "@/server/account/contacts";
import { deleteLocationHistory, locationHistoryStats, updatePrivacySettings } from "@/server/account/profile";
import { purgeExpiredLocations } from "@/server/account/retention";
import { LOCATION_REMOVED, MAP_LINK_REMOVED } from "@/domain/notification-messages";
import { createCustomer } from "../../helpers/db";
import { addLastLocation, addMin, bookedTrip, checkinRow, consentedContact, jobsFor, notificationsFor, optIn, runCheckinJobs, setFullName } from "./helpers";

afterAll(closeDb);

const COORDS = /-?\d{1,3}\.\d{5}, ?-?\d{1,3}\.\d{5}/;

// Unique recipients per contact: notice sends are rate limited per recipient
// address, so sharing the default test number across tests would throttle them.
let seq = 0;
const uniquePhone = () => `+1555${String(Date.now() % 10_000_000).padStart(7, "0").slice(0, 5)}${String(seq++ % 100).padStart(2, "0")}`;
const uniqueEmail = () => `qa-${Date.now().toString(36)}-${seq++}@example.com`;
const reachable = (over: { email?: string; phone?: string } = {}) => ({ phone: uniquePhone(), email: uniqueEmail(), ...over });

async function overdueJob(checkinId: string) {
  const [j] = await sql()<{ id: number; status: string; runAt: Date; attempts: number; maxAttempts: number }[]>`
    select id, status, run_at, attempts, max_attempts from public.jobs where dedup_key like ${`checkin:${checkinId}:%:overdue`} order by id desc limit 1`;
  return j;
}

async function sendJob(notificationId: string) {
  const [j] = await sql()<{ id: number; status: string; runAt: Date; attempts: number; maxAttempts: number }[]>`
    select id, status, run_at, attempts, max_attempts from public.jobs where dedup_key = ${`notify:${notificationId}`}`;
  return j;
}

describe("overdue safety-net scan", () => {
  it("pulls forward an overdue job still queued for a later time (deadline moved earlier) so the same run notifies once", async () => {
    const user = await createCustomer("scanfwd");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user, reachable({ email: "" }));
    const c = await optIn(user, trip.id, contact, { minutesAhead: 180, graceMinutes: 30, reminders: [] });
    // The e2e way of forcing overdue: the job stays queued at the old deadline, hours ahead.
    await sql()`update public.trip_checkins set expected_return_at = now() - interval '3 hours' where id = ${c.id}`;
    expect((await overdueJob(c.id)).runAt.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);

    const out = await scanOverdue(new Date());
    expect(out).toMatchObject({ outcome: "done", note: expect.stringMatching(/1 requeued/) });
    const job = await overdueJob(c.id);
    expect(job.status).toBe("queued");
    expect(job.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await jobsFor(c.id)).filter((j) => j.kind === "checkins.overdue")).toHaveLength(1); // same key, no duplicate

    await runCheckinJobs(c.id, new Date());
    await scanOverdue(new Date()); // no longer awaiting: nothing to recover
    await runCheckinJobs(c.id, new Date());
    const toContact = (await notificationsFor(c.id)).filter((n) => n.recipientKind === "emergency_contact");
    expect(toContact).toHaveLength(1);
    expect(toContact[0].status).toBe("simulated");
    expect((await checkinRow(trip.id)).status).toBe("contact_notified");
  });

  it("pulls forward an overdue job that is waiting out a long retry backoff", async () => {
    const user = await createCustomer("scanbackoff");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user, reachable({ email: "" }));
    const c = await optIn(user, trip.id, contact, { minutesAhead: 20, graceMinutes: 15, reminders: [] });
    await sql()`update public.trip_checkins set expected_return_at = now() - interval '1 hour' where id = ${c.id}`;
    // as markFailed leaves it after a few failures: queued, run_at = now() + backoff (up to an hour)
    await sql()`
      update public.jobs set status = 'queued', attempts = 4, run_at = now() + interval '1 hour', last_error = 'boom'
      where dedup_key = ${`checkin:${c.id}:v${c.version}:overdue`}`;
    await scanOverdue(new Date());
    const job = await overdueJob(c.id);
    expect(job.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(job.maxAttempts).toBeGreaterThanOrEqual(job.attempts + 3);
    await runCheckinJobs(c.id, addMin(new Date(), 1)); // the overdue job, then the sends it creates
    expect((await checkinRow(trip.id)).status).toBe("contact_notified");
  });

  it("caps the retry delay of undelivered overdue notices (and revives dead ones) while the check-in is still overdue; reminders are left alone", async () => {
    const user = await createCustomer("sendcap");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user, reachable({ email: "" }));
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 20, graceMinutes: 15, reminders: [] });
    await runCheckinJobs(c.id, addMin(now, 40), { kinds: ["checkins.overdue"] });
    const notes = await notificationsFor(c.id);
    const toContact = notes.find((n) => n.recipientKind === "emergency_contact")!;
    const toUser = notes.find((n) => n.recipientKind === "user")!;
    // a failed send backed off for an hour, and the hiker's own notice dead-lettered
    await sql()`update public.notifications set status = 'failed', error = 'provider timeout' where id in (${toContact.id}, ${toUser.id})`;
    await sql()`update public.jobs set attempts = 4, run_at = now() + interval '1 hour', last_error = 'timeout' where dedup_key = ${`notify:${toContact.id}`}`;
    await sql()`update public.jobs set status = 'dead', attempts = 6, finished_at = now() where dedup_key = ${`notify:${toUser.id}`}`;

    // an unrelated reminder send with a long backoff must not be touched
    const other = await createCustomer("sendcap-rem");
    const t2 = await bookedTrip(other);
    const c2 = await optIn(other, t2.id, await consentedContact(other, reachable()), { now, minutesAhead: 120, graceMinutes: 30, reminders: [60] });
    await runCheckinJobs(c2.id, addMin(now, 61), { kinds: ["checkins.reminder"] });
    const reminder = (await notificationsFor(c2.id)).find((n) => n.template === "checkin_reminder")!;
    await sql()`update public.jobs set run_at = now() + interval '1 hour' where dedup_key = ${`notify:${reminder.id}`}`;

    const out = await scanOverdue(new Date());
    expect(out?.note).toMatch(/2 notice sends expedited/);
    const contactJob = await sendJob(toContact.id);
    expect(contactJob.status).toBe("queued");
    expect(contactJob.runAt.getTime()).toBeLessThanOrEqual(Date.now() + SAFETY_RETRY_MAX_DELAY_SEC * 1000);
    const userJob = await sendJob(toUser.id);
    expect(userJob.status).toBe("queued");
    expect(userJob.maxAttempts).toBeGreaterThan(userJob.attempts);
    expect((await sendJob(reminder.id)).runAt.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);

    await runCheckinJobs(c.id, new Date(), { kinds: ["notifications.send"] });
    expect((await checkinRow(trip.id)).status).toBe("contact_notified");
    const after = await notificationsFor(c.id);
    expect(after.filter((n) => n.recipientKind === "emergency_contact").map((n) => n.status)).toEqual(["simulated"]);
  });
});

describe("“Yes, I'm back — finish trip” finishes the trip", () => {
  it("on an active trip: closes the hike session, completes the trip and the check-in, cancels jobs", async () => {
    const user = await createCustomer("finishhike");
    const trip = await bookedTrip(user, { status: "active" });
    const contact = await consentedContact(user, reachable());
    const c = await optIn(user, trip.id, contact, { minutesAhead: 120, graceMinutes: 30, reminders: [60] });
    const sessionId = await addLastLocation(user, trip.id, { lat: 47.5, lng: -121.7, accuracyM: 9, recordedAt: new Date() });

    const r = await finishTripByUser(user, trip.id);
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/Welcome back/) });
    const [t] = await sql()<{ status: string }[]>`select status from public.trips where id = ${trip.id}`;
    expect(t.status).toBe("completed");
    const [s] = await sql()<{ status: string; finishedAt: Date | null }[]>`select status, finished_at from public.hike_sessions where id = ${sessionId}`;
    expect(s.status).toBe("finished");
    expect(s.finishedAt).not.toBeNull();
    expect((await checkinRow(trip.id)).status).toBe("completed");
    expect((await jobsFor(c.id)).every((j) => j.status === "cancelled")).toBe(true);
    // idempotent
    expect(await finishTripByUser(user, trip.id)).toMatchObject({ ok: true, message: "This trip is already finished." });
  });

  it("repairs a trip left active after only the check-in was completed", async () => {
    const user = await createCustomer("finishrepair");
    const trip = await bookedTrip(user, { status: "active" });
    await optIn(user, trip.id, await consentedContact(user, reachable()));
    const sessionId = await addLastLocation(user, trip.id, { lat: 47.5, lng: -121.7, accuracyM: 9, recordedAt: new Date() });
    await withSystem((tx) => onTripFinished(tx, trip.id, user.id)); // old behaviour of the check-in "Finish trip"
    expect(await finishTripByUser(user, trip.id)).toMatchObject({ ok: true });
    const [t] = await sql()<{ status: string }[]>`select status from public.trips where id = ${trip.id}`;
    expect(t.status).toBe("completed");
    const [s] = await sql()<{ status: string }[]>`select status from public.hike_sessions where id = ${sessionId}`;
    expect(s.status).toBe("finished");
  });

  it("on a booked trip whose hike was never started: completes the check-in, leaves the booking alone", async () => {
    const user = await createCustomer("finishbooked");
    const trip = await bookedTrip(user);
    await optIn(user, trip.id, await consentedContact(user, reachable()));
    expect(await finishTripByUser(user, trip.id)).toMatchObject({ ok: true });
    expect((await checkinRow(trip.id)).status).toBe("completed");
    const [t] = await sql()<{ status: string }[]>`select status from public.trips where id = ${trip.id}`;
    expect(t.status).toBe("booked");
  });

  it("after the contact was notified: the follow-up is queued and the message says it is simulated in demo mode", async () => {
    const user = await createCustomer("finishnotified");
    await setFullName(user, "Hana Hiker");
    const trip = await bookedTrip(user, { status: "active" });
    const contact = await consentedContact(user, reachable({ email: "" }));
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 20, graceMinutes: 15, reminders: [] });
    await addLastLocation(user, trip.id, { lat: 47.5, lng: -121.7, accuracyM: 9, recordedAt: now });
    await runCheckinJobs(c.id, addMin(now, 40));
    expect((await checkinRow(trip.id)).status).toBe("contact_notified");
    const r = await finishTripByUser(user, trip.id, addMin(now, 45));
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/letting your contact know \(a simulated follow-up/) });
    const fin = (await notificationsFor(c.id)).filter((n) => n.template === "checkin_followup_finished");
    expect(fin).toHaveLength(1);
  });
});

describe("share links after finishing", () => {
  it("never reveal a position once the trip or its check-in is finished, and new links are refused", async () => {
    const user = await createCustomer("sharefinish");
    await setFullName(user, "Hana Hiker");
    const trip = await bookedTrip(user, { status: "active" });
    await optIn(user, trip.id, await consentedContact(user, reachable()));
    await addLastLocation(user, trip.id, { lat: 47.512345, lng: -121.684321, accuracyM: 11, recordedAt: new Date() });
    const link = await createShare(user, trip.id, 24, true);
    if (!link.ok) throw new Error(link.error);
    expect(link.expiresLabel).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M P[SD]T$/);
    expect((await resolveShare(link.token))!.location).not.toBeNull();

    // check-in completed while the session was left open (e.g. finished elsewhere): location hidden already
    await withSystem((tx) => onTripFinished(tx, trip.id, user.id));
    const mid = (await resolveShare(link.token))!;
    expect(mid.location).toBeNull();
    expect(mid.locationNote).toMatch(/hike has ended/);
    expect(await createShare(user, trip.id, 6, true)).toMatchObject({ ok: false, error: expect.stringMatching(/finished/) });

    await finishTripByUser(user, trip.id);
    const v = (await resolveShare(link.token))!;
    expect(v.statusText).toMatch(/^Finished the trip at /);
    expect(v.location).toBeNull();
    expect(v.showNoConfirmationNote).toBe(false);
    expect(JSON.stringify(v)).not.toMatch(COORDS);
    expect(await createShare(user, trip.id, 6, false)).toMatchObject({ ok: false });
  });
});

describe("emergency contact consent follows the contact details", () => {
  it("a pre-ticked box does not carry consent over to a new phone or email; ticking again for the new details does", async () => {
    const user = await createCustomer("reconsent");
    const id = await consentedContact(user, { name: "Quinn", phone: "", email: "quinn@example.com" });
    const base = { name: "Quinn", phone: "", relationship: "" };
    const firstConsent = (await listContacts(user))[0].consentConfirmedAt!;

    // unchanged details: consent (and its original time) kept
    expect(await updateContact(user, id, { ...base, email: "quinn@example.com", relationship: "friend", consent: true })).toEqual({ ok: true });
    expect((await listContacts(user))[0].consentConfirmedAt!.getTime()).toBe(firstConsent.getTime());

    // email changed, box still ticked from the old attestation (no / stale consentFor): consent cleared
    expect(await updateContact(user, id, { ...base, email: "someone-else@example.com", consent: true })).toEqual({ ok: true, consentCleared: true });
    let [c] = await listContacts(user);
    expect(c.email).toBe("someone-else@example.com");
    expect(c.hasConsent).toBe(false);
    expect(c.consentStatement).toBeNull();

    // ticked again (contact had no consent on file): fresh attestation
    expect(await updateContact(user, id, { ...base, email: "someone-else@example.com", consent: true })).toEqual({ ok: true });
    [c] = await listContacts(user);
    expect(c.hasConsent).toBe(true);

    // changed again, ticked for the NEW details in the form: consent re-attested now
    const res = await updateContact(user, id, { ...base, email: "third@example.com", consent: true, consentFor: JSON.stringify(["", " Third@Example.com "]) });
    expect(res).toEqual({ ok: true });
    [c] = await listContacts(user);
    expect(c.hasConsent).toBe(true);
    expect(c.consentConfirmedAt!.getTime()).toBeGreaterThan(firstConsent.getTime());

    // consentFor naming the OLD details does not count for new ones
    expect(
      await updateContact(user, id, { ...base, phone: "+1 555 555 0142", email: "third@example.com", consent: true, consentFor: JSON.stringify(["", "third@example.com"]) }),
    ).toEqual({ ok: true, consentCleared: true });
    expect((await listContacts(user))[0].hasConsent).toBe(false);
  });

  it("consentCoversDetails normalizes phone and email and rejects junk", () => {
    expect(consentCoversDetails(JSON.stringify(["(555) 555-0123", ""]), "+15555550123", null)).toBe(true);
    expect(consentCoversDetails(JSON.stringify(["", "A@B.example"]), null, "a@b.example")).toBe(true);
    expect(consentCoversDetails(JSON.stringify(["", "a@b.example"]), "+15555550123", "a@b.example")).toBe(false);
    expect(consentCoversDetails("not json", null, null)).toBe(false);
    expect(consentCoversDetails(JSON.stringify([1, 2]), null, null)).toBe(false);
    expect(consentCoversDetails(undefined, null, null)).toBe(false);
  });
});

describe("coordinates inside stored notices", () => {
  async function notifiedWithLocation(label: string) {
    const user = await createCustomer(label);
    await setFullName(user, "Hana Hiker");
    const trip = await bookedTrip(user, { status: "active" });
    const contact = await consentedContact(user, reachable()); // phone + email: SMS and email (with map link) notices
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 20, graceMinutes: 15, reminders: [] });
    await addLastLocation(user, trip.id, { lat: 47.512345, lng: -121.684321, accuracyM: 11, recordedAt: now });
    await runCheckinJobs(c.id, addMin(now, 40));
    const bodies = (await notificationsFor(c.id)).filter((n) => n.recipientKind === "emergency_contact").map((n) => n.body);
    expect(bodies).toHaveLength(2);
    expect(bodies.every((b) => COORDS.test(b))).toBe(true);
    return { user, trip, c };
  }

  it("“Delete my location history now” redacts them (and counts them as stored location)", async () => {
    const { user, c } = await notifiedWithLocation("redact");
    const { c: otherC } = await notifiedWithLocation("redact-other");
    expect((await locationHistoryStats(user)).noticesWithLocation).toBe(2);
    const res = await deleteLocationHistory(user);
    expect(res).toMatchObject({ lastFixesDeleted: 1, noticesRedacted: 2 });
    const mine = (await notificationsFor(c.id)).filter((n) => n.recipientKind === "emergency_contact");
    for (const n of mine) {
      expect(n.body).not.toMatch(COORDS);
      expect(n.body).not.toContain("openstreetmap");
      expect(n.body).toContain(`Last reported location: ${LOCATION_REMOVED}`);
      expect(n.body).toContain("Ghost Guide has NOT contacted emergency services");
    }
    expect(mine.find((n) => n.channel === "email")!.body).toContain(MAP_LINK_REMOVED);
    expect((await locationHistoryStats(user)).noticesWithLocation).toBe(0);
    // someone else's notices are untouched
    expect((await notificationsFor(otherC.id)).filter((n) => n.recipientKind === "emergency_contact").every((n) => COORDS.test(n.body))).toBe(true);
  });

  it("the retention purge redacts notices older than the user's window, but not those of a check-in that is still open", async () => {
    const { user, trip, c } = await notifiedWithLocation("retain");
    await updatePrivacySettings(user, { locationRetentionDays: 1, shareLocationWithContacts: true });
    await sql()`update public.notifications set created_at = now() - interval '2 days' where checkin_id = ${c.id}`;
    await purgeExpiredLocations(new Date());
    // check-in still open (contact_notified): kept for a notice that may still matter
    expect((await notificationsFor(c.id)).filter((n) => n.template === "checkin_overdue_contact").every((n) => COORDS.test(n.body))).toBe(true);

    await finishTripByUser(user, trip.id);
    const out = await purgeExpiredLocations(new Date());
    expect(out?.note).toMatch(/[1-9]\d* notices redacted/);
    const after = (await notificationsFor(c.id)).filter((n) => n.template === "checkin_overdue_contact");
    expect(after).toHaveLength(2);
    expect(after.every((n) => !COORDS.test(n.body) && n.body.includes(LOCATION_REMOVED))).toBe(true);
    const [audit] = await sql()<{ metadata: { noticesRedacted: number } }[]>`
      select metadata from public.audit_logs where action = 'retention.purge' order by id desc limit 1`;
    expect(audit.metadata.noticesRedacted).toBeGreaterThanOrEqual(2);
  });
});
