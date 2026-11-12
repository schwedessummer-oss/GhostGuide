-- ============================================================================
-- Trail catalog (Phase 1: real data)
--
-- Real trails and points of interest from open / official data providers
-- (OpenStreetMap via Overpass, Recreation.gov RIDB, future official sources),
-- normalized into one schema and stored with PostGIS. Data is loaded on
-- demand per geographic tile and refreshed by background jobs; nothing here
-- is invented. Every row carries its source, license and sync time.
--
-- Separate from the curated `public.trails` table (fictional demo region and
-- guided-route product): catalog rows are provider data, never edited by hand
-- except for moderation (`hidden`).
--
-- Access:
--   catalog_trails / catalog_pois  public read (open data), system writes only
--   saved_trails                   owner only (RLS)
--   tiles, caches, usage, throttle server only (RLS on, no policies, no grants)
-- ============================================================================

create schema if not exists extensions;
create extension if not exists postgis with schema extensions;

-- ---------------------------------------------------------------------------
-- Trails
-- ---------------------------------------------------------------------------
create table public.catalog_trails (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  provider_id text not null check (length(provider_id) between 1 and 200),
  name text not null check (length(name) between 1 and 300),
  name_en text check (name_en is null or length(name_en) between 1 and 300),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 120),
  country_code text not null default 'xx' check (country_code ~ '^[a-z]{2}$'),
  region_name text,
  region_slug text not null default 'unknown' check (region_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(region_slug) <= 80),
  nearest_place text,
  timezone text,
  centroid extensions.geography(Point, 4326) not null,
  trailhead extensions.geography(Point, 4326),
  trailhead_source text check (trailhead_source in ('osm_trailhead', 'parking', 'route_start', 'official')),
  geom extensions.geometry(MultiLineString, 4326) not null,
  -- Total mapped length of the route geometry (one traversal), metres.
  distance_m integer not null check (distance_m > 0),
  route_type text not null default 'unknown' check (route_type in ('loop', 'linear', 'network', 'unknown')),
  elevation_gain_m integer check (elevation_gain_m >= 0),
  elevation_loss_m integer check (elevation_loss_m >= 0),
  max_elevation_m integer,
  min_elevation_m integer,
  -- [[distance_m, elevation_m], ...] downsampled (<= 300 points); estimate from a DEM.
  elevation_profile jsonb,
  elevation_source text,
  -- One traversal of the mapped route (loop, or one way for linear routes); an estimate.
  estimated_duration_min integer check (estimated_duration_min > 0),
  difficulty text not null default 'unknown' check (difficulty in ('easy', 'moderate', 'hard', 'expert', 'unknown')),
  difficulty_source text check (difficulty_source in ('osm_sac_scale', 'estimated', 'official')),
  sac_scale text,
  trail_visibility text,
  surfaces text[] not null default '{}',
  activities text[] not null default '{}',
  features text[] not null default '{}',
  -- Provider-supplied text only (e.g. OSM description tag). Never generated.
  description text,
  dog_policy text not null default 'unknown' check (dog_policy in ('allowed', 'leashed', 'not_allowed', 'unknown')),
  wheelchair text not null default 'unknown' check (wheelchair in ('yes', 'limited', 'no', 'unknown')),
  fee_required boolean,
  permit_required boolean,
  access text,
  seasonality text,
  operator text,
  website text,
  has_parking boolean not null default false,
  has_toilets boolean not null default false,
  has_drinking_water boolean not null default false,
  has_camping boolean not null default false,
  family_friendly boolean not null default false,
  -- Provider tags kept verbatim for provenance and future re-normalization.
  tags jsonb not null default '{}'::jsonb,
  source_name text not null,
  source_url text,
  source_license text not null,
  source_updated_at timestamptz,
  last_synced_at timestamptz not null default now(),
  quality_score smallint not null default 0 check (quality_score between 0 and 100),
  hidden boolean not null default false,
  hidden_reason text,
  search_text tsvector generated always as (
    to_tsvector('simple',
      coalesce(name, '') || ' ' || coalesce(name_en, '') || ' ' || coalesce(nearest_place, '') || ' ' || coalesce(region_name, ''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_id),
  unique (country_code, region_slug, slug)
);
create index catalog_trails_geom_idx on public.catalog_trails using gist (geom);
create index catalog_trails_centroid_idx on public.catalog_trails using gist (centroid);
create index catalog_trails_search_idx on public.catalog_trails using gin (search_text);
create index catalog_trails_features_idx on public.catalog_trails using gin (features);
create index catalog_trails_distance_idx on public.catalog_trails (distance_m);
create index catalog_trails_synced_idx on public.catalog_trails (last_synced_at);
create trigger catalog_trails_updated_at before update on public.catalog_trails
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Points of interest (outdoor features near trails; services near trailheads)
-- ---------------------------------------------------------------------------
create table public.catalog_pois (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  provider_id text not null check (length(provider_id) between 1 and 200),
  layer text not null check (layer in ('outdoor', 'services')),
  category text not null check (category in (
    -- outdoor
    'trailhead', 'parking', 'toilets', 'drinking_water', 'shelter', 'campsite', 'viewpoint', 'peak',
    'waterfall', 'lake', 'spring', 'cave', 'picnic_site', 'ranger_station', 'information',
    -- services
    'fuel', 'ev_charging', 'restaurant', 'fast_food', 'cafe', 'lodging', 'supermarket', 'convenience',
    'outdoor_shop', 'hospital', 'clinic', 'pharmacy'
  )),
  name text,
  name_en text,
  location extensions.geography(Point, 4326) not null,
  elevation_m integer,
  tags jsonb not null default '{}'::jsonb,
  opening_hours text,
  phone text,
  website text,
  source_name text not null,
  source_url text,
  source_license text not null,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_id)
);
create index catalog_pois_location_idx on public.catalog_pois using gist (location);
create index catalog_pois_layer_category_idx on public.catalog_pois (layer, category);
create trigger catalog_pois_updated_at before update on public.catalog_pois
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Coverage: which geographic tiles have been loaded from which provider.
-- tile_key = '<deg>/<ix>/<iy>' on a fixed degree grid (src/server/geo/tiles.ts).
-- ---------------------------------------------------------------------------
create table public.catalog_tiles (
  layer text not null check (layer in ('outdoor', 'services')),
  provider text not null,
  tile_key text not null check (tile_key ~ '^[0-9.]+/[0-9]+/[0-9]+$'),
  bounds extensions.geometry(Polygon, 4326) not null,
  status text not null default 'pending' check (status in ('pending', 'fetching', 'ready', 'failed')),
  trail_count integer not null default 0,
  poi_count integer not null default 0,
  attempts integer not null default 0,
  last_error text,
  requested_at timestamptz not null default now(),
  fetch_started_at timestamptz,
  last_synced_at timestamptz,
  next_refresh_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (layer, provider, tile_key)
);
create index catalog_tiles_bounds_idx on public.catalog_tiles using gist (bounds);
create index catalog_tiles_refresh_idx on public.catalog_tiles (status, next_refresh_at);
create trigger catalog_tiles_updated_at before update on public.catalog_tiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Caches (respect each provider's caching terms; see docs/INTEGRATIONS.md)
-- ---------------------------------------------------------------------------
create table public.geocode_cache (
  provider text not null,
  query_key text not null,
  results jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (provider, query_key)
);
create index geocode_cache_expires_idx on public.geocode_cache (expires_at);

-- Reverse-geocoded administrative names on a coarse grid (country/region/place).
create table public.geo_admin_cache (
  provider text not null,
  cell_key text not null,
  country_code text,
  region_name text,
  nearest_place text,
  payload jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (provider, cell_key)
);

create table public.weather_cache (
  provider text not null,
  cache_key text not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_modified text,
  primary key (provider, cache_key)
);
create index weather_cache_expires_idx on public.weather_cache (expires_at);

-- ---------------------------------------------------------------------------
-- External API usage (per provider per UTC day) and global request spacing
-- ---------------------------------------------------------------------------
create table public.external_api_usage (
  provider text not null,
  day date not null,
  requests integer not null default 0,
  errors integer not null default 0,
  cache_hits integer not null default 0,
  bytes bigint not null default 0,
  last_status integer,
  last_error text,
  last_request_at timestamptz,
  last_success_at timestamptz,
  primary key (provider, day)
);

-- Serializes requests to providers with a global rate policy (e.g. Nominatim
-- allows at most 1 request per second per application).
create table public.provider_throttle (
  provider text primary key,
  next_allowed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Saved trails (per user)
-- ---------------------------------------------------------------------------
create table public.saved_trails (
  user_id uuid not null references auth.users (id) on delete cascade,
  trail_id uuid not null references public.catalog_trails (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, trail_id)
);
create index saved_trails_trail_idx on public.saved_trails (trail_id);

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------
alter table public.catalog_trails enable row level security;
alter table public.catalog_pois enable row level security;
alter table public.catalog_tiles enable row level security;
alter table public.geocode_cache enable row level security;
alter table public.geo_admin_cache enable row level security;
alter table public.weather_cache enable row level security;
alter table public.external_api_usage enable row level security;
alter table public.provider_throttle enable row level security;
alter table public.saved_trails enable row level security;

-- Open data: readable by everyone; writes only by trusted server code.
revoke all on public.catalog_trails, public.catalog_pois from anon, authenticated;
grant select on public.catalog_trails, public.catalog_pois to anon, authenticated;
create policy catalog_trails_public_read on public.catalog_trails
  for select to anon, authenticated using (not hidden);
create policy catalog_pois_public_read on public.catalog_pois
  for select to anon, authenticated using (true);

-- Server-only tables.
revoke all on public.catalog_tiles, public.geocode_cache, public.geo_admin_cache, public.weather_cache,
  public.external_api_usage, public.provider_throttle from anon, authenticated;

-- Saved trails: owner only.
revoke all on public.saved_trails from anon, authenticated;
grant select, insert, delete on public.saved_trails to authenticated;
create policy saved_trails_owner_select on public.saved_trails
  for select to authenticated using (user_id = auth.uid());
create policy saved_trails_owner_insert on public.saved_trails
  for insert to authenticated with check (user_id = auth.uid());
create policy saved_trails_owner_delete on public.saved_trails
  for delete to authenticated using (user_id = auth.uid());
