import { describe, expect, it } from "vitest";
import {
  closedOnDateMessage,
  closureVerdict,
  daylightProblem,
  formatReceiptNumber,
  isRealIsoDate,
  planDiffersFromBooking,
  replanForBooking,
  type ReplanInput,
} from "@/domain/booking";
import { zonedTimeToUtc } from "@/lib/time";

const TZ = "America/Los_Angeles";

describe("booked-date validation", () => {
  it("accepts only real calendar dates", () => {
    expect(isRealIsoDate("2026-12-16")).toBe(true);
    expect(isRealIsoDate("2028-02-29")).toBe(true);
    for (const bad of ["2026-13-45", "2026-12-32", "2026-02-30", "2027-02-29", "2026-00-10", "2026-1-5", "", "tomorrow"]) {
      expect(isRealIsoDate(bad), bad).toBe(false);
    }
  });
});

describe("receipt number date", () => {
  it("uses the region-local payment date when a zone is given", () => {
    // 9:14 PM Pacific on Nov 4 is already Nov 5 in UTC.
    const paidAt = new Date("2026-11-05T05:14:00Z");
    expect(formatReceiptNumber(paidAt, [0, 1, 2, 3, 4, 5])).toMatch(/^GG-20261105-/);
    expect(formatReceiptNumber(paidAt, [0, 1, 2, 3, 4, 5], TZ)).toMatch(/^GG-20261104-/);
  });
});

describe("closures on the hike day", () => {
  const day = "2027-03-10";
  const local = (d: string, t = "00:00") => zonedTimeToUtc(d, t, TZ);

  it("refuses a day with a scheduled full closure, counted in region-local time", () => {
    const scheduled = { severity: "closed" as const, reason: "Bridge repair", startsAt: local(day), endsAt: local("2027-03-11") };
    expect(closureVerdict([scheduled], day, TZ).closed?.reason).toBe("Bridge repair");
    // The day before and the day after are not affected (ends exactly at the next local midnight).
    expect(closureVerdict([scheduled], "2027-03-09", TZ).closed).toBeNull();
    expect(closureVerdict([scheduled], "2027-03-11", TZ).closed).toBeNull();
  });

  it("treats an open-ended closure as covering every later day, and an ended one as not", () => {
    const openEnded = { severity: "closed" as const, reason: "Washout", startsAt: local("2027-01-01"), endsAt: null };
    const ended = { severity: "closed" as const, reason: "Storm", startsAt: local("2027-01-01"), endsAt: local("2027-01-05") };
    expect(closureVerdict([openEnded], day, TZ).closed?.reason).toBe("Washout");
    expect(closureVerdict([ended], day, TZ).closed).toBeNull();
  });

  it("only warns for partial closures and advisories", () => {
    const partial = { severity: "partial" as const, reason: "Upper spur closed", startsAt: local(day, "06:00"), endsAt: local(day, "18:00") };
    const advisory = { severity: "advisory" as const, reason: "Muddy", startsAt: local("2027-03-01"), endsAt: null };
    const v = closureVerdict([advisory, partial], day, TZ);
    expect(v.closed).toBeNull();
    expect(v.notices.map((n) => n.reason)).toEqual(["Muddy", "Upper spur closed"]);
  });

  it("explains the refusal with the closure reason", () => {
    expect(closedOnDateMessage({ reason: "Bridge repair." })).toBe("The trail is closed on that date: Bridge repair. Please choose another date.");
  });
});

const trail: ReplanInput["trail"] = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Test Ridge",
  distanceKm: 12,
  elevationGainM: 700,
  terrain: ["forest"],
  routeType: "out_and_back",
  estimatedDurationMin: 300,
  permitRequired: false,
  geometry: null,
};
const pois: ReplanInput["pois"] = [
  { id: "p1", name: "Trailhead", kind: "trailhead", lat: 0, lng: 0, seq: 1 },
  { id: "p2", name: "Falls", kind: "water", lat: 0, lng: 0, seq: 2 },
];
const base: ReplanInput = {
  trail,
  pois,
  permits: [{ name: "Day-use pass", leadTimeDays: 7 }],
  preferences: { pace: "steady", fitness: "moderate", experience: "some", availableHours: 7, plannedDate: "2027-06-16", startTime: "09:00", partySize: 2 },
  hikeDate: "2027-06-16",
  startTime: "09:00",
  partySize: 2,
  now: new Date("2026-11-11T12:00:00Z"),
};

