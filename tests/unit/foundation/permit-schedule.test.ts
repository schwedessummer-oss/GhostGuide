import { describe, expect, it } from "vitest";
import { nextPermitRemindRun } from "@/server/jobs/handlers/ops";

describe("permit reminder schedule", () => {
  it("always schedules the next run on the following UTC day (no same-day dedup collision)", () => {
    expect(nextPermitRemindRun(new Date("2026-11-11T14:06:00Z")).toISOString()).toBe("2026-11-12T16:00:00.000Z");
    expect(nextPermitRemindRun(new Date("2026-11-11T17:30:00Z")).toISOString()).toBe("2026-11-12T16:00:00.000Z");
    expect(nextPermitRemindRun(new Date("2026-12-31T23:59:00Z")).toISOString()).toBe("2027-01-01T16:00:00.000Z");
  });
});
