import { afterAll, describe, expect, it } from "vitest";
import { closeDb, sql } from "@/server/db";
import { getOwnedTrip } from "@/server/trips/queries";
import { getCheckinDefaults } from "@/server/checkins/manage";
import { getTripBookingView, listTripBookingSummaries } from "@/server/commerce/queries";
import { replanForBooking } from "@/domain/booking";
import { localDateInZone, localTimeInZone } from "@/lib/time";
import { createCustomer } from "../../helpers/db";
import { booking, checkoutFor, freshDateInMonth, payAndDeliver, savedTrip, TZ, upcomingMonth } from "./helpers";

afterAll(closeDb);

const PREFS = {
  experience: "some",
  fitness: "moderate",
  preferredTerrain: [],
  pace: "steady",
  availableHours: 6,
  accessibilityNeeds: [],
  equipment: [],
  startTime: "08:30",
};

/** A trip saved the way the planner saves it: answers, itinerary and summary for the planned day. */
async function plannerTrip(label: string, plannedDate: string, partySize = 2) {
  const user = await createCustomer(label);
  const [lc] = await sql()<
    { id: string; name: string; distanceKm: number; elevationGainM: number; terrain: string[]; routeType: "loop"; estimatedDurationMin: number; permitRequired: boolean; geometry: null }[]
  >`select id, name, distance_km, elevation_gain_m, terrain, route_type, estimated_duration_min, permit_required, geometry
    from public.trails where slug = 'lantern-creek-loop'`;
  const pois = await sql()<{ id: string; name: string; kind: "trailhead"; lat: number; lng: number; seq: number }[]>`
    select id, name, kind, lat, lng, seq from public.trail_pois where trail_id = ${lc.id} order by seq`;
  const plan = replanForBooking({
    trail: lc,
    pois,
    permits: [],
    preferences: { ...PREFS, plannedDate, partySize } as never,
    hikeDate: plannedDate,
    startTime: "08:30",
    partySize,
    now: new Date("2026-11-01T00:00:00Z"),
  });
  const trip = await savedTrip(user, {
    plannedDate,
    partySize,
    startTime: "08:30",
    preferences: { ...PREFS, plannedDate, partySize },
    itinerary: plan.itinerary as unknown as Record<string, unknown>,
    aiSummary: `Start Lantern Creek Loop at 08:30 on ${plannedDate}. Template summary.`,
  });
  return { user, trip, plan };
}

async function tripRow(id: string) {
  const [t] = await sql()<
    {
      plannedDate: string;
      startTime: string;
      partySize: number;
      status: string;
      itinerary: { plannedDate: string; paceFactor: number; notes: string[]; generatedAt: string; estimatedFinishTime: string };
      preferences: Record<string, unknown>;
      recommendation: Record<string, unknown>;
      aiSummary: string | null;
      aiProvider: string | null;
    }[]
  >`select to_char(planned_date, 'YYYY-MM-DD') as planned_date, to_char(start_time, 'HH24:MI') as start_time, party_size, status,
           itinerary, preferences, recommendation, ai_summary, ai_provider
    from public.trips where id = ${id}`;
  return t;
}

