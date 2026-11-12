import "server-only";
import type { Fragment } from "postgres";
import { OUTDOOR_POI_CATEGORIES, SERVICE_POI_CATEGORIES, type Bbox, type CatalogLayer } from "@/domain/catalog";
import { isUniqueViolation, withSystem, type JsonValue, type Tx } from "@/server/db";
import type { Tile } from "@/server/geo/tiles";
import { log } from "@/server/log";
import { attributesFromJson, attributesToJson, type ElevationSnapshot, type NearbyPoi, type TrailAttributes, type TrailRecord } from "./enrich";
import { escapeLike } from "./read";
import { UNKNOWN_COUNTRY_CODE, UNKNOWN_REGION_SLUG, pickFreeSlug } from "./slug";
import type { Line, NormalizedPoi } from "./types";

/**
 * SQL for catalog ingestion and coverage: tiles (public.catalog_tiles),
 * trails (public.catalog_trails + catalog_trail_parts) and POIs
 * (public.catalog_pois). Trusted server code only (withSystem / a system
 * transaction): RLS is bypassed, callers decide what is written.
 *
 * Every value reaches SQL as a bound parameter. Timestamps that are
 * compared across transactions (claim tokens, sync starts) travel as the
 * database's own text form of the timestamptz, so microseconds survive the
 * round trip through JavaScript (a Date keeps milliseconds only).
 */

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

export type TileStatus = "pending" | "fetching" | "ready" | "failed";

/** A tile is reclaimable when its fetch started longer ago than this (crashed worker). */
export const STALE_FETCH_MINUTES = 5;
/** Fetching tiles count toward a provider's concurrency cap for this long after they started. */
export const CONCURRENCY_WINDOW_MINUTES = 3;
/** Backoff after a failed fetch: 5 min × 2^(attempts − 1), at most 6 h. */
export const FAILURE_BACKOFF_BASE_MINUTES = 5;
export const FAILURE_BACKOFF_MAX_MINUTES = 6 * 60;
export const INGEST_JOB_KIND = "catalog.ingest_tile";

/** Next-refresh delay after a failure with `attempts` consecutive failures (≥ 1). */
export function failureBackoffMinutes(attempts: number): number {
  const n = Math.max(1, Math.floor(Number.isFinite(attempts) ? attempts : 1));
  return Math.min(FAILURE_BACKOFF_MAX_MINUTES, FAILURE_BACKOFF_BASE_MINUTES * 2 ** Math.min(n - 1, 20));
}

/**
 * Dedup key of the ingest job for one request generation of a tile. The
 * generation is the tile's requested_at in epoch milliseconds: repeated
 * requests while a job is outstanding share the key (deduplicated); a later
 * request (refresh, retry after the job finished) bumps requested_at and so
 * gets a new key.
 */
export function ingestJobKey(layer: CatalogLayer, provider: string, tileKey: string, requestGen: string): string {
  return `${INGEST_JOB_KIND}:${layer}:${provider}:${tileKey}:${requestGen}`;
}

/** SQL: request generation (epoch ms, text) of a catalog_tiles row aliased `t`. */
const genOf = (tx: Tx) => tx`floor(extract(epoch from t.requested_at) * 1000)::bigint::text`;
/** SQL: the ingest job's dedup key for a catalog_tiles row aliased `t` (must match ingestJobKey). */
const jobKeyOf = (tx: Tx) =>
  tx`${`${INGEST_JOB_KIND}:`}::text || t.layer || ':' || t.provider || ':' || t.tile_key || ':' || ${genOf(tx)}`;

export interface TileRow {
  layer: CatalogLayer;
  provider: string;
  tileKey: string;
  status: TileStatus;
  attempts: number;
  requestGen: string;
  fetchStartedAt: Date | null;
  lastSyncedAt: Date | null;
  nextRefreshAt: Date | null;
  lastError: string | null;
  trailCount: number;
  poiCount: number;
  /** next_refresh_at is null or has passed. */
  due: boolean;
  /** Fetching for longer than STALE_FETCH_MINUTES (the worker presumably died). */
  fetchStale: boolean;
  /** Status of the ingest job for the current request generation (null: none). */
  jobStatus: string | null;
}

const tileColumns = (tx: Tx) => tx`
  t.layer, t.provider, t.tile_key, t.status, t.attempts, ${genOf(tx)} as request_gen,
  t.fetch_started_at, t.last_synced_at, t.next_refresh_at, t.last_error, t.trail_count, t.poi_count,
  coalesce(t.next_refresh_at <= now(), true) as due,
  (t.status = 'fetching' and (t.fetch_started_at is null
     or t.fetch_started_at < now() - make_interval(mins => ${STALE_FETCH_MINUTES}))) as fetch_stale,
  j.status::text as job_status`;

/** Whether a tile needs an ingest run (pending, due refresh/retry, or a crashed fetch). */
export function tileNeedsWork(row: Pick<TileRow, "status" | "due" | "fetchStale">): boolean {
  switch (row.status) {
    case "pending":
      return true;
    case "ready":
    case "failed":
      return row.due;
    case "fetching":
      return row.fetchStale;
    default:
      return false;
  }
}

export const jobOutstanding = (jobStatus: string | null) => jobStatus === "queued" || jobStatus === "running";

/** Insert missing (tile, provider) rows as pending. Existing rows are untouched. */
export async function insertPendingTiles(tx: Tx, layer: CatalogLayer, items: readonly { provider: string; tile: Tile }[]): Promise<number> {
  if (items.length === 0) return 0;
  // Sorted, so concurrent inserts of overlapping sets take locks in the same order.
  const keyOf = (i: { provider: string; tile: Tile }) => `${i.provider}\u0000${i.tile.key}`;
  const sorted = [...items].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  const rows = sorted.map(({ provider, tile }) => ({
    provider,
    tileKey: tile.key,
    w: tile.bbox[0],
    s: tile.bbox[1],
    e: tile.bbox[2],
    n: tile.bbox[3],
  }));
  const inserted = await tx`
    insert into public.catalog_tiles (layer, provider, tile_key, bounds, status, requested_at)
    select ${layer}, r."provider", r."tileKey", st_makeenvelope(r.w, r.s, r.e, r.n, 4326), 'pending',
           date_trunc('milliseconds', now())
      from jsonb_to_recordset(${tx.json(rows as unknown as JsonValue)})
           as r("provider" text, "tileKey" text, w float8, s float8, e float8, n float8)
    on conflict (layer, provider, tile_key) do nothing
    returning tile_key`;
  return inserted.length;
}

