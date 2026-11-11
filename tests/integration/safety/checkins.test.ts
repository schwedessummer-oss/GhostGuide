import { afterAll, describe, expect, it } from "vitest";
import { closeDb, sql, withSystem } from "@/server/db";
import { confirmOkByUser, extendCheckinByUser, finishTripByUser, getOwnedCheckin, optOutOfCheckin, setupCheckin } from "@/server/checkins/manage";
import { cancelCheckinForTrip, onCheckinConfirmedFromDevice, onHikeStarted, onTripFinished } from "@/server/checkins/service";
import { processOverdueJob, scanOverdue } from "@/server/checkins/jobs";
import { createContact, updateContact } from "@/server/account/contacts";
import { OK_AUTO_EXTEND_MIN, toLocalInputValue } from "@/domain/checkin";
import { createCustomer } from "../../helpers/db";
import { TZ, addMin, bookedTrip, checkinRow, consentedContact, jobsFor, notificationsFor, optIn, runCheckinJobs, setFullName } from "./helpers";

afterAll(closeDb);

describe("check-in setup", () => {
  it("schedules version-keyed reminder + overdue jobs at the right times", async () => {
    const user = await createCustomer("setup");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user);
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 180, graceMinutes: 45, reminders: [60, 15] });
    expect(c.status).toBe("scheduled");
    expect(c.version).toBe(1);
    const jobs = await jobsFor(c.id);
    expect(jobs.map((j) => j.dedupKey).sort()).toEqual(
      [`checkin:${c.id}:v1:overdue`, `checkin:${c.id}:v1:reminder:15`, `checkin:${c.id}:v1:reminder:60`].sort(),
    );
    const overdue = jobs.find((j) => j.kind === "checkins.overdue")!;
    expect(overdue.runAt.getTime()).toBe(c.expectedReturnAt.getTime() + 45 * 60_000);
    expect(overdue.payload).toEqual({ checkinId: c.id, version: 1 });
    const r60 = jobs.find((j) => j.dedupKey.endsWith("reminder:60"))!;
    expect(r60.runAt.getTime()).toBe(c.expectedReturnAt.getTime() - 60 * 60_000);
    const events = await sql()`select kind, actor from public.checkin_events where checkin_id = ${c.id}`;
    expect(events.map((e) => e.kind)).toContain("opted_in");
  });

  it("is active immediately when a hike session is already open; hike start moves scheduled -> active", async () => {
    const user = await createCustomer("open");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user);
    await withSystem((tx) => tx`insert into public.hike_sessions (trip_id, user_id, status) values (${trip.id}, ${user.id}, 'active')`);
    expect((await optIn(user, trip.id, contact)).status).toBe("active");

    const trip2 = await bookedTrip(user);
    await optIn(user, trip2.id, contact);
    await withSystem((tx) => onHikeStarted(tx, trip2.id, user.id));
    expect((await checkinRow(trip2.id)).status).toBe("active");
    await withSystem((tx) => onHikeStarted(tx, trip2.id, user.id)); // idempotent
    expect((await checkinRow(trip2.id)).status).toBe("active");
  });

  it("rejects contacts without consent, other users' contacts and ineligible trips", async () => {
    const user = await createCustomer("consent");
    const other = await createCustomer("other");
    const trip = await bookedTrip(user);
    const noConsent = await createContact(user, { name: "Pat", phone: "+15555550111", email: "", relationship: "", consent: false });
    if (!noConsent.ok) throw new Error(noConsent.error);
    const input = (contactId: string) => ({
      contactId,
      expectedReturnLocal: toLocalInputValue(addMin(new Date(), 120), TZ),
      graceMinutes: 30,
      reminderOffsetsMin: [15],
    });
    const r = await setupCheckin(user, trip.id, input(noConsent.id));
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/hasn't agreed/);
    const othersContact = await consentedContact(other);
    expect(await setupCheckin(user, trip.id, input(othersContact))).toMatchObject({ ok: false });
    const saved = await bookedTrip(user, { status: "saved" });
    expect(await setupCheckin(user, saved.id, input(await consentedContact(user)))).toMatchObject({ ok: false });
    expect(await checkinRow(trip.id)).toBeUndefined();
  });

  it("opt out cancels jobs; opting back in starts a new version", async () => {
    const user = await createCustomer("optout");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user);
    const c = await optIn(user, trip.id, contact);
    expect(await optOutOfCheckin(user, trip.id)).toMatchObject({ ok: true });
    const row = await checkinRow(trip.id);
    expect(row.status).toBe("cancelled");
    expect((await jobsFor(c.id)).every((j) => j.status === "cancelled")).toBe(true);
    const again = await optIn(user, trip.id, contact);
    expect(again.status).toBe("scheduled");
    expect(again.version).toBe(row.version + 1);
    expect((await jobsFor(c.id)).filter((j) => j.status === "queued").every((j) => j.dedupKey.includes(`:v${again.version}:`))).toBe(true);
  });
});

