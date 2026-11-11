import "server-only";
import { withSystem, withUser } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { getOwnedTrip, type TripRow } from "@/server/trips/queries";
import { activeElapsedMs, pausesFromEvents } from "@/domain/progress";
import type { FulfillmentStatus } from "@/domain/types";
import { closureVerdict } from "@/domain/booking";
import type { BundleClosure, BundleLogistics } from "@/lib/offline/wire";
import { SESSION_COLUMNS, bookedDateFor, tripClosures, type SessionRow } from "./sessions";
import { getTripLogistics } from "./logistics";

/**
 * Read models for the hike slice's pages and the HikeActionsCard. All run
 * as the user (RLS) and also filter on user_id; a trip the user does not own
 * yields null so callers respond 404.
 */
export interface DownloadRecord {
  createdAt: Date;
  verifiedComplete: boolean;
  itemCount: number;
}

export interface HikeOverview {
  trip: TripRow;
  openSession: SessionRow | null;
  latestSession: SessionRow | null;
  lastDownload: DownloadRecord | null;
  feedback: { rating: number; comments: string | null; issues: string[]; createdAt: Date } | null;
  /** the booked hike date (region-local YYYY-MM-DD; live booking's date, else the planned date) and the region's time zone */
  booked: { bookedDate: string | null; timezone: string } | null;
}

export async function getHikeOverview(user: SessionUser, tripId: string): Promise<HikeOverview | null> {
  const trip = await getOwnedTrip(user, tripId);
  if (!trip) return null;
  return withUser(user, async (tx) => {
    const [sessions, downloads, feedback, booked] = await Promise.all([
      tx<SessionRow[]>`
        select ${SESSION_COLUMNS(tx)} from public.hike_sessions where trip_id = ${trip.id} and user_id = ${user.id}
        order by (status in ('active', 'paused')) desc, started_at desc limit 1`,
      tx<DownloadRecord[]>`
        select created_at, verified_complete, item_count from public.trip_downloads
        where trip_id = ${trip.id} and user_id = ${user.id} order by created_at desc limit 1`,
      tx<{ rating: number; comments: string | null; issues: string[]; createdAt: Date }[]>`
        select rating, comments, issues, created_at from public.trip_feedback where trip_id = ${trip.id} and user_id = ${user.id}`,
      bookedDateFor(tx, trip.id),
    ]);
    const latest = sessions[0] ?? null;
    return {
      trip,
      latestSession: latest,
      openSession: latest && (latest.status === "active" || latest.status === "paused") ? latest : null,
      lastDownload: downloads[0] ?? null,
      feedback: feedback[0] ?? null,
      booked,
    };
  });
}

export interface PermitView {
  requirementId: string;
  name: string;
  authority: string;
  officialUrl: string;
  requirementSummary: string;
  howToObtain: string;
  leadTimeDays: number | null;
  status: "not_started" | "applied" | "obtained" | "denied" | "not_required";
  confirmationRef: string | null;
}

export interface AddonReadiness {
  id: string;
  name: string;
  kind: string;
  status: FulfillmentStatus;
  simulated: boolean;
}

export interface PrepareView extends HikeOverview {
  permits: PermitView[];
  addons: AddonReadiness[];
  /** the booked hike date (region-local) and the region's time zone */
  bookedDate: string | null;
  timezone: string;
  /** closures active now or scheduled for the booked date (full closures first) */
  closures: BundleClosure[];
  /** a full closure on the booked date: the hike can't be started that day */
  closedOnBookedDate: BundleClosure | null;
  /** add-on details (locker, pickup, meals) and permits, as saved in the offline download */
  logistics: BundleLogistics;
}