/** Rows for the given (provider, tile key) pairs, with their job status. */
export async function readTiles(tx: Tx, layer: CatalogLayer, pairs: readonly { provider: string; tileKey: string }[]): Promise<TileRow[]> {
  if (pairs.length === 0) return [];
  const providers = pairs.map((p) => p.provider);
  const keys = pairs.map((p) => p.tileKey);
  return tx<TileRow[]>`
    select ${tileColumns(tx)}
      from unnest(${providers}::text[], ${keys}::text[]) as want(provider, tile_key)
      join public.catalog_tiles t on t.layer = ${layer} and t.provider = want.provider and t.tile_key = want.tile_key
      left join public.jobs j on j.dedup_key = ${jobKeyOf(tx)}`;
}

/**
 * Per-tile coverage counts over every tile row whose bounds overlap the
 * interior of `bbox` (tiles that only touch its edge are excluded). Used for
 * areas too large to enumerate. A tile is "ready" when every provider row it
 * has holds data, "loading" when any row is pending/fetching without data (or
 * failed with a retry queued), else "failed" when any row failed.
 */
export async function coverageCountsInBbox(
  tx: Tx,
  layer: CatalogLayer,
  providers: readonly string[],
  bbox: Bbox,
): Promise<{ ready: number; loading: number; failed: number; oldestSyncAt: Date | null }> {
  if (providers.length === 0) return { ready: 0, loading: 0, failed: 0, oldestSyncAt: null };
  const eps = 1e-9;
  const [w, s, e, n] = bbox;
  const [row] = await tx<{ ready: number; loading: number; failed: number; oldestSyncAt: Date | null }[]>`
    with per_tile as (
      select t.tile_key,
             bool_or(t.last_synced_at is null and (t.status in ('pending', 'fetching')
                     or (t.status = 'failed' and j.status::text in ('queued', 'running')))) as loading,
             bool_or(t.last_synced_at is null and t.status = 'failed'
                     and coalesce(j.status::text, '') not in ('queued', 'running')) as failed,
             bool_and(t.status = 'ready' or t.last_synced_at is not null) as ready,
             min(t.last_synced_at) as oldest
        from public.catalog_tiles t
        left join public.jobs j on j.dedup_key = ${jobKeyOf(tx)}
       where t.layer = ${layer} and t.provider = any(${providers as string[]}::text[])
         and t.bounds && st_makeenvelope(${w + eps}::float8, ${s + eps}::float8, ${e - eps}::float8, ${n - eps}::float8, 4326)
       group by t.tile_key)
    select count(*) filter (where not loading and not failed and ready)::int as ready,
           count(*) filter (where loading)::int as loading,
           count(*) filter (where not loading and failed)::int as failed,
           min(oldest) filter (where not loading and not failed and ready) as oldest_sync_at
      from per_tile`;
  return { ready: row?.ready ?? 0, loading: row?.loading ?? 0, failed: row?.failed ?? 0, oldestSyncAt: row?.oldestSyncAt ?? null };
}

/**
 * Start a new request generation for a tile if nobody else did since
 * `oldGen` was read (compare-and-set), and enqueue its ingest job in the
 * same transaction. Returns the new generation, or null when another
 * request won the race (its job covers this one).
 */
export async function requestTileIngest(
  tx: Tx,
  layer: CatalogLayer,
  provider: string,
  tileKey: string,
  oldGen: string,
  opts: { runAt?: Date; maxAttempts?: number } = {},
): Promise<string | null> {
  const [bumped] = await tx<{ requestGen: string }[]>`
    update public.catalog_tiles t
       set requested_at = greatest(date_trunc('milliseconds', clock_timestamp()), t.requested_at + interval '1 millisecond')
     where t.layer = ${layer} and t.provider = ${provider} and t.tile_key = ${tileKey} and ${genOf(tx)} = ${oldGen}
     returning ${genOf(tx)} as request_gen`;
  if (!bumped) return null;
  const payload = { layer, provider, tileKey };
  await tx`
    insert into public.jobs (kind, payload, run_at, dedup_key, max_attempts)
    values (${INGEST_JOB_KIND}, ${tx.json(payload as JsonValue)}, coalesce(${opts.runAt ?? null}::timestamptz, now()),
            ${ingestJobKey(layer, provider, tileKey, bumped.requestGen)}, ${opts.maxAttempts ?? 4})
    on conflict (dedup_key) where dedup_key is not null do nothing`;
  return bumped.requestGen;
}

/**
 * Tiles that need work and have no outstanding job (refresh_stale): due
 * refreshes and retries, crashed fetches, and pending tiles whose job was
 * lost. Oldest first.
 */
export async function tilesNeedingWork(tx: Tx, providers: readonly string[], limit: number): Promise<TileRow[]> {
  if (providers.length === 0 || limit <= 0) return [];
  return tx<TileRow[]>`
    select ${tileColumns(tx)}
      from public.catalog_tiles t
      left join public.jobs j on j.dedup_key = ${jobKeyOf(tx)}
     where t.provider = any(${providers as string[]}::text[])
       and (t.status = 'pending'
            or (t.status in ('ready', 'failed') and coalesce(t.next_refresh_at <= now(), true))
            or (t.status = 'fetching' and (t.fetch_started_at is null
                or t.fetch_started_at < now() - make_interval(mins => ${STALE_FETCH_MINUTES}))))
       and coalesce(j.status::text, '') not in ('queued', 'running')
     order by coalesce(t.next_refresh_at, t.requested_at) asc, t.tile_key asc
     limit ${limit}::int`;
}

export type ClaimResult =
  | {
      status: "claimed";
      /** Fencing token: the claim's fetch_started_at (DB text form). */
      token: string;
      /** Sync start (same instant as token, DB text form). */
      syncStart: string;
      /** Whether the tile held data before this fetch (a refresh). */
      hadData: boolean;
      attempts: number;
    }
  /** The provider's global concurrency cap is reached; try again shortly. */
  | { status: "busy" }
  /** Another worker is fetching this tile right now. */
  | { status: "in_progress" }
  /** The tile is loaded and not due for a refresh. */
  | { status: "not_due" };