describe("overdue processing", () => {
  it("notifies each consented contact exactly once, even when the job runs twice or the scan re-enqueues it", async () => {
    const user = await createCustomer("overdue");
    await setFullName(user, "Hana Hiker");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user);
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 30, graceMinutes: 15, reminders: [] });
    const after = addMin(now, 46);

    const first = await processOverdueJob({ checkinId: c.id, version: c.version }, after);
    expect(first).toMatchObject({ outcome: "done" });
    const second = await processOverdueJob({ checkinId: c.id, version: c.version }, after);
    expect(second).toMatchObject({ outcome: "noop" });

    // the periodic safety net uses the SAME dedup key: no new job rows
    const before = (await jobsFor(c.id)).length;
    await scanOverdue(addMin(now, 50));
    expect((await jobsFor(c.id)).filter((j) => j.kind === "checkins.overdue")).toHaveLength(1);
    expect((await jobsFor(c.id)).length).toBe(before);

    await runCheckinJobs(c.id, addMin(now, 60)); // runs the original overdue job (noop) + sends
    const notes = await notificationsFor(c.id);
    const toContact = notes.filter((n) => n.recipientKind === "emergency_contact");
    expect(toContact.map((n) => n.channel).sort()).toEqual(["email", "sms"]); // contact has phone + email
    expect(toContact.every((n) => n.recipientRef === contact)).toBe(true);
    expect(notes.filter((n) => n.recipientKind === "user")).toHaveLength(1);
    // only masked recipients are stored
    expect(toContact.find((n) => n.channel === "sms")!.recipientMasked).toBe("+1•••••0123");
    expect(JSON.stringify(notes)).not.toContain("5555550123");
    expect(JSON.stringify(notes)).not.toContain("casey@example.com");
    const row = await checkinRow(trip.id);
    expect(row.status).toBe("contact_notified");
    expect(row.overdueAt).not.toBeNull();
    expect(row.contactNotifiedAt).not.toBeNull();
  });

  it("the scan recovers a lost overdue job by enqueueing the same key, which then notifies once", async () => {
    const user = await createCustomer("scan");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user, { email: "" });
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 20, graceMinutes: 15, reminders: [] });
    // simulate a lost job
    await sql()`delete from public.jobs where dedup_key = ${`checkin:${c.id}:v1:overdue`}`;
    await scanOverdue(addMin(now, 40));
    await scanOverdue(addMin(now, 41));
    const overdueJobs = (await jobsFor(c.id)).filter((j) => j.kind === "checkins.overdue");
    expect(overdueJobs).toHaveLength(1);
    expect(overdueJobs[0].dedupKey).toBe(`checkin:${c.id}:v1:overdue`);
    await runCheckinJobs(c.id, addMin(now, 41));
    const notes = await notificationsFor(c.id);
    expect(notes.filter((n) => n.recipientKind === "emergency_contact")).toHaveLength(1);
  });

  it("a delayed overdue job for an extended check-in is a no-op (version guard); extension reschedules", async () => {
    const user = await createCustomer("extend");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user);
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 60, graceMinutes: 15, reminders: [30] });
    expect(await extendCheckinByUser(user, trip.id, { minutes: 120 }, addMin(now, 10))).toMatchObject({ ok: true });
    const row = await checkinRow(trip.id);
    expect(row.version).toBe(2);
    expect(row.expectedReturnAt.getTime()).toBe(c.expectedReturnAt.getTime() + 120 * 60_000);
    const jobs = await jobsFor(c.id);
    expect(jobs.filter((j) => j.dedupKey.includes(":v1:")).every((j) => j.status === "cancelled")).toBe(true);
    expect(jobs.filter((j) => j.dedupKey.includes(":v2:")).map((j) => j.status)).toEqual(["queued", "queued"]);

    // the old v1 overdue job is delayed and runs anyway past the OLD deadline
    const stale = await processOverdueJob({ checkinId: c.id, version: 1 }, addMin(now, 90));
    expect(stale).toMatchObject({ outcome: "noop" });
    // and even the v2 job run early (e.g. clock skew) is a no-op
    expect(await processOverdueJob({ checkinId: c.id, version: 2 }, addMin(now, 90))).toMatchObject({ outcome: "noop" });
    expect(await notificationsFor(c.id)).toHaveLength(0);
    expect((await checkinRow(trip.id)).status).toBe("scheduled");

    // pick-a-time extension
    const until = toLocalInputValue(addMin(now, 300), TZ);
    expect(await extendCheckinByUser(user, trip.id, { untilLocal: until }, addMin(now, 11))).toMatchObject({ ok: true });
    expect((await checkinRow(trip.id)).version).toBe(3);
    expect(await extendCheckinByUser(user, trip.id, { minutes: 45 }, addMin(now, 12))).toMatchObject({ ok: false });
  });

  it("finishing cancels queued reminders/overdue jobs, and a stale job that still runs is a no-op", async () => {
    const user = await createCustomer("finish");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user);
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 90, graceMinutes: 30, reminders: [60, 15] });
    expect(await finishTripByUser(user, trip.id, addMin(now, 20))).toMatchObject({ ok: true });
    const row = await checkinRow(trip.id);
    expect(row.status).toBe("completed");
    expect((await jobsFor(c.id)).every((j) => j.status === "cancelled")).toBe(true);
    // a job already claimed before the cancel still runs: no-op
    expect(await processOverdueJob({ checkinId: c.id, version: c.version }, addMin(now, 200))).toMatchObject({ outcome: "noop" });
    await scanOverdue(addMin(now, 200));
    expect((await jobsFor(c.id)).every((j) => j.status === "cancelled")).toBe(true);
    expect(await notificationsFor(c.id)).toHaveLength(0);
    // safe to call repeatedly (hike slice hook + web action)
    await withSystem((tx) => onTripFinished(tx, trip.id, user.id));
    expect((await checkinRow(trip.id)).completedAt?.getTime()).toBe(row.completedAt?.getTime());
    // OK after finishing is ignored
    await withSystem((tx) => onCheckinConfirmedFromDevice(tx, trip.id, user.id, new Date(), "evt-after-finish"));
    expect((await checkinRow(trip.id)).status).toBe("completed");
  });
});