export async function getPrepareView(user: SessionUser, tripId: string): Promise<PrepareView | null> {
  const overview = await getHikeOverview(user, tripId);
  if (!overview) return null;
  const { trip } = overview;
  const logistics = await getTripLogistics(user, trip);
  return withUser(user, async (tx) => {
    const when = await bookedDateFor(tx, trip.id);
    const timezone = when?.timezone ?? "UTC";
    const [permits, addons, closureRows] = await Promise.all([
      tx<PermitView[]>`
        select pr.id as requirement_id, pr.name, pr.authority, pr.official_url, pr.requirement_summary, pr.how_to_obtain, pr.lead_time_days,
               coalesce(tp.status, 'not_started') as status, tp.confirmation_ref
        from public.permit_requirements pr
        left join public.trip_permits tp on tp.permit_requirement_id = pr.id and tp.trip_id = ${trip.id}
        where pr.trail_id = ${trip.trailId}
        order by pr.name`,
      tx<AddonReadiness[]>`
        select f.id, a.name, f.provider_kind as kind, f.status, (f.provider_key = 'demo') as simulated
        from public.fulfillments f
        join public.bookings b on b.id = f.booking_id
        join public.booking_addons ba on ba.id = f.booking_addon_id
        join public.addons a on a.id = ba.addon_id
        where b.trip_id = ${trip.id} and b.user_id = ${user.id}
          and b.status in ('confirmed', 'cancellation_requested', 'needs_attention')
        order by a.name`,
      tripClosures(tx, trip.trailId, when),
    ]);
    const closures: BundleClosure[] = closureRows.map((c) => ({
      severity: c.severity,
      reason: c.reason,
      startsAt: c.startsAt.toISOString(),
      endsAt: c.endsAt?.toISOString() ?? null,
    }));
    const bookedDate = when?.bookedDate ?? null;
    const closed = bookedDate
      ? closureVerdict(
          closureRows.map((c) => ({ severity: c.severity as "closed" | "partial" | "advisory", reason: c.reason, startsAt: c.startsAt, endsAt: c.endsAt })),
          bookedDate,
          timezone,
        ).closed
      : null;
    const closedOnBookedDate = closed ? (closures.find((c) => c.severity === "closed" && c.reason === closed.reason) ?? null) : null;
    return { ...overview, permits, addons, bookedDate, timezone, closures, closedOnBookedDate, logistics };
  });
}

export interface CompletionSummary {
  distanceM: number;
  movingTimeSec: number | null;
  stopsHeard: { poiId: string; name: string }[];
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface CompletionView extends HikeOverview {
  summary: CompletionSummary | null;
}

export async function getCompletionView(user: SessionUser, tripId: string): Promise<CompletionView | null> {
  const overview = await getHikeOverview(user, tripId);
  if (!overview) return null;
  const session = overview.latestSession;
  if (!session) return { ...overview, summary: null };
  return withUser(user, async (tx) => {
    const events = await tx<{ kind: string; occurredAt: Date; poiId: string | null }[]>`
      select kind, occurred_at, payload ->> 'poiId' as poi_id from public.hike_events
      where hike_session_id = ${session.id} and user_id = ${user.id}
        and kind in ('pause', 'resume', 'poi_triggered', 'poi_replayed')
      order by occurred_at`;
    const poiIds = [...new Set(events.filter((e) => e.poiId && (e.kind === "poi_triggered" || e.kind === "poi_replayed")).map((e) => e.poiId!))];
    const names = poiIds.length
      ? await tx<{ id: string; name: string }[]>`select id, name from public.trail_pois where id = any(${poiIds}::uuid[])`
      : [];
    const pauses = pausesFromEvents(events.map((e) => ({ kind: e.kind, at: e.occurredAt.getTime() })));
    const end = session.finishedAt ?? null;
    const movingMs = end ? activeElapsedMs(session.startedAt.getTime(), pauses, end.getTime(), end.getTime()) : null;
    return {
      ...overview,
      summary: {
        distanceM: session.distanceCompletedM,
        movingTimeSec: movingMs === null ? null : Math.round(movingMs / 1000),
        stopsHeard: poiIds.map((id) => ({ poiId: id, name: names.find((n) => n.id === id)?.name ?? "Stop" })),
        startedAt: session.startedAt,
        finishedAt: session.finishedAt,
      },
    };
  });
}

export interface ServerLastLocation {
  lat: number;
  lng: number;
  accuracyM: number | null;
  recordedAt: Date;
  receivedAt: Date;
}

/** The last location the SERVER received for this trip's latest session (help-screen fallback). */
export async function getServerLastLocation(user: SessionUser, tripId: string): Promise<ServerLastLocation | null> {
  const trip = await getOwnedTrip(user, tripId);
  if (!trip) return null;
  const [row] = await withUser(
    user,
    (tx) => tx<ServerLastLocation[]>`
      select l.lat, l.lng, l.accuracy_m, l.recorded_at, l.received_at
      from public.hike_last_locations l join public.hike_sessions s on s.id = l.hike_session_id
      where s.trip_id = ${trip.id} and l.user_id = ${user.id}
      order by l.recorded_at desc limit 1`,
  );
  return row ?? null;
}

/** Minutes after which a last-known location is labelled stale (admin setting; default 15). */
export async function getStaleLocationMinutes(): Promise<number> {
  const [row] = await withSystem((tx) => tx<{ value: unknown }[]>`select value from public.app_settings where key = 'stale_location_minutes'`);
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : 15;
}
