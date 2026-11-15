-- ============================================================================
-- Ghost Guide core schema.
--
-- Conventions
--  * All timestamps are timestamptz (UTC). Calendar dates use `date`.
--  * Money is integer cents + ISO currency code.
--  * Every table has RLS enabled. The application connects as the database
--    owner and, for user-scoped work, switches to the `authenticated` role and
--    sets `request.jwt.claims` per transaction so these policies apply.
--  * Trusted server code (webhooks, jobs, use-cases that need row locks)
--    runs as the owner role and must perform its own authorization checks.
--  * Precise location and emergency-contact data are readable only by the
--    owner and by staff holding the `safety` or `admin` role.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('admin', 'operator', 'safety', 'content_editor', 'support');

create type public.trail_status as enum ('draft', 'published', 'closed', 'archived');
create type public.difficulty as enum ('easy', 'moderate', 'hard', 'strenuous');
create type public.route_type as enum ('loop', 'out_and_back', 'point_to_point');
create type public.fact_kind as enum ('verified', 'estimate', 'operator_note', 'demo');
create type public.content_status as enum ('draft', 'in_review', 'approved', 'retired', 'rejected');

create type public.trip_status as enum ('saved', 'booked', 'active', 'completed', 'cancelled');
create type public.booking_status as enum (
  'pending_payment',      -- checkout created, inventory held until hold_expires_at
  'confirmed',            -- payment verified via signed webhook
  'cancellation_requested',
  'cancelled',
  'refund_pending',
  'refunded',
  'payment_failed',
  'expired',              -- hold expired without payment
  'needs_attention'       -- e.g. paid after hold expired and capacity is gone
);
create type public.fulfillment_status as enum (
  'pending', 'requested', 'awaiting_customer', 'confirmed', 'completed',
  'failed', 'cancelled', 'needs_attention'
);
create type public.hike_status as enum ('active', 'paused', 'finished', 'abandoned');
create type public.checkin_status as enum (
  'scheduled',      -- opted in, hike not started yet
  'active',         -- hike in progress, awaiting confirmation by expected return
  'confirmed_ok',   -- user tapped "I'm okay" (still active, reminders continue)
  'completed',      -- user finished the trip; all reminders obsolete
  'overdue',        -- no confirmation received by expected return + grace
  'contact_notified',
  'cancelled'
);
create type public.job_status as enum ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled');
create type public.notification_status as enum ('queued', 'simulated', 'sent', 'delivered', 'failed', 'suppressed');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  phone text,
  units text not null default 'imperial' check (units in ('imperial', 'metric')),
  location_retention_days integer not null default 30 check (location_retention_days between 1 and 365),
  share_location_with_contacts boolean not null default true,
  marketing_opt_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Create a profile row for every new auth user (Supabase-documented pattern).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create table public.staff_roles (
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.app_role not null,
  granted_by uuid references auth.users (id),
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

-- SECURITY DEFINER so policies can consult staff_roles without granting
-- customers read access to it. search_path pinned to avoid hijacking.
create or replace function public.has_any_role(roles public.app_role[]) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff_roles sr
    where sr.user_id = auth.uid() and sr.role = any (roles)
  )
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.staff_roles sr where sr.user_id = auth.uid())
$$;

create table public.emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  phone text,
  email text,
  relationship text,
  -- The customer attests that the contact agreed to receive check-in notices.
  consent_confirmed_at timestamptz,
  consent_statement text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint emergency_contact_reachable check (phone is not null or email is not null)
);
create index on public.emergency_contacts (user_id);
create trigger emergency_contacts_updated_at before update on public.emergency_contacts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Catalog: regions, trails, provenance, closures, POIs, narration, permits
-- ---------------------------------------------------------------------------
create table public.regions (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  timezone text not null default 'America/Los_Angeles',
  center_lat double precision not null,
  center_lng double precision not null,
  default_zoom real not null default 11,
  is_active boolean not null default true,
  is_demo boolean not null default false,
  emergency_number text not null default '911',
  emergency_guidance text not null default '',
  created_at timestamptz not null default now()
);

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  url text,
  publisher text,
  source_type text not null check (source_type in ('official', 'land_manager', 'field_survey', 'publication', 'operator', 'demo')),
  retrieved_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

