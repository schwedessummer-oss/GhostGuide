import { describe, expect, it } from "vitest";
import {
  OK_AUTO_EXTEND_MIN,
  cancelTransition,
  computeSchedule,
  confirmOkTransition,
  contactNotifiedTransition,
  defaultExpectedReturn,
  describeCheckinForOwner,
  describeCheckinForShare,
  extendTransition,
  extendedReturnAt,
  finishTransition,
  hikeStartedTransition,
  normalizeReminderOffsets,
  overdueDedupKey,
  overdueDueAt,
  overdueTransition,
  parseLocalInputValue,
  reminderDedupKey,
  setupTransition,
  toLocalInputValue,
  validateExtension,
  type CheckinState,
  type TransitionResult,
} from "@/domain/checkin";

const TZ = "America/Los_Angeles";
const now = new Date("2026-11-14T18:00:00Z"); // 10:00 PST
const min = (n: number) => n * 60_000;
const at = (offsetMin: number) => new Date(now.getTime() + min(offsetMin));

function state(over: Partial<CheckinState> = {}): CheckinState {
  return {
    status: "active",
    version: 3,
    expectedReturnAt: at(120),
    graceMinutes: 60,
    reminderOffsetsMin: [60, 15],
    lastOkAt: null,
    overdueAt: null,
    contactNotifiedAt: null,
    completedAt: null,
    ...over,
  };
}

function ok(r: TransitionResult | { error: string }): TransitionResult {
  if ("error" in r) throw new Error(`unexpected error: ${r.error}`);
  return r;
}

