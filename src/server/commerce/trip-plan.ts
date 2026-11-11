import "server-only";
import { z } from "zod";
import { withAnon, withSystem, type JsonValue, type Tx } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { log } from "@/server/log";
import type { Region, TrailDetail } from "@/server/catalog/trails";
import type { TripRow } from "@/server/trips/queries";
import {
  closureVerdict,
  daylightProblem,
  planDiffersFromBooking,
  replanForBooking,
  type ClosureVerdict,
  type DayClosure,
  type ReplanResult,
} from "@/domain/booking";
import type { ItineraryPoi, ItineraryTrail } from "@/domain/itinerary";
import { DEFAULT_LATEST_FINISH_BY_MONTH } from "@/domain/recommendation";
import type { Itinerary, TripPreferences } from "@/domain/types";
import { templateSummary, TEMPLATE_PROVIDER_KEY } from "@/integrations/ai/template";
import { zonedTimeToUtc } from "@/lib/time";

/**
 * Keeps a trip consistent with what was actually booked.
 *
 * The checkout lets the customer pick a different date or group size than the
 * saved plan. Decision (documented):
 *  - Before payment, the checkout page and createCheckout evaluate the SELECTED
 *    date/group with the planner's own rules: a full closure on that day, or
 *    an estimated finish after the latest-finish estimate, refuses the date.
 *    The trip row is NOT changed while the booking is unpaid (an abandoned
 *    checkout must not rewrite the customer's saved plan); pages show the
 *    held date/group from the pending booking instead.
 *  - When the payment is confirmed (inside the webhook transaction), the trip
 *    is rewritten for the booked date, start time and group: planned_date,
 *    start_time, party_size, preferences, a REBUILT itinerary (same builder and
 *    latest-finish table as the planner), refreshed recommendation estimates,
 *    and — if the trip had one — a deterministic template summary (no model
 *    call inside a payment transaction). Every customer surface that reads the
 *    trip (itinerary, check-in defaults, Prepare, My trips, offline bundle,
 *    share page, permit reminders) then uses the booked values.
 */
const SYSTEM_ACTOR = { id: null, roles: ["system"] as string[] };

const latestFinishSchema = z.record(z.string(), z.record(z.string().regex(/^(1[0-2]|[1-9])$/), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)));

/** Operator-configurable latest-finish table (app_settings.latest_finish_by_month), else the built-in default. */
export async function loadLatestFinishTable(tx: Tx, regionSlug: string): Promise<Record<number, string>> {
  const [row] = await tx<{ value: unknown }[]>`select value from public.app_settings where key = 'latest_finish_by_month'`;
  const parsed = latestFinishSchema.safeParse(row?.value);
  const table = parsed.success ? parsed.data[regionSlug] : undefined;
  if (!table) return DEFAULT_LATEST_FINISH_BY_MONTH;
  const out: Record<number, string> = { ...DEFAULT_LATEST_FINISH_BY_MONTH };
  for (const [m, t] of Object.entries(table)) out[Number(m)] = t;
  return out;
}

function nextDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10);
}

/** Closures (active or scheduled) overlapping the region-local day. */
export async function closuresOnDay(tx: Tx, trailId: string, day: string, timeZone: string): Promise<ClosureVerdict> {
  const dayStart = zonedTimeToUtc(day, "00:00", timeZone);
  const dayEnd = zonedTimeToUtc(nextDay(day), "00:00", timeZone);
  const rows = await tx<DayClosure[]>`
    select severity, reason, starts_at, ends_at from public.trail_closures
    where trail_id = ${trailId} and starts_at < ${dayEnd}::timestamptz and (ends_at is null or ends_at > ${dayStart}::timestamptz)
    order by starts_at`;
  return closureVerdict(rows, day, timeZone);
}

/** Read-only variant for pages (public catalog data). */
export async function getClosuresOnDay(trailId: string, day: string, timeZone: string): Promise<ClosureVerdict> {
  return withAnon((tx) => closuresOnDay(tx, trailId, day, timeZone));
}