create table public.trails (
  id uuid primary key default gen_random_uuid(),
  region_id uuid not null references public.regions (id),
  slug text not null unique,
  name text not null,
  summary text not null default '',
  description text not null default '',
  is_demo boolean not null default false,
  status public.trail_status not null default 'draft',
  distance_km numeric(6, 2) not null check (distance_km > 0),
  elevation_gain_m integer not null check (elevation_gain_m >= 0),
  max_elevation_m integer,
  difficulty public.difficulty not null,
  terrain text[] not null default '{}',
  route_type public.route_type not null,
  estimated_duration_min integer not null check (estimated_duration_min > 0),
  accessibility_features text[] not null default '{}',
  dogs_allowed boolean,
  permit_required boolean not null default false,
  trailhead_name text,
  trailhead_lat double precision not null,
  trailhead_lng double precision not null,
  parking_info text,
  hero_image_url text,
  base_price_cents integer not null check (base_price_cents >= 0),
  currency text not null default 'usd',
  daily_capacity integer not null default 20 check (daily_capacity >= 0),
  -- GeoJSON LineString, coordinates [lng, lat] or [lng, lat, ele_m].
  geometry jsonb,
  geometry_source_id uuid references public.sources (id),
  geometry_checksum text,
  geometry_validated_at timestamptz,
  geometry_validated_by uuid references auth.users (id),
  facts_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.trails (region_id, status);
create trigger trails_updated_at before update on public.trails
  for each row execute function public.set_updated_at();

-- Per-field provenance: separates verified facts from estimates.
create table public.trail_field_provenance (
  trail_id uuid not null references public.trails (id) on delete cascade,
  field text not null,
  kind public.fact_kind not null,
  source_id uuid references public.sources (id),
  verified_at timestamptz,
  verified_by uuid references auth.users (id),
  note text,
  primary key (trail_id, field)
);

create table public.trail_sources (
  trail_id uuid not null references public.trails (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete cascade,
  primary key (trail_id, source_id)
);

create table public.route_files (
  id uuid primary key default gen_random_uuid(),
  trail_id uuid not null references public.trails (id) on delete cascade,
  storage_path text not null,
  format text not null check (format in ('geojson', 'gpx')),
  checksum text not null,
  validation_status text not null default 'pending' check (validation_status in ('pending', 'valid', 'invalid')),
  validation_errors jsonb not null default '[]'::jsonb,
  is_active boolean not null default false,
  uploaded_by uuid references auth.users (id),
  uploaded_at timestamptz not null default now()
);
create index on public.route_files (trail_id);

create table public.trail_closures (
  id uuid primary key default gen_random_uuid(),
  trail_id uuid not null references public.trails (id) on delete cascade,
  severity text not null check (severity in ('closed', 'partial', 'advisory')),
  reason text not null,
  source_id uuid references public.sources (id),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index on public.trail_closures (trail_id, starts_at);

create table public.trail_pois (
  id uuid primary key default gen_random_uuid(),
  trail_id uuid not null references public.trails (id) on delete cascade,
  seq integer not null,
  name text not null,
  kind text not null check (kind in ('history', 'ecology', 'safety', 'viewpoint', 'water', 'junction', 'trailhead')),
  lat double precision not null,
  lng double precision not null,
  trigger_radius_m integer not null default 40 check (trigger_radius_m between 10 and 500),
  created_at timestamptz not null default now(),
  unique (trail_id, seq)
);

create table public.narrations (
  id uuid primary key default gen_random_uuid(),
  trail_id uuid not null references public.trails (id) on delete cascade,
  poi_id uuid references public.trail_pois (id) on delete set null,
  title text not null,
  transcript text not null,
  audio_path text,           -- object storage path; null => device TTS of the transcript
  duration_sec integer,
  language text not null default 'en',
  status public.content_status not null default 'draft',
  source_id uuid references public.sources (id),
  source_citation text,
  version integer not null default 1,
  submitted_by uuid references auth.users (id),
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Approved narration must cite a source.
  constraint narration_approved_needs_source check (status <> 'approved' or (source_id is not null and approved_at is not null))
);
create index on public.narrations (trail_id, status);
create trigger narrations_updated_at before update on public.narrations
  for each row execute function public.set_updated_at();

create table public.permit_requirements (
  id uuid primary key default gen_random_uuid(),
  trail_id uuid not null references public.trails (id) on delete cascade,
  name text not null,
  authority text not null,
  official_url text not null,
  requirement_summary text not null,
  how_to_obtain text not null default '',
  lead_time_days integer,
  source_id uuid references public.sources (id),
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Commerce configuration: add-ons, pricing, inventory, flags, settings
-- ---------------------------------------------------------------------------
create table public.addons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text not null default '',
  kind text not null check (kind in ('gear_locker', 'shuttle', 'meal_pack', 'satellite_device', 'other')),
  provider_key text not null default 'demo',
  price_cents integer not null check (price_cents >= 0),
  pricing_unit text not null check (pricing_unit in ('per_booking', 'per_person')),
  requires_customer_confirmation boolean not null default false,
  daily_capacity integer,
  active boolean not null default true,
  region_id uuid references public.regions (id),
  created_at timestamptz not null default now()
);

create table public.pricing_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('weekend_pct', 'holiday_pct', 'high_demand_pct', 'group_discount_pct', 'flat_fee')),
  -- percent rules: value is a percentage (e.g. 15 => +15%); flat_fee: cents
  value numeric(10, 2) not null,
  -- optional parameters (camelCase keys), e.g. {"threshold": 0.75} or {"minParty": 4} or {"dates": ["2026-12-25"]}
  params jsonb not null default '{}'::jsonb,
  region_id uuid references public.regions (id),
  trail_id uuid references public.trails (id) on delete cascade,
  active boolean not null default true,
  priority integer not null default 100,
  effective_from date,
  effective_to date,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger pricing_rules_updated_at before update on public.pricing_rules
  for each row execute function public.set_updated_at();

-- One row per trail per day; locked FOR UPDATE during reservation to
-- serialize capacity checks. capacity null => trails.daily_capacity.
create table public.trail_day_inventory (
  trail_id uuid not null references public.trails (id) on delete cascade,
  day date not null,
  capacity integer check (capacity >= 0),
  blocked boolean not null default false,
  note text,
  primary key (trail_id, day)
);

create table public.feature_flags (
  key text primary key,
  enabled boolean not null default false,
  description text not null default '',
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

create table public.app_settings (
  key text primary key,
  value jsonb not null,
  description text not null default '',
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Trips, bookings, payments
-- ---------------------------------------------------------------------------
create table public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  region_id uuid not null references public.regions (id),
  trail_id uuid not null references public.trails (id),
  status public.trip_status not null default 'saved',
  planned_date date,
  start_time time,
  party_size integer not null default 1 check (party_size between 1 and 12),
  -- questionnaire answers (validated server-side)
  preferences jsonb not null default '{}'::jsonb,
  -- deterministic scoring output for the chosen trail (scores, reasons, warnings)
  recommendation jsonb not null default '{}'::jsonb,
  -- deterministic schedule: legs, POIs, estimated times, reminders
  itinerary jsonb not null default '{}'::jsonb,
  -- untrusted AI text; display only, never used for decisions
  ai_summary text,
  ai_provider text,
  ai_generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.trips (user_id, created_at desc);
create trigger trips_updated_at before update on public.trips
  for each row execute function public.set_updated_at();

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  trip_id uuid not null references public.trips (id) on delete cascade,
  trail_id uuid not null references public.trails (id),
  hike_date date not null,
  party_size integer not null check (party_size between 1 and 12),
  status public.booking_status not null default 'pending_payment',
  currency text not null default 'usd',
  subtotal_cents integer not null check (subtotal_cents >= 0),
  addons_cents integer not null default 0 check (addons_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  price_breakdown jsonb not null default '{}'::jsonb,
  payment_provider text not null,
  checkout_session_id text unique,
  payment_intent_id text,
  hold_expires_at timestamptz,
  paid_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  refunded_cents integer not null default 0,
  receipt_number text unique,
  -- client-supplied key to make "create checkout" idempotent per attempt
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.bookings (user_id, created_at desc);
create index on public.bookings (trail_id, hike_date, status);
-- At most one live booking per trip.
create unique index bookings_one_live_per_trip on public.bookings (trip_id)
  where status in ('pending_payment', 'confirmed', 'cancellation_requested', 'refund_pending', 'needs_attention');
create trigger bookings_updated_at before update on public.bookings
  for each row execute function public.set_updated_at();

create table public.booking_addons (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  addon_id uuid not null references public.addons (id),
  quantity integer not null default 1 check (quantity between 1 and 12),
  unit_price_cents integer not null,
  total_cents integer not null,
  details jsonb not null default '{}'::jsonb,
  unique (booking_id, addon_id)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  provider text not null,
  provider_payment_id text not null,
  amount_cents integer not null,
  currency text not null,
  status text not null check (status in ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_payment_id)
);
create trigger payments_updated_at before update on public.payments
  for each row execute function public.set_updated_at();

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  payment_id uuid references public.payments (id),
  amount_cents integer not null check (amount_cents > 0),
  reason text not null,
  status text not null check (status in ('requested', 'pending', 'succeeded', 'failed')),
  provider_refund_id text unique,
  requested_by uuid references auth.users (id),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger refunds_updated_at before update on public.refunds
  for each row execute function public.set_updated_at();

-- Signed webhook deliveries; (provider, event_id) makes processing idempotent.
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  type text not null,
  status text not null default 'received' check (status in ('received', 'processed', 'failed', 'ignored')),
  attempts integer not null default 0,
  error text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_id)
);

-- ---------------------------------------------------------------------------
-- Partner fulfillment (status kept separate from booking status)
-- ---------------------------------------------------------------------------
create table public.fulfillments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  booking_addon_id uuid not null unique references public.booking_addons (id) on delete cascade,
  provider_kind text not null check (provider_kind in ('gear_locker', 'shuttle', 'meal_pack', 'satellite_device', 'other')),
  provider_key text not null,
  status public.fulfillment_status not null default 'pending',
  external_ref text,
  details jsonb not null default '{}'::jsonb,       -- customer-visible details (no secrets)
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.fulfillments (status);
create trigger fulfillments_updated_at before update on public.fulfillments
  for each row execute function public.set_updated_at();

create table public.gear_lockers (
  id uuid primary key default gen_random_uuid(),
  region_id uuid not null references public.regions (id),
  name text not null,
  location_description text not null,
  lat double precision,
  lng double precision,
  status text not null default 'online' check (status in ('online', 'offline', 'maintenance')),
  provider_key text not null default 'demo',
  created_at timestamptz not null default now()
);

create table public.gear_items (
  id uuid primary key default gen_random_uuid(),
  locker_id uuid references public.gear_lockers (id),
  region_id uuid not null references public.regions (id),
  kind text not null check (kind in ('trekking_poles', 'daypack', 'bear_canister', 'headlamp', 'first_aid_kit', 'water_filter', 'satellite_communicator', 'other')),
  label text not null,
  status text not null default 'available' check (status in ('available', 'reserved', 'checked_out', 'maintenance', 'retired')),
  condition_notes text,
  last_maintenance_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger gear_items_updated_at before update on public.gear_items
  for each row execute function public.set_updated_at();

create table public.gear_reservations (
  id uuid primary key default gen_random_uuid(),
  fulfillment_id uuid not null references public.fulfillments (id) on delete cascade,
  gear_item_id uuid not null references public.gear_items (id),
  locker_id uuid references public.gear_lockers (id),
  reserved_for date not null,
  -- access codes are stored hashed; only the last 2 digits are kept in clear
  access_code_hash text,
  access_code_hint text,
  access_code_expires_at timestamptz,
  status text not null default 'reserved' check (status in ('reserved', 'picked_up', 'returned', 'cancelled', 'overdue')),
  picked_up_at timestamptz,
  returned_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index gear_item_one_active_reservation_per_day on public.gear_reservations (gear_item_id, reserved_for)
  where status in ('reserved', 'picked_up');

create table public.shuttle_requests (
  id uuid primary key default gen_random_uuid(),
  fulfillment_id uuid not null unique references public.fulfillments (id) on delete cascade,
  pickup_description text,
  pickup_lat double precision,
  pickup_lng double precision,
  dropoff_description text,
  pickup_at timestamptz,
  quoted_price_cents integer,
  quote_expires_at timestamptz,
  -- A paid ride request may only be submitted after the customer confirms
  -- pickup location, price and timing.
  customer_confirmed_at timestamptz,
  status text not null default 'quote_pending' check (status in ('quote_pending', 'quoted', 'confirmed', 'requested', 'completed', 'cancelled', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger shuttle_requests_updated_at before update on public.shuttle_requests
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Permits
-- ---------------------------------------------------------------------------
create table public.trip_permits (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  permit_requirement_id uuid not null references public.permit_requirements (id) on delete cascade,
  status text not null default 'not_started' check (status in ('not_started', 'applied', 'obtained', 'denied', 'not_required')),
  confirmation_ref text,
  remind_at timestamptz,
  notes text,
  updated_at timestamptz not null default now(),
  unique (trip_id, permit_requirement_id)
);
create trigger trip_permits_updated_at before update on public.trip_permits
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Hike sessions, locations, events
-- ---------------------------------------------------------------------------
create table public.hike_sessions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  status public.hike_status not null default 'active',
  started_at timestamptz not null default now(),
  paused_at timestamptz,
  finished_at timestamptz,
  distance_completed_m integer not null default 0,
  last_sync_at timestamptz,
  last_location_at timestamptz,   -- timestamp only; coordinates live in hike_last_locations
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index hike_sessions_one_open_per_trip on public.hike_sessions (trip_id)
  where status in ('active', 'paused');
create trigger hike_sessions_updated_at before update on public.hike_sessions
  for each row execute function public.set_updated_at();

-- Precise last-known location (restricted).
create table public.hike_last_locations (
  hike_session_id uuid primary key references public.hike_sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  accuracy_m real,
  recorded_at timestamptz not null,
  received_at timestamptz not null default now()
);

create table public.location_points (
  id bigint generated always as identity primary key,
  hike_session_id uuid not null references public.hike_sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  client_point_id text not null,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  accuracy_m real,
  altitude_m real,
  recorded_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (hike_session_id, client_point_id)
);
create index on public.location_points (user_id, recorded_at);

create table public.hike_events (
  id bigint generated always as identity primary key,
  hike_session_id uuid not null references public.hike_sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  client_event_id text not null,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (hike_session_id, client_event_id)
);

create table public.trip_downloads (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  manifest_version integer not null,
  manifest_checksum text not null,
  item_count integer not null,
  verified_complete boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.trip_feedback (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null unique references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  comments text check (char_length(comments) <= 4000),
  issues text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Check-ins and notifications
-- ---------------------------------------------------------------------------
create table public.trip_checkins (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null unique references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  emergency_contact_id uuid references public.emergency_contacts (id) on delete set null,
  expected_return_at timestamptz not null,
  grace_minutes integer not null default 60 check (grace_minutes between 15 and 720),
  reminder_offsets_min integer[] not null default '{60,15}',
  status public.checkin_status not null default 'scheduled',
  -- Bumped on every schedule change; jobs carry the version they were
  -- scheduled for and become no-ops when it no longer matches.
  version integer not null default 1,
  last_ok_at timestamptz,
  overdue_at timestamptz,
  contact_notified_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.trip_checkins (status, expected_return_at);
create trigger trip_checkins_updated_at before update on public.trip_checkins
  for each row execute function public.set_updated_at();

create table public.checkin_events (
  id bigint generated always as identity primary key,
  checkin_id uuid not null references public.trip_checkins (id) on delete cascade,
  kind text not null,
  actor text not null check (actor in ('user', 'system', 'staff')),
  actor_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on public.checkin_events (checkin_id, created_at);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  trip_id uuid references public.trips (id) on delete cascade,
  checkin_id uuid references public.trip_checkins (id) on delete cascade,
  channel text not null check (channel in ('sms', 'email', 'push', 'in_app')),
  recipient_kind text not null check (recipient_kind in ('user', 'emergency_contact', 'operator')),
  recipient_masked text not null,
  template text not null,
  body text not null,
  status public.notification_status not null default 'queued',
  provider text not null,
  provider_message_id text,
  error text,
  dedup_key text unique,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index on public.notifications (status, created_at);

create table public.trip_shares (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique,
  include_last_location boolean not null default false,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Operations: support, marketing, weather, jobs, integrations, audit, limits
-- ---------------------------------------------------------------------------
create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  trip_id uuid references public.trips (id) on delete set null,
  booking_id uuid references public.bookings (id) on delete set null,
  subject text not null,
  body text not null,
  status text not null default 'open' check (status in ('open', 'pending', 'resolved')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  assigned_to uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger support_tickets_updated_at before update on public.support_tickets
  for each row execute function public.set_updated_at();

create table public.weather_snapshots (
  id uuid primary key default gen_random_uuid(),
  trail_id uuid references public.trails (id) on delete cascade,
  region_id uuid references public.regions (id),
  provider text not null,
  is_simulated boolean not null,
  fetched_at timestamptz not null,
  valid_from timestamptz,
  valid_to timestamptz,
  data jsonb not null,
  source_url text
);

create table public.marketing_drafts (
  id uuid primary key default gen_random_uuid(),
  trail_id uuid not null references public.trails (id) on delete cascade,
  channel text not null default 'newsletter' check (channel in ('newsletter', 'social', 'web')),
  title text not null,
  body text not null,
  status text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'published', 'rejected')),
  -- [{label, url, retrieved_at}] used to compose the draft
  sources jsonb not null default '[]'::jsonb,
  weather_snapshot_id uuid references public.weather_snapshots (id),
  facts_as_of timestamptz,
  ai_provider text,
  created_by uuid references auth.users (id),
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_publish_requires_approval check (status <> 'published' or approved_at is not null)
);
create trigger marketing_drafts_updated_at before update on public.marketing_drafts
  for each row execute function public.set_updated_at();

create table public.jobs (
  id bigint generated always as identity primary key,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  run_at timestamptz not null default now(),
  status public.job_status not null default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  dedup_key text,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index jobs_dedup_key on public.jobs (dedup_key) where dedup_key is not null;
create index jobs_due on public.jobs (status, run_at);
create trigger jobs_updated_at before update on public.jobs
  for each row execute function public.set_updated_at();

create table public.integration_events (
  id bigint generated always as identity primary key,
  provider_kind text not null,
  provider_key text not null,
  operation text not null,
  outcome text not null check (outcome in ('success', 'failure', 'simulated')),
  entity_type text,
  entity_id text,
  error text,
  duration_ms integer,
  created_at timestamptz not null default now()
);
create index on public.integration_events (outcome, created_at desc);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_roles text[] not null default '{}',
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on public.audit_logs (entity_type, entity_id);
create index on public.audit_logs (created_at desc);

create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

-- ============================================================================
-- Row-level security
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','staff_roles','emergency_contacts','regions','sources','trails',
    'trail_field_provenance','trail_sources','route_files','trail_closures','trail_pois',
    'narrations','permit_requirements','addons','pricing_rules','trail_day_inventory',
    'feature_flags','app_settings','trips','bookings','booking_addons','payments','refunds',
    'webhook_events','fulfillments','gear_lockers','gear_items','gear_reservations',
    'shuttle_requests','trip_permits','hike_sessions','hike_last_locations','location_points',
    'hike_events','trip_downloads','trip_feedback','trip_checkins','checkin_events',
    'notifications','trip_shares','support_tickets','weather_snapshots','marketing_drafts',
    'jobs','integration_events','audit_logs','rate_limits'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Table privileges. RLS policies below are what actually restrict rows.
grant select on all tables in schema public to anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
grant execute on function public.has_any_role(public.app_role[]) to anon, authenticated;
grant execute on function public.is_staff() to anon, authenticated;
-- Server-only tables: never readable through the API roles.
revoke all on public.webhook_events, public.jobs, public.rate_limits from anon, authenticated;

-- ---- identity --------------------------------------------------------------
create policy profiles_owner_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.has_any_role('{admin,support,operator,safety}'));
create policy profiles_owner_insert on public.profiles for insert to authenticated
  with check (id = auth.uid());
create policy profiles_owner_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy staff_roles_read on public.staff_roles for select to authenticated
  using (user_id = auth.uid() or public.has_any_role('{admin}'));
create policy staff_roles_admin_write on public.staff_roles for all to authenticated
  using (public.has_any_role('{admin}')) with check (public.has_any_role('{admin}'));

create policy emergency_contacts_owner on public.emergency_contacts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy emergency_contacts_safety_read on public.emergency_contacts for select to authenticated
  using (public.has_any_role('{admin,safety}'));

-- ---- catalog (public read of published content) ----------------------------
create policy regions_public_read on public.regions for select to anon, authenticated
  using (is_active or public.is_staff());
create policy regions_admin_write on public.regions for all to authenticated
  using (public.has_any_role('{admin}')) with check (public.has_any_role('{admin}'));

create policy sources_public_read on public.sources for select to anon, authenticated using (true);
create policy sources_editor_write on public.sources for all to authenticated
  using (public.has_any_role('{admin,content_editor,operator}'))
  with check (public.has_any_role('{admin,content_editor,operator}'));

create policy trails_public_read on public.trails for select to anon, authenticated
  using (status in ('published', 'closed') or public.is_staff());
create policy trails_editor_write on public.trails for all to authenticated
  using (public.has_any_role('{admin,content_editor,operator}'))
  with check (public.has_any_role('{admin,content_editor,operator}'));

create policy provenance_public_read on public.trail_field_provenance for select to anon, authenticated using (true);
create policy provenance_editor_write on public.trail_field_provenance for all to authenticated
  using (public.has_any_role('{admin,content_editor}')) with check (public.has_any_role('{admin,content_editor}'));

create policy trail_sources_public_read on public.trail_sources for select to anon, authenticated using (true);
create policy trail_sources_editor_write on public.trail_sources for all to authenticated
  using (public.has_any_role('{admin,content_editor}')) with check (public.has_any_role('{admin,content_editor}'));

create policy route_files_staff on public.route_files for all to authenticated
  using (public.has_any_role('{admin,content_editor,operator}'))
  with check (public.has_any_role('{admin,content_editor,operator}'));

create policy closures_public_read on public.trail_closures for select to anon, authenticated using (true);
create policy closures_staff_write on public.trail_closures for all to authenticated
  using (public.has_any_role('{admin,operator,content_editor}'))
  with check (public.has_any_role('{admin,operator,content_editor}'));

create policy pois_public_read on public.trail_pois for select to anon, authenticated using (true);
create policy pois_editor_write on public.trail_pois for all to authenticated
  using (public.has_any_role('{admin,content_editor}')) with check (public.has_any_role('{admin,content_editor}'));

create policy narrations_public_read on public.narrations for select to anon, authenticated
  using (status = 'approved' or public.has_any_role('{admin,content_editor,operator}'));
create policy narrations_editor_write on public.narrations for all to authenticated
  using (public.has_any_role('{admin,content_editor}')) with check (public.has_any_role('{admin,content_editor}'));

create policy permits_public_read on public.permit_requirements for select to anon, authenticated using (true);
create policy permits_staff_write on public.permit_requirements for all to authenticated
  using (public.has_any_role('{admin,operator,content_editor}'))
  with check (public.has_any_role('{admin,operator,content_editor}'));

create policy addons_public_read on public.addons for select to anon, authenticated
  using (active or public.is_staff());
create policy addons_admin_write on public.addons for all to authenticated
  using (public.has_any_role('{admin,operator}')) with check (public.has_any_role('{admin,operator}'));

create policy pricing_rules_read on public.pricing_rules for select to anon, authenticated using (true);
create policy pricing_rules_admin_write on public.pricing_rules for all to authenticated
  using (public.has_any_role('{admin}')) with check (public.has_any_role('{admin}'));

create policy inventory_read on public.trail_day_inventory for select to anon, authenticated using (true);
create policy inventory_staff_write on public.trail_day_inventory for all to authenticated
  using (public.has_any_role('{admin,operator}')) with check (public.has_any_role('{admin,operator}'));

create policy flags_read on public.feature_flags for select to anon, authenticated using (true);
create policy flags_admin_write on public.feature_flags for all to authenticated
  using (public.has_any_role('{admin}')) with check (public.has_any_role('{admin}'));

create policy settings_staff_read on public.app_settings for select to authenticated using (public.is_staff());
create policy settings_admin_write on public.app_settings for all to authenticated
  using (public.has_any_role('{admin}')) with check (public.has_any_role('{admin}'));

-- ---- trips & bookings --------------------------------------------------------
create policy trips_owner on public.trips for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy trips_staff_read on public.trips for select to authenticated
  using (public.has_any_role('{admin,operator,support,safety}'));

-- Customers can read their bookings; all writes go through trusted server
-- code that verifies prices, inventory and payment.
create policy bookings_owner_read on public.bookings for select to authenticated
  using (user_id = auth.uid());
create policy bookings_staff_read on public.bookings for select to authenticated
  using (public.has_any_role('{admin,operator,support}'));

create policy booking_addons_read on public.booking_addons for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id and b.user_id = auth.uid())
         or public.has_any_role('{admin,operator,support}'));

create policy payments_read on public.payments for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id and b.user_id = auth.uid())
         or public.has_any_role('{admin,operator}'));
create policy refunds_read on public.refunds for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id and b.user_id = auth.uid())
         or public.has_any_role('{admin,operator}'));

create policy fulfillments_read on public.fulfillments for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id and b.user_id = auth.uid())
         or public.has_any_role('{admin,operator,support}'));

create policy lockers_staff on public.gear_lockers for all to authenticated
  using (public.has_any_role('{admin,operator}')) with check (public.has_any_role('{admin,operator}'));
create policy lockers_public_read on public.gear_lockers for select to anon, authenticated using (true);
create policy gear_items_staff on public.gear_items for all to authenticated
  using (public.has_any_role('{admin,operator}')) with check (public.has_any_role('{admin,operator}'));
create policy gear_reservations_read on public.gear_reservations for select to authenticated
  using (exists (select 1 from public.fulfillments f join public.bookings b on b.id = f.booking_id
                 where f.id = fulfillment_id and b.user_id = auth.uid())
         or public.has_any_role('{admin,operator}'));
create policy shuttle_read on public.shuttle_requests for select to authenticated
  using (exists (select 1 from public.fulfillments f join public.bookings b on b.id = f.booking_id
                 where f.id = fulfillment_id and b.user_id = auth.uid())
         or public.has_any_role('{admin,operator,support}'));

create policy trip_permits_owner on public.trip_permits for all to authenticated
  using (exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid()))
  with check (exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid()));
create policy trip_permits_staff_read on public.trip_permits for select to authenticated
  using (public.has_any_role('{admin,operator,support}'));

-- ---- hike data ---------------------------------------------------------------
create policy hike_sessions_owner on public.hike_sessions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy hike_sessions_staff_read on public.hike_sessions for select to authenticated
  using (public.has_any_role('{admin,operator,safety,support}'));

-- precise location: owner + safety/admin only
create policy last_location_owner on public.hike_last_locations for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy last_location_safety_read on public.hike_last_locations for select to authenticated
  using (public.has_any_role('{admin,safety}'));
create policy location_points_owner on public.location_points for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy location_points_safety_read on public.location_points for select to authenticated
  using (public.has_any_role('{admin,safety}'));

create policy hike_events_owner on public.hike_events for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy hike_events_staff_read on public.hike_events for select to authenticated
  using (public.has_any_role('{admin,safety,operator}'));

create policy downloads_owner on public.trip_downloads for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy downloads_staff_read on public.trip_downloads for select to authenticated
  using (public.has_any_role('{admin,operator,support}'));

create policy feedback_owner on public.trip_feedback for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy feedback_staff_read on public.trip_feedback for select to authenticated
  using (public.has_any_role('{admin,operator,support}'));

-- ---- check-ins & notifications ------------------------------------------------
create policy checkins_owner_read on public.trip_checkins for select to authenticated
  using (user_id = auth.uid() or public.has_any_role('{admin,safety,operator}'));
create policy checkin_events_read on public.checkin_events for select to authenticated
  using (exists (select 1 from public.trip_checkins c where c.id = checkin_id and c.user_id = auth.uid())
         or public.has_any_role('{admin,safety,operator}'));
-- notification bodies can contain coordinates: owner + safety/admin only
create policy notifications_read on public.notifications for select to authenticated
  using (user_id = auth.uid() or public.has_any_role('{admin,safety}'));

create policy trip_shares_owner on public.trip_shares for all to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid());

-- ---- operations -------------------------------------------------------------
create policy tickets_owner on public.support_tickets for select to authenticated
  using (user_id = auth.uid() or public.has_any_role('{admin,support,operator}'));
create policy tickets_owner_insert on public.support_tickets for insert to authenticated
  with check (user_id = auth.uid());
create policy tickets_staff_update on public.support_tickets for update to authenticated
  using (public.has_any_role('{admin,support,operator}')) with check (public.has_any_role('{admin,support,operator}'));

create policy weather_staff on public.weather_snapshots for select to authenticated using (public.is_staff());
create policy marketing_staff on public.marketing_drafts for all to authenticated
  using (public.has_any_role('{admin,operator,content_editor}'))
  with check (public.has_any_role('{admin,operator,content_editor}'));
create policy integration_events_staff on public.integration_events for select to authenticated
  using (public.has_any_role('{admin,operator}'));
create policy audit_logs_admin on public.audit_logs for select to authenticated
  using (public.has_any_role('{admin}'));

-- ---- column-level write grants ------------------------------------------------
-- On Supabase the Data API exposes `public` to the anon/authenticated roles, so
-- customers must not be able to write lifecycle columns (trip status, etc.)
-- directly. Lifecycle transitions happen only in trusted server code.
revoke insert, update on public.trips from authenticated;
grant insert (user_id, region_id, trail_id, planned_date, start_time, party_size,
              preferences, recommendation, itinerary, ai_summary, ai_provider, ai_generated_at)
  on public.trips to authenticated;
grant update (planned_date, start_time, party_size, preferences, recommendation, itinerary,
              ai_summary, ai_provider, ai_generated_at)
  on public.trips to authenticated;

revoke insert, update on public.profiles from authenticated;
grant insert (id, email, full_name, phone, units, location_retention_days,
              share_location_with_contacts, marketing_opt_in) on public.profiles to authenticated;
grant update (full_name, phone, units, location_retention_days, share_location_with_contacts,
              marketing_opt_in) on public.profiles to authenticated;

-- Hike sessions: customers may record progress but not rewrite history.
revoke update on public.hike_sessions from authenticated;
grant update (status, paused_at, finished_at, distance_completed_m, last_sync_at, last_location_at)
  on public.hike_sessions to authenticated;
revoke update on public.location_points, public.hike_events from authenticated;

-- Bookings, payments, refunds, fulfillment and check-in rows are written only
-- by trusted server code (no customer write policies exist), but revoke the
-- table privileges too as defense in depth.
revoke insert, update, delete on public.bookings, public.booking_addons, public.payments,
  public.refunds, public.fulfillments, public.gear_reservations, public.shuttle_requests,
  public.trip_checkins, public.checkin_events, public.notifications, public.audit_logs,
  public.integration_events, public.weather_snapshots
  from authenticated;

-- Make sure future tables do not silently become writable by API roles.
alter default privileges in schema public revoke all on tables from anon, authenticated;
