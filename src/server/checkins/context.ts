import "server-only";
import type { Tx } from "@/server/db";
import { firstNameOf, type LastLocation } from "@/domain/notification-messages";

/** Everything needed to word a check-in notice (trusted server reads). */
export interface NoticeContext {
  checkinId: string;
  tripId: string;
  userId: string;
  trailName: string;
  trailIsDemo: boolean;
  timeZone: string;
  emergencyNumber: string;
  hikerFirstName: string | null;
  /** profiles.share_location_with_contacts */
  shareLocation: boolean;
  /** the hiker's own reachable details (profile phone, profile/auth email) */
  phone: string | null;
  email: string | null;
}

export async function loadNoticeContext(tx: Tx, checkinId: string): Promise<NoticeContext | null> {
  const [row] = await tx<NoticeContext[]>`
    select c.id as checkin_id, c.trip_id, c.user_id, t.name as trail_name, t.is_demo as trail_is_demo,
           r.timezone as time_zone, r.emergency_number,
           p.full_name as hiker_first_name, coalesce(p.share_location_with_contacts, true) as share_location,
           p.phone, coalesce(nullif(p.email, ''), u.email) as email
    from public.trip_checkins c
    join public.trips tr on tr.id = c.trip_id
    join public.trails t on t.id = tr.trail_id
    join public.regions r on r.id = tr.region_id
    join auth.users u on u.id = c.user_id
    left join public.profiles p on p.id = c.user_id
    where c.id = ${checkinId}`;
  if (!row) return null;
  return { ...row, hikerFirstName: firstNameOf(row.hikerFirstName) };
}

/** The most recent last-known location reported during any hike session of this trip. */
export async function loadLastLocationForTrip(tx: Tx, tripId: string): Promise<LastLocation | null> {
  const [loc] = await tx<LastLocation[]>`
    select hll.lat, hll.lng, hll.accuracy_m, hll.recorded_at
    from public.hike_last_locations hll
    join public.hike_sessions s on s.id = hll.hike_session_id
    where s.trip_id = ${tripId}
    order by hll.recorded_at desc
    limit 1`;
  return loc ?? null;
}

export interface ContactRow {
  id: string;
  userId: string;
  name: string;
  phone: string | null;
  email: string | null;
  consentConfirmedAt: Date | null;
}

export async function loadContact(tx: Tx, contactId: string | null, userId: string): Promise<ContactRow | null> {
  if (!contactId) return null;
  const [c] = await tx<ContactRow[]>`
    select id, user_id, name, phone, email, consent_confirmed_at from public.emergency_contacts
    where id = ${contactId} and user_id = ${userId}`;
  return c ?? null;
}
