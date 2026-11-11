import { randomUUID } from "node:crypto";
import { withSystem } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import type { TripStatus } from "@/domain/types";
import type { SyncInput } from "@/server/hike/schemas";
import { trailBySlug } from "../../helpers/db";

/**
 * Insert a trip directly (as trusted test setup) in the given lifecycle status,
 * planned for the region's local "today" shifted by `dayOffset` days (a hike
 * can only start on its booked date in the region's time zone).
 */
export async function createTrip(user: SessionUser, status: TripStatus = "booked", slug = "lantern-creek-loop", dayOffset = 0): Promise<string> {
  const trail = await trailBySlug(slug);
  const [trip] = await withSystem(
    (tx) => tx<{ id: string }[]>`
      insert into public.trips (user_id, region_id, trail_id, status, planned_date, start_time, party_size, itinerary)
      select ${user.id}, r.id, ${trail.id}, ${status}, (now() at time zone r.timezone)::date + ${dayOffset}::int, '09:00'::time, 2,
             ${tx.json({ version: 1, reminders: { hydrationEveryMin: 30, paceCheckEveryMin: 45 }, estimatedDurationMin: 60 })}
      from public.regions r where r.id = ${trail.regionId}
      returning id`,
  );
  return trip.id;
}

/** Region-local calendar date (YYYY-MM-DD) shifted by `dayOffset` days. */
export async function regionDate(slug = "lantern-creek-loop", dayOffset = 0): Promise<string> {
  const trail = await trailBySlug(slug);
  const [r] = await withSystem(
    (tx) => tx<{ d: string }[]>`
      select to_char((now() at time zone timezone)::date + ${dayOffset}::int, 'YYYY-MM-DD') as d from public.regions where id = ${trail.regionId}`,
  );
  return r.d;
}

/** A confirmed booking for the trip on `hikeDate` (trusted test setup). */
export async function confirmBooking(user: SessionUser, tripId: string, hikeDate: string): Promise<void> {
  await withSystem(
    (tx) => tx`
      insert into public.bookings (user_id, trip_id, trail_id, hike_date, party_size, status, subtotal_cents, total_cents, payment_provider, idempotency_key, paid_at)
      select ${user.id}, t.id, t.trail_id, ${hikeDate}::date, t.party_size, 'confirmed', 1000, 1000, 'demo', ${randomUUID()}, now()
      from public.trips t where t.id = ${tripId}`,
  );
}

export const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

export function point(minutesAgo: number, lat = 47.5052, lng = -121.7021, id = randomUUID()) {
  return { id, lat, lng, accuracyM: 8, altitudeM: null, recordedAt: iso(-minutesAgo * 60_000) };
}

export function syncInput(sessionId: string, partial: Partial<SyncInput> = {}): SyncInput {
  return { sessionId, points: [], events: [], ...partial };
}
