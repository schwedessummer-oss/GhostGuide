import { describe, expect, it } from "vitest";
import { addMinutesToClock, localDateInZone, localTimeInZone, zonedTimeToUtc } from "@/lib/time";

const TZ = "America/Los_Angeles";

describe("time-zone helpers", () => {
  it("converts local wall time to UTC in standard time", () => {
    expect(zonedTimeToUtc("2026-12-01", "08:30", TZ).toISOString()).toBe("2026-12-01T16:30:00.000Z");
  });
  it("converts local wall time to UTC in daylight time", () => {
    expect(zonedTimeToUtc("2026-07-01", "08:30", TZ).toISOString()).toBe("2026-07-01T15:30:00.000Z");
  });
  it("round-trips local date and time", () => {
    const d = zonedTimeToUtc("2026-11-14", "23:15", TZ);
    expect(localDateInZone(d, TZ)).toBe("2026-11-14");
    expect(localTimeInZone(d, TZ)).toBe("23:15");
  });
  it("adds minutes to a clock time", () => {
    expect(addMinutesToClock("08:30", 95)).toBe("10:05");
    expect(addMinutesToClock("23:30", 45)).toBe("00:15");
  });
});
