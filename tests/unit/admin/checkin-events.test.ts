import { describe, expect, it } from "vitest";
import { describeCheckinEvent, NOT_NOTIFIED_REASON } from "@/server/admin/checkin-events";

const TZ = "America/Los_Angeles";

describe("safety monitor check-in event descriptions", () => {
  it("explains every reason a contact was not notified in plain language", () => {
    const cases: Record<string, RegExp> = {
      consent_withdrawn: /consent was withdrawn/,
      contact_removed: /contact was removed/,
      no_valid_phone_or_email: /no valid phone number or email address/,
      no_contact_selected: /no emergency contact was chosen/,
      no_consent_on_file: /no consent on file/,
    };
    for (const [reason, re] of Object.entries(cases)) {
      const d = describeCheckinEvent({ kind: "contact_not_notified", actor: "system", details: { version: 2, reason } }, TZ);
      expect(d.label).toBe("The hiker's contact was not notified");
      expect(d.detail, reason).toMatch(re);
      expect(d.detail).not.toMatch(/[a-z]_[a-z]/);
    }
    expect(Object.keys(NOT_NOTIFIED_REASON)).toHaveLength(5);
  });

  it("never shows raw keys, ids or the word emergency for overdue", () => {
    const d = describeCheckinEvent({ kind: "overdue", actor: "system", details: { version: 3, clientEventId: "abc-123" } }, TZ);
    expect(d.label).toBe("No confirmation by the expected return time plus grace period");
    expect(d.detail).toBe("");
    expect(`${d.label} ${d.detail}`).not.toMatch(/emergency|clientEventId|version/i);
  });

  it("formats a new expected return in the trail's zone and names the device source", () => {
    const d = describeCheckinEvent({ kind: "extended", actor: "user", details: { expectedReturnAt: "2026-11-05T02:29:00Z", source: "device" } }, TZ);
    expect(d.label).toBe("Expected return changed");
    expect(d.detail).toContain("from the hiker's device");
    expect(d.detail).toContain("new expected return Wed, Nov 4, 6:29 PM PST");
  });

  it("describes cancellations and staff follow-ups; staff notes are masked", () => {
    expect(describeCheckinEvent({ kind: "cancelled", actor: "system", details: { reason: "trip_cancelled" } }, TZ).detail).toBe("the trip or booking was cancelled");
    const note = describeCheckinEvent({ kind: "staff_note", actor: "staff", details: { note: "Called contact on +1 555 123 4567, no answer" } }, TZ);
    expect(note.label).toBe("Staff note");
    expect(note.detail).toContain("[phone]");
    expect(note.detail).not.toContain("555 123 4567");
    const resolved = describeCheckinEvent({ kind: "staff_resolved", actor: "staff", details: { outcome: "hiker_confirmed_safe", note: "Hiker phoned the office" } }, TZ);
    expect(resolved.label).toBe("Staff closed the check-in: hiker confirmed safe");
    expect(resolved.detail).toContain("Hiker phoned the office");
    // unknown staff kinds still read as staff actions, by outcome when present
    expect(describeCheckinEvent({ kind: "resolved_by_staff", actor: "staff", details: { outcome: "hiker_confirmed_safe" } }, TZ).label).toBe(
      "Staff closed the check-in: hiker confirmed safe",
    );
    expect(describeCheckinEvent({ kind: "something_new", actor: "system", details: null }, TZ).label).toBe("Something new");
  });

  it("labels staff-closed check-ins as such whatever kind the safety service records", () => {
    for (const kind of ["finished", "staff_resolved", "completed"]) {
      expect(describeCheckinEvent({ kind, actor: "staff", details: { note: "Hiker emailed from home" } }, TZ).label, kind).toBe("Staff closed the check-in: hiker confirmed safe");
    }
    expect(describeCheckinEvent({ kind: "note", actor: "staff", details: { note: "Left a voicemail" } }, TZ)).toEqual({ label: "Staff note", detail: "“Left a voicemail”" });
    // a hiker "finished" is not a staff action
    expect(describeCheckinEvent({ kind: "finished", actor: "user", details: { source: "web", status: "completed" } }, TZ)).toEqual({
      label: "Trip finished",
      detail: "from the hiker's account",
    });
  });

  it("explains ignored and unknown reasons without raw codes", () => {
    expect(describeCheckinEvent({ kind: "ok_ignored", actor: "user", details: { note: "check-in is completed" } }, TZ).detail).toBe("check-in is completed");
    expect(describeCheckinEvent({ kind: "cancelled", actor: "user", details: { reason: "opted_out" } }, TZ).detail).toBe("the hiker turned check-ins off");
    expect(describeCheckinEvent({ kind: "contact_not_notified", actor: "system", details: { reason: "provider_rejected" } }, TZ).detail).toBe("provider rejected");
    expect(describeCheckinEvent({ kind: "contact_not_notified", actor: "system", details: {} }, TZ).detail).toBe("no reason recorded");
    const ext = describeCheckinEvent({ kind: "extended", actor: "user", details: { newExpectedReturnAt: "2026-11-05T03:00:00Z", source: "device", clientEventId: "e-1" } }, TZ);
    expect(ext.detail).toBe("from the hiker's device (sent when it had signal) · new expected return Wed, Nov 4, 7:00 PM PST");
    expect(describeCheckinEvent({ kind: "reminder_queued", actor: "system", details: { version: 1, offsetMin: 30 } }, TZ).detail).toBe("30 min before the expected return");
  });

  it("describes the safety service's newer events: device extensions ignored, late taps, staff resolution", () => {
    expect(describeCheckinEvent({ kind: "extend_ignored", actor: "user", details: { source: "device", reason: "invalid time", clientEventId: "x" } }, TZ)).toEqual({
      label: "Return-time change from the hiker's device not applied",
      detail: "invalid time · from the hiker's device (sent when it had signal)",
    });
    const late = describeCheckinEvent(
      { kind: "ok_recorded_late", actor: "user", details: { note: "tapped before the expected return; it reached us after the check-in became overdue" } },
      TZ,
    );
    expect(late.label).toBe("Late “I'm okay” recorded (check-in still not confirmed)");
    expect(late.detail).toContain("reached us after the check-in became overdue");
    expect(
      describeCheckinEvent({ kind: "staff_resolved", actor: "staff", details: { outcome: "hiker_confirmed_safe", note: "Hiker called", status: "completed", toVersion: 3 } }, TZ),
    ).toEqual({ label: "Staff closed the check-in: hiker confirmed safe", detail: "“Hiker called”" });
  });
});

