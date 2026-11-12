/**
 * Daylight planning (src/server/weather/planning.ts) and the forecast
 * altitude choice (src/server/weather/conditions.ts), with fixed instants.
 *
 * Reference place: Table Rock State Park, SC (35.033, -82.7), America/New_York.
 * Sun times on 2026-11-12 from sunTimes(): sunrise 12:02:27.793Z (7:02 AM),
 * sunset 22:27:01.711Z (5:27 PM); 2026-11-13 sunset 22:26:20.386Z;
 * sunrise 12:03:26.356Z.
 */
import { describe, expect, it } from "vitest";
import { estimateOutAndBackMin } from "@/server/trails/estimate";
import { forecastAltitude, whenLocal } from "@/server/weather/conditions";
import {
  DAYLIGHT_BUFFER_MIN,
  buildPlanning,
  formatDuration,
  outAndBackMinutes,
  sunDays,
  toSunTimesDto,
  type PlanningInput,
} from "@/server/weather/planning";

const NY = "America/New_York";
const LAT = 35.033;
const LNG = -82.7;
const SUNSET_TODAY = Date.parse("2026-11-12T22:27:01.711Z");
const SUNRISE_TODAY = Date.parse("2026-11-12T12:02:27.793Z");
const SUNSET_TOMORROW = Date.parse("2026-11-13T22:26:20.386Z");
const MIN = 60_000;

function plan(nowIso: string, o: Partial<PlanningInput> = {}) {
  const now = new Date(nowIso);
  return buildPlanning({
    now,
    timeZone: NY,
    timeZoneKnown: true,
    routeType: "loop",
    distanceM: 6_000,
    estimatedDurationMin: 120,
    profile: null,
    sun: sunDays(LAT, LNG, NY, now),
    ...o,
  });
}