describe("check-in state machine", () => {
  it("setup -> scheduled, or active when a hike session is already open; bumps version", () => {
    const input = { expectedReturnAt: at(180), graceMinutes: 45, reminderOffsetsMin: [15, 60, 60, 2] };
    const fresh = ok(setupTransition(null, input, { now, hikeOpen: false }));
    expect(fresh.state.status).toBe("scheduled");
    expect(fresh.state.version).toBe(1);
    expect(fresh.state.reminderOffsetsMin).toEqual([60, 15]); // deduped, out-of-range dropped, sorted
    expect(fresh.effects).toEqual([{ type: "reschedule" }]);

    const open = ok(setupTransition(state({ status: "scheduled", version: 1 }), input, { now, hikeOpen: true }));
    expect(open.state.status).toBe("active");
    expect(open.state.version).toBe(2);
    expect(open.event).toBe("updated");

    const reOptIn = ok(setupTransition(state({ status: "cancelled", version: 4, lastOkAt: at(-5) }), input, { now, hikeOpen: false }));
    expect(reOptIn.state.version).toBe(5);
    expect(reOptIn.state.lastOkAt).toBeNull();
    expect(reOptIn.event).toBe("opted_in");
  });

  it("setup validates time, grace and state", () => {
    const base = { expectedReturnAt: at(180), graceMinutes: 60, reminderOffsetsMin: [] };
    expect(setupTransition(null, { ...base, expectedReturnAt: at(2) }, { now, hikeOpen: false })).toHaveProperty("error");
    expect(setupTransition(null, { ...base, graceMinutes: 10 }, { now, hikeOpen: false })).toHaveProperty("error");
    expect(setupTransition(null, { ...base, graceMinutes: 721 }, { now, hikeOpen: false })).toHaveProperty("error");
    expect(setupTransition(state({ status: "overdue" }), base, { now, hikeOpen: false })).toHaveProperty("error");
    expect(setupTransition(state({ status: "completed" }), base, { now, hikeOpen: false })).toHaveProperty("error");
  });

  it("hike start moves scheduled -> active only", () => {
    expect(hikeStartedTransition(state({ status: "scheduled" })).state.status).toBe("active");
    const r = hikeStartedTransition(state({ status: "confirmed_ok" }));
    expect(r.changed).toBe(false);
    expect(r.state.status).toBe("confirmed_ok");
  });

  it("“I'm okay” before the expected return -> confirmed_ok, no reschedule, overdue time unchanged", () => {
    const prev = state();
    const r = confirmOkTransition(prev, { tappedAt: now, now });
    expect(r.state.status).toBe("confirmed_ok");
    expect(r.state.lastOkAt).toEqual(now);
    expect(r.state.version).toBe(prev.version);
    expect(r.effects).toEqual([]);
    expect(overdueDueAt(r.state)).toEqual(overdueDueAt(prev));
  });

  it("“I'm okay” after the expected return auto-extends to now + 60 min and reschedules", () => {
    const prev = state({ expectedReturnAt: at(-10) });
    const r = confirmOkTransition(prev, { tappedAt: now, now });
    expect(r.state.status).toBe("confirmed_ok");
    expect(r.state.version).toBe(prev.version + 1);
    expect(r.state.expectedReturnAt).toEqual(at(OK_AUTO_EXTEND_MIN));
    expect(r.effects).toEqual([{ type: "reschedule" }]);
    expect(r.event).toBe("ok_confirmed_auto_extended");
  });

  it("“I'm okay” while overdue / contact_notified counts as confirmation and follows up with the contact", () => {
    const overdue = confirmOkTransition(state({ status: "overdue", expectedReturnAt: at(-90) }), { tappedAt: now, now });
    expect(overdue.state.status).toBe("confirmed_ok");
    expect(overdue.effects).toEqual([{ type: "reschedule" }, { type: "suppress_pending_notices" }]);

    const notified = confirmOkTransition(state({ status: "contact_notified", expectedReturnAt: at(-90), contactNotifiedAt: at(-20) }), {
      tappedAt: at(-5), // tapped offline 5 min ago, synced now
      now,
    });
    expect(notified.state.expectedReturnAt).toEqual(at(OK_AUTO_EXTEND_MIN)); // from processing time
    expect(notified.state.lastOkAt).toEqual(at(-5));
    expect(notified.effects).toContainEqual({ type: "follow_up_contact", kind: "ok" });
  });

  it("an offline “I'm okay” tapped before the expected return keeps the original deadline", () => {
    const prev = state({ expectedReturnAt: at(-10) });
    const r = confirmOkTransition(prev, { tappedAt: at(-30), now });
    expect(r.state.status).toBe("confirmed_ok");
    expect(r.state.version).toBe(prev.version);
    expect(r.state.expectedReturnAt).toEqual(prev.expectedReturnAt);
  });

  it("ignores “I'm okay” for completed/cancelled check-ins", () => {
    for (const status of ["completed", "cancelled"] as const) {
      const r = confirmOkTransition(state({ status }), { tappedAt: now, now });
      expect(r.changed).toBe(false);
      expect(r.state.status).toBe(status);
    }
  });

  it("extend -> new time, version++, back to active/confirmed_ok, cancels old jobs", () => {
    const r = ok(extendTransition(state({ status: "contact_notified", contactNotifiedAt: at(-1) }), { newExpectedReturnAt: at(60), now }));
    expect(r.state.status).toBe("active");
    expect(r.state.version).toBe(4);
    expect(r.effects).toContainEqual({ type: "reschedule" });
    expect(r.effects).toContainEqual({ type: "follow_up_contact", kind: "extended" });
    expect(ok(extendTransition(state({ status: "confirmed_ok" }), { newExpectedReturnAt: at(200), now })).state.status).toBe("confirmed_ok");
    expect(ok(extendTransition(state({ status: "scheduled" }), { newExpectedReturnAt: at(200), now })).state.status).toBe("scheduled");
    expect(extendTransition(state({ status: "completed" }), { newExpectedReturnAt: at(60), now })).toHaveProperty("error");
    expect(validateExtension(at(2), now)).toMatch(/at least/);
    expect(validateExtension(at(25 * 60), now)).toMatch(/24 hours/);
  });

  it("+N extensions count from the later of now and the current expected return", () => {
    expect(extendedReturnAt(at(30), 60, now)).toEqual(at(90));
    expect(extendedReturnAt(at(-30), 60, now)).toEqual(at(60));
  });

  it("finish -> completed (terminal), cancels jobs; follow-up only when the contact was notified", () => {
    const r = finishTransition(state(), now);
    expect(r.state.status).toBe("completed");
    expect(r.state.completedAt).toEqual(now);
    expect(r.effects).toEqual([{ type: "cancel_jobs" }, { type: "suppress_pending_notices" }]);
    const notified = finishTransition(state({ status: "contact_notified", contactNotifiedAt: at(-3) }), now);
    expect(notified.effects).toContainEqual({ type: "follow_up_contact", kind: "finished" });
    const again = finishTransition(r.state, at(5));
    expect(again.changed).toBe(false);
    expect(again.state.completedAt).toEqual(now);
  });

  it("overdue only when awaiting and past expected return + grace", () => {
    const prev = state({ expectedReturnAt: at(-30), graceMinutes: 60 });
    expect(overdueTransition(prev, now).changed).toBe(false); // 30 min left in grace
    const r = overdueTransition(prev, at(31));
    expect(r.state.status).toBe("overdue");
    expect(r.state.overdueAt).toEqual(at(31));
    expect(overdueTransition(state({ status: "completed", expectedReturnAt: at(-500) }), now).changed).toBe(false);
    expect(overdueTransition(state({ status: "contact_notified", expectedReturnAt: at(-500) }), now).changed).toBe(false);
  });

  it("contact_notified after delivery of the current version's notice", () => {
    const r = contactNotifiedTransition(state({ status: "overdue" }), 3, now);
    expect(r.state.status).toBe("contact_notified");
    expect(r.state.contactNotifiedAt).toEqual(now);
    // delivered after the user already confirmed: status unchanged, fact recorded
    const late = contactNotifiedTransition(state({ status: "confirmed_ok", version: 4 }), 3, now);
    expect(late.state.status).toBe("confirmed_ok");
    expect(late.state.contactNotifiedAt).toEqual(now);
  });

  it("cancel -> cancelled, version++, cancels jobs", () => {
    const r = cancelTransition(state());
    expect(r.state.status).toBe("cancelled");
    expect(r.state.version).toBe(4);
    expect(r.effects).toContainEqual({ type: "cancel_jobs" });
    expect(cancelTransition(state({ status: "completed" })).changed).toBe(false);
  });
});

