import { randomUUID } from "node:crypto";
import { withSystem } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import type { TripStatus } from "@/domain/types";
import type { SyncInput } from "@/server/hike/schemas";
import { trailBySlug } from "../../helpers/db";

/** Insert a trip directly (as trusted test setup) in the given lifecycle status. */
export async function createTrip(user: SessionUser, status: TripStatus = "booked", slug = "lantern-creek-loop"): Promise<string> {
  const trail = await trailBySlug(slug);
  const [trip] = await withSystem(
    (tx) => tx<{ id: string }[]>`
      insert into public.trips (user_id, region_id, trail_id, status, planned_date, start_time, party_size, itinerary)
      values (${user.id}, ${trail.regionId}, ${trail.id}, ${status}, current_date, '09:00'::time, 2,
              ${tx.json({ version: 1, reminders: { hydrationEveryMin: 30, paceCheckEveryMin: 45 }, estimatedDurationMin: 60 })})
      returning id`,
  );
  return trip.id;
}

export const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

export function point(minutesAgo: number, lat = 47.5052, lng = -121.7021, id = randomUUID()) {
  return { id, lat, lng, accuracyM: 8, altitudeM: null, recordedAt: iso(-minutesAgo * 60_000) };
}

export function syncInput(sessionId: string, partial: Partial<SyncInput> = {}): SyncInput {
  return { sessionId, points: [], events: [], ...partial };
}