describe("sunDays / toSunTimesDto", () => {
  it("returns today and the next two local days as ISO strings", () => {
    const days = sunDays(LAT, LNG, NY, new Date("2026-11-12T15:00:00Z")).map(toSunTimesDto);
    expect(days.map((d) => d.date)).toEqual(["2026-11-12", "2026-11-13", "2026-11-14"]);
    expect(days[0]).toEqual({
      date: "2026-11-12",
      sunrise: "2026-11-12T12:02:27.793Z",
      sunset: "2026-11-12T22:27:01.711Z",
      civilDusk: "2026-11-12T22:53:48.130Z",
      polar: null,
    });
  });

  it("uses the LOCAL date: 11 PM EST is still the 12th", () => {
    expect(sunDays(LAT, LNG, NY, new Date("2026-11-13T04:00:00Z"))[0].date).toBe("2026-11-12");
  });

  it("crosses a DST change (local sunset moves an hour earlier on the clock)", () => {
    const days = sunDays(LAT, LNG, NY, new Date("2026-10-31T16:00:00Z"));
    expect(days.map((d) => d.date)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
    const local = (d: Date) => Number(d.toLocaleString("en-US", { timeZone: NY, hour: "numeric", hourCycle: "h23" }));
    expect(local(days[0].times!.sunset!)).toBe(18);
    expect(local(days[1].times!.sunset!)).toBe(17);
  });

  it("never throws: unknown zones give no days, bad coordinates null times", () => {
    expect(sunDays(LAT, LNG, "Mars/Olympus", new Date())).toEqual([]);
    const bad = sunDays(95, LNG, NY, new Date("2026-11-12T15:00:00Z"));
    expect(bad).toHaveLength(3);
    expect(bad.every((d) => d.times === null)).toBe(true);
    expect(toSunTimesDto(bad[0])).toEqual({ date: bad[0].date, sunrise: null, sunset: null, civilDusk: null, polar: null });
  });
});

describe("buildPlanning: loop", () => {
  it("computes latest start, finish and daylight left (10 AM)", () => {
    const p = plan("2026-11-12T15:00:00Z");
    expect(p.estimatedDurationMin).toBe(120);
    expect(p.outAndBackDurationMin).toBeNull();
    expect(p.latestRecommendedStart).toBe(new Date(SUNSET_TODAY - (120 + DAYLIGHT_BUFFER_MIN) * MIN).toISOString());
    expect(p.finishIfStartNow).toBe("2026-11-12T17:00:00.000Z");
    expect(p.daylightRemainingMin).toBe(Math.round((SUNSET_TODAY - Date.parse("2026-11-12T15:00:00Z")) / MIN));
    expect(p.notes).toEqual([
      "Estimates assume an average pace and do not include long breaks.",
      "The latest recommended start leaves an hour of daylight to spare before sunset.",
      "Sunrise and sunset are calculated for a flat horizon; mountains and valleys can bring darkness earlier.",
    ]);
  });

  it("before sunrise, daylight left is the whole day's daylight", () => {
    expect(plan("2026-11-12T10:00:00Z").daylightRemainingMin).toBe(Math.round((SUNSET_TODAY - SUNRISE_TODAY) / MIN));
  });

  it("warns when starting now would finish after sunset", () => {
    const p = plan("2026-11-12T20:00:00Z", { estimatedDurationMin: 150 });
    expect(p.finishIfStartNow).toBe("2026-11-12T22:30:00.000Z");
    expect(p.notes).toContain("Starting now, you would finish around 5:30 PM, after sunset (5:27 PM). Bring a headlamp or choose a shorter hike.");
  });

  it("moves the latest start to tomorrow when today's has passed, and says so", () => {
    const p = plan("2026-11-12T21:00:00Z");
    const latest = new Date(SUNSET_TOMORROW - 180 * MIN);
    expect(p.latestRecommendedStart).toBe(latest.toISOString());
    expect(p.notes[0]).toBe("It is too late today to finish an hour before sunset. Tomorrow, start by 2:26 PM at the latest.");
    expect(p.daylightRemainingMin).toBe(Math.round((SUNSET_TODAY - Date.parse("2026-11-12T21:00:00Z")) / MIN));
  });

  it("after sunset: no daylight left, latest start tomorrow", () => {
    const p = plan("2026-11-12T23:00:00Z");
    expect(p.daylightRemainingMin).toBe(0);
    expect(p.notes).toContain("The sun has already set today (5:27 PM).");
    expect(p.latestRecommendedStart).toBe(new Date(SUNSET_TOMORROW - 180 * MIN).toISOString());
  });

  it("flags a hike longer than the daylight (start before sunrise)", () => {
    const early = plan("2026-11-12T05:00:00Z", { estimatedDurationMin: 700 });
    expect(early.latestRecommendedStart).toBe(new Date(SUNSET_TODAY - 760 * MIN).toISOString());
    expect(early.notes).toContain(
      "That start is before sunrise (7:02 AM): this hike takes longer than the daylight available, so part of it would be in the dark.",
    );
    const later = plan("2026-11-12T15:00:00Z", { estimatedDurationMin: 700 });
    expect(later.latestRecommendedStart).toBe(new Date(SUNSET_TOMORROW - 760 * MIN).toISOString());
    expect(later.notes.some((n) => n.startsWith("That start is before sunrise (7:03 AM)"))).toBe(true);
  });

  it("without a duration: no start or finish times, and an honest note", () => {
    const p = plan("2026-11-12T15:00:00Z", { estimatedDurationMin: null });
    expect(p).toMatchObject({ estimatedDurationMin: null, outAndBackDurationMin: null, latestRecommendedStart: null, finishIfStartNow: null });
    expect(p.daylightRemainingMin).toBeGreaterThan(0);
    expect(p.notes[0]).toBe("The hiking time for this trail is not known, so Ghost Guide cannot suggest a latest start time.");
    expect(p.notes).not.toContain("Estimates assume an average pace and do not include long breaks.");
  });

  it("ignores invalid stored durations", () => {
    expect(plan("2026-11-12T15:00:00Z", { estimatedDurationMin: 0 }).finishIfStartNow).toBeNull();
    expect(plan("2026-11-12T15:00:00Z", { estimatedDurationMin: Number.NaN }).estimatedDurationMin).toBeNull();
  });

  it("says when times are in UTC because the zone is unknown", () => {
    const now = new Date("2026-11-12T15:00:00Z");
    const p = buildPlanning({
      now,
      timeZone: "UTC",
      timeZoneKnown: false,
      routeType: "loop",
      distanceM: 6000,
      estimatedDurationMin: 120,
      profile: null,
      sun: sunDays(LAT, LNG, "UTC", now),
    });
    expect(p.notes.at(-1)).toBe("The trail's time zone is unknown, so times are shown in UTC.");
  });
});

describe("buildPlanning: linear (out and back)", () => {
  const profile: [number, number][] = [
    [0, 340],
    [1500, 520],
    [2900, 960],
  ];

  it("plans with the out-and-back estimate from the stored profile", () => {
    const outAndBack = estimateOutAndBackMin(2900, profile);
    const p = plan("2026-11-12T15:00:00Z", { routeType: "linear", distanceM: 2900, estimatedDurationMin: 95, profile });
    expect(p.estimatedDurationMin).toBe(95);
    expect(p.outAndBackDurationMin).toBe(outAndBack);
    expect(p.finishIfStartNow).toBe(new Date(Date.parse("2026-11-12T15:00:00Z") + outAndBack * MIN).toISOString());
    expect(p.latestRecommendedStart).toBe(new Date(SUNSET_TODAY - (outAndBack + 60) * MIN).toISOString());
    expect(p.notes[0]).toBe(
      `This is a one-way route. Times assume you hike out and back (about ${formatDuration(outAndBack)}); one way takes about 1 h 35 min.`,
    );
  });

  it("estimates out and back on flat pace without a profile, even when the one-way time is unknown", () => {
    const p = plan("2026-11-12T15:00:00Z", { routeType: "linear", distanceM: 4500, estimatedDurationMin: null, profile: null });
    expect(p.outAndBackDurationMin).toBe(120); // 9 km at 4.5 km/h
    expect(p.finishIfStartNow).toBe("2026-11-12T17:00:00.000Z");
    expect(p.notes[0]).toBe("This is a one-way route. Times assume you hike out and back (about 2 h).");
  });

  it("outAndBackMinutes is null for other route types and unusable distances", () => {
    expect(outAndBackMinutes("loop", 3000, null)).toBeNull();
    expect(outAndBackMinutes("network", 3000, null)).toBeNull();
    expect(outAndBackMinutes("linear", 0, null)).toBeNull();
    expect(outAndBackMinutes("linear", null, null)).toBeNull();
    expect(outAndBackMinutes("linear", Number.NaN, null)).toBeNull();
  });
});

describe("buildPlanning: polar day and night (Longyearbyen, Svalbard)", () => {
  const svalbard = (nowIso: string) => {
    const now = new Date(nowIso);
    return buildPlanning({
      now,
      timeZone: "Arctic/Longyearbyen",
      timeZoneKnown: true,
      routeType: "loop",
      distanceM: 5000,
      estimatedDurationMin: 100,
      profile: null,
      sun: sunDays(78.22, 15.65, "Arctic/Longyearbyen", now),
    });
  };

  it("polar night: no daylight, no latest start", () => {
    const p = svalbard("2026-12-15T12:00:00Z");
    expect(p.daylightRemainingMin).toBe(0);
    expect(p.latestRecommendedStart).toBeNull();
    expect(p.finishIfStartNow).toBe("2026-12-15T13:40:00.000Z");
    expect(p.notes).toContain("The sun does not rise here today. Plan for hiking in darkness or twilight.");
  });

  it("polar day: daylight does not limit the start", () => {
    const p = svalbard("2026-06-15T12:00:00Z");
    expect(p.daylightRemainingMin).toBeNull();
    expect(p.latestRecommendedStart).toBeNull();
    expect(p.notes).toContain("The sun does not set here today, so daylight does not limit your start time.");
  });

  it("missing sun data never invents times", () => {
    const p = buildPlanning({
      now: new Date("2026-11-12T15:00:00Z"),
      timeZone: NY,
      timeZoneKnown: true,
      routeType: "loop",
      distanceM: 5000,
      estimatedDurationMin: 100,
      profile: null,
      sun: [],
    });
    expect(p.daylightRemainingMin).toBeNull();
    expect(p.latestRecommendedStart).toBeNull();
    expect(p.finishIfStartNow).toBe("2026-11-12T16:40:00.000Z");
  });
});

describe("formatDuration", () => {
  it.each([
    [45, "45 min"],
    [60, "1 h"],
    [190, "3 h 10 min"],
    [0, "0 min"],
    [-5, "0 min"],
    [59.6, "1 h"],
  ])("%s → %s", (min, text) => {
    expect(formatDuration(min)).toBe(text);
  });
});

describe("forecastAltitude", () => {
  const profile: [number, number][] = [
    [0, 341.6],
    [1000, 600],
    [2000, 955.2],
  ];
  const start = { lng: -82.7, lat: 35.033 };
  const end = { lng: -82.69, lat: 35.05 };

  it("uses the profile elevation of the route end nearest the trailhead (≤ 300 m)", () => {
    expect(forecastAltitude({ trailhead: { lng: -82.7005, lat: 35.0332 }, profile, routeStart: start, routeEnd: end })).toBe(342);
    expect(forecastAltitude({ trailhead: { lng: -82.6901, lat: 35.0499 }, profile, routeStart: start, routeEnd: end })).toBe(955);
  });

  it("is null when the trailhead is far from both ends, or data is missing", () => {
    expect(forecastAltitude({ trailhead: { lng: -82.71, lat: 35.04 }, profile, routeStart: start, routeEnd: end })).toBeNull();
    expect(forecastAltitude({ trailhead: null, profile, routeStart: start, routeEnd: end })).toBeNull();
    expect(forecastAltitude({ trailhead: start, profile: null, routeStart: start, routeEnd: end })).toBeNull();
    expect(forecastAltitude({ trailhead: start, profile: [[0, 300]], routeStart: start, routeEnd: end })).toBeNull();
    expect(forecastAltitude({ trailhead: start, profile, routeStart: null, routeEnd: null })).toBeNull();
  });
});

describe("whenLocal", () => {
  const now = new Date("2026-11-12T15:00:00Z"); // 10 AM EST
  it("words an instant relative to today in the trail's zone", () => {
    expect(whenLocal(new Date("2026-11-12T13:17:00Z"), now, NY)).toBe("at 8:17 AM");
    expect(whenLocal(new Date("2026-11-12T01:17:18Z"), now, NY)).toBe("yesterday at 8:17 PM");
    expect(whenLocal(new Date("2026-11-10T13:00:00Z"), now, NY)).toBe("on 2026-11-10 at 8 AM");
  });
});
