import { describe, expect, it } from "vitest";
import { ageText, classifyLocation } from "@/domain/staleness";
import {
  SMS_MAX_CHARS,
  buildContactFollowUpMessage,
  buildOverdueContactMessage,
  buildOverdueUserMessage,
  buildReminderMessage,
  containsBannedPhrase,
  firstNameOf,
  maskEmail,
  maskPhone,
  maskRecipient,
  normalizePhone,
  type OverdueContactInput,
} from "@/domain/notification-messages";

const TZ = "America/Los_Angeles";
const now = new Date("2026-11-14T23:30:00Z"); // 3:30 PM PST
const min = (n: number) => new Date(now.getTime() + n * 60_000);

describe("staleness", () => {
  it("classifies fresh / stale / none with the configured threshold", () => {
    expect(classifyLocation(min(-3), now, 15)).toMatchObject({ state: "fresh", ageMin: 3, label: "Updated 3 min ago" });
    expect(classifyLocation(min(-15), now, 15)).toMatchObject({ state: "stale", ageMin: 15, label: "STALE — 15 min old" });
    expect(classifyLocation(min(-49), now, 60)).toMatchObject({ state: "fresh" });
    expect(classifyLocation(null, now)).toMatchObject({ state: "none", ageMin: null });
    expect(classifyLocation(min(5), now).ageMin).toBe(0); // clock skew
    expect(classifyLocation(min(-300), now).label).toBe("STALE — 5 h old");
  });

  it("writes human age text", () => {
    expect(ageText(0)).toBe("just now");
    expect(ageText(42)).toBe("42 min old");
    expect(ageText(125)).toBe("2 h 5 min old");
    expect(ageText(60 * 72)).toBe("3 days old");
  });
});