function itineraryTrailOf(t: Pick<TrailDetail, "id" | "name" | "distanceKm" | "elevationGainM" | "terrain" | "routeType" | "estimatedDurationMin" | "permitRequired" | "geometry">): ItineraryTrail {
  return {
    id: t.id,
    name: t.name,
    distanceKm: t.distanceKm,
    elevationGainM: t.elevationGainM,
    terrain: t.terrain,
    routeType: t.routeType,
    estimatedDurationMin: t.estimatedDurationMin,
    permitRequired: t.permitRequired,
    geometry: t.geometry,
  };
}

export interface SelectionPlan {
  /** The selection differs from what the saved plan was computed for. */
  changed: boolean;
  plan: ReplanResult;
  /** Set when the selection would finish after the latest-finish estimate (refused at checkout). */
  daylightError: string | null;
}

/**
 * Evaluate a date / group selected at checkout with the planner's rules.
 * The daylight rule is enforced only for selections that differ from the
 * saved plan: the planner already validated the saved date and group.
 */
export async function planForSelection(
  trip: Pick<TripRow, "plannedDate" | "partySize" | "startTime" | "itinerary" | "preferences">,
  trail: TrailDetail,
  region: Pick<Region, "slug">,
  sel: { hikeDate: string; partySize: number; startTime: string },
  now = new Date(),
): Promise<SelectionPlan> {
  const table = await withSystem((tx) => loadLatestFinishTable(tx, region.slug)).catch((err) => {
    log.warn("commerce.latest_finish_lookup_failed", { error: err instanceof Error ? err.message : String(err) });
    return DEFAULT_LATEST_FINISH_BY_MONTH;
  });
  const plan = replanForBooking({
    trail: itineraryTrailOf(trail),
    pois: trail.pois.map((p) => ({ id: p.id, name: p.name, kind: p.kind, lat: p.lat, lng: p.lng, seq: p.seq })),
    permits: trail.permits.map((p) => ({ name: p.name, leadTimeDays: p.leadTimeDays })),
    preferences: trip.preferences ?? {},
    hikeDate: sel.hikeDate,
    startTime: sel.startTime,
    partySize: sel.partySize,
    latestFinishByMonth: table,
    now,
  });
  const changed = planDiffersFromBooking(trip, sel);
  return { changed, plan, daylightError: changed ? daylightProblem(plan) : null };
}

interface TripForSync {
  id: string;
  status: string;
  plannedDate: string | null;
  startTime: string | null;
  partySize: number;
  preferences: Partial<TripPreferences> | null;
  recommendation: Record<string, unknown> | null;
  itinerary: Partial<Itinerary> | null;
  aiSummary: string | null;
  regionSlug: string;
  timezone: string;
}

interface TrailForSync extends ItineraryTrail {
  isDemo: boolean;
}

/**
 * Rewrite the trip for the booked date / start time / group. Call inside the
 * confirming transaction (withSystem) — the booking has already been matched
 * to its owner by the payment processor. Returns true when the trip changed.
 */
