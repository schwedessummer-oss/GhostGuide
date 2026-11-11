import "server-only";
import { z } from "zod";
import { withAnon, withSystem } from "@/server/db";
import { log } from "@/server/log";
import type { LineStringGeometry } from "@/domain/geo";
import type { Closure, Difficulty, RouteType } from "@/domain/types";
import type { CandidateTrail } from "@/domain/recommendation";
import { closureOverlapsDay, DEFAULT_LATEST_FINISH_BY_MONTH } from "@/domain/recommendation";
import type { ItineraryPoi, ItineraryTrail } from "@/domain/itinerary";
import { zonedTimeToUtc } from "@/lib/time";

/**
 * Discovery read model: candidate trails for the recommendation engine,
 * evaluated for a specific planned date (closures overlapping that day,
 * permits, POIs and remaining capacity).
 */
export interface PlanTrail extends ItineraryTrail {
  slug: string;
  regionId: string;
  isDemo: boolean;
  summary: string;
  difficulty: Difficulty;
  routeType: RouteType;
  basePriceCents: number;
  currency: string;
  trailheadName: string | null;
}

export interface CandidateBundle {
  candidates: CandidateTrail[];
  trails: Map<string, PlanTrail>;
  pois: Map<string, ItineraryPoi[]>;
  permitsByTrail: Map<string, { name: string; officialUrl: string; leadTimeDays: number | null }[]>;
}

