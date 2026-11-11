import { describe, expect, it } from "vitest";
import { buildItinerary, computePaceFactor, estimateTripDurationMin, reminderCadence, type ItineraryPoi, type ItineraryTrail } from "@/domain/itinerary";
import { cumulativeDistancesM, offsetMeters, pointAtDistance, type Position } from "@/domain/geo";
import { makeLoop, makeOutAndBack } from "../../../scripts/seed/geometry";
import { prefs } from "./fixtures";

const TH = { lat: 47.5, lng: -121.7 };
const NOW = new Date("2026-11-05T18:00:00Z");

/** Straight 2 km north, then back along the same line (4 km out-and-back). */
function outAndBackCoords(): Position[] {
  const out: Position[] = [];
  for (let m = 0; m <= 2000; m += 100) {
    const p = offsetMeters(TH, 0, m);
    out.push([p.lng, p.lat]);
  }
  return [...out, ...out.slice(0, -1).reverse()];
}

function poiAt(id: string, seq: number, northM: number, kind: ItineraryPoi["kind"] = "viewpoint"): ItineraryPoi {
  const p = offsetMeters(TH, 0, northM);
  return { id, seq, name: `POI ${id}`, kind, lat: p.lat, lng: p.lng };
}

const outAndBack: ItineraryTrail = {
  id: "trail-oab",
  name: "Test Out and Back",
  distanceKm: 4,
  elevationGainM: 300,
  terrain: ["forest"],
  routeType: "out_and_back",
  estimatedDurationMin: 120,
  permitRequired: false,
  geometry: { type: "LineString", coordinates: outAndBackCoords() },
};

describe("pace factor", () => {
  it("combines pace, fitness and group size (documented estimate)", () => {
    expect(computePaceFactor({ pace: "steady", fitness: "moderate", partySize: 2 })).toBe(1);
    expect(computePaceFactor({ pace: "brisk", fitness: "high", partySize: 1 })).toBe(0.78);
    expect(computePaceFactor({ pace: "leisurely", fitness: "low", partySize: 9 })).toBe(1.65);
    expect(computePaceFactor({ pace: "steady", fitness: "moderate", partySize: 4 })).toBe(1.05);
    expect(computePaceFactor({ pace: "steady", fitness: "moderate", partySize: 6 })).toBe(1.1);
  });

  it("adds a fixed dwell per narration stop", () => {
    expect(estimateTripDurationMin(120, 1.25, 3)).toBe(150 + 15);
  });
});