/**
 * Atomically claim a tile for fetching (status → 'fetching').
 *
 * Claimable: pending, failed (the job queue's retries may run before the
 * tile's own backoff), ready and due, or fetching but stale (crashed
 * worker). Refused with "busy" when `cap` tiles of the provider (any layer)
 * started fetching within CONCURRENCY_WINDOW_MINUTES: a per-provider
 * advisory lock serializes concurrent claimers so the count is exact. A
 * missing tile row is created first (pending).
 */
export async function claimTile(layer: CatalogLayer, provider: string, tile: Tile, cap: number): Promise<ClaimResult> {
  const limit = Math.max(1, Math.floor(cap));
  return withSystem(async (tx) => {
    await insertPendingTiles(tx, layer, [{ provider, tile }]);
    await tx`select pg_advisory_xact_lock(hashtext(${`catalog_tiles.fetch:${provider}`}))`;
    const [claimed] = await tx<{ token: string; attempts: number; hadData: boolean }[]>`
      update public.catalog_tiles t
         set status = 'fetching', fetch_started_at = now()
       where t.layer = ${layer} and t.provider = ${provider} and t.tile_key = ${tile.key}
         and (t.status in ('pending', 'failed')
              or (t.status = 'ready' and coalesce(t.next_refresh_at <= now(), true))
              or (t.status = 'fetching' and (t.fetch_started_at is null
                  or t.fetch_started_at < now() - make_interval(mins => ${STALE_FETCH_MINUTES}))))
         and (select count(*) from public.catalog_tiles f
               where f.provider = ${provider} and f.status = 'fetching'
                 and f.fetch_started_at > now() - make_interval(mins => ${CONCURRENCY_WINDOW_MINUTES})
                 and not (f.layer = t.layer and f.tile_key = t.tile_key)) < ${limit}::int
       returning t.fetch_started_at::text as token, t.attempts, (t.last_synced_at is not null) as had_data`;
    if (claimed) return { status: "claimed", token: claimed.token, syncStart: claimed.token, hadData: claimed.hadData, attempts: claimed.attempts };

    const [cur] = await tx<{ status: TileStatus; due: boolean; fetchStale: boolean }[]>`
      select t.status, coalesce(t.next_refresh_at <= now(), true) as due,
             (t.fetch_started_at is null or t.fetch_started_at < now() - make_interval(mins => ${STALE_FETCH_MINUTES})) as fetch_stale
        from public.catalog_tiles t
       where t.layer = ${layer} and t.provider = ${provider} and t.tile_key = ${tile.key}`;
    if (!cur) return { status: "busy" };
    if (cur.status === "fetching" && !cur.fetchStale) return { status: "in_progress" };
    if (cur.status === "ready" && !cur.due) return { status: "not_due" };
    // Claimable state but the cap refused it.
    return { status: "busy" };
  });
}

/** SQL condition: the tile row is still held by the claim with this token. */
const heldBy = (tx: Tx, layer: CatalogLayer, provider: string, tileKey: string, token: string) =>
  tx`t.layer = ${layer} and t.provider = ${provider} and t.tile_key = ${tileKey}
     and t.status = 'fetching' and t.fetch_started_at = ${token}::timestamptz`;

/** Lock the tile row if this claim still holds it (fencing against a reclaim). */
export async function lockHeldTile(tx: Tx, layer: CatalogLayer, provider: string, tileKey: string, token: string): Promise<boolean> {
  const rows = await tx`select 1 from public.catalog_tiles t where ${heldBy(tx, layer, provider, tileKey, token)} for update`;
  return rows.length > 0;
}

/** Mark a held tile loaded. `ttlSeconds` sets next_refresh_at. */
export async function markTileReady(
  tx: Tx,
  layer: CatalogLayer,
  provider: string,
  tileKey: string,
  token: string,
  r: { trailCount: number; poiCount: number; ttlSeconds: number; note: string | null },
): Promise<boolean> {
  const rows = await tx`
    update public.catalog_tiles t
       set status = 'ready', attempts = 0, last_error = ${r.note}, trail_count = ${r.trailCount}::int, poi_count = ${r.poiCount}::int,
           last_synced_at = now(), next_refresh_at = now() + make_interval(secs => ${Math.max(60, Math.round(r.ttlSeconds))})
     where ${heldBy(tx, layer, provider, tileKey, token)}
     returning 1`;
  return rows.length > 0;
}

/**
 * Record a failed fetch of a held tile: attempts + 1, last_error, backoff
 * (failureBackoffMinutes). A tile that already held data stays 'ready' (its
 * data is still served and still correct as of its last sync); a tile that
 * never loaded becomes 'failed'. Returns null when the claim was lost.
 */
export async function markTileFailed(
  layer: CatalogLayer,
  provider: string,
  tileKey: string,
  token: string,
  error: string,
): Promise<{ status: TileStatus; attempts: number; nextRefreshAt: Date } | null> {
  return withSystem(async (tx) => {
    const [row] = await tx<{ status: TileStatus; attempts: number; nextRefreshAt: Date }[]>`
      update public.catalog_tiles t
         set status = case when t.last_synced_at is null then 'failed' else 'ready' end,
             attempts = t.attempts + 1,
             last_error = ${error.slice(0, 300)},
             next_refresh_at = now() + least(
               make_interval(mins => ${FAILURE_BACKOFF_MAX_MINUTES}),
               make_interval(mins => ${FAILURE_BACKOFF_BASE_MINUTES}) * power(2, least(t.attempts, 20)))
       where ${heldBy(tx, layer, provider, tileKey, token)}
       returning t.status, t.attempts, t.next_refresh_at`;
    return row ?? null;
  });
}

