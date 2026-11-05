import { describe, expect, it } from "vitest";
import {
  INITIAL_REMINDER_STATE,
  REMINDER_DISCLAIMER,
  clearReminders,
  defaultReminderSettings,
  dueReminders,
  nextReminderInMs,
  reminderMessage,
  type ReminderSettings,
  type ReminderState,
} from "@/domain/reminders";
import { activeElapsedMs } from "@/domain/progress";

const MIN = 60_000;

function simulate(settings: ReminderSettings, activeMinutes: number[], start: ReminderState = INITIAL_REMINDER_STATE) {
  let state = start;
  const fired: { kind: string; at: number }[] = [];
  for (const m of activeMinutes) {
    const r = dueReminders(state, m * MIN, settings);
    state = r.state;
    for (const k of r.due) fired.push({ kind: k, at: m });
  }
  return { state, fired };
}

describe("hike reminders", () => {
  it("fires at the configured interval", () => {
    const minutes = Array.from({ length: 91 }, (_, i) => i);
    const { fired } = simulate({ hydrationEveryMin: 30, paceCheckEveryMin: 45 }, minutes);
    expect(fired).toEqual([
      { kind: "hydration", at: 30 },
      { kind: "pace_check", at: 45 },
      { kind: "hydration", at: 60 },
      { kind: "hydration", at: 90 },
      { kind: "pace_check", at: 90 },
    ]);
  });

  it("is pause-aware: paused time does not count", () => {
    const pauses = [{ start: 20 * MIN, end: 50 * MIN }];
    // 40 min of wall-clock time includes a 20 min pause → only 20 active minutes
    const active40 = activeElapsedMs(0, pauses, 40 * MIN);
    expect(dueReminders(INITIAL_REMINDER_STATE, active40, { hydrationEveryMin: 30, paceCheckEveryMin: null }).due).toEqual([]);
    const active60 = activeElapsedMs(0, pauses, 60 * MIN); // 30 active minutes
    expect(dueReminders(INITIAL_REMINDER_STATE, active60, { hydrationEveryMin: 30, paceCheckEveryMin: null }).due).toEqual(["hydration"]);
  });

  it("can be turned off or changed", () => {
    const minutes = Array.from({ length: 121 }, (_, i) => i);
    expect(simulate({ hydrationEveryMin: null, paceCheckEveryMin: null }, minutes).fired).toEqual([]);
    expect(simulate({ hydrationEveryMin: 0, paceCheckEveryMin: null }, minutes).fired).toEqual([]);
    const first = simulate({ hydrationEveryMin: 60, paceCheckEveryMin: null }, Array.from({ length: 61 }, (_, i) => i));
    expect(first.fired).toEqual([{ kind: "hydration", at: 60 }]);
    // switching to every 20 min counts from the last reminder
    const after = simulate({ hydrationEveryMin: 20, paceCheckEveryMin: null }, [70, 80, 90], first.state);
    expect(after.fired).toEqual([{ kind: "hydration", at: 80 }]);
    expect(nextReminderInMs(after.state, 85 * MIN, { hydrationEveryMin: 20, paceCheckEveryMin: null })).toEqual({ hydration: 15 * MIN, pace_check: null });
  });

  it("does not burst after a long gap (e.g. the page was in the background)", () => {
    const r = dueReminders(INITIAL_REMINDER_STATE, 200 * MIN, { hydrationEveryMin: 30, paceCheckEveryMin: null });
    expect(r.due).toEqual(["hydration"]);
    expect(dueReminders(r.state, 201 * MIN, { hydrationEveryMin: 30, paceCheckEveryMin: null }).due).toEqual([]);
  });

  it("is cleared on finish", () => {
    const cleared = clearReminders(INITIAL_REMINDER_STATE);
    expect(dueReminders(cleared, 500 * MIN, { hydrationEveryMin: 30, paceCheckEveryMin: 45 }).due).toEqual([]);
    expect(nextReminderInMs(cleared, 0, { hydrationEveryMin: 30, paceCheckEveryMin: 45 })).toEqual({ hydration: null, pace_check: null });
  });

  it("defaults come from the itinerary; wording is general, not medical advice", () => {
    expect(defaultReminderSettings({ hydrationEveryMin: 30, paceCheckEveryMin: 45 })).toEqual({ hydrationEveryMin: 30, paceCheckEveryMin: 45 });
    expect(defaultReminderSettings(null).hydrationEveryMin).toBeGreaterThan(0);
    expect(reminderMessage("hydration").body).toMatch(/Consider taking a drink of water/);
    expect(reminderMessage("pace_check", { progress: 0.4, elapsedMin: 60, plannedTotalMin: 120 }).body).toMatch(/about 40%.*about 50%/);
    expect(REMINDER_DISCLAIMER).toMatch(/not medical advice/);
  });
});