describe("“I'm okay”", () => {
  it("before the expected return: confirmed_ok, same version, overdue still evaluated", async () => {
    const user = await createCustomer("okbefore");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user);
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 60, graceMinutes: 15, reminders: [] });
    expect(await confirmOkByUser(user, trip.id, addMin(now, 30))).toMatchObject({ ok: true });
    const row = await checkinRow(trip.id);
    expect(row.status).toBe("confirmed_ok");
    expect(row.version).toBe(c.version);
    expect(row.lastOkAt?.getTime()).toBe(addMin(now, 30).getTime());
    // still overdue at expected return + grace if nothing else arrives
    expect(await processOverdueJob({ checkinId: c.id, version: c.version }, addMin(now, 76))).toMatchObject({ outcome: "done" });
  });

  it("after the expected return: auto-extends to now + 60 min, bumps version and reschedules", async () => {
    const user = await createCustomer("okafter");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user);
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 30, graceMinutes: 60, reminders: [] });
    const late = addMin(now, 45); // past expected return, inside grace
    expect(await confirmOkByUser(user, trip.id, late)).toMatchObject({ ok: true });
    const row = await checkinRow(trip.id);
    expect(row.status).toBe("confirmed_ok");
    expect(row.version).toBe(c.version + 1);
    expect(row.expectedReturnAt.getTime()).toBe(late.getTime() + OK_AUTO_EXTEND_MIN * 60_000);
    const jobs = await jobsFor(c.id);
    expect(jobs.find((j) => j.dedupKey === `checkin:${c.id}:v1:overdue`)?.status).toBe("cancelled");
    expect(jobs.find((j) => j.dedupKey === `checkin:${c.id}:v2:overdue`)?.status).toBe("queued");
  });

  it("while the contact was notified: confirms, suppresses nothing already sent, and sends the contact a follow-up", async () => {
    const user = await createCustomer("okfollow");
    await setFullName(user, "Ravi Rambler");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user, { email: "" });
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 20, graceMinutes: 15, reminders: [] });
    // the deadline passed in real time (device taps are judged against the server clock)
    await sql()`update public.trip_checkins set expected_return_at = now() - interval '40 minutes' where id = ${c.id}`;
    expect(await processOverdueJob({ checkinId: c.id, version: c.version }, new Date())).toMatchObject({ outcome: "done" });
    await runCheckinJobs(c.id, new Date(), { kinds: ["notifications.send"] });
    expect((await checkinRow(trip.id)).status).toBe("contact_notified");
    // device tap (after the deadline) synced later (idempotent per clientEventId)
    const tappedAt = addMin(new Date(), -2);
    await withSystem((tx) => onCheckinConfirmedFromDevice(tx, trip.id, user.id, tappedAt, "device-evt-1"));
    await withSystem((tx) => onCheckinConfirmedFromDevice(tx, trip.id, user.id, tappedAt, "device-evt-1"));
    const row = await checkinRow(trip.id);
    expect(row.status).toBe("confirmed_ok");
    expect(row.version).toBe(2);
    const okEvents = await sql()`select 1 from public.checkin_events where checkin_id = ${c.id} and details ->> 'clientEventId' = 'device-evt-1'`;
    expect(okEvents).toHaveLength(1);
    await runCheckinJobs(c.id, new Date(), { kinds: ["notifications.send"] });
    const followUps = (await notificationsFor(c.id)).filter((n) => n.template === "checkin_followup_ok");
    expect(followUps).toHaveLength(1);
    expect(followUps[0].status).toBe("simulated");
    expect(followUps[0].body).toMatch(/Ravi has confirmed they're okay/);
  });
});

