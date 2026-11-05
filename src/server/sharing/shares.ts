import "server-only";
import { z } from "zod";
import { withSystem, withUser } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { randomToken, sha256 } from "@/server/auth/tokens";
import { checkRateLimit } from "@/server/rate-limit";
import { isEnabled } from "@/server/flags";
import { env } from "@/config/env";
import { getOwnedTrip } from "@/server/trips/queries";
import { classifyLocation, type LocationFreshness } from "@/domain/staleness";
import { describeCheckinForShare, isOpen } from "@/domain/checkin";
import { firstNameOf } from "@/domain/notification-messages";
import type { CheckinStatus } from "@/domain/types";
import { getSafetySettings } from "@/server/checkins/settings";

/**
 * Expiring, revocable trip-share links. The random token is returned ONCE
 * at creation; only its SHA-256 hash is stored, so a database leak does not
 * reveal working links. Management is owner-only (getOwnedTrip + RLS on
 * trip_shares). Public resolution is a trusted lookup by token hash that
 * returns a deliberately small, neutral view (no contact details; last
 * location only if the owner opted in for that link).
 */
export const SHARE_DURATIONS_HOURS = [6, 24, 72] as const;
export const MAX_ACTIVE_SHARES_PER_TRIP = 5;
const SHARE_TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

export type ShareResult = { ok: true; token: string; url: string; expiresAt: Date; shareId: string } | { ok: false; error: string; notFound?: boolean };

export interface ShareView {
  id: string;
  includeLastLocation: boolean;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  active: boolean;
}

export const shareUrl = (token: string) => `${env().NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/share/${token}`;

const createSchema = z.object({
  hours: z.coerce.number().refine((h) => (SHARE_DURATIONS_HOURS as readonly number[]).includes(h), "Choose 6, 24 or 72 hours."),
  includeLastLocation: z.boolean(),
});

