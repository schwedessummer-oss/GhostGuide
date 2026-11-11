import { afterAll, describe, expect, it } from "vitest";
import { closeDb, sql, withUser } from "@/server/db";
import { saveTrip, SaveTripError } from "@/server/discover/save-trip";
import { planTrip } from "@/server/discover/plan";
import { parsePlanQuery, toPlanQuery } from "@/server/discover/preferences";
import { getOwnedTrip } from "@/server/trips/queries";
import type { Itinerary, TripPreferences } from "@/domain/types";
import { createCustomer, daysFromNow, trailBySlug } from "../../helpers/db";

afterAll(closeDb);

function prefs(overrides: Partial<TripPreferences> = {}): TripPreferences {
  return {
    experience: "some",
    fitness: "moderate",
    preferredTerrain: ["forest", "river"],
    pace: "steady",
    availableHours: 4,
    plannedDate: daysFromNow(10),
    startTime: "09:00",
    accessibilityNeeds: ["rest_stops"],
    partySize: 2,
    equipment: ["first_aid_kit"],
    bringingDog: false,
    ...overrides,
  };
}

describe("saveTrip", () => {
  it("persists a saved trip with RLS: the owner can read it, another customer cannot", async () => {
    const alice = await createCustomer("alice");
    const bob = await createCustomer("bob");
    const lantern = await trailBySlug("lantern-creek-loop");
    const p = prefs();

    const saved = await saveTrip(alice, p, lantern.id);
    const trip = await getOwnedTrip(alice, saved.tripId);
    expect(trip).not.toBeNull();
    expect(trip!.status).toBe("saved");
    expect(trip!.userId).toBe(alice.id);
    expect(trip!.regionId).toBe(lantern.regionId);
    expect(trip!.plannedDate).toBe(p.plannedDate);
    expect(trip!.startTime).toBe("09:00");
    expect(trip!.partySize).toBe(2);
    expect(trip!.preferences).toMatchObject({ experience: "some", accessibilityNeeds: ["rest_stops"] });

    const itinerary = trip!.itinerary as Itinerary;
    expect(itinerary.version).toBe(1);
    expect(itinerary.trailId).toBe(lantern.id);
    expect(itinerary.stops).toHaveLength(4);
    expect(itinerary.estimatedFinishTime).toMatch(/^\d{2}:\d{2}$/);

    // the stored score is the server's deterministic score for this trail
    const plan = await planTrip(p);
    const expected = plan.suggestions.find((s) => s.trail.id === lantern.id)!.result;
    expect(trip!.recommendation).toMatchObject({ version: 1, trailId: lantern.id, score: expected.score });
    expect(saved.score).toBe(expected.score);

    // AI text: display-only, labeled with its provider (template in tests)
    expect(trip!.aiProvider).toBe("demo-template");
    expect(trip!.aiSummary).toMatch(/Start Lantern Creek Loop at 09:00/);
    expect(trip!.aiGeneratedAt).toBeInstanceOf(Date);

    // RLS: Bob cannot see Alice's trip by any path
    expect(await getOwnedTrip(bob, saved.tripId)).toBeNull();
    expect(await withUser(bob, (tx) => tx`select id from public.trips where id = ${saved.tripId}`)).toHaveLength(0);

    // every AI call is recorded (simulated template here)
    const [ev] = await sql()<{ n: number }[]>`
      select count(*)::int as n from public.integration_events
      where provider_kind = 'ai' and operation = 'summarizeItinerary' and entity_id = ${lantern.id} and outcome = 'simulated'`;
    expect(ev.n).toBeGreaterThan(0);
  });

  it("persists the partial closure in the saved itinerary and summary", async () => {
    const fran = await createCustomer("fran");
    const signal = await trailBySlug("old-signal-summit");
    const p = prefs({ experience: "regular", fitness: "high", pace: "brisk", availableHours: 8, startTime: "07:00", accessibilityNeeds: [], preferredTerrain: [] });
    const saved = await saveTrip(fran, p, signal.id);
    const trip = await getOwnedTrip(fran, saved.tripId);
    const itinerary = trip!.itinerary as Itinerary;
    expect(itinerary.notes).toContainEqual(expect.stringMatching(/^Partial closure on your date: Upper switchbacks closed.*Turn around at the Signal Tower\. Follow the closure/));
    expect(itinerary.notes.join(" ")).not.toMatch(/even if you have not reached it/);
    // the same itinerary as the results page
    const plan = await planTrip(p);
    const shown = plan.suggestions.find((s) => s.trail.id === signal.id)!.itinerary;
    expect(itinerary.notes).toEqual(shown.notes);
    expect(trip!.aiSummary).toMatch(/partial closure on your date: follow the closure notice/);
    expect(trip!.aiSummary).not.toMatch(/even if you have not reached the far end/);
  });

  it("refuses a trail that the recommendation excludes for these preferences", async () => {
    const carol = await createCustomer("carol");
    const whisper = await trailBySlug("whisper-falls");
    const err = await saveTrip(carol, prefs({ bringingDog: true, accessibilityNeeds: [] }), whisper.id).catch((e) => e);
    expect(err).toBeInstanceOf(SaveTripError);
    expect((err as SaveTripError).code).toBe("excluded");
    expect((err as SaveTripError).reasons.join(" ")).toMatch(/Dogs are not allowed/);
    const rows = await withUser(carol, (tx) => tx`select id from public.trips`);
    expect(rows).toHaveLength(0);
  });

  it("refuses draft or unknown trails and past dates", async () => {
    const dan = await createCustomer("dan");
    const draft = await trailBySlug("cinder-spur-draft");
    await expect(saveTrip(dan, prefs(), draft.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(saveTrip(dan, prefs(), "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "not_found" });
    await expect(saveTrip(dan, prefs(), "not-a-uuid")).rejects.toMatchObject({ code: "not_found" });
    const lantern = await trailBySlug("lantern-creek-loop");
    await expect(saveTrip(dan, prefs({ plannedDate: daysFromNow(-3) }), lantern.id)).rejects.toMatchObject({ code: "date" });
    await expect(saveTrip(dan, { experience: "guru" }, lantern.id)).rejects.toMatchObject({ code: "invalid" });
  });

  it("ignores tampered client-side scores and recomputes server-side", async () => {
    const erin = await createCustomer("erin");
    const lantern = await trailBySlug("lantern-creek-loop");
    const honest = await saveTrip(erin, prefs(), lantern.id);

    const tampered = {
      ...prefs(),
      score: 999,
      recommendation: { score: 999, breakdown: [] },
      itinerary: { estimatedDurationMin: 1 },
    };
    const saved = await saveTrip(erin, tampered, lantern.id);
    const trip = await getOwnedTrip(erin, saved.tripId);
    expect((trip!.recommendation as { score: number }).score).toBe(honest.score);
    expect((trip!.recommendation as { score: number }).score).not.toBe(999);
    expect(trip!.preferences).not.toHaveProperty("score");
    expect(trip!.preferences).not.toHaveProperty("recommendation");
    expect((trip!.itinerary as Itinerary).estimatedDurationMin).toBeGreaterThan(1);

    // The form path (hidden query string + extra fields) also drops tampered values.
    const q = `${toPlanQuery(prefs())}&score=999&breakdown=hacked`;
    const parsed = parsePlanQuery(new URLSearchParams(q));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const viaForm = await saveTrip(erin, parsed.prefs, lantern.id);
      expect(viaForm.score).toBe(honest.score);
    }
  });
});