describe("contacts and cancellation", () => {
  it("a contact whose consent was withdrawn is never notified; the user still is", async () => {
    const user = await createCustomer("withdrawn");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user);
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 20, graceMinutes: 15, reminders: [] });
    const upd = await updateContact(user, contact, { name: "Casey Contact", phone: "+15555550123", email: "casey@example.com", relationship: "", consent: false });
    expect(upd.ok).toBe(true);
    await runCheckinJobs(c.id, addMin(now, 40));
    const notes = await notificationsFor(c.id);
    expect(notes.filter((n) => n.recipientKind === "emergency_contact")).toHaveLength(0);
    expect(notes.filter((n) => n.recipientKind === "user")).toHaveLength(1);
    const ev = await sql()`select details from public.checkin_events where checkin_id = ${c.id} and kind = 'contact_not_notified'`;
    expect(ev[0].details).toMatchObject({ reason: "no_consent_on_file" });
    expect((await checkinRow(trip.id)).status).toBe("overdue");
  });

  it("consent withdrawn after the notice was queued but before delivery: the send is suppressed", async () => {
    const user = await createCustomer("lateconsent");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user, { email: "" });
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 20, graceMinutes: 15, reminders: [] });
    await runCheckinJobs(c.id, addMin(now, 40), { kinds: ["checkins.overdue"] });
    await updateContact(user, contact, { name: "Casey", phone: "+15555550123", email: "", relationship: "", consent: false });
    await runCheckinJobs(c.id, addMin(now, 41));
    const toContact = (await notificationsFor(c.id)).filter((n) => n.recipientKind === "emergency_contact");
    expect(toContact).toHaveLength(1);
    expect(toContact[0].status).toBe("suppressed");
    expect(toContact[0].error).toMatch(/no consent/);
    expect((await checkinRow(trip.id)).status).toBe("overdue");
    // recorded on the check-in so the hiker's activity says the contact was not notified (once per version)
    await runCheckinJobs(c.id, addMin(now, 42));
    const ev = await sql()`select details from public.checkin_events where checkin_id = ${c.id} and kind = 'contact_not_notified'`;
    expect(ev).toHaveLength(1);
    expect(ev[0].details).toMatchObject({ reason: "consent_withdrawn", version: c.version });
  });

  it("cancelCheckinForTrip cancels the check-in and its jobs; jobs self-heal when only the trip was cancelled", async () => {
    const user = await createCustomer("cancel");
    const contact = await consentedContact(user);
    const trip = await bookedTrip(user);
    const c = await optIn(user, trip.id, contact);
    expect(await withSystem((tx) => cancelCheckinForTrip(tx, trip.id))).toBe(true);
    expect(await withSystem((tx) => cancelCheckinForTrip(tx, trip.id))).toBe(false);
    expect((await checkinRow(trip.id)).status).toBe("cancelled");
    expect((await jobsFor(c.id)).every((j) => j.status === "cancelled")).toBe(true);

    const trip2 = await bookedTrip(user);
    const now = new Date();
    const c2 = await optIn(user, trip2.id, contact, { now, minutesAhead: 20, graceMinutes: 15, reminders: [] });
    await withSystem((tx) => tx`update public.trips set status = 'cancelled' where id = ${trip2.id}`);
    expect(await processOverdueJob({ checkinId: c2.id, version: c2.version }, addMin(now, 60))).toMatchObject({ outcome: "noop" });
    expect((await checkinRow(trip2.id)).status).toBe("cancelled");
    expect(await notificationsFor(c2.id)).toHaveLength(0);
  });

  it("customers cannot read or change someone else's check-in", async () => {
    const alice = await createCustomer("alice");
    const bob = await createCustomer("bob");
    const trip = await bookedTrip(alice);
    const contact = await consentedContact(alice);
    const c = await optIn(alice, trip.id, contact);
    expect(await getOwnedCheckin(bob, trip.id)).toBeNull();
    for (const r of [
      await confirmOkByUser(bob, trip.id),
      await extendCheckinByUser(bob, trip.id, { minutes: 60 }),
      await finishTripByUser(bob, trip.id),
      await optOutOfCheckin(bob, trip.id),
    ]) {
      expect(r).toMatchObject({ ok: false, notFound: true });
    }
    // bob's contact on alice's trip via the hike hooks: ignored (user mismatch)
    await withSystem((tx) => onTripFinished(tx, trip.id, bob.id));
    await withSystem((tx) => onCheckinConfirmedFromDevice(tx, trip.id, bob.id, new Date(), "bob-evt"));
    const row = await checkinRow(trip.id);
    expect(row.status).toBe("scheduled");
    expect(row.version).toBe(c.version);
    // RLS: bob sees nothing
    const { withUser } = await import("@/server/db");
    expect(await withUser(bob, (tx) => tx`select id from public.trip_checkins where trip_id = ${trip.id}`)).toHaveLength(0);
    await expect(withUser(alice, (tx) => tx`update public.trip_checkins set status = 'completed' where id = ${c.id}`)).rejects.toThrow(/permission denied/);
  });
});