/** Make tiles due for refresh now (e.g. to rebuild a trail whose piece vanished elsewhere). */
export async function markTilesDue(tx: Tx, layer: CatalogLayer, keys: readonly { provider: string; tileKey: string }[]): Promise<number> {
  if (keys.length === 0) return 0;
  const rows = await tx`
    update public.catalog_tiles t set next_refresh_at = now()
      from unnest(${keys.map((k) => k.provider)}::text[], ${keys.map((k) => k.tileKey)}::text[]) as k(provider, tile_key)
     where t.layer = ${layer} and t.provider = k.provider and t.tile_key = k.tile_key
       and t.status = 'ready' and (t.next_refresh_at is null or t.next_refresh_at > now())
    returning 1`;
  return rows.length;
}

// ---------------------------------------------------------------------------
// POIs
// ---------------------------------------------------------------------------

const POI_BATCH = 1000;

const POI_CATEGORIES_BY_LAYER: Record<CatalogLayer, readonly string[]> = { outdoor: OUTDOOR_POI_CATEGORIES, services: SERVICE_POI_CATEGORIES };

const validLngLat = (lng: unknown, lat: unknown) =>
  typeof lng === "number" && typeof lat === "number" && Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;

/**
 * Insert or update POIs by (provider, provider_id); last_synced_at = now().
 * Invalid rows (bad coordinates, empty ids, a category outside the layer's
 * vocabulary) are skipped, so one bad element never fails the batch;
 * duplicates within the input keep their last occurrence. Returns the
 * number written.
 */
export async function upsertPois(tx: Tx, pois: readonly NormalizedPoi[]): Promise<number> {
  const byId = new Map<string, NormalizedPoi>();
  for (const p of pois) {
    if (!p || typeof p.providerId !== "string" || p.providerId.length === 0 || p.providerId.length > 200) continue;
    if (!validLngLat(p.lng, p.lat) || typeof p.provider !== "string" || !/^[a-z][a-z0-9_]{1,30}$/.test(p.provider)) continue;
    if (!POI_CATEGORIES_BY_LAYER[p.layer]?.includes(p.category)) continue;
    if (typeof p.sourceName !== "string" || typeof p.sourceLicense !== "string") continue;
    byId.set(`${p.provider}\u0000${p.providerId}`, p);
  }
  const all = [...byId.values()];
  let written = 0;
  for (let i = 0; i < all.length; i += POI_BATCH) {
    const rows = all.slice(i, i + POI_BATCH).map((p) => ({
      provider: p.provider,
      providerId: p.providerId,
      layer: p.layer,
      category: p.category,
      name: p.name ?? null,
      nameEn: p.nameEn ?? null,
      lng: p.lng,
      lat: p.lat,
      elevationM: typeof p.elevationM === "number" && Number.isFinite(p.elevationM) ? Math.round(p.elevationM) : null,
      tags: p.tags && typeof p.tags === "object" ? p.tags : {},
      openingHours: p.openingHours ?? null,
      phone: p.phone ?? null,
      website: p.website ?? null,
      sourceName: p.sourceName,
      sourceUrl: p.sourceUrl ?? null,
      sourceLicense: p.sourceLicense,
    }));
    const res = await tx`
      insert into public.catalog_pois as c (provider, provider_id, layer, category, name, name_en, location, elevation_m, tags,
                                            opening_hours, phone, website, source_name, source_url, source_license, last_synced_at)
      select r."provider", r."providerId", r."layer", r."category", r."name", r."nameEn",
             st_setsrid(st_makepoint(r."lng", r."lat"), 4326)::geography, r."elevationM", coalesce(r."tags", '{}'::jsonb),
             r."openingHours", r."phone", r."website", r."sourceName", r."sourceUrl", r."sourceLicense", now()
        from jsonb_to_recordset(${tx.json(rows as unknown as JsonValue)}) as r(
             "provider" text, "providerId" text, "layer" text, "category" text, "name" text, "nameEn" text,
             "lng" float8, "lat" float8, "elevationM" int, "tags" jsonb, "openingHours" text, "phone" text,
             "website" text, "sourceName" text, "sourceUrl" text, "sourceLicense" text)
      on conflict (provider, provider_id) do update set
        layer = excluded.layer, category = excluded.category, name = excluded.name, name_en = excluded.name_en,
        location = excluded.location, elevation_m = excluded.elevation_m, tags = excluded.tags,
        opening_hours = excluded.opening_hours, phone = excluded.phone, website = excluded.website,
        source_name = excluded.source_name, source_url = excluded.source_url, source_license = excluded.source_license,
        last_synced_at = excluded.last_synced_at
      returning 1`;
    written += res.length;
  }
  return written;
}

/** SQL: the half-open tile test [w, e) × [s, n) for a point expression (east/north world edges inclusive). */
const inTile = (tx: Tx, x: Fragment, y: Fragment, tile: Tile) => {
  const [w, s, e, n] = tile.bbox;
  return tx`(${x} >= ${w}::float8 and (${x} < ${e}::float8 or ${e}::float8 >= 180)
             and ${y} >= ${s}::float8 and (${y} < ${n}::float8 or ${n}::float8 >= 90))`;
};

/**
 * Delete POIs of a provider+layer located in the tile (half-open) that this
 * sync did not return. The geography index narrows the search to within
 * 1 km of the tile (a superset: geodesic and lat/lng edges differ by metres);
 * the exact lng/lat test decides.
 */
export async function deleteStalePois(tx: Tx, provider: string, layer: CatalogLayer, tile: Tile, syncStart: string): Promise<number> {
  const [w, s, e, n] = tile.bbox;
  const [row] = await tx<{ n: number }[]>`
    with d as (
      delete from public.catalog_pois p
       where p.provider = ${provider} and p.layer = ${layer} and p.last_synced_at < ${syncStart}::timestamptz
         and st_dwithin(p.location, st_makeenvelope(${w}::float8, ${s}::float8, ${e}::float8, ${n}::float8, 4326)::geography, 1000)
         and ${inTile(tx, tx`st_x(p.location::geometry)`, tx`st_y(p.location::geometry)`, tile)}
      returning 1)
    select count(*)::int as n from d`;
  return row?.n ?? 0;
}

