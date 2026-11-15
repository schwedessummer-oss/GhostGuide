-- ============================================================================
-- Trail catalog ingestion support (Phase 1, additive)
--
-- On-demand tile ingestion (src/server/trails/ingest.ts) needs a little more
-- state than 20261112000000_trail_catalog.sql provides:
--
--   catalog_trails.alias_ids
--     Other provider ids that resolve to this row. OpenStreetMap "way group"
--     trails (named ways without a route relation) only see the ways of one
--     tile, so a trail crossing a tile edge comes back from each tile as a
--     partial piece, possibly under a different "waygroup/<id>". The pieces
--     are merged into the first row; the other ids are recorded here so a
--     later refresh of either tile updates the same row (lookup by
--     provider_id OR alias).
--
--   catalog_trails.retired_at
--     Set when ingestion hides a trail because the source no longer has it
--     (hidden_reason says so). Only retired trails are un-hidden when they
--     reappear; a trail hidden by moderation (retired_at null) stays hidden.
--
--   catalog_trails.geom_hash
--     Fingerprint of the stored geometry. A refresh with identical geometry
--     reuses the stored DEM elevation profile instead of re-sampling terrain
--     tiles (and keeps it when the terrain service is down).
--
--   catalog_trail_parts
--     The per-tile pieces a merged way-group trail was assembled from
--     (geometry + the attributes of that piece). The row's geometry is the
--     PostGIS union of its parts; a refresh of one tile replaces only that
--     tile's part, and a piece that disappears from its tile is removed
--     without touching the parts other tiles contributed.
--
-- Access: server only (RLS on, no policies, no grants), like catalog_tiles.
-- The new catalog_trails columns are covered by the existing public SELECT
-- grant; they carry provider ids and timestamps only.
-- ============================================================================

alter table public.catalog_trails
  add column alias_ids text[] not null default '{}',
  add column retired_at timestamptz,
  add column geom_hash text check (geom_hash is null or geom_hash ~ '^[0-9a-f]{16,64}$');

create index catalog_trails_alias_ids_idx on public.catalog_trails using gin (alias_ids);

create table public.catalog_trail_parts (
  trail_id uuid not null references public.catalog_trails (id) on delete cascade,
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  -- Provider id of the piece, e.g. 'waygroup/123'.
  part_id text not null check (length(part_id) between 1 and 200),
  -- Tile whose response contained the piece (src/server/geo/tiles.ts key).
  tile_key text not null check (tile_key ~ '^[0-9.]+/[0-9]+/[0-9]+$'),
  geom extensions.geometry(MultiLineString, 4326) not null,
  -- Normalized attributes of the piece (sac_scale, surfaces, ...), recombined on merge.
  attrs jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  primary key (provider, part_id, tile_key)
);
create index catalog_trail_parts_trail_idx on public.catalog_trail_parts (trail_id);
create index catalog_trail_parts_tile_idx on public.catalog_trail_parts (provider, tile_key, synced_at);

alter table public.catalog_trail_parts enable row level security;
revoke all on public.catalog_trail_parts from anon, authenticated;
