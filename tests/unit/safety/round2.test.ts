import { describe, expect, it } from "vitest";
import {
  OK_AUTO_EXTEND_MIN,
  confirmOkTransition,
  deviceExtendTransition,
  describeCheckinForOwner,
  overdueDueAt,
  staffResolveTransition,
  type CheckinState,
  type TransitionResult,
} from "@/domain/checkin";
import {
  SMS_MAX_CHARS,
  buildContactFollowUpMessage,
  buildOverdueContactMessage,
  containsBannedPhrase,
  formatCoords,
  type OverdueContactInput,
} from "@/domain/notification-messages";

const TZ = "America/Los_Angeles";
const now = new Date("2026-11-15T01:30:00Z"); // 5:30 PM PST
const at = (offsetMin: number) => new Date(now.getTime() + offsetMin * 60_000);

function state(over: Partial<CheckinState> = {}): CheckinState {
  return {
    status: "active",
    version: 3,
    expectedReturnAt: at(-150), // 3:00 PM
    graceMinutes: 60,
    reminderOffsetsMin: [60, 15],
    lastOkAt: null,
    overdueAt: null,
    contactNotifiedAt: null,
    completedAt: null,
    ...over,
  };
}

const notified = (over: Partial<CheckinState> = {}) => state({ status: "contact_notified", overdueAt: at(-90), contactNotifiedAt: at(-89), ...over });

function transition(r: TransitionResult | { error: string }): TransitionResult {
  if ("error" in r) throw new Error(`unexpected error: ${r.error}`);
  return r;
}

describe("SAFETY-1: an old offline “I'm okay” never clears an overdue check-in", () => {
  it("a tap from before the expected return only records last_ok_at (contact_notified and overdue)", () => {
    for (const prev of [notified(), state({ status: "overdue", overdueAt: at(-90) })]) {
      const r = confirmOkTransition(prev, { tappedAt: at(-270), now }); // 1:00 PM, synced at 5:30 PM
      expect(r.state.status).toBe(prev.status);
      expect(r.state.version).toBe(prev.version);
      expect(r.state.expectedReturnAt).toEqual(prev.expectedReturnAt);
      expect(r.state.lastOkAt).toEqual(at(-270));
      expect(r.effects).toEqual([]); // no reschedule, no suppression, no "okay" follow-up
      expect(r.event).toBe("ok_recorded_late");
    }
  });

  it("does not move last_ok_at backwards", () => {
    const r = confirmOkTransition(notified({ lastOkAt: at(-200) }), { tappedAt: at(-270), now });
    expect(r.state.lastOkAt).toEqual(at(-200));
    expect(r.changed).toBe(false);
  });

  it("a tap after the expected return resolves the overdue state as if it had arrived when tapped", () => {
    // tapped 3:45 PM (after the 3:00 PM expected return), reached us 5:30 PM: new deadline 4:45 PM + 60 min grace = 5:45 PM
    const r = confirmOkTransition(notified(), { tappedAt: at(-105), now });
    expect(r.state.status).toBe("confirmed_ok");
    expect(r.state.version).toBe(4);
    expect(r.state.expectedReturnAt).toEqual(at(-105 + OK_AUTO_EXTEND_MIN));
    expect(overdueDueAt(r.state).getTime()).toBeGreaterThan(now.getTime());
    expect(r.effects).toEqual([
      { type: "reschedule" },
      { type: "suppress_pending_notices" },
      { type: "follow_up_contact", kind: "ok", at: at(-105) }, // the time the hiker actually tapped
    ]);
  });

  it("a tap after the expected return that is too old to matter is only recorded", () => {
    // tapped 3:20 PM: tap + 60 min + 60 min grace = 5:20 PM, already past at 5:30 PM
    const r = confirmOkTransition(notified(), { tappedAt: at(-130), now });
    expect(r.state.status).toBe("contact_notified");
    expect(r.state.lastOkAt).toEqual(at(-130));
    expect(r.effects).toEqual([]);
    expect(r.event).toBe("ok_recorded_late");
  });

  it("the outcome no longer depends on whether the sync beat the overdue job", () => {
    const tappedAt = at(-270); // 1:00 PM, before the 3:00 PM expected return
    const beforeJob = confirmOkTransition(state({ status: "active" }), { tappedAt, now: at(-160) });
    const afterJob = confirmOkTransition(notified(), { tappedAt, now });
    expect(beforeJob.state.expectedReturnAt).toEqual(state().expectedReturnAt);
    expect(afterJob.state.expectedReturnAt).toEqual(state().expectedReturnAt);
    expect(beforeJob.effects).toEqual([]);
    expect(afterJob.effects).toEqual([]);
  });

  it("live taps still resolve overdue immediately and extend from the tap", () => {
    const r = confirmOkTransition(notified(), { tappedAt: now, now });
    expect(r.state.status).toBe("confirmed_ok");
    expect(r.state.expectedReturnAt).toEqual(at(OK_AUTO_EXTEND_MIN));
    expect(r.effects).toContainEqual({ type: "follow_up_contact", kind: "ok", at: now });
  });

  it("taps from the future (fast device clock) count as now", () => {
    const r = confirmOkTransition(notified(), { tappedAt: at(30), now });
    expect(r.state.lastOkAt).toEqual(now);
    expect(r.state.expectedReturnAt).toEqual(at(OK_AUTO_EXTEND_MIN));
  });
});