/** Outdoor POIs within `radiusM` of a route (any tile), for enrichment. */
export async function nearbyOutdoorPois(tx: Tx, lines: Line[], radiusM: number, categories: readonly string[], limit = 20_000): Promise<NearbyPoi[]> {
  if (lines.length === 0) return [];
  return tx<NearbyPoi[]>`
    with route as (select st_setsrid(st_geomfromgeojson(${geoJson(lines)}), 4326)::geography as g)
    select p.provider_id, p.category, st_x(p.location::geometry) as lng, st_y(p.location::geometry) as lat
      from public.catalog_pois p, route
     where p.layer = 'outdoor' and p.category = any(${categories as string[]}::text[])
       and st_dwithin(p.location, route.g, ${radiusM}::float8)
     order by p.provider_id
     limit ${limit}::int`;
}

// ---------------------------------------------------------------------------
// Trails
// ---------------------------------------------------------------------------

/** MultiLineString GeoJSON text for st_geomfromgeojson. */
export function geoJson(lines: Line[]): string {
  return JSON.stringify({ type: "MultiLineString", coordinates: lines });
}

/** Parse ST_AsGeoJSON output (LineString or MultiLineString) into lines. */
export function linesFromGeoJson(json: string | null): Line[] {
  if (!json) return [];
  let g: unknown;
  try {
    g = JSON.parse(json);
  } catch {
    return [];
  }
  if (!g || typeof g !== "object") return [];
  const { type, coordinates } = g as { type?: unknown; coordinates?: unknown };
  const raw: unknown[] = type === "MultiLineString" && Array.isArray(coordinates) ? coordinates : type === "LineString" ? [coordinates] : [];
  const out: Line[] = [];
  for (const line of raw) {
    if (!Array.isArray(line)) continue;
    const pts: Line = [];
    for (const c of line) if (Array.isArray(c) && validLngLat(c[0], c[1])) pts.push([c[0], c[1]]);
    if (pts.length >= 2) out.push(pts);
  }
  return out;
}

/** The stored state of a trail that ingestion needs to update it. */
export interface StoredTrail {
  id: string;
  provider: string;
  providerId: string;
  aliasIds: string[];
  name: string;
  slug: string;
  countryCode: string;
  regionSlug: string;
  regionName: string | null;
  hidden: boolean;
  retiredAt: Date | null;
  geomHash: string | null;
  sourceUrl: string | null;
  /** First vertex of the stored geometry (a point ON the route). */
  firstVertex: { lng: number; lat: number };
  elevation: ElevationSnapshot | null;
  partCount: number;
}

interface StoredTrailRow {
  id: string;
  provider: string;
  providerId: string;
  aliasIds: string[] | null;
  name: string;
  slug: string;
  countryCode: string;
  regionSlug: string;
  regionName: string | null;
  hidden: boolean;
  retiredAt: Date | null;
  geomHash: string | null;
  sourceUrl: string | null;
  firstLng: number;
  firstLat: number;
  elevationGainM: number | null;
  elevationLossM: number | null;
  maxElevationM: number | null;
  minElevationM: number | null;
  elevationProfile: unknown;
  elevationSource: string | null;
  partCount: number;
}

const storedColumns = (tx: Tx) => tx`
  t.id, t.provider, t.provider_id, t.alias_ids, t.name, t.slug, t.country_code, t.region_slug, t.region_name,
  t.hidden, t.retired_at, t.geom_hash, t.source_url,
  st_x(st_pointn(st_geometryn(t.geom, 1), 1)) as first_lng, st_y(st_pointn(st_geometryn(t.geom, 1), 1)) as first_lat,
  t.elevation_gain_m, t.elevation_loss_m, t.max_elevation_m, t.min_elevation_m,
  t.elevation_profile, t.elevation_source,
  (select count(*) from public.catalog_trail_parts p where p.trail_id = t.id)::int as part_count`;

function toStored(row: StoredTrailRow): StoredTrail {
  const profile = Array.isArray(row.elevationProfile) ? (row.elevationProfile as [number, number][]) : null;
  const hasElevation =
    row.elevationSource !== null && profile !== null && profile.length >= 2 && row.elevationGainM !== null && row.elevationLossM !== null;
  return {
    id: row.id,
    provider: row.provider,
    providerId: row.providerId,
    aliasIds: row.aliasIds ?? [],
    name: row.name,
    slug: row.slug,
    countryCode: row.countryCode,
    regionSlug: row.regionSlug,
    regionName: row.regionName,
    hidden: row.hidden,
    retiredAt: row.retiredAt,
    geomHash: row.geomHash,
    sourceUrl: row.sourceUrl,
    firstVertex: { lng: row.firstLng, lat: row.firstLat },
    elevation: hasElevation
      ? {
          profile: profile!,
          gainM: row.elevationGainM!,
          lossM: row.elevationLossM!,
          maxM: row.maxElevationM ?? Math.max(...profile!.map((p) => p[1])),
          minM: row.minElevationM ?? Math.min(...profile!.map((p) => p[1])),
          source: row.elevationSource!,
        }
      : null,
    partCount: row.partCount,
  };
}

/** The row a provider id resolves to (its own id or an alias), locked for update. */
export async function findTrailForUpdate(tx: Tx, provider: string, providerId: string): Promise<StoredTrail | null> {
  const [row] = await tx<StoredTrailRow[]>`
    select ${storedColumns(tx)}
      from public.catalog_trails t
     where t.provider = ${provider}
       and (t.provider_id = ${providerId} or t.alias_ids @> array[${providerId}]::text[])
     order by (t.provider_id = ${providerId}) desc, t.created_at asc, t.id asc
     limit 1
     for update of t`;
  return row ? toStored(row) : null;
}

/** Lock and read one trail by id. */
export async function readTrailForUpdate(tx: Tx, id: string): Promise<StoredTrail | null> {
  const [row] = await tx<StoredTrailRow[]>`select ${storedColumns(tx)} from public.catalog_trails t where t.id = ${id}::uuid for update of t`;
  return row ? toStored(row) : null;
}

/**
 * Visible trails of a provider whose id starts with `idPrefix` (e.g. OSM
 * "waygroup/") within `radiusM` of the lines, nearest first, excluding
 * trails that already received a piece from `tileKey` in this sync (two
 * pieces of one tile were deliberately kept apart by the provider).
 * Name matching is the caller's job.
 */
