import "server-only";
import { withAnon, type Tx } from "@/server/db";
import { env } from "@/config/env";
import type { Closure, FieldProvenance, Narration, Poi, Source, Trail } from "@/domain/types";

/**
 * Catalog read model (public, RLS: published/closed trails + approved narration).
 * Shared by discovery, booking, hike and admin views.
 */
const TRAIL_COLUMNS = (tx: Tx) => tx`
  t.id, t.region_id, t.slug, t.name, t.summary, t.description, t.is_demo, t.status, t.distance_km,
  t.elevation_gain_m, t.max_elevation_m, t.difficulty, t.terrain, t.route_type, t.estimated_duration_min,
  t.accessibility_features, t.dogs_allowed, t.permit_required, t.trailhead_name, t.trailhead_lat, t.trailhead_lng,
  t.parking_info, t.hero_image_url, t.base_price_cents, t.currency, t.daily_capacity, t.geometry,
  t.geometry_checksum, t.geometry_validated_at, t.facts_verified_at, t.updated_at`;

export interface Region {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  centerLat: number;
  centerLng: number;
  defaultZoom: number;
  isDemo: boolean;
  emergencyNumber: string;
  emergencyGuidance: string;
}

export async function getLaunchRegion(): Promise<Region> {
  const [r] = await withAnon(
    (tx) => tx<Region[]>`
      select id, slug, name, timezone, center_lat, center_lng, default_zoom, is_demo, emergency_number, emergency_guidance
      from public.regions where slug = ${env().LAUNCH_REGION_SLUG} and is_active`,
  );
  if (!r) throw new Error(`Launch region ${env().LAUNCH_REGION_SLUG} not found. Run npm run db:seed.`);
  return r;
}

export async function getRegionById(id: string): Promise<Region | null> {
  const [r] = await withAnon(
    (tx) => tx<Region[]>`
      select id, slug, name, timezone, center_lat, center_lng, default_zoom, is_demo, emergency_number, emergency_guidance
      from public.regions where id = ${id}`,
  );
  return r ?? null;
}

/** Published (and visibly closed) trails in a region, with active closures. */
export async function listTrails(regionId: string): Promise<(Trail & { activeClosures: Closure[] })[]> {
  return withAnon(async (tx) => {
    const trails = await tx<Trail[]>`
      select ${TRAIL_COLUMNS(tx)} from public.trails t
      where t.region_id = ${regionId} and t.status in ('published', 'closed')
      order by t.name`;
    const closures = await activeClosures(tx, trails.map((t) => t.id));
    return trails.map((t) => ({ ...t, activeClosures: closures.filter((c) => c.trailId === t.id) }));
  });
}

export async function activeClosures(tx: Tx, trailIds: string[]): Promise<Closure[]> {
  if (!trailIds.length) return [];
  return tx<Closure[]>`
    select id, trail_id, severity, reason, source_id, starts_at, ends_at from public.trail_closures
    where trail_id = any(${trailIds}::uuid[]) and starts_at <= now() and (ends_at is null or ends_at > now())
    order by starts_at desc`;
}

export interface TrailDetail extends Trail {
  activeClosures: Closure[];
  pois: Poi[];
  narrations: Narration[];
  provenance: FieldProvenance[];
  sources: Source[];
  permits: {
    id: string;
    name: string;
    authority: string;
    officialUrl: string;
    requirementSummary: string;
    howToObtain: string;
    leadTimeDays: number | null;
    verifiedAt: Date | null;
  }[];
}

async function loadDetail(tx: Tx, trail: Trail): Promise<TrailDetail> {
  const [closures, pois, narrations, provenance, sources, permits] = await Promise.all([
    activeClosures(tx, [trail.id]),
    tx<Poi[]>`select id, trail_id, seq, name, kind, lat, lng, trigger_radius_m from public.trail_pois where trail_id = ${trail.id} order by seq`,
    tx<Narration[]>`
      select id, trail_id, poi_id, title, transcript, audio_path, duration_sec, status, source_id, source_citation, version, approved_at
      from public.narrations where trail_id = ${trail.id} and status = 'approved' order by created_at`,
    tx<FieldProvenance[]>`select field, kind, source_id, verified_at, note from public.trail_field_provenance where trail_id = ${trail.id}`,
    tx<Source[]>`
      select s.id, s.label, s.url, s.publisher, s.source_type, s.retrieved_at, s.notes
      from public.sources s join public.trail_sources ts on ts.source_id = s.id where ts.trail_id = ${trail.id}
      union
      select s.id, s.label, s.url, s.publisher, s.source_type, s.retrieved_at, s.notes
      from public.sources s join public.permit_requirements pr on pr.source_id = s.id where pr.trail_id = ${trail.id}`,
    tx<TrailDetail["permits"]>`
      select id, name, authority, official_url, requirement_summary, how_to_obtain, lead_time_days, verified_at
      from public.permit_requirements where trail_id = ${trail.id}`,
  ]);
  return { ...trail, activeClosures: closures, pois, narrations, provenance, sources, permits };
}

export async function getTrailBySlug(slug: string): Promise<TrailDetail | null> {
  return withAnon(async (tx) => {
    const [t] = await tx<Trail[]>`select ${TRAIL_COLUMNS(tx)} from public.trails t where t.slug = ${slug} and t.status in ('published', 'closed')`;
    return t ? loadDetail(tx, t) : null;
  });
}

export async function getTrailById(id: string): Promise<TrailDetail | null> {
  return withAnon(async (tx) => {
    const [t] = await tx<Trail[]>`select ${TRAIL_COLUMNS(tx)} from public.trails t where t.id = ${id} and t.status in ('published', 'closed')`;
    return t ? loadDetail(tx, t) : null;
  });
}

/** A trail is bookable/recommendable only if published, validated and not fully closed. */
export function isTrailAvailable(t: Pick<Trail, "status" | "geometryValidatedAt" | "geometry">, closures: Closure[]): boolean {
  return t.status === "published" && !!t.geometry && !!t.geometryValidatedAt && !closures.some((c) => c.severity === "closed");
}
