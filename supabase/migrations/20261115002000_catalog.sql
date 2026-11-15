-- ============================================================================
-- Our catalog (docs/PLAN.md §3 "Our catalog"): curated, every value traceable.
--
--  * hikes holds identity plus the PUBLISHED value of each non-OSM fact. All
--    fact columns are nullable: a null shows "Check the official site".
--  * hike_facts is the field-level history behind those values. Each row
--    needs a source record; its licence is inherited from that record through
--    a composite foreign key, so the licence gate applies to facts too.
--    Publishing copies current verified facts into hikes (one writer).
--  * Nothing computed from OSM geometry is stored here (PLAN §4.4): routes,
--    points and route metrics live in schema osm (next migration).
--  * Fees, rules, hazards, permits, stages, official routes, places and FX
--    rates each require a source record.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
create type public.area_kind as enum (
  'national_park', 'state_park', 'provincial_park', 'regional_park', 'nature_reserve', 'protected_area',
  'wilderness', 'national_forest', 'conservation_area', 'world_heritage_site', 'heritage_route', 'region', 'other'
);
create type public.trip_type as enum ('day', 'overnight', 'multi_day');
create type public.access_mode as enum ('independent', 'licensed_operator_required', 'guide_recommended');
create type public.distance_basis as enum ('round_trip', 'one_way', 'loop');
create type public.hike_route_type as enum ('loop', 'out_and_back', 'point_to_point');
create type public.permit_requirement as enum ('yes', 'no', 'seasonal', 'conditional');
create type public.publish_status as enum ('draft', 'review', 'published', 'archived');
create type public.operating_status as enum ('open', 'seasonal', 'partially_closed', 'closed', 'unknown');
create type public.fact_method as enum ('ingested', 'curated', 'calculated');
create type public.permit_kind as enum (
  'day_use', 'overnight', 'lottery', 'quota', 'timed_entry', 'vehicle_reservation', 'parking',
  'trekking_card', 'restricted_area', 'other'
);
create type public.fee_unit as enum (
  'per_person', 'per_vehicle', 'per_group', 'per_night', 'per_day', 'per_application', 'per_trip'
);
create type public.fee_audience as enum ('all', 'adult', 'child', 'resident', 'non_resident', 'senior', 'student');
create type public.rule_kind as enum ('dogs', 'drones', 'camping', 'fires', 'group_size');
create type public.rule_value as enum ('allowed', 'not_allowed', 'restricted');
create type public.hazard_type as enum (
  'heat', 'cold', 'altitude', 'flash_flood', 'river_crossing', 'exposure', 'rockfall', 'avalanche',
  'lightning', 'weather', 'wildlife', 'remoteness', 'volcanic', 'tides', 'security_advisory', 'other'
);
create type public.area_text_source as enum ('wikivoyage', 'wikipedia');
create type public.place_kind as enum ('town', 'sight');

-- ---------------------------------------------------------------------------
-- Money: currencies (ISO 4217 with decimals) and dated, sourced FX rates
-- ---------------------------------------------------------------------------
create table public.currencies (
  code char(3) primary key check (code ~ '^[A-Z]{3}$'),
  name text not null,
  minor_unit smallint not null check (minor_unit between 0 and 4)
);
comment on column public.currencies.minor_unit is 'ISO 4217 decimals: JPY 0, USD 2, JOD 3. Amounts are stored in minor units.';