export async function mergeCandidates(
  tx: Tx,
  provider: string,
  idPrefix: string,
  lines: Line[],
  radiusM: number,
  tileKey: string,
  syncStart: string,
): Promise<{ id: string; name: string; distanceM: number }[]> {
  if (lines.length === 0) return [];
  let maxAbsLat = 0;
  for (const l of lines) for (const c of l) maxAbsLat = Math.max(maxAbsLat, Math.abs(c[1]));
  const dy = (radiusM * 1.2) / 111_320;
  const dx = dy / Math.max(0.01, Math.cos((Math.min(89.9, maxAbsLat) * Math.PI) / 180));
  return tx<{ id: string; name: string; distanceM: number }[]>`
    with piece as (select st_setsrid(st_geomfromgeojson(${geoJson(lines)}), 4326) as g)
    select t.id, t.name, st_distance(t.geom::geography, piece.g::geography) as distance_m
      from public.catalog_trails t, piece
     where t.provider = ${provider} and t.provider_id like ${`${escapeLike(idPrefix)}%`} and not t.hidden
       and t.geom && st_expand(piece.g, ${dx}::float8, ${dy}::float8)
       and st_dwithin(t.geom::geography, piece.g::geography, ${radiusM}::float8)
       and not exists (select 1 from public.catalog_trail_parts p
                        where p.trail_id = t.id and p.tile_key = ${tileKey} and p.synced_at >= ${syncStart}::timestamptz)
     order by distance_m asc, t.created_at asc, t.id asc
     limit 10`;
}

/** Insert or replace one piece of a merged trail (this tile's version of `partId`). */
export async function upsertPart(
  tx: Tx,
  trailId: string,
  provider: string,
  partId: string,
  tileKey: string,
  lines: Line[],
  attrs: TrailAttributes,
): Promise<void> {
  await tx`
    insert into public.catalog_trail_parts (trail_id, provider, part_id, tile_key, geom, attrs, synced_at)
    values (${trailId}::uuid, ${provider}, ${partId}, ${tileKey},
            st_multi(st_setsrid(st_geomfromgeojson(${geoJson(lines)}), 4326)),
            ${tx.json(attributesToJson(attrs) as JsonValue)}, now())
    on conflict (provider, part_id, tile_key) do update set
      trail_id = excluded.trail_id, geom = excluded.geom, attrs = excluded.attrs, synced_at = excluded.synced_at`;
}

/**
 * Create a part from a trail's current geometry when it has none (rows
 * stored before parts existed), so a merge never drops that geometry.
 */
export async function seedPartFromTrail(tx: Tx, trailId: string, tileKey: string): Promise<void> {
  await tx`
    insert into public.catalog_trail_parts (trail_id, provider, part_id, tile_key, geom, attrs, synced_at)
    select t.id, t.provider, t.provider_id, ${tileKey}, t.geom,
           jsonb_build_object('name', t.name, 'nameEn', t.name_en, 'sacScale', t.sac_scale, 'trailVisibility', t.trail_visibility,
                              'surfaces', to_jsonb(t.surfaces), 'activities', to_jsonb(t.activities), 'description', t.description,
                              'dogPolicy', t.dog_policy, 'wheelchair', t.wheelchair, 'feeRequired', t.fee_required,
                              'permitRequired', t.permit_required, 'access', t.access, 'seasonality', t.seasonality,
                              'operator', t.operator, 'website', t.website, 'tags', t.tags,
                              'sourceUpdatedAt', t.source_updated_at),
           t.last_synced_at
      from public.catalog_trails t
     where t.id = ${trailId}::uuid
       and not exists (select 1 from public.catalog_trail_parts p where p.trail_id = t.id)
    on conflict (provider, part_id, tile_key) do nothing`;
}

/**
 * Union of a trail's current parts: every part from other tiles plus the
 * parts of `tileKey` written in this sync (stale parts of this tile are
 * ignored; they are deleted when the sync completes). Overlaps, such as the
 * way that straddles a tile edge and comes back from both tiles, dissolve
 * in the unary union; ST_LineMerge then rejoins lines at degree-2 nodes.
 * Also returns every part's attributes except `exceptPart` (for merging).
 */
export async function mergedPartsGeometry(
  tx: Tx,
  trailId: string,
  tileKey: string,
  syncStart: string,
  exceptPart: { partId: string; tileKey: string } | null,
): Promise<{ lines: Line[]; partCount: number; otherAttributes: TrailAttributes[] }> {
  const parts = await tx<{ partId: string; tileKey: string; attrs: unknown }[]>`
    select p.part_id, p.tile_key, p.attrs
      from public.catalog_trail_parts p
     where p.trail_id = ${trailId}::uuid and (p.tile_key <> ${tileKey} or p.synced_at >= ${syncStart}::timestamptz)
     order by p.synced_at desc, p.part_id, p.tile_key`;
  if (parts.length === 0) return { lines: [], partCount: 0, otherAttributes: [] };
  const [geom] = await tx<{ json: string | null }[]>`
    select st_asgeojson(st_multi(st_linemerge(st_collectionextract(st_union(p.geom), 2))), 7) as json
      from public.catalog_trail_parts p
     where p.trail_id = ${trailId}::uuid and (p.tile_key <> ${tileKey} or p.synced_at >= ${syncStart}::timestamptz)`;
  const otherAttributes = parts
    .filter((p) => !(exceptPart && p.partId === exceptPart.partId && p.tileKey === exceptPart.tileKey))
    .map((p) => attributesFromJson(p.attrs))
    .filter((a): a is TrailAttributes => a !== null);
  return { lines: linesFromGeoJson(geom?.json ?? null), partCount: parts.length, otherAttributes };
}

const SLUG_CONSTRAINT = "catalog_trails_country_code_region_slug_slug_key";
const PROVIDER_ID_CONSTRAINT = "catalog_trails_provider_provider_id_key";
const MAX_SLUG_ATTEMPTS = 8;

const constraintOf = (err: unknown): string | null =>
  typeof err === "object" && err !== null && typeof (err as { constraint_name?: unknown }).constraint_name === "string"
    ? (err as { constraint_name: string }).constraint_name
    : null;
const isSlugConflict = (err: unknown) => isUniqueViolation(err) && constraintOf(err) === SLUG_CONSTRAINT;