describe("check-in schedule", () => {
  const c = { id: "abc", version: 7, expectedReturnAt: at(180), graceMinutes: 45, reminderOffsetsMin: [15, 60] };

  it("schedules reminders at expected return - offset and overdue at expected return + grace", () => {
    const steps = computeSchedule(c);
    expect(steps).toEqual([
      { step: "reminder", kind: "checkins.reminder", at: at(120), offsetMin: 60, dedupKey: "checkin:abc:v7:reminder:60" },
      { step: "reminder", kind: "checkins.reminder", at: at(165), offsetMin: 15, dedupKey: "checkin:abc:v7:reminder:15" },
      { step: "overdue", kind: "checkins.overdue", at: at(225), dedupKey: "checkin:abc:v7:overdue" },
    ]);
  });

  it("dedup keys include the version so a reschedule never collides", () => {
    expect(reminderDedupKey("abc", 8, 60)).toBe("checkin:abc:v8:reminder:60");
    expect(overdueDedupKey("abc", 8)).toBe("checkin:abc:v8:overdue");
    const v8 = computeSchedule({ ...c, version: 8 }).map((s) => s.dedupKey);
    const v7 = computeSchedule(c).map((s) => s.dedupKey);
    expect(v8.some((k) => v7.includes(k))).toBe(false);
  });

  it("skips reminders already in the past but always schedules the overdue check", () => {
    const steps = computeSchedule({ ...c, expectedReturnAt: at(30) }, now);
    expect(steps.map((s) => s.step)).toEqual(["reminder", "overdue"]);
    expect(computeSchedule({ ...c, expectedReturnAt: at(-100) }, now).map((s) => s.step)).toEqual(["overdue"]);
  });

  it("normalizes reminder offsets", () => {
    expect(normalizeReminderOffsets([15, 60, 60, 0, 900, 30.4])).toEqual([60, 30, 15]);
    expect(normalizeReminderOffsets([10, 20, 30, 40, 50, 60, 70])).toHaveLength(5);
  });
});

describe("check-in defaults & time helpers", () => {
  it("default expected return = itinerary finish + 30 min in the region zone", () => {
    const d = defaultExpectedReturn({ plannedDate: "2026-11-14", startTime: "09:00", estimatedFinishTime: "13:15" }, TZ);
    expect(d?.toISOString()).toBe("2026-11-14T21:45:00.000Z"); // 13:45 PST
    const overnight = defaultExpectedReturn({ plannedDate: "2026-11-14", startTime: "22:00", estimatedFinishTime: "01:00" }, TZ);
    expect(overnight?.toISOString()).toBe("2026-11-15T09:30:00.000Z");
    const fallback = defaultExpectedReturn({ plannedDate: "2026-11-14", startTime: "09:00", estimatedDurationMin: 90 }, TZ);
    expect(fallback?.toISOString()).toBe("2026-11-14T19:00:00.000Z"); // 09:00 PST + 90 + 30
    expect(defaultExpectedReturn({ plannedDate: null, startTime: null }, TZ)).toBeNull();
  });

  it("round-trips datetime-local values in the region zone", () => {
    const v = toLocalInputValue(new Date("2026-11-14T21:45:00Z"), TZ);
    expect(v).toBe("2026-11-14T13:45");
    expect(parseLocalInputValue(v, TZ)?.toISOString()).toBe("2026-11-14T21:45:00.000Z");
    expect(parseLocalInputValue("tomorrow", TZ)).toBeNull();
  });

  it("describes status in neutral words", () => {
    const owner = describeCheckinForOwner(state({ status: "contact_notified", contactNotifiedAt: now }), TZ);
    expect(owner.title).toBe("Your contact was sent a notice");
    for (const s of ["scheduled", "active", "confirmed_ok", "overdue", "contact_notified", "completed", "cancelled"] as const) {
      const text = JSON.stringify(describeCheckinForOwner(state({ status: s }), TZ));
      expect(text).not.toMatch(/emergency|danger|rescue|SOS/i);
    }
    expect(describeCheckinForShare(state({ status: "confirmed_ok", lastOkAt: new Date("2026-11-14T18:42:00Z") }), TZ)).toBe(
      "Confirmed okay at 10:42 AM PST",
    );
    expect(describeCheckinForShare(state({ status: "active" }), TZ)).toBe("No confirmation received yet");
    expect(describeCheckinForShare(null, TZ)).toMatch(/not turned on/);
  });
});
