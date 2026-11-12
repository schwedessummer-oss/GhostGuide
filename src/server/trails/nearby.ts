import "server-only";
import type { CoverageDto, LngLat, NearbyGroupDto, NearbyResponse, PoiDto } from "@/domain/catalog";
import { withAnon } from "@/server/db";
import { bboxAround } from "@/server/geo/tiles";
import { log } from "@/server/log";
import { ensureCoverage } from "@/server/trails/coverage";
import { catalogAttribution, toPoiDto, type PoiRow } from "@/server/trails/read";

/**
 * Nearby services for a catalog trail: fuel, food, lodging, supplies,
 * medical care (OpenStreetMap "services" layer) plus parking and restrooms
 * at the trailhead (OSM "outdoor" layer).
 *
 *   origin    the trailhead, else the trail's centroid (notes say which)
 *   services  within radiusM (default 15 km) of the origin, nearest first
 *   parking / restrooms   within 1 km of the origin
 *   groups    at most NEARBY_GROUP_LIMIT items each; empty groups omitted
 *
 * Loading: services are loaded on demand per tile. ensureCoverage('services',
 * bbox of the radius, { request: true, inlineTiles: 1 }) reports whether the
 * area is loaded and requests the missing tiles; what is already stored is
 * returned meanwhile, with an honest note. If the coverage service fails,
 * stored results are still returned with coverage state "failed".
 *
 * Distances are straight lines (PostGIS geography, metres), never driving
 * distances. OSM has no ratings and its opening hours are volunteer-mapped:
 * the notes say both. All reads go through withAnon (public RLS policy);
 * SQL takes only bound parameters.
 */

export const NEARBY_RADIUS_M = 15_000;
export const NEARBY_MIN_RADIUS_M = 1_000;
export const NEARBY_MAX_RADIUS_M = 25_000;
export const TRAILHEAD_AMENITY_RADIUS_M = 1_000;
export const NEARBY_GROUP_LIMIT = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type GroupKey = NearbyGroupDto["category"];

interface GroupDef {
  key: GroupKey;
  label: string;
  layer: "services" | "outdoor";
  categories: readonly string[];
}

/** Display order and membership. A group's `key` is its representative category. */
export const NEARBY_GROUPS: readonly GroupDef[] = [
  { key: "fuel", label: "Gas", layer: "services", categories: ["fuel"] },
  { key: "ev_charging", label: "EV charging", layer: "services", categories: ["ev_charging"] },
  { key: "restaurant", label: "Food", layer: "services", categories: ["restaurant", "fast_food"] },
  { key: "cafe", label: "Coffee", layer: "services", categories: ["cafe"] },
  { key: "lodging", label: "Lodging", layer: "services", categories: ["lodging"] },
  { key: "supermarket", label: "Supplies", layer: "services", categories: ["supermarket", "convenience", "outdoor_shop"] },
  { key: "hospital", label: "Medical", layer: "services", categories: ["hospital", "clinic", "pharmacy"] },
  { key: "parking", label: "Parking", layer: "outdoor", categories: ["parking"] },
  { key: "toilets", label: "Restrooms", layer: "outdoor", categories: ["toilets"] },
];

const SERVICE_CATEGORIES = NEARBY_GROUPS.filter((g) => g.layer === "services").flatMap((g) => g.categories);
const OUTDOOR_CATEGORIES = NEARBY_GROUPS.filter((g) => g.layer === "outdoor").flatMap((g) => g.categories);
const GROUP_OF_CATEGORY = new Map<string, GroupKey>(NEARBY_GROUPS.flatMap((g) => g.categories.map((c) => [c, g.key] as const)));

/** Coverage reported when the coverage service itself fails: honest, never "ready". */
export const NEARBY_COVERAGE_FAILED: CoverageDto = {
  layer: "services",
  state: "failed",
  tilesTotal: 0,
  tilesReady: 0,
  tilesLoading: 0,
  tilesFailed: 0,
  oldestSyncAt: null,
  message: "Loading nearby services is unavailable right now. Showing services already stored for this area, which may be incomplete.",
};

interface NearbyRow extends PoiRow {
  groupKey: GroupKey;
}