describe("masking & normalization", () => {
  it("masks phones and emails", () => {
    expect(maskPhone("+15555550123")).toBe("+1•••••0123");
    expect(maskEmail("casey@example.com")).toBe("c•••@example.com");
    expect(maskRecipient("sms", "+442079460958")).toBe("+4•••••0958");
    expect(maskRecipient("email", "x@y.org")).toBe("x•••@y.org");
  });

  it("normalizes phone numbers to E.164", () => {
    expect(normalizePhone("(555) 555-0123")).toBe("+15555550123");
    expect(normalizePhone("1-555-555-0123")).toBe("+15555550123");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("0044 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("call me")).toBeNull();
    expect(normalizePhone("+0 123 456 789")).toBeNull();
  });

  it("extracts a first name", () => {
    expect(firstNameOf("Hana Hiker")).toBe("Hana");
    expect(firstNameOf("  ")).toBeNull();
    expect(firstNameOf(null)).toBeNull();
  });
});

const base: OverdueContactInput = {
  channel: "sms",
  hikerFirstName: "Hana",
  trailName: "Lantern Creek Loop",
  expectedReturnAt: min(-75),
  timeZone: TZ,
  now,
  location: { lat: 47.505212345, lng: -121.702101, accuracyM: 12.4, recordedAt: min(-49) },
  locationSharingDisabled: false,
  staleMinutes: 15,
  emergencyNumber: "911",
};

describe("overdue notice to the emergency contact", () => {
  it("includes name, trail, expected return, no-confirmation, coordinates, timestamp, accuracy and STALE label", () => {
    const { body, subject } = buildOverdueContactMessage(base);
    expect(body).toContain("Hana");
    expect(body).toContain("Lantern Creek Loop");
    expect(body).toContain("2:15 PM PST"); // expected return in region tz
    expect(body).toMatch(/has NOT sent “I'm okay” or “Finish trip”/);
    expect(body).toMatch(/does not necessarily mean anything is wrong/);
    expect(body).toContain("47.50521, -121.70210");
    expect(body).toContain("2:41 PM PST"); // fix timestamp
    expect(body).toContain("accuracy ±12 m");
    expect(body).toContain("STALE — 49 min old");
    expect(body).toMatch(/Ghost Guide has NOT contacted emergency services/);
    expect(body).toMatch(/Try calling them/);
    expect(body).toMatch(/call local emergency services \(911\)/);
    expect(subject).not.toMatch(/emergency/i);
    expect(body.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
  });

  it("omits the STALE label for a fresh fix", () => {
    const { body } = buildOverdueContactMessage({ ...base, location: { ...base.location!, recordedAt: min(-4) } });
    expect(body).not.toContain("STALE");
    expect(body).toContain("47.50521, -121.70210");
  });

  it("says no location has been reported when there is none or sharing is off", () => {
    const none = buildOverdueContactMessage({ ...base, location: null }).body;
    expect(none).toContain("No location has been reported");
    expect(none).not.toMatch(/\d+\.\d{5}/);
    const off = buildOverdueContactMessage({ ...base, locationSharingDisabled: true }).body;
    expect(off).toContain("No location has been reported");
    expect(off).not.toContain("47.50521");
  });

  it("email variant has a subject, map link and full guidance", () => {
    const { body, subject } = buildOverdueContactMessage({ ...base, channel: "email" });
    expect(subject).toMatch(/Check-in notice: Hana hasn't confirmed/);
    expect(body).toContain("openstreetmap.org/?mlat=47.50521&mlon=-121.70210");
    expect(body).toMatch(/not a monitoring or emergency service/);
  });

  it("stays SMS-length with very long names and trails, and never uses banned phrases", () => {
    const long = buildOverdueContactMessage({
      ...base,
      hikerFirstName: "Bartholomew-Maximilian-Alexander",
      trailName: "The Extraordinarily Long And Winding Demonstration Ridge Traverse Trail",
      lastOkAt: min(-200),
    });
    expect(long.body.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(long.body).toMatch(/NOT contacted emergency services/);
    for (const channel of ["sms", "email"] as const) {
      for (const variant of [base, { ...base, location: null }, { ...base, locationSharingDisabled: true }, { ...base, hikerFirstName: null }]) {
        const m = buildOverdueContactMessage({ ...variant, channel });
        expect(containsBannedPhrase(m.body + m.subject)).toBe(false);
      }
    }
  });
});

describe("other messages", () => {
  it("reminder tells the user how to confirm and when the contact would be notified", () => {
    const m = buildReminderMessage({ channel: "sms", trailName: "Lantern Creek Loop", expectedReturnAt: min(60), graceMinutes: 30, timeZone: TZ });
    expect(m.body).toContain("4:30 PM PST");
    expect(m.body).toContain("5:00 PM PST");
    expect(m.body).toMatch(/I'm okay/);
    expect(containsBannedPhrase(m.body)).toBe(false);
  });

  it("overdue-to-user explains what is happening", () => {
    const withContact = buildOverdueUserMessage({ channel: "sms", trailName: "Lantern Creek Loop", expectedReturnAt: min(-60), timeZone: TZ, contactWillBeNotified: true });
    expect(withContact.body).toMatch(/sending your emergency contact a check-in notice/);
    const without = buildOverdueUserMessage({ channel: "email", trailName: "X", expectedReturnAt: min(-60), timeZone: TZ, contactWillBeNotified: false });
    expect(without.body).toMatch(/no one else is being notified/);
    expect(containsBannedPhrase(withContact.body + without.body)).toBe(false);
  });

  it("follow-ups say the hiker finished / confirmed okay", () => {
    const fin = buildContactFollowUpMessage({ channel: "sms", kind: "finished", hikerFirstName: "Hana", trailName: "Lantern Creek Loop", at: now, timeZone: TZ });
    expect(fin.body).toMatch(/Hana has now confirmed they finished/);
    const okMsg = buildContactFollowUpMessage({
      channel: "email",
      kind: "ok",
      hikerFirstName: "Hana",
      trailName: "Lantern Creek Loop",
      at: now,
      newExpectedReturnAt: min(60),
      timeZone: TZ,
    });
    expect(okMsg.body).toMatch(/confirmed they're okay/);
    expect(okMsg.body).toContain("4:30 PM PST");
    expect(containsBannedPhrase(fin.body + okMsg.body)).toBe(false);
  });
});