describe("device extensions (contract A)", () => {
  const ctx = (over: Partial<Parameters<typeof deviceExtendTransition>[1]> = {}) => ({
    occurredAt: at(-10),
    newExpectedReturnAt: at(110),
    now,
    lastScheduleChangeAt: null,
    ...over,
  });

  it("applies while awaiting: version++, reschedule, status kept", () => {
    const r = deviceExtendTransition(state({ status: "confirmed_ok", expectedReturnAt: at(30), lastOkAt: at(-40) }), ctx());
    if (!r.ok) throw new Error(r.reason);
    expect(r.result.state.expectedReturnAt).toEqual(at(110));
    expect(r.result.state.version).toBe(4);
    expect(r.result.state.status).toBe("confirmed_ok");
    expect(r.result.effects).toEqual([{ type: "reschedule" }]);
    expect(r.result.event).toBe("extended");
  });

  it("rejects times at/before the request and more than 24 h after it", () => {
    expect(deviceExtendTransition(state(), ctx({ newExpectedReturnAt: at(-10) }))).toMatchObject({ ok: false });
    expect(deviceExtendTransition(state(), ctx({ newExpectedReturnAt: at(-10 + 24 * 60 + 1) }))).toMatchObject({ ok: false });
    expect(deviceExtendTransition(state(), ctx({ occurredAt: new Date(Number.NaN) }))).toMatchObject({ ok: false });
    expect(deviceExtendTransition(state(), ctx({ newExpectedReturnAt: at(-10 + 24 * 60) }))).toMatchObject({ ok: true });
  });

  it("ignores finished/cancelled check-ins", () => {
    for (const status of ["completed", "cancelled"] as const) expect(deviceExtendTransition(state({ status }), ctx())).toMatchObject({ ok: false });
  });

  it("a stale extension never overrides a newer schedule change", () => {
    const r = deviceExtendTransition(state({ expectedReturnAt: at(60) }), ctx({ occurredAt: at(-30), newExpectedReturnAt: at(200), lastScheduleChangeAt: at(-20) }));
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/newer/) });
  });

  it("a stale extension never moves the time backwards behind a later confirmation", () => {
    // tapped “I'm okay” after the deadline at -20 (auto-extended to +40); extension made at -30 to +20
    const prev = state({ status: "confirmed_ok", lastOkAt: at(-20), expectedReturnAt: at(40) });
    expect(deviceExtendTransition(prev, ctx({ occurredAt: at(-30), newExpectedReturnAt: at(20) }))).toMatchObject({ ok: false });
    const later = deviceExtendTransition(prev, ctx({ occurredAt: at(-30), newExpectedReturnAt: at(90) }));
    if (!later.ok) throw new Error(later.reason);
    expect(later.result.state.expectedReturnAt).toEqual(at(90));
  });

  it("an extension made before the deadline but synced after the notice resolves it while still within the new time", () => {
    const r = deviceExtendTransition(notified(), ctx({ occurredAt: at(-200), newExpectedReturnAt: at(30) })); // made 2:10 PM, until 6:00 PM
    if (!r.ok) throw new Error(r.reason);
    expect(r.result.state.status).toBe("active");
    expect(r.result.effects).toEqual([
      { type: "reschedule" },
      { type: "suppress_pending_notices" },
      { type: "follow_up_contact", kind: "extended", at: at(-200) },
    ]);
  });

  it("an extension whose new time (plus grace) has also passed does not clear an overdue check-in", () => {
    const r = deviceExtendTransition(notified(), ctx({ occurredAt: at(-200), newExpectedReturnAt: at(-80) })); // until 4:10 PM + 60 min grace
    expect(r).toMatchObject({ ok: false });
  });

  it("future occurredAt (fast device clock) counts as now", () => {
    const r = deviceExtendTransition(state({ expectedReturnAt: at(30) }), ctx({ occurredAt: at(5), newExpectedReturnAt: at(65) }));
    expect(r).toMatchObject({ ok: true });
  });

  it("a wildly fast device clock can't push the deadline far into the future", () => {
    const yearAhead = 365 * 24 * 60;
    expect(deviceExtendTransition(state(), ctx({ occurredAt: at(yearAhead), newExpectedReturnAt: at(yearAhead + 60) }))).toMatchObject({ ok: false });
  });
});