-- Currencies of the seed countries (docs/PLAN.md §9).
insert into public.currencies (code, name, minor_unit) values
  ('USD', 'US dollar', 2), ('CAD', 'Canadian dollar', 2), ('MXN', 'Mexican peso', 2),
  ('GTQ', 'Guatemalan quetzal', 2), ('CRC', 'Costa Rican colón', 2),
  ('PEN', 'Peruvian sol', 2), ('CLP', 'Chilean peso', 0), ('ARS', 'Argentine peso', 2),
  ('COP', 'Colombian peso', 2), ('BRL', 'Brazilian real', 2),
  ('EUR', 'Euro', 2), ('GBP', 'Pound sterling', 2), ('CHF', 'Swiss franc', 2),
  ('SEK', 'Swedish krona', 2), ('NOK', 'Norwegian krone', 2), ('ISK', 'Icelandic króna', 0),
  ('PLN', 'Polish złoty', 2), ('BGN', 'Bulgarian lev', 2), ('TRY', 'Turkish lira', 2),
  ('TZS', 'Tanzanian shilling', 2), ('KES', 'Kenyan shilling', 2), ('MAD', 'Moroccan dirham', 2),
  ('NAD', 'Namibian dollar', 2), ('ZAR', 'South African rand', 2), ('MWK', 'Malawian kwacha', 2),
  ('UGX', 'Ugandan shilling', 0),
  ('NPR', 'Nepalese rupee', 2), ('HKD', 'Hong Kong dollar', 2), ('INR', 'Indian rupee', 2),
  ('JPY', 'Japanese yen', 0), ('TWD', 'New Taiwan dollar', 2), ('KRW', 'South Korean won', 0),
  ('CNY', 'Chinese yuan', 2), ('MYR', 'Malaysian ringgit', 2), ('IDR', 'Indonesian rupiah', 2),
  ('KGS', 'Kyrgyzstani som', 2), ('GEL', 'Georgian lari', 2), ('JOD', 'Jordanian dinar', 3),
  ('OMR', 'Omani rial', 3),
  ('NZD', 'New Zealand dollar', 2), ('AUD', 'Australian dollar', 2), ('PGK', 'Papua New Guinean kina', 2);

create table public.fx_rates (
  id uuid primary key default gen_random_uuid(),
  base char(3) not null references public.currencies (code),
  quote char(3) not null references public.currencies (code),
  rate numeric(24, 10) not null check (rate > 0),
  as_of date not null,
  source_record_id uuid not null references public.source_records (id),
  created_at timestamptz not null default now(),
  check (base <> quote),
  unique (base, quote, as_of)
);
create index fx_rates_source_record_idx on public.fx_rates (source_record_id);