interface OriginRow {
  id: string;
  centroidLng: number;
  centroidLat: number;
  trailheadLng: number | null;
  trailheadLat: number | null;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** CASE expression text is constant; category values are bound. */
async function queryNearby(origin: LngLat, radiusM: number): Promise<NearbyRow[]> {
  return withAnon(
    (tx) => tx<NearbyRow[]>`
      with o as (
        select st_setsrid(st_makepoint(${origin.lng}::float8, ${origin.lat}::float8), 4326)::geography as g
      ),
      candidates as (
        select p.id, p.category, p.name, p.location, p.elevation_m, p.opening_hours, p.website, p.phone,
               p.source_name, p.provider,
               case when p.category in ('restaurant', 'fast_food') then 'restaurant'
                    when p.category in ('supermarket', 'convenience', 'outdoor_shop') then 'supermarket'
                    when p.category in ('hospital', 'clinic', 'pharmacy') then 'hospital'
                    else p.category end as group_key,
               st_distance(p.location, o.g) as dist
          from public.catalog_pois p, o
         where (p.layer = 'services' and p.category = any(${SERVICE_CATEGORIES as string[]}::text[])
                and st_dwithin(p.location, o.g, ${radiusM}::float8))
            or (p.layer = 'outdoor' and p.category = any(${OUTDOOR_CATEGORIES as string[]}::text[])
                and st_dwithin(p.location, o.g, ${TRAILHEAD_AMENITY_RADIUS_M}::float8))
      ),
      ranked as (
        select c.*, row_number() over (partition by c.group_key order by c.dist asc, c.id asc) as rn
          from candidates c
      )
      select r.id, r.category, r.name, st_x(r.location::geometry) as lng, st_y(r.location::geometry) as lat,
             round(r.dist)::int as distance_m, r.elevation_m, r.opening_hours, r.website, r.phone,
             r.source_name, r.provider, r.group_key
        from ranked r
       where r.rn <= ${NEARBY_GROUP_LIMIT}::int
       order by r.group_key asc, r.dist asc, r.id asc`,
  );
}

/** Rows → groups in NEARBY_GROUPS order, nearest first, empty groups omitted. */
export function groupNearby(rows: NearbyRow[]): NearbyGroupDto[] {
  const byGroup = new Map<GroupKey, PoiDto[]>();
  for (const row of rows) {
    const key = GROUP_OF_CATEGORY.get(row.category);
    const dto = toPoiDto(row);
    if (!key || !dto) continue;
    const list = byGroup.get(key) ?? [];
    list.push(dto);
    byGroup.set(key, list);
  }
  const out: NearbyGroupDto[] = [];
  for (const g of NEARBY_GROUPS) {
    const items = (byGroup.get(g.key) ?? [])
      .sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity) || a.id.localeCompare(b.id))
      .slice(0, NEARBY_GROUP_LIMIT);
    if (items.length > 0) out.push({ category: g.key, label: g.label, items });
  }
  return out;
}

function nearbyNotes(coverage: CoverageDto, hasTrailhead: boolean, groups: NearbyGroupDto[], radiusM: number): string[] {
  const from = hasTrailhead ? "the trailhead" : "the middle of the trail (no trailhead is mapped)";
  const notes = [
    `Distances are straight-line distances from ${from}, not driving distances.`,
    "Ratings are not available from OpenStreetMap.",
    "Opening hours are as mapped by volunteers — confirm before relying on them.",
  ];
  switch (coverage.state) {
    case "loading":
      notes.unshift("Nearby services for this area are still loading. More results will appear shortly.");
      break;
    case "partial":
      notes.unshift("Some nearby services could not be loaded, so this list may be incomplete.");
      break;
    case "failed":
      notes.unshift("Nearby services could not be loaded right now, so this list may be incomplete.");
      break;
    case "too_large":
      notes.unshift("This area is too large to load at once, so this list may be incomplete.");
      break;
    case "ready":
      if (groups.length === 0) notes.unshift(`No services are mapped in OpenStreetMap within ${Math.round(radiusM / 1000)} km.`);
      break;
  }
  return notes;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface NearbyOptions {
  /** Search radius for services, metres (clamped to 1–25 km; default 15 km). */
  radiusM?: number;
}

/**
 * Nearby services for a trail; null when the trail does not exist or is
 * hidden. Never invents places: only stored OSM POIs are returned.
 */
export async function getNearbyServices(trailId: string, opts: NearbyOptions = {}): Promise<NearbyResponse | null> {
  if (typeof trailId !== "string" || !UUID_RE.test(trailId)) return null;
  const radiusM = Math.round(
    Math.min(NEARBY_MAX_RADIUS_M, Math.max(NEARBY_MIN_RADIUS_M, finite(opts.radiusM) ? opts.radiusM : NEARBY_RADIUS_M)),
  );

  const [trail] = await withAnon(
    (tx) => tx<OriginRow[]>`
      select t.id,
             st_x(t.centroid::geometry) as centroid_lng, st_y(t.centroid::geometry) as centroid_lat,
             st_x(t.trailhead::geometry) as trailhead_lng, st_y(t.trailhead::geometry) as trailhead_lat
        from public.catalog_trails t
       where t.id = ${trailId.toLowerCase()}::uuid and not t.hidden`,
  );
  if (!trail || !finite(trail.centroidLng) || !finite(trail.centroidLat)) return null;
  const hasTrailhead = finite(trail.trailheadLng) && finite(trail.trailheadLat);
  const origin: LngLat = hasTrailhead
    ? { lng: trail.trailheadLng as number, lat: trail.trailheadLat as number }
    : { lng: trail.centroidLng, lat: trail.centroidLat };

  const coveragePromise = Promise.resolve()
    .then(() => ensureCoverage("services", bboxAround(origin, radiusM), { request: true, inlineTiles: 1 }))
    .catch((err: unknown): CoverageDto => {
      log.error("nearby.coverage_failed", { error: errorMessage(err) });
      return { ...NEARBY_COVERAGE_FAILED };
    });
  const [coverage, rows] = await Promise.all([coveragePromise, queryNearby(origin, radiusM)]);

  const groups = groupNearby(rows);
  return {
    trailId: trail.id,
    origin,
    radiusM,
    coverage,
    groups,
    notes: nearbyNotes(coverage, hasTrailhead, groups, radiusM),
    // Services are loaded from OpenStreetMap, so it is always credited.
    attribution: catalogAttribution(["osm", ...rows.map((r) => r.provider)]),
  };
}