export async function syncTripToBooking(
  tx: Tx,
  b: { id: string; tripId: string; trailId: string; hikeDate: string; partySize: number },
  now = new Date(),
): Promise<boolean> {
  const [trip] = await tx<TripForSync[]>`
    select tr.id, tr.status, to_char(tr.planned_date, 'YYYY-MM-DD') as planned_date, to_char(tr.start_time, 'HH24:MI') as start_time,
           tr.party_size, tr.preferences, tr.recommendation, tr.itinerary, tr.ai_summary, r.slug as region_slug, r.timezone
    from public.trips tr join public.regions r on r.id = tr.region_id
    where tr.id = ${b.tripId}
    for update of tr`;
  if (!trip || !["saved", "booked"].includes(trip.status)) return false;
  const [bk] = await tx<{ startTime: string | null }[]>`select price_breakdown ->> 'startTime' as start_time from public.bookings where id = ${b.id}`;
  const rawStart = bk?.startTime ?? trip.startTime ?? trip.itinerary?.startTime ?? trip.preferences?.startTime ?? "08:00";
  const startTime = /^\d{2}:\d{2}/.test(rawStart) ? rawStart.slice(0, 5) : "08:00";
  if (!planDiffersFromBooking(trip, { hikeDate: b.hikeDate, partySize: b.partySize, startTime })) return false;

  const [trail] = await tx<TrailForSync[]>`
    select id, name, is_demo, distance_km, elevation_gain_m, terrain, route_type, estimated_duration_min, permit_required, geometry
    from public.trails where id = ${b.trailId}`;
  if (!trail) return false;
  const [pois, permits, table, closures] = await Promise.all([
    tx<ItineraryPoi[]>`select id, seq, name, kind, lat, lng from public.trail_pois where trail_id = ${b.trailId} order by seq`,
    tx<{ name: string; leadTimeDays: number | null }[]>`select name, lead_time_days from public.permit_requirements where trail_id = ${b.trailId} order by name`,
    loadLatestFinishTable(tx, trip.regionSlug),
    closuresOnDay(tx, b.trailId, b.hikeDate, trip.timezone),
  ]);
  const partialClosures = closures.notices.filter((c) => c.severity === "partial").map((c) => c.reason);

  const plan = replanForBooking({
    trail,
    pois,
    permits,
    preferences: trip.preferences ?? {},
    hikeDate: b.hikeDate,
    startTime,
    partySize: b.partySize,
    latestFinishByMonth: table,
    partialClosures,
    now,
  });
  const it = plan.itinerary;
  const recommendation = {
    ...(trip.recommendation ?? {}),
    estimatedDurationMin: it.estimatedDurationMin,
    estimatedFinishTime: it.estimatedFinishTime,
    paceFactor: it.paceFactor,
    latestFinishEstimate: plan.latestFinishTime,
    replannedFor: { bookingId: b.id, hikeDate: b.hikeDate, partySize: b.partySize, startTime, at: now.toISOString() },
    replanNote: "Estimates recomputed for the booked date and group. The score and reasons describe the original plan.",
  };
  const trailheadIds = new Set(pois.filter((p) => p.kind === "trailhead").map((p) => p.id));
  // Deterministic template text from the rebuilt itinerary: the old summary
  // named the old date and times. No model is called in a payment transaction.
  const summary = trip.aiSummary
    ? templateSummary({
        trailId: trail.id,
        trailName: trail.name,
        isDemo: trail.isDemo,
        plannedDate: it.plannedDate,
        startTime: it.startTime,
        estimatedFinishTime: it.estimatedFinishTime,
        estimatedDurationMin: it.estimatedDurationMin,
        turnaroundBy: it.turnaroundBy,
        stops: it.stops.filter((s) => !trailheadIds.has(s.poiId)).map((s) => ({ name: s.name, etaOffsetMin: s.etaOffsetMin })),
        reminders: it.reminders,
        partialClosures,
      })
    : null;

  await tx`
    update public.trips set
      planned_date = ${b.hikeDate}::date,
      start_time = ${startTime}::time,
      party_size = ${b.partySize},
      preferences = ${tx.json(plan.preferences as unknown as JsonValue)},
      itinerary = ${tx.json(it as unknown as JsonValue)},
      recommendation = ${tx.json(recommendation as unknown as JsonValue)}
      ${summary ? tx`, ai_summary = ${summary}, ai_provider = ${TEMPLATE_PROVIDER_KEY}, ai_generated_at = ${now}::timestamptz` : tx``}
    where id = ${trip.id}`;
  await recordAudit(tx, SYSTEM_ACTOR, "trip.replanned_for_booking", "trip", trip.id, {
    bookingId: b.id,
    from: { plannedDate: trip.plannedDate, partySize: trip.partySize, startTime: trip.startTime },
    to: { plannedDate: b.hikeDate, partySize: b.partySize, startTime },
    finishesAfterLatest: plan.finishesAfterLatest,
  });
  return true;
}