export async function createShare(user: SessionUser, tripId: string, hours: number, includeLastLocation: boolean, now = new Date()): Promise<ShareResult> {
  const trip = z.uuid().safeParse(tripId).success ? await getOwnedTrip(user, tripId) : null;
  if (!trip) return { ok: false, error: "Trip not found.", notFound: true };
  if (!(await isEnabled("trip_sharing"))) return { ok: false, error: "Trip sharing is not available right now." };
  const parsed = createSchema.safeParse({ hours, includeLastLocation });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Choose how long the link should work." };
  if (trip.status === "cancelled" || trip.status === "saved") return { ok: false, error: "You can share booked or active trips only." };
  const limit = await checkRateLimit(`share:create:user:${user.id}`, 10, 3600);
  if (!limit.allowed) return { ok: false, error: "You've created a lot of links recently. Please try again later." };

  const token = randomToken(24);
  const expiresAt = new Date(now.getTime() + parsed.data.hours * 3_600_000);
  return withUser(user, async (tx) => {
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from public.trip_shares
      where trip_id = ${trip.id} and created_by = ${user.id} and revoked_at is null and expires_at > ${now}::timestamptz`;
    if (n >= MAX_ACTIVE_SHARES_PER_TRIP) {
      return { ok: false as const, error: `You can have up to ${MAX_ACTIVE_SHARES_PER_TRIP} active links per trip. Turn one off first.` };
    }
    const [row] = await tx<{ id: string }[]>`
      insert into public.trip_shares (trip_id, created_by, token_hash, include_last_location, expires_at)
      values (${trip.id}, ${user.id}, ${sha256(token)}, ${parsed.data.includeLastLocation}, ${expiresAt}::timestamptz)
      returning id`;
    return { ok: true as const, token, url: shareUrl(token), expiresAt, shareId: row.id };
  });
}

export async function listShares(user: SessionUser, tripId: string, now = new Date()): Promise<ShareView[]> {
  if (!z.uuid().safeParse(tripId).success) return [];
  const rows = await withUser(
    user,
    (tx) => tx<Omit<ShareView, "active">[]>`
      select id, include_last_location, expires_at, revoked_at, created_at from public.trip_shares
      where trip_id = ${tripId} and created_by = ${user.id}
      order by created_at desc limit 20`,
  );
  return rows.map((r) => ({ ...r, active: !r.revokedAt && r.expiresAt.getTime() > now.getTime() }));
}

export async function revokeShare(user: SessionUser, tripId: string, shareId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!z.uuid().safeParse(tripId).success || !z.uuid().safeParse(shareId).success) return { ok: false, error: "Link not found." };
  const rows = await withUser(
    user,
    (tx) => tx`
      update public.trip_shares set revoked_at = coalesce(revoked_at, now())
      where id = ${shareId} and trip_id = ${tripId} and created_by = ${user.id}
      returning id`,
  );
  return rows.length ? { ok: true } : { ok: false, error: "Link not found." };
}

export interface SharedTripView {
  trailId: string;
  hikerFirstName: string | null;
  trailName: string;
  trailIsDemo: boolean;
  regionName: string;
  timeZone: string;
  emergencyNumber: string;
  plannedDate: string | null;
  checkinStatus: CheckinStatus | null;
  expectedReturnAt: Date | null;
  statusText: string;
  /** whether the owner chose to include their last location in this link */
  locationIncluded: boolean;
  location: { lat: number; lng: number; accuracyM: number | null; recordedAt: Date; freshness: LocationFreshness; label: string } | null;
  /** why no location is shown (when included but unavailable) */
  locationNote: string | null;
  expiresAt: Date;
}

/** Resolve a share token. Null for unknown, expired or revoked links (indistinguishable to the caller). */
export async function resolveShare(token: string, now = new Date()): Promise<SharedTripView | null> {
  if (typeof token !== "string" || !SHARE_TOKEN.test(token)) return null;
  const hash = sha256(token);
  return withSystem(async (tx) => {
    const [s] = await tx<
      {
        tripId: string;
        trailId: string;
        includeLastLocation: boolean;
        expiresAt: Date;
        revokedAt: Date | null;
        tripStatus: string;
        plannedDate: string | null;
        trailName: string;
        trailIsDemo: boolean;
        regionName: string;
        timezone: string;
        emergencyNumber: string;
        fullName: string | null;
      }[]
    >`
      select sh.trip_id, tr.trail_id, sh.include_last_location, sh.expires_at, sh.revoked_at, tr.status as trip_status,
             to_char(tr.planned_date, 'YYYY-MM-DD') as planned_date, t.name as trail_name, t.is_demo as trail_is_demo,
             r.name as region_name, r.timezone, r.emergency_number, p.full_name
      from public.trip_shares sh
      join public.trips tr on tr.id = sh.trip_id and tr.user_id = sh.created_by
      join public.trails t on t.id = tr.trail_id
      join public.regions r on r.id = tr.region_id
      left join public.profiles p on p.id = tr.user_id
      where sh.token_hash = ${hash}`;
    if (!s || s.revokedAt || s.expiresAt.getTime() <= now.getTime() || s.tripStatus === "cancelled") return null;

    const [c] = await tx<{ status: CheckinStatus; expectedReturnAt: Date; lastOkAt: Date | null; completedAt: Date | null }[]>`
      select status, expected_return_at, last_ok_at, completed_at from public.trip_checkins where trip_id = ${s.tripId}`;
    const checkin = c && c.status !== "cancelled" ? c : null;

    let location: SharedTripView["location"] = null;
    let locationNote: string | null = null;
    if (s.includeLastLocation) {
      const [session] = await tx<{ status: string }[]>`
        select status from public.hike_sessions where trip_id = ${s.tripId} order by started_at desc limit 1`;
      const hikeOngoing = session?.status === "active" || session?.status === "paused" || (checkin ? isOpen(checkin.status) : false);
      if (!hikeOngoing) {
        locationNote = session ? "The hike has ended, so location is no longer shown." : "No location has been reported yet.";
      } else {
        const [loc] = await tx<{ lat: number; lng: number; accuracyM: number | null; recordedAt: Date }[]>`
          select hll.lat, hll.lng, hll.accuracy_m, hll.recorded_at
          from public.hike_last_locations hll join public.hike_sessions hs on hs.id = hll.hike_session_id
          where hs.trip_id = ${s.tripId} order by hll.recorded_at desc limit 1`;
        if (loc) {
          const { staleLocationMinutes } = await getSafetySettings(tx);
          const age = classifyLocation(loc.recordedAt, now, staleLocationMinutes);
          location = { ...loc, freshness: age.state, label: age.label };
        } else {
          locationNote = "No location has been reported yet.";
        }
      }
    }
    return {
      trailId: s.trailId,
      hikerFirstName: firstNameOf(s.fullName),
      trailName: s.trailName,
      trailIsDemo: s.trailIsDemo,
      regionName: s.regionName,
      timeZone: s.timezone,
      emergencyNumber: s.emergencyNumber,
      plannedDate: s.plannedDate,
      checkinStatus: checkin?.status ?? null,
      expectedReturnAt: checkin && checkin.status !== "completed" ? checkin.expectedReturnAt : null,
      statusText: describeCheckinForShare(checkin, s.timezone),
      locationIncluded: s.includeLastLocation,
      location,
      locationNote,
      expiresAt: s.expiresAt,
    };
  });
}

/**
 * Public lookup with rate limiting (per client key, e.g. IP), so tokens
 * cannot be brute-forced. Returns `rateLimited` instead of a view when over.
 */
export async function lookupShare(token: string, clientKey: string, now = new Date()): Promise<{ rateLimited: true } | { rateLimited: false; view: SharedTripView | null }> {
  const limit = await checkRateLimit(`share:lookup:${sha256(clientKey).slice(0, 32)}`, 60, 60);
  if (!limit.allowed) return { rateLimited: true };
  return { rateLimited: false, view: await resolveShare(token, now) };
}