interface TrailRow {
  id: string;
  regionId: string;
  slug: string;
  name: string;
  summary: string;
  isDemo: boolean;
  status: "draft" | "published" | "closed" | "archived";
  distanceKm: number;
  elevationGainM: number;
  difficulty: Difficulty;
  terrain: string[];
  routeType: RouteType;
  estimatedDurationMin: number;
  accessibilityFeatures: string[];
  dogsAllowed: boolean | null;
  permitRequired: boolean;
  dailyCapacity: number;
  geometry: LineStringGeometry | null;
  geometryValidatedAt: Date | null;
  basePriceCents: number;
  currency: string;
  trailheadName: string | null;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  return new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

/** Booking statuses that occupy capacity (pending checkouts only while their hold is live). */
const OCCUPYING = ["confirmed", "cancellation_requested", "needs_attention"];

export async function loadCandidates(
  scope: { regionId: string } | { trailId: string },
  plannedDate: string,
  timeZone: string,
): Promise<CandidateBundle> {
  const dayStart = zonedTimeToUtc(plannedDate, "00:00", timeZone);
  const dayEnd = zonedTimeToUtc(addDays(plannedDate, 1), "00:00", timeZone);

  // Public catalog via the anon role: RLS hides drafts/archived trails.
  const { trails, closures, permits, pois } = await withAnon(async (tx) => {
    const trails = await tx<TrailRow[]>`
      select t.id, t.region_id, t.slug, t.name, t.summary, t.is_demo, t.status, t.distance_km, t.elevation_gain_m,
             t.difficulty, t.terrain, t.route_type, t.estimated_duration_min, t.accessibility_features, t.dogs_allowed,
             t.permit_required, t.daily_capacity, t.geometry, t.geometry_validated_at, t.base_price_cents, t.currency,
             t.trailhead_name
      from public.trails t
      where t.status in ('published', 'closed')
        and ${"regionId" in scope ? tx`t.region_id = ${scope.regionId}` : tx`t.id = ${scope.trailId}`}
      order by t.name`;
    const ids = trails.map((t) => t.id);
    if (!ids.length) return { trails, closures: [], permits: [], pois: [] };
    const [closures, permits, pois] = await Promise.all([
      tx<(Closure & { trailId: string })[]>`
        select id, trail_id, severity, reason, source_id, starts_at, ends_at from public.trail_closures
        where trail_id = any(${ids}::uuid[])
          and starts_at < ${dayEnd}::timestamptz and (ends_at is null or ends_at > ${dayStart}::timestamptz)
        order by starts_at`,
      tx<{ trailId: string; name: string; officialUrl: string; leadTimeDays: number | null }[]>`
        select trail_id, name, official_url, lead_time_days from public.permit_requirements
        where trail_id = any(${ids}::uuid[]) order by name`,
      tx<(ItineraryPoi & { trailId: string })[]>`
        select id, trail_id, seq, name, kind, lat, lng from public.trail_pois
        where trail_id = any(${ids}::uuid[]) order by trail_id, seq`,
    ]);
    return { trails, closures, permits, pois };
  });

  // Remaining capacity is an aggregate over lifecycle rows (no customer data
  // leaves this function), read in trusted code. Checkout re-checks it.
  const capacity = new Map<string, number>();
  if (trails.length) {
    const ids = trails.map((t) => t.id);
    try {
      const rows = await withSystem(
        (tx) => tx<{ trailId: string; remaining: number }[]>`
          select t.id as trail_id,
                 case when coalesce(inv.blocked, false) then 0
                      else coalesce(inv.capacity, t.daily_capacity) - coalesce((
                        select sum(b.party_size) from public.bookings b
                        where b.trail_id = t.id and b.hike_date = ${plannedDate}::date
                          and (b.status = any(${OCCUPYING}::public.booking_status[])
                               or (b.status = 'pending_payment' and b.hold_expires_at > now()))
                      ), 0) end as remaining
          from public.trails t
          left join public.trail_day_inventory inv on inv.trail_id = t.id and inv.day = ${plannedDate}::date
          where t.id = any(${ids}::uuid[])`,
      );
      for (const r of rows) capacity.set(r.trailId, Number(r.remaining));
    } catch (err) {
      // Capacity is advisory here; checkout performs the authoritative check.
      log.warn("discover.capacity_lookup_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const poisByTrail = new Map<string, ItineraryPoi[]>();
  for (const p of pois) {
    const list = poisByTrail.get(p.trailId) ?? [];
    list.push({ id: p.id, name: p.name, kind: p.kind, lat: p.lat, lng: p.lng, seq: p.seq });
    poisByTrail.set(p.trailId, list);
  }
  const permitsByTrail = new Map<string, { name: string; officialUrl: string; leadTimeDays: number | null }[]>();
  for (const p of permits) {
    const list = permitsByTrail.get(p.trailId) ?? [];
    list.push({ name: p.name, officialUrl: p.officialUrl, leadTimeDays: p.leadTimeDays });
    permitsByTrail.set(p.trailId, list);
  }

  const trailMap = new Map<string, PlanTrail>();
  const candidates: CandidateTrail[] = trails.map((t) => {
    trailMap.set(t.id, {
      id: t.id,
      regionId: t.regionId,
      slug: t.slug,
      name: t.name,
      summary: t.summary,
      isDemo: t.isDemo,
      distanceKm: t.distanceKm,
      elevationGainM: t.elevationGainM,
      terrain: t.terrain,
      routeType: t.routeType,
      difficulty: t.difficulty,
      estimatedDurationMin: t.estimatedDurationMin,
      permitRequired: t.permitRequired,
      geometry: t.geometry,
      basePriceCents: t.basePriceCents,
      currency: t.currency,
      trailheadName: t.trailheadName,
    });
    const trailPois = poisByTrail.get(t.id) ?? [];
    return {
      trail: {
        id: t.id,
        slug: t.slug,
        name: t.name,
        status: t.status,
        isDemo: t.isDemo,
        distanceKm: t.distanceKm,
        elevationGainM: t.elevationGainM,
        difficulty: t.difficulty,
        terrain: t.terrain,
        routeType: t.routeType,
        estimatedDurationMin: t.estimatedDurationMin,
        accessibilityFeatures: t.accessibilityFeatures,
        dogsAllowed: t.dogsAllowed,
        permitRequired: t.permitRequired,
        dailyCapacity: t.dailyCapacity,
        geometryValidatedAt: t.geometryValidatedAt,
        hasGeometry: !!t.geometry && Array.isArray(t.geometry.coordinates) && t.geometry.coordinates.length >= 2,
      },
      closures: closures.filter((c) => c.trailId === t.id).map((c) => ({ severity: c.severity, reason: c.reason, startsAt: c.startsAt, endsAt: c.endsAt })),
      permits: (permitsByTrail.get(t.id) ?? []).map((p) => ({ name: p.name, leadTimeDays: p.leadTimeDays })),
      poiCount: trailPois.length,
      stopCount: trailPois.filter((p) => p.kind !== "trailhead").length,
      capacityRemaining: capacity.has(t.id) ? capacity.get(t.id) : null,
    };
  });

  return { candidates, trails: trailMap, pois: poisByTrail, permitsByTrail };
}

/**
 * Reasons of the PARTIAL closures on a trail that overlap the planned
 * region-local day (oldest first). The itinerary must surface these: the
 * schedule is computed for the full route.
 */
export function partialClosuresOn(bundle: CandidateBundle, trailId: string, plannedDate: string, timeZone: string): string[] {
  const c = bundle.candidates.find((x) => x.trail.id === trailId);
  return (c?.closures ?? []).filter((cl) => cl.severity === "partial" && closureOverlapsDay(cl, plannedDate, timeZone)).map((cl) => cl.reason);
}

/** Region of a publicly visible (published/closed) trail, or null. */
export async function getVisibleTrailRegionId(trailId: string): Promise<string | null> {
  const [row] = await withAnon(
    (tx) => tx<{ regionId: string }[]>`select region_id from public.trails where id = ${trailId} and status in ('published', 'closed')`,
  );
  return row?.regionId ?? null;
}

const latestFinishSchema = z.record(z.string(), z.record(z.string().regex(/^(1[0-2]|[1-9])$/), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)));

/**
 * Conservative latest-finish table for a region (estimate, not sunset).
 * Operators can override it in app_settings.latest_finish_by_month as
 * {"<region-slug>": {"1": "15:45", …}}; otherwise the built-in default applies.
 */
export async function getLatestFinishTable(regionSlug: string): Promise<Record<number, string>> {
  try {
    const [row] = await withSystem(
      (tx) => tx<{ value: unknown }[]>`select value from public.app_settings where key = 'latest_finish_by_month'`,
    );
    const parsed = latestFinishSchema.safeParse(row?.value);
    const table = parsed.success ? parsed.data[regionSlug] : undefined;
    if (!table) return DEFAULT_LATEST_FINISH_BY_MONTH;
    const out: Record<number, string> = { ...DEFAULT_LATEST_FINISH_BY_MONTH };
    for (const [m, t] of Object.entries(table)) out[Number(m)] = t;
    return out;
  } catch (err) {
    log.warn("discover.latest_finish_lookup_failed", { error: err instanceof Error ? err.message : String(err) });
    return DEFAULT_LATEST_FINISH_BY_MONTH;
  }
}