-- ---------------------------------------------------------------------------
-- Agencies, areas, macro-regions
-- ---------------------------------------------------------------------------
create table public.agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  country_code char(2) check (country_code ~ '^[A-Z]{2}$'),
  official_url text check (official_url ~ '^https?://'),
  wikidata_qid text unique check (wikidata_qid ~ '^Q[1-9][0-9]*$'),
  source_record_id uuid references public.source_records (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index agencies_source_record_idx on public.agencies (source_record_id);
create trigger agencies_updated_at before update on public.agencies
  for each row execute function public.set_updated_at();

create table public.areas (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  kind public.area_kind not null default 'other',
  country_code char(2) check (country_code ~ '^[A-Z]{2}$'),
  subdivision_code text check (subdivision_code ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$'),
  timezone text check (timezone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)*$'),
  official_url text check (official_url ~ '^https?://'),
  booking_url text check (booking_url ~ '^https?://'),
  wikidata_qid text unique check (wikidata_qid ~ '^Q[1-9][0-9]*$'),
  agency_id uuid references public.agencies (id) on delete set null,
  source_record_id uuid references public.source_records (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (subdivision_code is null or country_code is null or left(subdivision_code, 2) = country_code)
);
create index areas_agency_idx on public.areas (agency_id);
create index areas_source_record_idx on public.areas (source_record_id);
create trigger areas_updated_at before update on public.areas
  for each row execute function public.set_updated_at();

create table public.macro_regions (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null check (btrim(name) <> ''),
  created_at timestamptz not null default now()
);

create table public.area_macro_regions (
  area_id uuid not null references public.areas (id) on delete cascade,
  macro_region_id uuid not null references public.macro_regions (id) on delete cascade,
  primary key (area_id, macro_region_id)
);
create index area_macro_regions_region_idx on public.area_macro_regions (macro_region_id);

-- ---------------------------------------------------------------------------
-- Hikes
-- ---------------------------------------------------------------------------
create table public.hikes (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 100),
  seed_no integer unique check (seed_no > 0),
  name text not null check (btrim(name) <> '' and char_length(name) <= 200),
  alt_names text[] not null default '{}',
  route_variant text,
  region_group text check (region_group in (
    'north-central-america', 'south-america', 'europe', 'africa', 'asia-middle-east', 'oceania')),
  -- ISO 3166-1 alpha-2 in route order; country_code is the primary one.
  countries char(2)[] not null default '{}'
    check (array_to_string(countries, ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$'),
  country_code char(2) check (country_code ~ '^[A-Z]{2}$'),
  subdivision_codes text[] not null default '{}'
    check (array_to_string(subdivision_codes, ',') ~ '^([A-Z]{2}-[A-Z0-9]{1,3}(,[A-Z]{2}-[A-Z0-9]{1,3})*)?$'),
  area_id uuid references public.areas (id) on delete set null,
  agency_id uuid references public.agencies (id) on delete set null,
  wikidata_qid text unique check (wikidata_qid ~ '^Q[1-9][0-9]*$'),
  official_url text check (official_url ~ '^https?://'),
  trip_type public.trip_type,
  typical_days smallint check (typical_days between 1 and 60),
  access_mode public.access_mode not null default 'independent',
  -- Seed flags (ingest/DATA_FORMATS.md).
  flags text[] not null default '{}' check (array_to_string(flags, ',') ~
    '^((gr_route_geometry_withheld|operator_only|advisory|seasonal_access|fallback_for:[a-z0-9-]+)(,(?!$)|$))*$'),

  -- Published values of non-OSM facts (copied from current hike_facts).
  distance_km numeric(7, 2) check (distance_km > 0),
  distance_basis public.distance_basis,
  elevation_gain_m integer check (elevation_gain_m >= 0),
  high_point_m integer check (high_point_m between -500 and 9000),
  duration_min_minutes integer check (duration_min_minutes > 0),
  duration_max_minutes integer check (duration_max_minutes > 0),
  duration_min_days smallint check (duration_min_days > 0),
  duration_max_days smallint check (duration_max_days > 0),
  route_type public.hike_route_type,
  difficulty_official jsonb check (difficulty_official is null or jsonb_typeof(difficulty_official) = 'object'),
  best_months smallint[] check (best_months <@ '{1,2,3,4,5,6,7,8,9,10,11,12}'::smallint[]),
  season_note text,
  permit_required public.permit_requirement,
  parking text,
  trailhead_access text,
  public_transport text,
  nearest_town text,

  status public.publish_status not null default 'draft',
  operating_status public.operating_status not null default 'unknown',
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint hikes_primary_country_listed check (country_code is null or country_code = any (countries)),
  constraint hikes_distance_basis_needs_distance check (distance_basis is null or distance_km is not null),
  constraint hikes_duration_minutes_order check (duration_max_minutes is null or duration_min_minutes is null
    or duration_min_minutes <= duration_max_minutes),
  constraint hikes_duration_days_order check (duration_max_days is null or duration_min_days is null
    or duration_min_days <= duration_max_days)
);
create index hikes_status_idx on public.hikes (status);
create index hikes_area_idx on public.hikes (area_id);
create index hikes_agency_idx on public.hikes (agency_id);
create index hikes_country_idx on public.hikes (country_code);
create trigger hikes_updated_at before update on public.hikes
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Field-level provenance with history
-- ---------------------------------------------------------------------------
create table public.hike_facts (
  id uuid primary key default gen_random_uuid(),
  hike_id uuid not null references public.hikes (id) on delete cascade,
  -- Fields of ingest/DATA_FORMATS.md ("Fields and value types").
  field text not null check (field in (
    'distance_km', 'elevation_gain_m', 'high_point_m', 'duration', 'route_type', 'difficulty_official',
    'best_months', 'season_note', 'permit_required', 'permit', 'fee', 'entry_fee_none', 'parking',
    'trailhead_access', 'public_transport', 'rule_dogs', 'rule_drones', 'rule_camping', 'rule_fires',
    'rule_group_size', 'hazard', 'nearest_town', 'access_mode', 'licensed_operator_list_url', 'closure',
    'official_url'
  )),
  -- Multi-valued fields (permit, fee, hazard) name each value, e.g. the
  -- permit name, "<fee name>|<audience>|<unit>" or the hazard type.
  value_key text check (value_key is null or btrim(value_key) <> ''),
  value jsonb not null,
  basis public.distance_basis,
  note text check (char_length(note) <= 300),
  method public.fact_method not null,
  source_record_id uuid not null,
  license_code text not null,
  checked_at timestamptz,
  verified boolean not null default false,
  verified_by text,
  verify_reason text,
  -- Internal evidence (page id, heading, exact quote). Never published.
  evidence jsonb check (evidence is null or jsonb_typeof(evidence) = 'object'),
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  -- The fact's licence is its source record's licence (already gated).
  constraint hike_facts_source_license foreign key (source_record_id, license_code)
    references public.source_records (id, license_code),
  constraint hike_facts_value_key_multi check ((field in ('permit', 'fee', 'hazard')) = (value_key is not null)),
  constraint hike_facts_basis_distance_only check (basis is null or field = 'distance_km'),
  constraint hike_facts_value_shape check (case
    when field in ('distance_km', 'elevation_gain_m', 'high_point_m') then jsonb_typeof(value) = 'number'
    when field in ('duration', 'difficulty_official', 'permit', 'fee', 'hazard', 'nearest_town', 'closure',
                   'rule_dogs', 'rule_drones', 'rule_camping', 'rule_fires', 'rule_group_size')
      then jsonb_typeof(value) = 'object'
    when field = 'best_months' then jsonb_typeof(value) = 'array'
    when field = 'route_type' then value in ('"loop"', '"out_and_back"', '"point_to_point"')
    when field = 'permit_required' then value in ('"yes"', '"no"', '"seasonal"', '"conditional"')
    when field = 'access_mode' then value in ('"independent"', '"licensed_operator_required"', '"guide_recommended"')
    when field = 'entry_fee_none' then value = 'true'::jsonb
    when field in ('licensed_operator_list_url', 'official_url') then jsonb_typeof(value) = 'string'
      and value #>> '{}' ~ '^https?://'
    else jsonb_typeof(value) = 'string'
  end),
  check (superseded_at is null or superseded_at >= created_at)
);
-- One current value per single-valued field ...
create unique index hike_facts_one_current_value on public.hike_facts (hike_id, field)
  where superseded_at is null and field not in ('permit', 'fee', 'hazard');
-- ... and one current value per key for multi-valued fields.
create unique index hike_facts_one_current_keyed_value on public.hike_facts (hike_id, field, value_key)
  where superseded_at is null and field in ('permit', 'fee', 'hazard');
create index hike_facts_source_record_idx on public.hike_facts (source_record_id);

-- ---------------------------------------------------------------------------
-- Official routes (government GIS lines with their own licence) and stages.
-- hike_routes, which links a hike to an OSM or official route, is created in
-- the osm migration because it references both schemas.
-- ---------------------------------------------------------------------------
create table public.official_routes (
  id uuid primary key default gen_random_uuid(),
  name text,
  geom extensions.geometry(MultiLineString, 4326) not null,
  geom_hash text not null,
  length_m numeric(10, 1) check (length_m > 0),
  source_record_id uuid not null references public.source_records (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index official_routes_geom_idx on public.official_routes using gist (geom);
create index official_routes_source_record_idx on public.official_routes (source_record_id);
create trigger official_routes_updated_at before update on public.official_routes
  for each row execute function public.set_updated_at();

create table public.hike_stages (
  id uuid primary key default gen_random_uuid(),
  hike_id uuid not null references public.hikes (id) on delete cascade,
  position smallint not null check (position > 0),
  name text,
  start_name text,
  end_name text,
  distance_km numeric(7, 2) check (distance_km > 0),
  elevation_gain_m integer check (elevation_gain_m >= 0),
  overnight_name text,
  note text check (char_length(note) <= 300),
  -- Official sources only; OSM stage relations stay in schema osm.
  source_record_id uuid not null references public.source_records (id),
  created_at timestamptz not null default now(),
  unique (hike_id, position)
);
create index hike_stages_source_record_idx on public.hike_stages (source_record_id);

-- ---------------------------------------------------------------------------
-- Permits, fees, rules, hazards
-- ---------------------------------------------------------------------------
create table public.permits (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  kind public.permit_kind not null,
  issuer_agency_id uuid references public.agencies (id) on delete set null,
  how_to_apply text check (char_length(how_to_apply) <= 300),
  booking_window text,
  official_url text check (official_url ~ '^https?://'),
  months smallint[] check (months <@ '{1,2,3,4,5,6,7,8,9,10,11,12}'::smallint[]),
  note text check (char_length(note) <= 300),
  source_record_id uuid not null references public.source_records (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index permits_source_record_idx on public.permits (source_record_id);
create index permits_issuer_idx on public.permits (issuer_agency_id);
create trigger permits_updated_at before update on public.permits
  for each row execute function public.set_updated_at();

create table public.hike_permits (
  hike_id uuid not null references public.hikes (id) on delete cascade,
  permit_id uuid not null references public.permits (id) on delete cascade,
  note text check (char_length(note) <= 300),
  primary key (hike_id, permit_id)
);
create index hike_permits_permit_idx on public.hike_permits (permit_id);

-- A fee belongs to a hike (entry, trail fee) or to a permit (its price).
create table public.fees (
  id uuid primary key default gen_random_uuid(),
  hike_id uuid references public.hikes (id) on delete cascade,
  permit_id uuid references public.permits (id) on delete cascade,
  name text,
  amount_minor bigint not null check (amount_minor >= 0),
  currency char(3) not null references public.currencies (code),
  unit public.fee_unit not null,
  audience public.fee_audience not null default 'all',
  valid_from date,
  valid_to date,
  note text check (char_length(note) <= 300),
  source_record_id uuid not null references public.source_records (id),
  created_at timestamptz not null default now(),
  constraint fees_one_owner check (num_nonnulls(hike_id, permit_id) = 1),
  check (valid_to is null or valid_from is null or valid_from <= valid_to)
);
create index fees_hike_idx on public.fees (hike_id);
create index fees_permit_idx on public.fees (permit_id);
create index fees_source_record_idx on public.fees (source_record_id);

create table public.hike_rules (
  id uuid primary key default gen_random_uuid(),
  hike_id uuid not null references public.hikes (id) on delete cascade,
  rule public.rule_kind not null,
  value public.rule_value not null,
  max_group smallint check (max_group > 0),
  note text check (char_length(note) <= 300),
  source_record_id uuid not null references public.source_records (id),
  created_at timestamptz not null default now(),
  unique (hike_id, rule),
  constraint hike_rules_restricted_needs_note check (value <> 'restricted' or note is not null),
  constraint hike_rules_max_group_size_only check (max_group is null or rule = 'group_size')
);
create index hike_rules_source_record_idx on public.hike_rules (source_record_id);

create table public.hike_hazards (
  id uuid primary key default gen_random_uuid(),
  hike_id uuid not null references public.hikes (id) on delete cascade,
  type public.hazard_type not null,
  note text check (char_length(note) <= 300),
  source_record_id uuid not null references public.source_records (id),
  created_at timestamptz not null default now(),
  unique (hike_id, type)
);
create index hike_hazards_source_record_idx on public.hike_hazards (source_record_id);

-- ---------------------------------------------------------------------------
-- Wikivoyage/Wikipedia excerpts, kept apart from our own text (share-alike)
-- ---------------------------------------------------------------------------
create table public.area_texts (
  id uuid primary key default gen_random_uuid(),
  area_id uuid references public.areas (id) on delete cascade,
  hike_id uuid references public.hikes (id) on delete cascade,
  source public.area_text_source not null,
  lang text not null default 'en' check (lang ~ '^[a-z]{2,3}(-[A-Za-z0-9]+)?$'),
  page_title text not null check (btrim(page_title) <> ''),
  revision_id bigint not null check (revision_id > 0),
  excerpt text not null check (btrim(excerpt) <> '' and char_length(excerpt) <= 1500),
  license_code text not null,
  license_allowed boolean not null default true check (license_allowed),
  modified boolean not null default false,
  attribution_text text not null check (btrim(attribution_text) <> ''),
  url text not null check (url ~ '^https?://'),
  retrieved_at timestamptz not null,
  source_record_id uuid references public.source_records (id),
  created_at timestamptz not null default now(),
  constraint area_texts_license_gate foreign key (license_code, license_allowed)
    references public.licenses (code, allowed),
  constraint area_texts_one_owner check (num_nonnulls(area_id, hike_id) = 1),
  unique nulls not distinct (area_id, hike_id, source, lang)
);
create index area_texts_hike_idx on public.area_texts (hike_id);
create index area_texts_source_record_idx on public.area_texts (source_record_id);

-- ---------------------------------------------------------------------------
-- Towns and sights for "nearby" (Wikidata or official data, never OSM)
-- ---------------------------------------------------------------------------
create table public.places (
  id uuid primary key default gen_random_uuid(),
  kind public.place_kind not null,
  name text not null check (btrim(name) <> ''),
  geom extensions.geometry(Point, 4326) not null,
  country_code char(2) check (country_code ~ '^[A-Z]{2}$'),
  wikidata_qid text unique check (wikidata_qid ~ '^Q[1-9][0-9]*$'),
  source_record_id uuid not null references public.source_records (id),
  created_at timestamptz not null default now()
);
create index places_geom_idx on public.places using gist (geom);
create index places_source_record_idx on public.places (source_record_id);

-- ---------------------------------------------------------------------------
-- Estimated required costs and old-slug redirects
-- ---------------------------------------------------------------------------
create table public.hike_cost_estimates (
  id uuid primary key default gen_random_uuid(),
  hike_id uuid not null references public.hikes (id) on delete cascade,
  audience public.fee_audience not null default 'non_resident',
  currency char(3) not null default 'USD' references public.currencies (code),
  amount_minor bigint not null check (amount_minor >= 0),
  -- What the estimate was built from: required fees and the dated FX rates.
  fee_ids uuid[] not null default '{}',
  fx_rate_ids uuid[] not null default '{}',
  fx_as_of date,
  method_version text not null,
  computed_at timestamptz not null default now(),
  unique (hike_id, audience, currency)
);

create table public.hike_redirects (
  id uuid primary key default gen_random_uuid(),
  old_slug text not null unique check (old_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  hike_id uuid not null references public.hikes (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index hike_redirects_hike_idx on public.hike_redirects (hike_id);

-- RLS on from the start; grants and public-read policies: catalog_rls.sql.
do $$
declare t text;
begin
  foreach t in array array[
    'currencies', 'fx_rates', 'agencies', 'areas', 'macro_regions', 'area_macro_regions', 'hikes',
    'hike_facts', 'official_routes', 'hike_stages', 'permits', 'hike_permits', 'fees', 'hike_rules',
    'hike_hazards', 'area_texts', 'places', 'hike_cost_estimates', 'hike_redirects'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
