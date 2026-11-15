-- ============================================================================
-- OpenStreetMap data (ODbL), in its own schema (docs/PLAN.md §3 "OSM", §4.4).
--
--  * Everything taken from or computed from OSM geometry lives here and only
--    here: raw elements, assembled routes, points near a route, and route
--    metrics (length, elevation profile, gain/loss, high point) computed from
--    the OSM line plus a DEM. Our catalog tables never copy these values, so
--    this schema can be exported under ODbL on request.
--  * Raw elements and points must come from an ODbL source record: their
--    license_code is fixed to 'ODbL-1.0' and a composite foreign key proves
--    the source record carries that licence.
--  * Route metrics are tied to the exact route geometry they were computed
--    from (geom_hash): the route's hash cannot change while metrics for the
--    old geometry exist, so stale metrics have to be deleted first.
--  * We never correct, verify or geocode our own data against OSM.
--
-- public.hike_routes (a hike's OSM or official route) is created at the end
-- because it references both schemas.
-- ============================================================================

create schema if not exists osm;
comment on schema osm is 'OpenStreetMap-derived data (ODbL 1.0). © OpenStreetMap contributors.';
revoke all on schema osm from public;
grant usage on schema osm to service_role;
alter default privileges in schema osm revoke all on tables from public, anon, authenticated;
alter default privileges in schema osm revoke execute on functions from public, anon, authenticated;

create type osm.point_kind as enum (
  'trailhead', 'parking', 'toilets', 'drinking_water', 'shelter', 'hut', 'campsite', 'viewpoint',
  'peak', 'bus_stop', 'train_station', 'information', 'other'
);

create table osm.elements (
  osm_type char(1) not null check (osm_type in ('n', 'w', 'r')),
  osm_id bigint not null check (osm_id > 0),
  version integer not null check (version > 0),
  tags jsonb not null default '{}'::jsonb check (jsonb_typeof(tags) = 'object'),
  -- Way node refs or relation members, as delivered by Overpass.
  members jsonb check (members is null or jsonb_typeof(members) = 'array'),
  geom extensions.geometry(Geometry, 4326),
  source_record_id uuid not null,
  license_code text not null default 'ODbL-1.0' check (license_code = 'ODbL-1.0'),
  primary key (osm_type, osm_id),
  constraint elements_odbl_source foreign key (source_record_id, license_code)
    references public.source_records (id, license_code)
);
create index elements_source_record_idx on osm.elements (source_record_id);

create table osm.routes (
  id uuid primary key default gen_random_uuid(),
  hike_id uuid references public.hikes (id) on delete set null,
  relation_ids bigint[] not null default '{}',
  way_ids bigint[] not null default '{}',
  geom extensions.geometry(MultiLineString, 4326) not null,
  geom_simplified extensions.geometry(MultiLineString, 4326),
  geom_hash text not null check (btrim(geom_hash) <> ''),
  length_m numeric(10, 1) check (length_m > 0),
  -- The source_records (ODbL) the route was assembled from.
  built_from uuid[] not null default '{}',
  built_at timestamptz not null default now(),
  check (cardinality(relation_ids) + cardinality(way_ids) > 0),
  unique (id, geom_hash)
);
create index routes_hike_idx on osm.routes (hike_id);
create index routes_geom_idx on osm.routes using gist (geom);
create index routes_relation_ids_idx on osm.routes using gin (relation_ids);
create index routes_way_ids_idx on osm.routes using gin (way_ids);

create table osm.points (
  id uuid primary key default gen_random_uuid(),
  osm_type char(1) not null check (osm_type in ('n', 'w', 'r')),
  osm_id bigint not null check (osm_id > 0),
  kind osm.point_kind not null,
  name text,
  tags jsonb not null default '{}'::jsonb check (jsonb_typeof(tags) = 'object'),
  geom extensions.geometry(Point, 4326) not null,
  hike_id uuid references public.hikes (id) on delete cascade,
  distance_to_route_m numeric(10, 1) check (distance_to_route_m >= 0),
  source_record_id uuid not null,
  license_code text not null default 'ODbL-1.0' check (license_code = 'ODbL-1.0'),
  constraint points_odbl_source foreign key (source_record_id, license_code)
    references public.source_records (id, license_code),
  unique nulls not distinct (osm_type, osm_id, hike_id)
);
create index points_hike_kind_idx on osm.points (hike_id, kind);
create index points_geom_idx on osm.points using gist (geom);
create index points_source_record_idx on osm.points (source_record_id);

create table osm.route_metrics (
  route_id uuid primary key,
  length_m numeric(10, 1) not null check (length_m > 0),
  gain_m integer check (gain_m >= 0),
  loss_m integer check (loss_m >= 0),
  high_point_m integer check (high_point_m between -500 and 9000),
  low_point_m integer check (low_point_m between -500 and 9000),
  -- [[distance_m, elevation_m], ...] sampled along the route.
  profile jsonb check (profile is null or jsonb_typeof(profile) = 'array'),
  -- DEM tile record (its licence is gated in public.source_records).
  dem_source_record_id uuid references public.source_records (id),
  method_version text not null,
  geom_hash text not null,
  computed_at timestamptz not null default now(),
  check (low_point_m is null or high_point_m is null or low_point_m <= high_point_m),
  constraint route_metrics_current_geometry foreign key (route_id, geom_hash)
    references osm.routes (id, geom_hash) on delete cascade
);
create index route_metrics_dem_source_record_idx on osm.route_metrics (dem_source_record_id);

alter table osm.elements enable row level security;
alter table osm.routes enable row level security;
alter table osm.points enable row level security;
alter table osm.route_metrics enable row level security;

-- ---------------------------------------------------------------------------
-- public.hike_routes: links a hike to exactly one OSM route or official route
-- ---------------------------------------------------------------------------
create type public.hike_route_kind as enum ('osm', 'official');

create table public.hike_routes (
  id uuid primary key default gen_random_uuid(),
  hike_id uuid not null references public.hikes (id) on delete cascade,
  kind public.hike_route_kind not null,
  osm_route_id uuid references osm.routes (id) on delete cascade,
  official_route_id uuid references public.official_routes (id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  constraint hike_routes_exactly_one check (num_nonnulls(osm_route_id, official_route_id) = 1),
  constraint hike_routes_kind_matches check ((kind = 'osm') = (osm_route_id is not null)),
  unique (hike_id, osm_route_id),
  unique (hike_id, official_route_id)
);
create unique index hike_routes_one_primary on public.hike_routes (hike_id) where is_primary;
create index hike_routes_osm_route_idx on public.hike_routes (osm_route_id);
create index hike_routes_official_route_idx on public.hike_routes (official_route_id);
alter table public.hike_routes enable row level security;
