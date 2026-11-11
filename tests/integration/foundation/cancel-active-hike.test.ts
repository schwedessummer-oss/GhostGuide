import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { closeDb, sql, withSystem } from "@/server/db";
import { enqueueJob } from "@/server/jobs/queue";
import { staffCancelBooking } from "@/server/commerce/staff-actions";
import { createCustomer, daysFromNow, demoUser, trailBySlug } from "../../helpers/db";

afterAll(closeDb);

/**
 * Regression (review SAFETY-2): staff cancelling a booking while the hike is
 * in progress must not switch off the hiker's check-in or its overdue job.
 */
describe("cancelling a booking during an active hike", () => {
  it("keeps the check-in and its queued overdue job", async () => {
    const admin = await demoUser("admin");
    const hiker = await createCustomer("activehike");
    const trail = await trailBySlug("lantern-creek-loop");
    const { tripId, bookingId, checkinId } = await withSystem(async (tx) => {
      const [trip] = await tx<{ id: string }[]>`
        insert into public.trips (user_id, region_id, trail_id, status, planned_date, start_time, party_size)
        values (${hiker.id}, ${trail.regionId}, ${trail.id}, 'active', ${daysFromNow(0)}::date, '08:00', 1) returning id`;
      const [booking] = await tx<{ id: string }[]>`
        insert into public.bookings (user_id, trip_id, trail_id, hike_date, party_size, status, subtotal_cents, total_cents,
                                     payment_provider, idempotency_key, paid_at)
        values (${hiker.id}, ${trip.id}, ${trail.id}, ${daysFromNow(0)}::date, 1, 'confirmed', 1900, 1900, 'demo', ${randomUUID()}, now())
        returning id`;
      const [checkin] = await tx<{ id: string }[]>`
        insert into public.trip_checkins (trip_id, user_id, expected_return_at, status)
        values (${trip.id}, ${hiker.id}, now() + interval '3 hours', 'active') returning id`;
      await tx`insert into public.hike_sessions (trip_id, user_id, status) values (${trip.id}, ${hiker.id}, 'active')`;
      return { tripId: trip.id, bookingId: booking.id, checkinId: checkin.id };
    });
    await enqueueJob(null, "checkins.overdue", { checkinId, version: 1 }, {
      dedupKey: `checkin:${checkinId}:v1:overdue`,
      runAt: new Date(Date.now() + 4 * 3600_000),
    });

    const res = await staffCancelBooking(admin, bookingId, "Customer asked by phone (test)");
    expect(res.ok).toBe(true);

    const [trip] = await sql()<{ status: string }[]>`select status from public.trips where id = ${tripId}`;
    expect(trip.status).toBe("active");
    const [checkin] = await sql()<{ status: string }[]>`select status from public.trip_checkins where id = ${checkinId}`;
    expect(checkin.status).toBe("active");
    const [job] = await sql()<{ status: string }[]>`select status from public.jobs where dedup_key = ${`checkin:${checkinId}:v1:overdue`}`;
    expect(job.status).toBe("queued");
  });
});