describe("staff resolution (contract B)", () => {
  it("hiker_confirmed_safe completes the check-in, cancels jobs and follows up with a notified contact", () => {
    const r = transition(staffResolveTransition(notified(), now));
    expect(r.state.status).toBe("completed");
    expect(r.state.completedAt).toEqual(now);
    expect(r.event).toBe("staff_resolved");
    expect(r.effects).toEqual([
      { type: "cancel_jobs" },
      { type: "suppress_pending_notices" },
      { type: "follow_up_contact", kind: "finished", by: "staff" },
    ]);
  });

  it("is allowed from overdue/contact_notified/active/confirmed_ok only", () => {
    for (const status of ["overdue", "active", "confirmed_ok"] as const) {
      const r = transition(staffResolveTransition(state({ status }), now));
      expect(r.effects.some((e) => e.type === "follow_up_contact")).toBe(false);
    }
    for (const status of ["scheduled", "completed", "cancelled"] as const) expect(staffResolveTransition(state({ status }), now)).toHaveProperty("error");
  });

  it("owner copy says staff closed it, not that the hiker finished", () => {
    const copy = describeCheckinForOwner(state({ status: "completed", completedAt: now }), TZ, { now, closedByStaff: true });
    expect(copy.title).toMatch(/closed by Ghost Guide staff/);
    expect(copy.detail).not.toMatch(/You finished/);
  });
});

// ---------------------------------------------------------------------------
// SAFETY-9: SMS budget by construction
// ---------------------------------------------------------------------------
const OPT_OUT = "https://ghostguide-demo.example.com/contact/opt-out/AbCdEfGhIjKlMnOp"; // 40-char origin + 16-char token