/** First free slug for `base` in (country, region), ignoring the row `excludeId`. */
export async function allocateSlug(tx: Tx, countryCode: string, regionSlug: string, base: string, excludeId: string | null): Promise<string> {
  const rows = await tx<{ slug: string }[]>`
    select slug from public.catalog_trails
     where country_code = ${countryCode} and region_slug = ${regionSlug}
       and (slug = ${base} or slug like ${`${escapeLike(base)}-%`})
       and (${excludeId}::uuid is null or id <> ${excludeId}::uuid)`;
  return pickFreeSlug(base, new Set(rows.map((r) => r.slug)));
}

/** Column → value pairs written on insert and on every refresh. */
function derivedColumns(tx: Tx, r: TrailRecord): [string, Fragment][] {
  const profile = r.elevationProfile ? tx.json(r.elevationProfile as unknown as JsonValue) : null;
  return [
    ["name", tx`${r.name}::text`],
    ["name_en", tx`${r.nameEn}::text`],
    ["centroid", tx`st_setsrid(st_makepoint(${r.centroid.lng}::float8, ${r.centroid.lat}::float8), 4326)::geography`],
    ["trailhead", tx`st_setsrid(st_makepoint(${r.trailhead.lng}::float8, ${r.trailhead.lat}::float8), 4326)::geography`],
    ["trailhead_source", tx`${r.trailheadSource}::text`],
    ["geom", tx`st_multi(st_setsrid(st_geomfromgeojson(${geoJson(r.lines)}), 4326))`],
    ["geom_hash", tx`${r.geomHash}::text`],
    ["distance_m", tx`${r.distanceM}::int`],
    ["route_type", tx`${r.routeType}::text`],
    ["elevation_gain_m", tx`${r.elevationGainM}::int`],
    ["elevation_loss_m", tx`${r.elevationLossM}::int`],
    ["max_elevation_m", tx`${r.maxElevationM}::int`],
    ["min_elevation_m", tx`${r.minElevationM}::int`],
    ["elevation_profile", profile ? tx`${profile}` : tx`null::jsonb`],
    ["elevation_source", tx`${r.elevationSource}::text`],
    ["estimated_duration_min", tx`${r.estimatedDurationMin}::int`],
    ["hike_duration_min", tx`${r.hikeDurationMin}::int`],
    ["difficulty", tx`${r.difficulty}::text`],
    ["difficulty_source", tx`${r.difficultySource}::text`],
    ["sac_scale", tx`${r.sacScale}::text`],
    ["trail_visibility", tx`${r.trailVisibility}::text`],
    ["surfaces", tx`${r.surfaces}::text[]`],
    ["activities", tx`${r.activities as string[]}::text[]`],
    ["features", tx`${r.features as string[]}::text[]`],
    ["description", tx`${r.description}::text`],
    ["dog_policy", tx`${r.dogPolicy}::text`],
    ["wheelchair", tx`${r.wheelchair}::text`],
    ["fee_required", tx`${r.feeRequired}::boolean`],
    ["permit_required", tx`${r.permitRequired}::boolean`],
    ["access", tx`${r.access}::text`],
    ["seasonality", tx`${r.seasonality}::text`],
    ["operator", tx`${r.operator}::text`],
    ["website", tx`${r.website}::text`],
    ["has_parking", tx`${r.hasParking}::boolean`],
    ["has_toilets", tx`${r.hasToilets}::boolean`],
    ["has_drinking_water", tx`${r.hasDrinkingWater}::boolean`],
    ["has_camping", tx`${r.hasCamping}::boolean`],
    ["family_friendly", tx`${r.familyFriendly}::boolean`],
    ["tags", tx`${tx.json(r.tags as JsonValue)}`],
    ["source_name", tx`${r.sourceName}::text`],
    ["source_url", tx`${r.sourceUrl}::text`],
    ["source_license", tx`${r.sourceLicense}::text`],
    ["source_updated_at", tx`${r.sourceUpdatedAt}::timestamptz`],
    ["quality_score", tx`${r.qualityScore}::int`],
    ["last_synced_at", tx`now()`],
  ];
}

const columnList = (tx: Tx, cols: [string, Fragment][]) => tx`,`.join(cols.map(([c]) => tx(c)));
const valueList = (tx: Tx, cols: [string, Fragment][]) => tx`,`.join(cols.map(([, v]) => v));
const assignments = (tx: Tx, cols: [string, Fragment][]) => tx`,`.join(cols.map(([c, v]) => tx`${tx(c)} = ${v}`));

/**
 * Insert a new trail with a slug that is unique in its (country, region).
 * Slug races are retried in a savepoint with the next free suffix. Returns
 * null when a row with the same (provider, provider_id) appeared
 * concurrently (the caller then updates that row instead).
 */
export async function insertTrail(tx: Tx, r: TrailRecord): Promise<{ id: string; slug: string } | null> {
  for (let attempt = 1; ; attempt++) {
    const slug = await allocateSlug(tx, r.countryCode, r.regionSlug, r.baseSlug, null);
    const cols: [string, Fragment][] = [
      ["provider", tx`${r.provider}::text`],
      ["provider_id", tx`${r.providerId}::text`],
      ["slug", tx`${slug}::text`],
      ["country_code", tx`${r.countryCode}::text`],
      ["region_name", tx`${r.regionName}::text`],
      ["region_slug", tx`${r.regionSlug}::text`],
      ["nearest_place", tx`${r.nearestPlace}::text`],
      ["timezone", tx`${r.timezone}::text`],
      ...derivedColumns(tx, r),
    ];
    try {
      const rows = await tx.savepoint(
        (sp) => sp<{ id: string }[]>`
          insert into public.catalog_trails (${columnList(sp, cols)}) values (${valueList(sp, cols)})
          on conflict (provider, provider_id) do nothing
          returning id`,
      );
      return rows[0] ? { id: rows[0].id, slug } : null;
    } catch (err) {
      if (isSlugConflict(err) && attempt < MAX_SLUG_ATTEMPTS) continue;
      throw err;
    }
  }
}

export interface UpdateTrailOptions {
  /** Provider id to record as an alias of this row (a merged piece). */
  alias: string | null;
}

