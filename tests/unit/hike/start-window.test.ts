import { describe, expect, it } from "vitest";
import { hikeStartWindow, startAllowed, startWindowMessage } from "@/lib/offline/start-window";

const TZ = "America/Los_Angeles";

describe("hikeStartWindow (booked date in the region's time zone)", () => {
  it("allows the start only on the booked date", () => {
    // 2026-11-28 10:00 in Los Angeles = 18:00 UTC
    const now = Date.parse("2026-11-28T18:00:00Z");
    expect(hikeStartWindow("2026-11-28", TZ, now)).toEqual({ status: "today", bookedDate: "2026-11-28", today: "2026-11-28" });
    expect(hikeStartWindow("2026-11-29", TZ, now).status).toBe("early");
    expect(hikeStartWindow("2026-11-27", TZ, now).status).toBe("late");
  });

  it("uses the region's calendar day, not UTC's", () => {
    // 2026-11-29 05:30 UTC is still 21:30 on Nov 28 in Los Angeles
    const lateEvening = Date.parse("2026-11-29T05:30:00Z");
    expect(hikeStartWindow("2026-11-28", TZ, lateEvening).status).toBe("today");
    expect(hikeStartWindow("2026-11-29", TZ, lateEvening).status).toBe("early");
    // and 07:59 UTC on Nov 28 is still Nov 27 locally
    expect(hikeStartWindow("2026-11-28", TZ, Date.parse("2026-11-28T07:59:00Z")).status).toBe("early");
  });

  it("does not block trips without a (valid) date", () => {
    const w = hikeStartWindow(null, TZ, Date.now());
    expect(w.status).toBe("unknown");
    expect(startAllowed(w)).toBe(true);
    expect(hikeStartWindow("not-a-date", TZ, Date.now()).status).toBe("unknown");
  });

  it("explains a refusal with the booked date", () => {
    const now = Date.parse("2026-11-11T18:00:00Z");
    expect(startWindowMessage(hikeStartWindow("2026-11-28", TZ, now))).toBe(
      "This hike is booked for Saturday, November 28. You can start it on Saturday, November 28.",
    );
    expect(startWindowMessage(hikeStartWindow("2026-11-01", TZ, now))).toMatch(/was booked for Sunday, November 1, which has passed/);
    expect(startWindowMessage(hikeStartWindow("2026-11-11", TZ, now))).toBeNull();
  });
});
