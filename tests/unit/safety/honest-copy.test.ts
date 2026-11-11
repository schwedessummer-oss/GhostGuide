import { describe, expect, it } from "vitest";
import {
  describeCheckinForOwner,
  describeCheckinForShare,
  formatWhen,
  shareNeedsNoConfirmationNote,
  timeZoneLabel,
  type CheckinState,
} from "@/domain/checkin";
import {
  buildOverdueContactMessage,
  COORDS_PATTERN,
  formatCoords,
  LOCATION_REMOVED,
  MAP_LINK_REMOVED,
  redactLocation,
} from "@/domain/notification-messages";

const TZ = "America/Los_Angeles";
const now = new Date("2026-11-14T18:00:00Z"); // Sat 10:00 PST
const at = (offsetMin: number) => new Date(now.getTime() + offsetMin * 60_000);

function state(over: Partial<CheckinState> = {}): CheckinState {
  return {
    status: "active",
    version: 3,
    expectedReturnAt: at(-120),
    graceMinutes: 60,
    reminderOffsetsMin: [],
    lastOkAt: null,
    overdueAt: null,
    contactNotifiedAt: null,
    completedAt: null,
    ...over,
  };
}

const text = (c: { title: string; detail: string }) => `${c.title} ${c.detail}`;

describe("owner status never promises a notice nobody will get", () => {
  it("overdue with no consenting, reachable contact says nobody else is being notified", () => {
    const copy = describeCheckinForOwner(state({ status: "overdue" }), TZ, { contactReachable: false, now });
    expect(text(copy)).not.toMatch(/sending your contact a notice|we'll let them know/i);
    expect(copy.detail).toMatch(/nobody else is being notified/);
    expect(copy.detail).toMatch(/tap “I'm okay” or “Finish trip”/);
  });

  it("overdue with a reachable contact still says a notice is on its way (live) or simulated (demo)", () => {
    expect(describeCheckinForOwner(state({ status: "overdue" }), TZ, { now }).detail).toMatch(/We're sending your contact a notice/);
    const demo = describeCheckinForOwner(state({ status: "overdue" }), TZ, { simulated: true, now });
    expect(demo.detail).toMatch(/simulated notice/);
    expect(demo.detail).not.toMatch(/We're sending your contact a notice/);
  });

  it("awaiting states without a reachable contact don't promise a notice either", () => {
    for (const status of ["scheduled", "active", "confirmed_ok"] as const) {
      const copy = describeCheckinForOwner(state({ status, expectedReturnAt: at(120) }), TZ, { contactReachable: false, now });
      expect(text(copy)).toMatch(/nobody else will be notified/);
      expect(text(copy)).not.toMatch(/we'll send your contact a notice|your contact gets a notice|so we don't send your contact/);
    }
  });

  it("contact_notified: demo copy says simulated, never sent/notified; live copy says sent, never delivered", () => {
    const demo = describeCheckinForOwner(state({ status: "contact_notified", contactNotifiedAt: at(-5) }), TZ, { simulated: true, now });
    expect(demo.title).toMatch(/simulated notice was recorded/i);
    expect(text(demo)).not.toMatch(/Your contact was sent a notice|we notified your contact|delivered/i);
    expect(demo.detail).toMatch(/nothing is actually sent/);
    const live = describeCheckinForOwner(state({ status: "contact_notified", contactNotifiedAt: at(-5) }), TZ, { now });
    expect(live.title).toBe("Your contact was sent a notice");
    expect(text(live)).not.toMatch(/delivered/i);
  });

  it("contact_notified but the contact can no longer be reached: no follow-up is promised", () => {
    const copy = describeCheckinForOwner(state({ status: "contact_notified", contactNotifiedAt: at(-5) }), TZ, { contactReachable: false, now });
    expect(copy.detail).not.toMatch(/send them a follow-up/);
    expect(copy.detail).toMatch(/please tell them yourself/);
  });
});

describe("times carry a date unless they are today", () => {
  it("formatWhen: clock only on the same local day, weekday + date otherwise", () => {
    expect(formatWhen(at(30), TZ, now)).toBe("10:30 AM PST");
    expect(formatWhen(at(-24 * 60), TZ, now)).toBe("Fri, Nov 13, 10:00 AM PST");
    // 23:30 local on the 13th is "yesterday" even though < 24 h ago
    expect(formatWhen(new Date("2026-11-14T07:30:00Z"), TZ, now)).toBe("Fri, Nov 13, 11:30 PM PST");
  });

  it("owner, share and contact-notice texts use it for 'I'm okay' and finish times", () => {
    const yesterday = at(-20 * 60);
    expect(describeCheckinForOwner(state({ status: "confirmed_ok", lastOkAt: yesterday, expectedReturnAt: at(60) }), TZ, { now }).title).toBe(
      "You confirmed you're okay at Fri, Nov 13, 2:00 PM PST",
    );
    expect(describeCheckinForShare(state({ status: "completed", completedAt: yesterday }), TZ, now)).toBe("Finished the trip at Fri, Nov 13, 2:00 PM PST");
    expect(describeCheckinForShare(state({ status: "completed", completedAt: at(-30) }), TZ, now)).toBe("Finished the trip at 9:30 AM PST");
    const msg = buildOverdueContactMessage({
      channel: "sms",
      hikerFirstName: "Hana",
      trailName: "Lantern Creek Loop",
      expectedReturnAt: at(-120),
      lastOkAt: yesterday,
      timeZone: TZ,
      now,
      location: null,
      locationSharingDisabled: false,
    });
    expect(msg.body).toContain("Last “I'm okay”: Nov 13, 2:00 PM PST."); // SMS: compact date, no weekday
    const email = buildOverdueContactMessage({
      channel: "email",
      hikerFirstName: "Hana",
      trailName: "Lantern Creek Loop",
      expectedReturnAt: at(-120),
      lastOkAt: yesterday,
      timeZone: TZ,
      now,
      location: null,
      locationSharingDisabled: false,
    });
    expect(email.body).toContain("Their last “I'm okay” was at Fri, Nov 13, 2:00 PM PST.");
  });
});

describe("share page caveat", () => {
  it("only for statuses that mean 'no confirmation'", () => {
    expect(shareNeedsNoConfirmationNote(state({ status: "active" }))).toBe(true);
    expect(shareNeedsNoConfirmationNote(state({ status: "overdue", lastOkAt: at(-200) }))).toBe(true);
    expect(shareNeedsNoConfirmationNote(state({ status: "contact_notified" }))).toBe(true);
    expect(shareNeedsNoConfirmationNote(state({ status: "confirmed_ok", lastOkAt: at(-10) }))).toBe(false);
    expect(shareNeedsNoConfirmationNote(state({ status: "completed", completedAt: at(-10) }))).toBe(false);
    expect(shareNeedsNoConfirmationNote(null)).toBe(false);
  });
});

describe("time zone label", () => {
  it("is the same DST-neutral name in winter and summer", () => {
    expect(timeZoneLabel(TZ, new Date("2026-01-15T12:00:00Z"))).toBe("Pacific Time");
    expect(timeZoneLabel(TZ, new Date("2026-07-15T12:00:00Z"))).toBe("Pacific Time");
    expect(timeZoneLabel("Not/AZone")).toBe("Not/AZone");
  });
});

describe("location redaction for stored notices", () => {
  it("removes coordinates and map links, keeps the rest of the notice", () => {
    const body = buildOverdueContactMessage({
      channel: "email",
      hikerFirstName: "Hana",
      trailName: "Lantern Creek Loop",
      expectedReturnAt: at(-120),
      timeZone: TZ,
      now,
      location: { lat: 47.512345, lng: -121.684321, accuracyM: 11, recordedAt: at(-40) },
      locationSharingDisabled: false,
    }).body;
    expect(body).toContain(formatCoords(47.512345, -121.684321));
    expect(body).toContain("openstreetmap.org");
    const red = redactLocation(body);
    expect(red).not.toMatch(new RegExp(COORDS_PATTERN));
    expect(red).not.toContain("openstreetmap");
    expect(red).not.toContain("47.51235");
    expect(red).toContain(`Last reported location: ${LOCATION_REMOVED}`);
    expect(red).toContain(MAP_LINK_REMOVED);
    expect(red).toContain("Ghost Guide has NOT contacted emergency services");
    expect(red).toContain("accuracy ±11 m");
    expect(redactLocation("no location here")).toBe("no location here");
  });
});
