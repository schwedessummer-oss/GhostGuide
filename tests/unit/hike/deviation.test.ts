import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVIATION_SETTINGS,
  INITIAL_DEVIATION_STATE,
  deviationStep,
  dismissDeviation,
  offRouteLimitM,
  type DeviationInput,
  type DeviationState,
} from "@/domain/deviation";

const S = { ...DEFAULT_DEVIATION_SETTINGS, thresholdM: 40, requiredConsecutive: 3, minDurationMs: 30_000, clearThresholdM: 25, clearConsecutive: 2 };

function run(inputs: DeviationInput[], start: DeviationState = INITIAL_DEVIATION_STATE) {
  let state = start;
  const events: { event: string; at: number }[] = [];
  for (const i of inputs) {
    const r = deviationStep(state, i, S);
    state = r.state;
    if (r.event) events.push({ event: r.event, at: i.timestamp });
  }
  return { state, events };
}
const f = (d: number, t: number, acc = 8): DeviationInput => ({ distanceFromRouteM: d, accuracyM: acc, timestamp: t * 1000 });

describe("route deviation", () => {
  it("a single spike does not alert", () => {
    const { state, events } = run([f(5, 0), f(150, 10), f(5, 20), f(6, 30), f(4, 60)]);
    expect(events).toEqual([]);
    expect(state.status).toBe("on_route");
  });

  it("ignores poor-accuracy fixes (they neither count nor reset)", () => {
    const poorOnly = run([f(200, 0, 80), f(200, 15, 80), f(200, 30, 80), f(200, 45, 80)]);
    expect(poorOnly.events).toEqual([]);
    // good off-route fixes with a poor on-route fix in between still accumulate
    const mixed = run([f(100, 0), f(100, 15), f(0, 20, 90), f(100, 35)]);
    expect(mixed.events).toEqual([{ event: "prompt", at: 35_000 }]);
  });

  it("includes an accuracy allowance in the threshold", () => {
    expect(offRouteLimitM(20, S)).toBe(60);
    expect(offRouteLimitM(100, S)).toBe(40 + S.maxAccuracyAllowanceM);
    // 55 m away with 20 m accuracy is within threshold + allowance → not off route
    expect(run([f(55, 0, 20), f(55, 20, 20), f(55, 40, 20), f(55, 60, 20)]).events).toEqual([]);
  });

  it("alerts after K consecutive off-route fixes spanning at least T seconds", () => {
    // 3 fixes in 10 s: count satisfied but not the duration
    const quick = run([f(90, 0), f(90, 5), f(90, 10)]);
    expect(quick.events).toEqual([]);
    expect(quick.state.status).toBe("on_route");
    const slow = run([f(90, 0), f(90, 5), f(90, 10), f(90, 20), f(90, 31)]);
    expect(slow.events).toEqual([{ event: "prompt", at: 31_000 }]);
    expect(slow.state.status).toBe("off_route");
    expect(slow.state.promptVisible).toBe(true);
  });

  it("uses hysteresis to clear: in-between distances keep the off-route state", () => {
    const off = run([f(90, 0), f(90, 15), f(90, 31)]);
    expect(off.state.status).toBe("off_route");
    // 35 m: below the off threshold but above the clear threshold → still off route
    const between = run([f(35, 40), f(35, 50), f(35, 60)], off.state);
    expect(between.state.status).toBe("off_route");
    // one close fix is not enough; two are
    const one = run([f(10, 70)], between.state);
    expect(one.state.status).toBe("off_route");
    const cleared = run([f(10, 80)], one.state);
    expect(cleared.state.status).toBe("on_route");
    expect(cleared.events).toEqual([{ event: "cleared", at: 80_000 }]);
    expect(cleared.state.promptVisible).toBe(false);
  });

  it("snoozes after dismissal and re-prompts only after the snooze expires", () => {
    const off = run([f(90, 0), f(90, 15), f(90, 31)]);
    expect(off.events).toHaveLength(1);
    const dismissed = dismissDeviation(off.state, 32_000, "fine", S);
    expect(dismissed.promptVisible).toBe(false);
    // still off route during the snooze: no new prompt
    const during = run([f(90, 60), f(90, 300), f(90, 600)], dismissed);
    expect(during.events).toEqual([]);
    // after the snooze (10 min) a new prompt appears if still off route
    const after = run([f(90, 32 + 600 + 1)], during.state);
    expect(after.events).toEqual([{ event: "prompt", at: (32 + 601) * 1000 }]);
    // "intentional" snoozes longer
    const intentional = dismissDeviation(off.state, 32_000, "intentional", S);
    expect(run([f(90, 32 + 601)], intentional).events).toEqual([]);
  });
});