describe("booking a different date or group than the saved plan", () => {
  it("keeps the saved plan while unpaid, then rewrites the trip for the booked date and group on confirmation", async () => {
    const june = await freshDateInMonth(upcomingMonth(6));
    const december = await freshDateInMonth(upcomingMonth(12));
    const { user, trip } = await plannerTrip("rebook", june, 2);
    const before = await tripRow(trip.id);
    expect(before.itinerary.notes.join(" ")).toContain("Plan to be off the trail by 20:15");

    const r = await checkoutFor(user, trip, { hikeDate: december, partySize: 4 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Unpaid: the saved plan is untouched, but every customer view reports the HELD date and group.
    expect(await tripRow(trip.id)).toEqual(before);
    const summaries = await listTripBookingSummaries(user);
    expect(summaries[trip.id]).toMatchObject({ hikeDate: december, partySize: 4, live: true, status: "pending_payment" });

    const b = await booking(r.bookingId);
    const res = await payAndDeliver(b.checkoutSessionId!);
    expect(res.body.outcome).toBe("confirmed");

    const after = await tripRow(trip.id);
    expect(after.status).toBe("booked");
    expect(after.plannedDate).toBe(december);
    expect(after.partySize).toBe(4);
    expect(after.startTime).toBe("08:30");
    // Rebuilt itinerary: booked day, group pace factor, December's latest-finish estimate.
    expect(after.itinerary.plannedDate).toBe(december);
    expect(after.itinerary.paceFactor).toBe(1.05);
    expect(after.itinerary.notes.join(" ")).toContain("Plan to be off the trail by 15:45");
    expect(after.itinerary.notes.join(" ")).not.toContain("20:15");
    // Saved answers are kept; only date / start / group change.
    expect(after.preferences).toMatchObject({ pace: "steady", fitness: "moderate", availableHours: 6, plannedDate: december, partySize: 4 });
    expect(after.recommendation).toMatchObject({ latestFinishEstimate: "15:45", replannedFor: { bookingId: r.bookingId, hikeDate: december, partySize: 4 } });
    // The summary no longer names the old date; it is labeled as template text.
    expect(after.aiSummary).toContain(december);
    expect(after.aiSummary).not.toContain(june);
    expect(after.aiProvider).toBe("demo-template");

    // Customer surfaces that read the trip now agree with the booking.
    const owned = await getOwnedTrip(user, trip.id);
    expect(owned).toMatchObject({ plannedDate: december, partySize: 4 });
    const defaults = await getCheckinDefaults(owned!);
    expect(defaults.expectedReturnAt).not.toBeNull();
    expect(localDateInZone(defaults.expectedReturnAt!, TZ)).toBe(december);
    expect(localTimeInZone(defaults.expectedReturnAt!, TZ) <= "15:45").toBe(true);
    const view = await getTripBookingView(user, trip.id);
    expect(view?.booking).toMatchObject({ hikeDate: december, partySize: 4, status: "confirmed" });

    const audit = await sql()`select metadata from public.audit_logs where action = 'trip.replanned_for_booking' and entity_id = ${trip.id}`;
    expect(audit).toHaveLength(1);
  });

  it("leaves the planner's itinerary alone when the booked date and group match the plan", async () => {
    const june = await freshDateInMonth(upcomingMonth(6));
    const { user, trip } = await plannerTrip("same", june, 2);
    const before = await tripRow(trip.id);
    const r = await checkoutFor(user, trip, { hikeDate: june, partySize: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = await payAndDeliver((await booking(r.bookingId)).checkoutSessionId!);
    expect(res.body.outcome).toBe("confirmed");
    const after = await tripRow(trip.id);
    expect(after.status).toBe("booked");
    expect(after.itinerary).toEqual(before.itinerary);
    expect(after.aiSummary).toBe(before.aiSummary);
    expect(await sql()`select 1 from public.audit_logs where action = 'trip.replanned_for_booking' and entity_id = ${trip.id}`).toHaveLength(0);
  });

  it("refuses a changed date or group that would finish after the latest-finish estimate (the planner's daylight rule)", async () => {
    const june = await freshDateInMonth(upcomingMonth(6));
    const december = await freshDateInMonth(upcomingMonth(12));
    const user = await createCustomer("daylight");
    // Old Signal Summit (~5 h estimate) starting at 11:00: fine in June, after dark in December.
    const trip = await savedTrip(user, { trail: "old-signal-summit", plannedDate: june, startTime: "11:00", partySize: 2 });
    const refused = await checkoutFor(user, trip, { hikeDate: december, partySize: 2 });
    expect(refused).toMatchObject({ ok: false, code: "unavailable" });
    if (!refused.ok) expect(refused.error).toMatch(/after the conservative latest-finish estimate for December \(15:45\)/);
    expect(await sql()`select id from public.bookings where trip_id = ${trip.id}`).toHaveLength(0);
    // The saved (planner-validated) date is still bookable.
    expect((await checkoutFor(user, trip, { hikeDate: june, partySize: 2 })).ok).toBe(true);
  });
});
