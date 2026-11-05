import "server-only";
import { withUser } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import type { Itinerary, TripPreferences, TripStatus } from "@/domain/types";

export interface TripRow {
  id: string;
  userId: string;
  regionId: string;
  trailId: string;
  status: TripStatus;
  plannedDate: string | null; // YYYY-MM-DD
  startTime: string | null; // HH:MM:SS
  partySize: number;
  preferences: Partial<TripPreferences>;
  recommendation: Record<string, unknown>;
  itinerary: Partial<Itinerary>;
  aiSummary: string | null;
  aiProvider: string | null;
  aiGeneratedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  trailName: string;
  trailSlug: string;
  trailIsDemo: boolean;
}

/**
 * Load a trip the user owns (RLS-enforced). Returns null when the trip does
 * not exist OR belongs to someone else — callers should respond 404 in both
 * cases so trip IDs cannot be probed.
 */
export async function getOwnedTrip(user: SessionUser, tripId: string): Promise<TripRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) return null;
  const [trip] = await withUser(
    user,
    (tx) => tx<TripRow[]>`
      select tr.id, tr.user_id, tr.region_id, tr.trail_id, tr.status, to_char(tr.planned_date, 'YYYY-MM-DD') as planned_date,
             to_char(tr.start_time, 'HH24:MI') as start_time, tr.party_size, tr.preferences, tr.recommendation, tr.itinerary,
             tr.ai_summary, tr.ai_provider, tr.ai_generated_at, tr.created_at, tr.updated_at,
             t.name as trail_name, t.slug as trail_slug, t.is_demo as trail_is_demo
      from public.trips tr join public.trails t on t.id = tr.trail_id
      where tr.id = ${tripId} and tr.user_id = ${user.id}`,
  );
  return trip ?? null;
}

export async function listOwnedTrips(user: SessionUser): Promise<TripRow[]> {
  return withUser(
    user,
    (tx) => tx<TripRow[]>`
      select tr.id, tr.user_id, tr.region_id, tr.trail_id, tr.status, to_char(tr.planned_date, 'YYYY-MM-DD') as planned_date,
             to_char(tr.start_time, 'HH24:MI') as start_time, tr.party_size, tr.preferences, tr.recommendation, tr.itinerary,
             tr.ai_summary, tr.ai_provider, tr.ai_generated_at, tr.created_at, tr.updated_at,
             t.name as trail_name, t.slug as trail_slug, t.is_demo as trail_is_demo
      from public.trips tr join public.trails t on t.id = tr.trail_id
      where tr.user_id = ${user.id}
      order by coalesce(tr.planned_date, tr.created_at::date) desc, tr.created_at desc`,
  );
}