const worstSms: OverdueContactInput = {
  channel: "sms",
  hikerFirstName: "Maximilian-Alexander-Bart", // longer than the 24-char cap
  trailName: "The Extraordinarily Long And Winding Demonstration Ridge Traverse Trail",
  expectedReturnAt: new Date("2026-11-13T20:59:00Z"), // another day: date + time
  lastOkAt: new Date("2026-11-13T19:01:00Z"),
  timeZone: "Australia/Lord_Howe", // "GMT+11" style zone names are the longest
  now: new Date("2026-11-15T23:30:00Z"),
  location: { lat: -89.123456, lng: -179.123456, accuracyM: 123456, recordedAt: new Date("2026-11-13T18:59:00Z") },
  locationSharingDisabled: false,
  staleMinutes: 15,
  emergencyNumber: "000 / 112 / 911 / extra long",
  optOutUrl: OPT_OUT,
};

describe("SAFETY-9: overdue SMS fits 600 characters by construction", () => {
  const zones = ["America/Los_Angeles", "Australia/Lord_Howe", "Asia/Kolkata", "America/St_Johns", "Pacific/Chatham", "Europe/London"];
  const names = [null, "Al", "Maximilian-Alexander-Bart"];
  const locations = [
    worstSms.location,
    { lat: 47.5, lng: -121.7, accuracyM: null, recordedAt: new Date("2026-11-13T18:59:00Z") },
    null,
  ];

  it("keeps the mandatory facts (who, trail, deadline, location, no-emergency-services, what to do, opt-out link) in the worst case", () => {
    for (const timeZone of zones)
      for (const hikerFirstName of names)
        for (const location of locations)
          for (const locationSharingDisabled of [false, true]) {
            const { body } = buildOverdueContactMessage({ ...worstSms, timeZone, hikerFirstName, location, locationSharingDisabled });
            const label = `${timeZone}/${hikerFirstName}/${!!location}/${locationSharingDisabled}`;
            expect(body.length, label).toBeLessThanOrEqual(SMS_MAX_CHARS);
            expect(body, label).toContain("Ghost Guide has NOT contacted emergency services.");
            expect(body, label).toMatch(/call local emergency services \(000 \/ 112 \/ 911\b/);
            expect(body, label).toContain("and share this message.");
            expect(body, label).toContain(`Stop these notices: ${OPT_OUT}`);
            expect(body, label).toMatch(/has NOT sent “I'm okay” or “Finish trip”\./);
            expect(body, label).not.toContain("…”"); // never cut inside a quoted phrase
            if (location && !locationSharingDisabled) expect(body, label).toContain(formatCoords(location.lat, location.lng));
            expect(containsBannedPhrase(body), label).toBe(false);
          }
  });

  it("still fits with an 80-character site origin (optional sentences go first, then the trail name is shortened)", () => {
    const longUrl = `https://${"a".repeat(60)}.example.com/contact/opt-out/AbCdEfGhIjKlMnOp`;
    expect(longUrl.length - "/contact/opt-out/AbCdEfGhIjKlMnOp".length).toBe(80);
    for (const timeZone of zones)
      for (const hikerFirstName of names) {
        const { body } = buildOverdueContactMessage({ ...worstSms, timeZone, hikerFirstName, optOutUrl: longUrl });
        expect(body.length, timeZone).toBeLessThanOrEqual(SMS_MAX_CHARS);
        expect(body).toContain(formatCoords(worstSms.location!.lat, worstSms.location!.lng));
        expect(body).toContain("Ghost Guide has NOT contacted emergency services.");
        expect(body.endsWith(longUrl)).toBe(true);
      }
  });

  it("keeps the last “I'm okay” time in the worst case (it is dropped only after the reassurance line)", () => {
    const { body } = buildOverdueContactMessage(worstSms);
    expect(body).toMatch(/Last “I'm okay”: Nov 1[34], \d{1,2}:\d{2} [AP]M GMT\+1[01](:30)?\./);
  });

  it("includes the reassurance line whenever it fits", () => {
    const typical = buildOverdueContactMessage({
      ...worstSms,
      hikerFirstName: "Robin",
      trailName: "Echo Basin Traverse",
      timeZone: TZ,
      expectedReturnAt: at(-75),
      lastOkAt: at(-200),
      now,
      location: { lat: 47.50521, lng: -121.70213, accuracyM: 12.4, recordedAt: at(-40) },
      emergencyNumber: "911",
    }).body;
    expect(typical).toContain("This does not necessarily mean anything is wrong");
    expect(typical).toContain("Last “I'm okay”: 2:10 PM PST.");
    expect(typical).toContain("Last reported location: 47.50521, -121.70213 at 4:50 PM PST, accuracy ±12 m [STALE — 40 min old].");
    expect(typical.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
  });

  it("does not truncate whole sentences mid-way: every sentence ends cleanly", () => {
    const { body } = buildOverdueContactMessage(worstSms);
    expect(body.endsWith(OPT_OUT)).toBe(true);
    expect(body).not.toMatch(/…\s*$/);
  });

  it("email carries the full text plus the opt-out link", () => {
    const { body } = buildOverdueContactMessage({ ...worstSms, channel: "email" });
    expect(body).toContain(OPT_OUT);
    expect(body).toMatch(/no longer want these notices/);
    expect(body).toMatch(/contact local emergency services \(000/);
  });
});

describe("follow-ups state when the hiker actually acted", () => {
  it("an “I'm okay” that arrived late says when it was tapped and when it reached Ghost Guide", () => {
    const m = buildContactFollowUpMessage({
      channel: "sms",
      kind: "ok",
      hikerFirstName: "Alex",
      trailName: "Demo Ridge",
      at: at(-105),
      receivedAt: now,
      newExpectedReturnAt: at(-45),
      graceMinutes: 60,
      timeZone: TZ,
      optOutUrl: OPT_OUT,
    });
    expect(m.body).toContain("tapped “I'm okay” at 3:45 PM PST");
    expect(m.body).toContain("it reached Ghost Guide at 5:30 PM PST");
    expect(m.body).not.toMatch(/has now confirmed/);
    expect(m.body).toContain("by 5:45 PM PST"); // next notice: new expected return + grace
    expect(m.body).toContain(`Stop these notices: ${OPT_OUT}`);
    expect(m.body.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
  });

  it("a live tap does not mention a delay", () => {
    const m = buildContactFollowUpMessage({ channel: "sms", kind: "ok", hikerFirstName: "Alex", trailName: "Demo Ridge", at: now, receivedAt: now, timeZone: TZ });
    expect(m.body).not.toMatch(/reached Ghost Guide/);
  });

  it("staff resolution is worded as a staff confirmation", () => {
    const m = buildContactFollowUpMessage({ channel: "email", kind: "finished", by: "staff", hikerFirstName: "Alex", trailName: "Demo Ridge", at: now, timeZone: TZ });
    expect(m.body).toMatch(/team has confirmed that Alex is safe/);
    expect(m.body).not.toMatch(/finished their hike/);
    expect(containsBannedPhrase(m.body + m.subject)).toBe(false);
  });

  it("worst-case follow-ups stay within the SMS budget", () => {
    for (const kind of ["ok", "finished", "extended"] as const) {
      const m = buildContactFollowUpMessage({
        channel: "sms",
        kind,
        hikerFirstName: "Maximilian-Alexander-Bart",
        trailName: worstSms.trailName,
        at: new Date("2026-11-13T19:01:00Z"),
        receivedAt: new Date("2026-11-15T23:30:00Z"),
        newExpectedReturnAt: new Date("2026-11-16T20:59:00Z"),
        graceMinutes: 720,
        timeZone: "Australia/Lord_Howe",
        optOutUrl: OPT_OUT,
      });
      expect(m.body.length, kind).toBeLessThanOrEqual(SMS_MAX_CHARS);
      expect(m.body, kind).toContain(OPT_OUT);
    }
  });
});