describe("buildItinerary", () => {
  const pois = [poiAt("th", 1, 0, "trailhead"), poiAt("a", 2, 500), poiAt("b", 3, 1200), poiAt("c", 4, 2000)];

  it("computes duration and finish time from catalog estimate × pace factor + stop dwell", () => {
    const it = buildItinerary(outAndBack, pois, prefs({ startTime: "08:00", pace: "leisurely" }), NOW);
    expect(it.version).toBe(1);
    expect(it.paceFactor).toBe(1.25);
    expect(it.estimatedDurationMin).toBe(150 + 3 * 5); // trailhead POI has no dwell
    expect(it.estimatedFinishTime).toBe("10:45");
    expect(it.generatedAt).toBe(NOW.toISOString());
    expect(it.notes[0]).toMatch(/Estimates only/);
  });

  it("orders out-and-back stops on the outbound leg with increasing ETAs", () => {
    // Pass POIs out of seq order: ordering must not depend on input order.
    const it = buildItinerary(outAndBack, [...pois].reverse(), prefs(), NOW);
    expect(it.stops.map((s) => s.poiId)).toEqual(["th", "a", "b", "c"]);
    const along = it.stops.map((s) => s.alongM);
    expect(along[0]).toBeLessThan(5);
    expect(Math.abs(along[1] - 500)).toBeLessThan(5);
    expect(Math.abs(along[2] - 1200)).toBeLessThan(5);
    expect(Math.abs(along[3] - 2000)).toBeLessThan(5);
    // every stop on the outbound half (not the return leg at 2 km + x)
    expect(along.every((a) => a <= 2005)).toBe(true);
    const etas = it.stops.map((s) => s.etaOffsetMin);
    expect([...etas].sort((a, b) => a - b)).toEqual(etas);
    // 500 m of 4 km at 120 min moving → 15 min (no dwell before the first real stop)
    expect(etas[1]).toBe(15);
    // 1200 m → 36 min + 5 min dwell at the previous stop
    expect(etas[2]).toBe(41);
  });

  it("keeps stops on the outbound leg of a winding out-and-back (seed geometry regression)", () => {
    // Same generator and POI fractions as the seeded Hollow Pine Ridge demo trail.
    for (const seed of [2.3, 3.7, 6.4, 7.1]) {
      const coords = makeOutAndBack({ lat: 47.5215, lng: -121.6702 }, 7.4, 40, 260, 400, seed);
      const cum = cumulativeDistancesM(coords);
      const total = cum[cum.length - 1];
      const fracs = [0.01, 0.18, 0.35, 0.49];
      const trailPois = fracs.map((f, i) => {
        const p = pointAtDistance(coords, total * f, cum);
        return { id: `p${i}`, seq: i + 1, name: `P${i}`, kind: (i === 0 ? "trailhead" : "viewpoint") as ItineraryPoi["kind"], lat: p.lat, lng: p.lng };
      });
      const it = buildItinerary({ ...outAndBack, distanceKm: total / 1000, geometry: { type: "LineString", coordinates: coords } }, trailPois, prefs(), NOW);
      expect(it.stops.map((s) => s.poiId), `seed ${seed}`).toEqual(["p0", "p1", "p2", "p3"]);
      it.stops.forEach((s, i) => expect(Math.abs(s.alongM - total * fracs[i]), `seed ${seed} stop ${i}`).toBeLessThan(20));
    }
  });

  it("orders loop stops by forward progress even near the start/finish", () => {
    const coords = makeLoop({ lat: 47.5052, lng: -121.7021 }, 3.2, 180, 40, 1.1);
    const cum = cumulativeDistancesM(coords);
    const total = cum[cum.length - 1];
    const fracs = [0.02, 0.3, 0.55, 0.82, 0.97];
    const trailPois = fracs.map((f, i) => {
      const p = pointAtDistance(coords, total * f, cum);
      return { id: `l${i}`, seq: i + 1, name: `L${i}`, kind: "viewpoint" as const, lat: p.lat, lng: p.lng };
    });
    const it = buildItinerary({ ...outAndBack, routeType: "loop", geometry: { type: "LineString", coordinates: coords } }, trailPois, prefs(), NOW);
    expect(it.stops.map((s) => s.poiId)).toEqual(["l0", "l1", "l2", "l3", "l4"]);
    expect(it.stops[4].alongM).toBeGreaterThan(total * 0.9);
  });

  it("sets a turnaround time for out-and-back routes from the halfway ETA and the latest finish", () => {
    // moving 120 min; halfway at 60 + 3 dwell stops (all ≤ 2 km) = 75 min; total 135 min
    const relaxed = buildItinerary(outAndBack, pois, prefs({ startTime: "08:00" }), NOW, { latestFinishTime: "15:45" });
    expect(relaxed.turnaroundBy).toBe("09:45"); // 08:00 + 75 + 30 slack
    // tight daylight: latest 10:30 − return leg 60 − margin 30 = 09:00
    const tight = buildItinerary(outAndBack, pois, prefs({ startTime: "08:00" }), NOW, { latestFinishTime: "10:30" });
    expect(tight.turnaroundBy).toBe("09:00");
    expect(tight.notes.join(" ")).toMatch(/before the estimated halfway point/);
  });

  it("surfaces partial closures and never implies continuing into the closed section", () => {
    const reason = "Upper switchbacks closed for (fictional) trail maintenance. Turn around at the Signal Tower.";
    const open = buildItinerary(outAndBack, pois, prefs({ startTime: "08:00" }), NOW, { latestFinishTime: "15:45" });
    const it = buildItinerary(outAndBack, pois, prefs({ startTime: "08:00" }), NOW, { latestFinishTime: "15:45", partialClosures: [reason] });
    // the schedule itself is unchanged (a full-route estimate) …
    expect(it.turnaroundBy).toBe(open.turnaroundBy);
    expect(it.estimatedFinishTime).toBe(open.estimatedFinishTime);
    // … but the notes lead with the closure and say to follow it
    expect(it.notes[0]).toMatch(/^Estimates only/);
    expect(it.notes[1]).toBe(
      "Partial closure on your date: Upper switchbacks closed for (fictional) trail maintenance. Turn around at the Signal Tower. Follow the closure, even if that means turning around earlier than this itinerary shows; the times here are estimates for the full route.",
    );
    const text = it.notes.join(" ");
    expect(text).toMatch(/part of the route is closed on your date\. Turn around where the closure notice says, and by 09:45 at the latest/);
    expect(text).not.toMatch(/even if you have not reached it/);
    expect(open.notes.join(" ")).toMatch(/Turn around by 09:45 even if you have not reached it/);
    // loops get the closure note too (there is no turnaround to adjust)
    const loop = buildItinerary({ ...outAndBack, routeType: "loop" }, pois, prefs(), NOW, { partialClosures: ["Boardwalk section closed"] });
    expect(loop.notes).toContain(
      "Partial closure on your date: Boardwalk section closed. Follow the closure, even if that means turning around earlier than this itinerary shows; the times here are estimates for the full route.",
    );
  });

  it("names the planned month for the latest-finish note (not 'this month')", () => {
    const june = buildItinerary(outAndBack, pois, prefs({ plannedDate: "2027-06-15" }), NOW, { latestFinishTime: "20:15" });
    expect(june.notes.join(" ")).toMatch(/off the trail by 20:15: a conservative planning estimate for June, not an exact sunset time/);
    expect(june.notes.join(" ")).not.toMatch(/this month/);
  });

  it("omits turnaround for loops and notes shuttles for point-to-point", () => {
    const loop = buildItinerary({ ...outAndBack, routeType: "loop" }, pois, prefs(), NOW);
    expect(loop.turnaroundBy).toBeUndefined();
    const p2p = buildItinerary({ ...outAndBack, routeType: "point_to_point", permitRequired: true }, pois, prefs(), NOW);
    expect(p2p.notes.join(" ")).toMatch(/shuttle/);
    expect(p2p.notes.join(" ")).toMatch(/permit is required/);
  });

  it("falls back to evenly spaced stops when geometry is missing", () => {
    const it = buildItinerary({ ...outAndBack, geometry: null }, pois.slice(1), prefs(), NOW);
    expect(it.stops.map((s) => s.alongM)).toEqual([1000, 2000, 3000]);
  });

  it("general reminders scale with duration and exposure", () => {
    expect(reminderCadence(60, { terrain: ["forest"], elevationGainM: 50 })).toEqual({ hydrationEveryMin: 45, paceCheckEveryMin: 30 });
    expect(reminderCadence(150, { terrain: ["forest"], elevationGainM: 50 })).toEqual({ hydrationEveryMin: 40, paceCheckEveryMin: 45 });
    expect(reminderCadence(150, { terrain: ["ridge"], elevationGainM: 50 })).toEqual({ hydrationEveryMin: 30, paceCheckEveryMin: 45 });
    expect(reminderCadence(320, { terrain: ["forest"], elevationGainM: 50 })).toEqual({ hydrationEveryMin: 30, paceCheckEveryMin: 60 });
    const it = buildItinerary(outAndBack, pois, prefs(), NOW);
    expect(it.notes.join(" ")).toMatch(/not personalized medical advice/);
  });
});