describe("re-planning for the booked date and group", () => {
  it("rebuilds the itinerary with the booked month's latest-finish estimate", () => {
    const june = replanForBooking({ ...base, startTime: "10:30" });
    const december = replanForBooking({ ...base, hikeDate: "2026-12-16", startTime: "10:30" });
    expect(june.latestFinishTime).toBe("20:15");
    expect(december.latestFinishTime).toBe("15:45");
    expect(december.itinerary.plannedDate).toBe("2026-12-16");
    expect(december.itinerary.notes.join(" ")).toContain("Plan to be off the trail by 15:45");
    expect(december.itinerary.notes.join(" ")).not.toContain("20:15");
    expect(december.itinerary.notes).toContain("Permit: Day-use pass (allow about 7 days).");
    // Out-and-back: the turnaround is pulled earlier by the December cutoff
    // (15:45 minus the return leg and the 30-minute margin).
    expect(june.itinerary.turnaroundBy).toBe("13:30");
    expect(december.itinerary.turnaroundBy).toBe("12:40");
  });

  it("uses the booked group size for the pace factor and keeps the saved answers", () => {
    const four = replanForBooking({ ...base, partySize: 4 });
    expect(four.itinerary.paceFactor).toBe(1.05);
    expect(four.itinerary.estimatedDurationMin).toBeGreaterThan(replanForBooking(base).itinerary.estimatedDurationMin);
    expect(four.preferences).toMatchObject({ pace: "steady", fitness: "moderate", availableHours: 7, partySize: 4, plannedDate: "2027-06-16" });
  });

  it("works for trips saved without questionnaire answers (estimates use neutral defaults)", () => {
    const r = replanForBooking({ ...base, preferences: {}, hikeDate: "2027-03-03", partySize: 1 });
    expect(r.itinerary.paceFactor).toBe(1);
    expect(r.preferences).toEqual({ plannedDate: "2027-03-03", startTime: "09:00", partySize: 1 });
  });

  it("flags a booked day that would finish after the latest-finish estimate", () => {
    const late = replanForBooking({ ...base, hikeDate: "2026-12-16", startTime: "11:00" });
    expect(late.finishesAfterLatest).toBe(true);
    expect(daylightProblem(late)).toMatch(/On 2026-12-16 your estimated finish \(16:\d\d\) is after the conservative latest-finish estimate for December \(15:45\)/);
    const ok = replanForBooking({ ...base, hikeDate: "2027-06-16", startTime: "11:00" });
    expect(ok.finishesAfterLatest).toBe(false);
    expect(daylightProblem(ok)).toBeNull();
  });

  it("detects when the saved plan was computed for another date, group or start", () => {
    const trip = { plannedDate: "2027-06-16", partySize: 2, startTime: "09:00", itinerary: { plannedDate: "2027-06-16" } };
    expect(planDiffersFromBooking(trip, { hikeDate: "2027-06-16", partySize: 2, startTime: "09:00" })).toBe(false);
    expect(planDiffersFromBooking(trip, { hikeDate: "2027-06-19", partySize: 2, startTime: "09:00" })).toBe(true);
    expect(planDiffersFromBooking(trip, { hikeDate: "2027-06-16", partySize: 4, startTime: "09:00" })).toBe(true);
    expect(planDiffersFromBooking(trip, { hikeDate: "2027-06-16", partySize: 2, startTime: "10:00" })).toBe(true);
    expect(planDiffersFromBooking({ ...trip, itinerary: { plannedDate: "2027-05-01" } }, { hikeDate: "2027-06-16", partySize: 2, startTime: "09:00" })).toBe(true);
    expect(planDiffersFromBooking({ ...trip, itinerary: {} }, { hikeDate: "2027-06-16", partySize: 2, startTime: "09:00" })).toBe(false);
  });
});
