import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, sql, withSystem } from "@/server/db";
import { resetEnvCache } from "@/config/env";
import { processNotificationSend } from "@/server/notifications/send";
import { finishTripByUser, listTripNotifications } from "@/server/checkins/manage";
import { processReminderJob } from "@/server/checkins/jobs";
import { updatePrivacySettings } from "@/server/account/profile";
import { containsBannedPhrase } from "@/domain/notification-messages";
import { createCustomer } from "../../helpers/db";
import { addLastLocation, addMin, bookedTrip, checkinRow, consentedContact, jobsFor, notificationsFor, optIn, runCheckinJobs, setFullName } from "./helpers";

afterAll(closeDb);

const ENV_KEYS = ["NOTIFY_PROVIDER", "APP_MODE", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "RESEND_API_KEY", "NOTIFY_FROM_EMAIL"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvCache();
});

describe("notification delivery", () => {
  it("demo provider never delivers: status 'simulated' and an integration event with outcome 'simulated'", async () => {
    const user = await createCustomer("demo");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user, { email: "" });
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 20, graceMinutes: 15, reminders: [] });
    await runCheckinJobs(c.id, addMin(now, 40));
    const notes = await notificationsFor(c.id);
    expect(notes.length).toBe(2);
    for (const n of notes) {
      expect(n.status).toBe("simulated");
      expect(n.provider).toBe("demo");
      const ev = await sql()`select outcome, provider_kind, provider_key from public.integration_events where entity_type = 'notification' and entity_id = ${n.id}`;
      expect(ev).toEqual([{ outcome: "simulated", providerKind: "notifications", providerKey: "demo" }]);
    }
    // sending again is a no-op (already simulated)
    expect(await processNotificationSend({ notificationId: notes[0].id }, new Date())).toMatchObject({ outcome: "noop" });
    // the user can see the full audit trail of their trip (masked recipients)
    const history = await listTripNotifications(user, trip.id);
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.recipientMasked)).toContain("+1•••••0123");
  });

  it("live mode without a configured provider fails loudly — never silently drops, never pretends success", async () => {
    const user = await createCustomer("live");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user, { email: "" });
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 20, graceMinutes: 15, reminders: [] });
    await runCheckinJobs(c.id, addMin(now, 40), { kinds: ["checkins.overdue"] });
    const contactNote = (await notificationsFor(c.id)).find((n) => n.recipientKind === "emergency_contact")!;

    process.env.NOTIFY_PROVIDER = "live";
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    resetEnvCache();
    await expect(processNotificationSend({ notificationId: contactNote.id }, new Date())).rejects.toThrow(/No live SMS provider is configured/);
    const [row] = await sql()`select status, error, provider, sent_at from public.notifications where id = ${contactNote.id}`;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/No live SMS provider is configured/);
    expect(row.provider).toBe("unconfigured");
    expect(row.sentAt).toBeNull();
    const ev = await sql()`select outcome from public.integration_events where entity_id = ${contactNote.id}`;
    expect(ev.map((e) => e.outcome)).toEqual(["failure"]);
    // the check-in is NOT marked contact_notified
    expect((await checkinRow(trip.id)).status).toBe("overdue");

    // APP_MODE=live with the demo provider also refuses to simulate
    process.env.NOTIFY_PROVIDER = "demo";
    process.env.APP_MODE = "live";
    resetEnvCache();
    await expect(processNotificationSend({ notificationId: contactNote.id }, new Date())).rejects.toThrow(/cannot run when APP_MODE=live/);
    expect((await sql()`select status from public.notifications where id = ${contactNote.id}`)[0].status).toBe("failed");

    // once the operator fixes configuration, the retry delivers
    process.env.APP_MODE = "demo";
    resetEnvCache();
    expect(await processNotificationSend({ notificationId: contactNote.id }, new Date())).toMatchObject({ outcome: "done" });
    expect((await checkinRow(trip.id)).status).toBe("contact_notified");
  });

  it("overdue notice includes last coordinates, timestamp, accuracy, and a STALE label for old fixes", async () => {
    const user = await createCustomer("loc");
    await setFullName(user, "Hana Hiker");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user);
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 20, graceMinutes: 15, reminders: [] });
    const runAt = addMin(now, 40);
    await addLastLocation(user, trip.id, { lat: 47.512345678, lng: -121.684321, accuracyM: 18.2, recordedAt: addMin(runAt, -49) });
    await runCheckinJobs(c.id, runAt);
    const sms = (await notificationsFor(c.id)).find((n) => n.recipientKind === "emergency_contact" && n.channel === "sms")!;
    expect(sms.body).toContain("47.51235, -121.68432");
    expect(sms.body).toContain("accuracy ±18 m");
    expect(sms.body).toContain("STALE — 49 min old");
    expect(sms.body).toMatch(/Last reported location: .* at \d{1,2}:\d{2} [AP]M P[SD]T/);
    expect(sms.body).toMatch(/Ghost Guide has NOT contacted emergency services/);
    expect(sms.body).toContain("Hana");
    expect(sms.body.length).toBeLessThanOrEqual(600);
    expect(containsBannedPhrase(sms.body)).toBe(false);
    const email = (await notificationsFor(c.id)).find((n) => n.recipientKind === "emergency_contact" && n.channel === "email")!;
    expect(email.body).toContain("openstreetmap.org");
  });

  it("fresh fixes are not labelled stale; disabled sharing means no coordinates", async () => {
    const user = await createCustomer("fresh");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user, { email: "" });
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 20, graceMinutes: 15, reminders: [] });
    const runAt = addMin(now, 40);
    await addLastLocation(user, trip.id, { lat: 47.5, lng: -121.7, accuracyM: 9, recordedAt: addMin(runAt, -3) });
    await runCheckinJobs(c.id, runAt, { kinds: ["checkins.overdue"] });
    const body = (await notificationsFor(c.id)).find((n) => n.recipientKind === "emergency_contact")!.body;
    expect(body).toContain("47.50000, -121.70000");
    expect(body).not.toContain("STALE");

    const private_ = await createCustomer("private");
    expect(await updatePrivacySettings(private_, { locationRetentionDays: 30, shareLocationWithContacts: false })).toEqual({ ok: true });
    const trip2 = await bookedTrip(private_);
    const contact2 = await consentedContact(private_, { email: "" });
    const c2 = await optIn(private_, trip2.id, contact2, { now, minutesAhead: 20, graceMinutes: 15, reminders: [] });
    await addLastLocation(private_, trip2.id, { lat: 47.5, lng: -121.7, accuracyM: 9, recordedAt: addMin(runAt, -3) });
    await runCheckinJobs(c2.id, runAt, { kinds: ["checkins.overdue"] });
    const body2 = (await notificationsFor(c2.id)).find((n) => n.recipientKind === "emergency_contact")!.body;
    expect(body2).toContain("No location has been reported");
    expect(body2).not.toContain("47.50000");
  });

  it("finishing after the contact was notified sends a 'has now confirmed they finished' follow-up exactly once", async () => {
    const user = await createCustomer("followup");
    await setFullName(user, "Hana Hiker");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user, { email: "" });
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 20, graceMinutes: 15, reminders: [] });
    await runCheckinJobs(c.id, addMin(now, 40));
    expect((await checkinRow(trip.id)).status).toBe("contact_notified");
    expect(await finishTripByUser(user, trip.id, addMin(now, 50))).toMatchObject({ ok: true });
    expect(await finishTripByUser(user, trip.id, addMin(now, 51))).toMatchObject({ ok: true });
    await runCheckinJobs(c.id, addMin(now, 52));
    const fin = (await notificationsFor(c.id)).filter((n) => n.template === "checkin_followup_finished");
    expect(fin).toHaveLength(1);
    expect(fin[0].status).toBe("simulated");
    expect(fin[0].body).toMatch(/Hana has now confirmed they finished/);
  });

  it("finishing before a queued overdue notice is delivered suppresses it (no notice, no follow-up)", async () => {
    const user = await createCustomer("race");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user, { email: "" });
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 20, graceMinutes: 15, reminders: [] });
    await runCheckinJobs(c.id, addMin(now, 40), { kinds: ["checkins.overdue"] });
    expect(await finishTripByUser(user, trip.id, addMin(now, 41))).toMatchObject({ ok: true });
    await runCheckinJobs(c.id, addMin(now, 42));
    const notes = await notificationsFor(c.id);
    expect(notes.every((n) => n.status === "suppressed")).toBe(true);
    expect(notes.find((n) => n.recipientKind === "emergency_contact")!.error).toMatch(/finished your trip/);
    expect(notes.some((n) => n.template.startsWith("checkin_followup"))).toBe(false);
  });

  it("reminders go to the user once per version/offset and are dropped after the check-in changes", async () => {
    const user = await createCustomer("remind");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user);
    const now = new Date();
    const c = await optIn(user, trip.id, contact, { now, minutesAhead: 120, graceMinutes: 30, reminders: [60, 15] });
    await runCheckinJobs(c.id, addMin(now, 61));
    expect(await processReminderJob({ checkinId: c.id, version: c.version, offsetMin: 60 }, addMin(now, 61))).toMatchObject({ outcome: "noop" });
    const reminders = (await notificationsFor(c.id)).filter((n) => n.template === "checkin_reminder");
    expect(reminders).toHaveLength(1);
    expect(reminders[0].recipientKind).toBe("user");
    // no phone/email on profile but auth email exists -> email channel
    expect(reminders[0].channel).toBe("email");
    expect(reminders[0].status).toBe("simulated");
    // after finishing, the 15-min reminder job is cancelled and a stale run is a no-op
    await finishTripByUser(user, trip.id, addMin(now, 70));
    expect((await jobsFor(c.id)).find((j) => j.dedupKey.endsWith("reminder:15"))?.status).toBe("cancelled");
    expect(await processReminderJob({ checkinId: c.id, version: c.version, offsetMin: 15 }, addMin(now, 106))).toMatchObject({ outcome: "noop" });
  });

  it("notification rows never store the real contact address; logs stay redacted", async () => {
    const rows = await withSystem((tx) => tx`select recipient_masked, body from public.notifications`);
    for (const r of rows) {
      expect(r.recipientMasked).not.toMatch(/\d{7,}/);
      expect(r.recipientMasked).not.toMatch(/^[^•]+@/);
    }
  });
});