/**
 * Refresh an existing trail in place: geometry, derived fields and
 * last_synced_at. Identity stays stable:
 *  - provider_id, id and slug are kept; once the row has a known region,
 *    country/region/slug never change (saved links and SEO);
 *  - a row whose region is still "unknown" moves to the new country/region
 *    when the new data knows more, with a slug allocated there;
 *  - nearest_place / timezone are only overwritten with known values;
 *  - a trail retired by ingestion is un-hidden (it is back in the source);
 *    a trail hidden by moderation stays hidden.
 */
export async function updateTrail(tx: Tx, stored: StoredTrail, r: TrailRecord, opts: UpdateTrailOptions): Promise<{ slug: string }> {
  const regionKnown = stored.regionSlug !== UNKNOWN_REGION_SLUG;
  const upgrade =
    !regionKnown &&
    (r.countryCode !== stored.countryCode || r.regionSlug !== stored.regionSlug) &&
    (r.regionSlug !== UNKNOWN_REGION_SLUG || (stored.countryCode === UNKNOWN_COUNTRY_CODE && r.countryCode !== UNKNOWN_COUNTRY_CODE));
  const alias = opts.alias && opts.alias !== stored.providerId && !stored.aliasIds.includes(opts.alias) ? opts.alias : null;

  for (let attempt = 1; ; attempt++) {
    const identity: [string, Fragment][] = upgrade
      ? [
          ["slug", tx`${await allocateSlug(tx, r.countryCode, r.regionSlug, r.baseSlug, stored.id)}::text`],
          ["country_code", tx`${r.countryCode}::text`],
          ["region_name", tx`${r.regionName}::text`],
          ["region_slug", tx`${r.regionSlug}::text`],
        ]
      : [];
    const cols: [string, Fragment][] = [
      ...identity,
      ["nearest_place", tx`coalesce(${r.nearestPlace}::text, t.nearest_place)`],
      ["timezone", tx`coalesce(${r.timezone}::text, t.timezone)`],
      ...derivedColumns(tx, r),
      ["alias_ids", alias ? tx`array_append(t.alias_ids, ${alias}::text)` : tx`t.alias_ids`],
      ["hidden", tx`case when t.retired_at is not null then false else t.hidden end`],
      ["hidden_reason", tx`case when t.retired_at is not null then null else t.hidden_reason end`],
      ["retired_at", tx`null::timestamptz`],
    ];
    try {
      const [row] = await tx.savepoint(
        (sp) => sp<{ slug: string }[]>`
          update public.catalog_trails t set ${assignments(sp, cols)}
           where t.id = ${stored.id}::uuid
          returning t.slug`,
      );
      if (!row) throw new Error(`catalog trail ${stored.id} disappeared during update`);
      return { slug: row.slug };
    } catch (err) {
      if (isSlugConflict(err) && upgrade && attempt < MAX_SLUG_ATTEMPTS) continue;
      throw err;
    }
  }
}

/** True for a unique violation on (provider, provider_id). */
export const isProviderIdConflict = (err: unknown) => isUniqueViolation(err) && constraintOf(err) === PROVIDER_ID_CONSTRAINT;

// ---------------------------------------------------------------------------
// Retirement (after a successful, complete sync of a tile)
// ---------------------------------------------------------------------------

export interface RetireResult {
  /** Trails hidden because the source no longer has them. */
  retired: number;
  /** Stale parts removed from merged trails. */
  partsRemoved: number;
  /** Tiles made due because a merged trail lost a piece and must be rebuilt from them. */
  tilesMadeDue: number;
}

/**
 * Retire what a complete sync of `tile` (started at `syncStart`) did not see:
 *  1. parts of merged trails that came from this tile and were not returned
 *     are deleted; a trail left with no part at all is retired; a trail that
 *     still has parts from other tiles gets those tiles marked due, so their
 *     next refresh rebuilds it from current data;
 *  2. trails without parts (route relations, single-tile trails stored
 *     before parts existed) are retired when this tile OWNS them and they
 *     were not synced in this run. A tile owns a trail when the trail's
 *     first vertex lies in it (half-open [w, e) × [s, n)): a vertex is ON
 *     the route, so the owning tile's response always includes the trail
 *     while it exists (a centroid can lie off the route, e.g. inside a loop
 *     around a massif, where no tile response would contain it).
 * Retired trails are hidden (never deleted: saved trails reference them)
 * with an honest reason; ingestion un-hides them if they reappear.
 */
export async function retireMissing(
  tx: Tx,
  layer: CatalogLayer,
  provider: string,
  tile: Tile,
  syncStart: string,
  reason: string,
): Promise<RetireResult> {
  const removed = await tx<{ trailId: string }[]>`
    delete from public.catalog_trail_parts p
     where p.provider = ${provider} and p.tile_key = ${tile.key} and p.synced_at < ${syncStart}::timestamptz
    returning p.trail_id`;
  const affected = [...new Set(removed.map((r) => r.trailId))];

  let tilesMadeDue = 0;
  if (affected.length > 0) {
    const survivors = await tx<{ provider: string; tileKey: string }[]>`
      select distinct p.provider, p.tile_key
        from public.catalog_trail_parts p
        join public.catalog_trails t on t.id = p.trail_id
       where p.trail_id = any(${affected}::uuid[]) and t.last_synced_at < ${syncStart}::timestamptz`;
    tilesMadeDue = await markTilesDue(tx, layer, survivors);
  }

  const [w, s, e, n] = tile.bbox;
  const first = tx`st_pointn(st_geometryn(t.geom, 1), 1)`;
  const retired = await tx`
    update public.catalog_trails t
       set hidden = true, hidden_reason = ${reason}, retired_at = now()
     where t.provider = ${provider} and not t.hidden and t.last_synced_at < ${syncStart}::timestamptz
       and not exists (select 1 from public.catalog_trail_parts p where p.trail_id = t.id)
       and (t.id = any(${affected}::uuid[])
            or (t.geom && st_makeenvelope(${w}::float8, ${s}::float8, ${e}::float8, ${n}::float8, 4326)
                and ${inTile(tx, tx`st_x(${first})`, tx`st_y(${first})`, tile)}))
    returning t.id`;
  if (retired.length > 0) log.info("catalog.trails_retired", { tileKey: tile.key, provider, count: retired.length });
  return { retired: retired.length, partsRemoved: removed.length, tilesMadeDue };
}
