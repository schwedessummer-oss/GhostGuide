-- ============================================================================
-- GhostGuide baseline (Phase 2b, docs/PLAN.md §3 "Security").
--
-- Only the platform tables the current app uses: identity (profiles, staff
-- roles), the admin shell (audit log, feature flags, settings, support
-- tickets), the background job queue, rate limits, the provider HTTP client's
-- usage and throttle tables, the (hidden) weather cache, webhook events and
-- the simulated payment provider's sessions.
--
-- Two ways this file runs:
--  * on an empty database (local dev, tests, a fresh Supabase project);
--  * on the HOSTED database after scripts/db/archive-v0-hosted.sql moved every
--    v0 table this baseline does not reuse into schema legacy_v0. Those reused
--    tables already exist there, so every statement below is guarded
--    (IF NOT EXISTS, DROP ... IF EXISTS, guarded ALTERs) and grants are reset
--    explicitly rather than assumed.
--
-- Conventions (kept from the v0 security hardening):
--  * RLS is enabled on every table. Policies call (select auth.uid()) so the
--    value is computed once per statement (Supabase advisor lint 0003).
--  * Functions pin search_path = '' and qualify every name. SECURITY DEFINER
--    is used only where a policy must read a table the caller cannot
--    (has_any_role / is_staff) and for the auth.users trigger.
--  * API roles (anon, authenticated) get no default privileges: every grant
--    below is explicit. Server-only tables have RLS on, no policies and no
--    grants (lint 0008 INFO, intentional).
-- ============================================================================

create extension if not exists pgcrypto;
create schema if not exists extensions;
create extension if not exists postgis with schema extensions;

-- New tables and functions never become reachable by API roles by default.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Enumerations (guarded: they already exist on the hosted database)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regtype('public.app_role') is null then
    -- The hosted v0 enum also has 'safety'; the app never grants it and
    -- archive-v0-hosted.sql moves any such rows out of staff_roles.
    create type public.app_role as enum ('admin', 'operator', 'content_editor', 'support');
  end if;
  if to_regtype('public.job_status') is null then
    create type public.job_status as enum ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  units text not null default 'imperial' check (units in ('imperial', 'metric')),
  marketing_opt_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Hosted v0 columns for removed features (check-in texts, location sharing).
-- archive-v0-hosted.sql copies their values into legacy_v0 first.
alter table public.profiles
  drop column if exists phone,
  drop column if exists location_retention_days,
  drop column if exists share_location_with_contacts;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- A profile row for every new auth user (Supabase-documented pattern).
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
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- Created only when missing, so the hosted auth schema is never altered.
do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'on_auth_user_created' and tgrelid = 'auth.users'::regclass
  ) then
    create trigger on_auth_user_created after insert on auth.users
      for each row execute function public.handle_new_user();
  end if;
end $$;

create table if not exists public.staff_roles (
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.app_role not null,
  granted_by uuid references auth.users (id),
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

-- SECURITY DEFINER so policies can consult staff_roles without granting
-- customers read access to it. They only report the CALLER's own roles.
create or replace function public.has_any_role(roles public.app_role[]) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff_roles sr
    where sr.user_id = (select auth.uid()) and sr.role = any (roles)
  )
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.staff_roles sr where sr.user_id = (select auth.uid()))
$$;

revoke all on function public.has_any_role(public.app_role[]) from public;
revoke all on function public.is_staff() from public;
grant execute on function public.has_any_role(public.app_role[]) to anon, authenticated, service_role;
grant execute on function public.is_staff() to anon, authenticated, service_role;

-- Never remove the last admin.
create or replace function public.prevent_last_admin_removal() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin') then
    if not exists (
      select 1 from public.staff_roles sr
      where sr.role = 'admin' and sr.user_id <> old.user_id
    ) then
      raise exception 'Cannot remove the last remaining admin role'
        using errcode = 'check_violation', hint = 'Grant admin to another user first.';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.prevent_last_admin_removal() from public, anon, authenticated;

drop trigger if exists staff_roles_keep_last_admin on public.staff_roles;
create trigger staff_roles_keep_last_admin
  before delete or update of role on public.staff_roles
  for each row execute function public.prevent_last_admin_removal();

-- ---------------------------------------------------------------------------
-- Admin shell
-- ---------------------------------------------------------------------------
create table if not exists public.feature_flags (
  key text primary key,
  enabled boolean not null default false,
  description text not null default '',
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  description text not null default '',
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  subject text not null,
  body text not null,
  status text not null default 'open' check (status in ('open', 'pending', 'resolved')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  assigned_to uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Hosted v0 links to trips and bookings (now in legacy_v0; archive-v0-hosted.sql
-- keeps a copy of the links there).
alter table public.support_tickets
  drop column if exists trip_id,
  drop column if exists booking_id;
create index if not exists support_tickets_status_priority_idx on public.support_tickets (status, priority, created_at desc);
create index if not exists support_tickets_user_idx on public.support_tickets (user_id);
drop trigger if exists support_tickets_updated_at on public.support_tickets;
create trigger support_tickets_updated_at before update on public.support_tickets
  for each row execute function public.set_updated_at();

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_roles text[] not null default '{}',
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_entity_type_entity_id_idx on public.audit_logs (entity_type, entity_id);
create index if not exists audit_logs_created_at_idx on public.audit_logs (created_at desc);
create index if not exists audit_logs_action_created_idx on public.audit_logs (action, created_at desc);
create index if not exists audit_logs_actor_created_idx on public.audit_logs (actor_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Operations (server-only)
-- ---------------------------------------------------------------------------
create table if not exists public.jobs (
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
create unique index if not exists jobs_dedup_key on public.jobs (dedup_key) where dedup_key is not null;
create index if not exists jobs_due on public.jobs (status, run_at);
create index if not exists jobs_status_kind_updated_idx on public.jobs (status, kind, updated_at desc);
drop trigger if exists jobs_updated_at on public.jobs;
create trigger jobs_updated_at before update on public.jobs
  for each row execute function public.set_updated_at();

create table if not exists public.integration_events (
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
create index if not exists integration_events_outcome_created_at_idx on public.integration_events (outcome, created_at desc);
create index if not exists integration_events_kind_created_idx on public.integration_events (provider_kind, created_at desc);

create table if not exists public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

-- Idempotent webhook processing (Stripe; PLAN §2 "keep and reuse").
create table if not exists public.webhook_events (
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
create index if not exists webhook_events_status_received_idx on public.webhook_events (status, received_at desc);

-- Provider HTTP client (src/server/providers/http.ts): daily usage counters
-- and a per-provider "next request not before" throttle.
create table if not exists public.external_api_usage (
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

create table if not exists public.provider_throttle (
  provider text primary key,
  next_allowed_at timestamptz not null default now()
);

-- Weather and alerts cache (weather stays hidden behind a switch, PLAN §2).
create table if not exists public.weather_cache (
  provider text not null,
  cache_key text not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_modified text,
  primary key (provider, cache_key)
);
create index if not exists weather_cache_expires_idx on public.weather_cache (expires_at);

-- Sessions of the SIMULATED payment provider (src/integrations/payments/demo.ts).
-- booking_id has no foreign key until the Phase 6 order tables exist. On the
-- hosted database the v0 table (which referenced v0 bookings) was archived,
-- so this is always a fresh, empty table.
create table if not exists public.demo_checkout_sessions (
  id text primary key check (id ~ '^demo_cs_[0-9a-f-]{36}$'),
  booking_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  amount_total integer not null check (amount_total >= 0),
  currency text not null,
  line_items jsonb not null default '[]'::jsonb,
  success_url text not null,
  cancel_url text not null,
  status text not null default 'open' check (status in ('open', 'complete', 'expired')),
  payment_status text not null default 'unpaid' check (payment_status in ('paid', 'unpaid', 'no_payment_required')),
  payment_intent_id text unique,
  idempotency_key text not null unique,
  expires_at timestamptz,
  last_event_body text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists demo_checkout_sessions_booking_idx on public.demo_checkout_sessions (booking_id);
create index if not exists demo_checkout_sessions_user_idx on public.demo_checkout_sessions (user_id);
drop trigger if exists demo_checkout_sessions_updated_at on public.demo_checkout_sessions;
create trigger demo_checkout_sessions_updated_at before update on public.demo_checkout_sessions
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Row-level security and grants (reset explicitly: the hosted tables carry
-- v0 grants such as "select on all tables to anon").
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'staff_roles', 'feature_flags', 'app_settings', 'support_tickets', 'audit_logs',
    'jobs', 'integration_events', 'rate_limits', 'webhook_events', 'external_api_usage',
    'provider_throttle', 'weather_cache', 'demo_checkout_sessions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
revoke all on all sequences in schema public from public, anon, authenticated;
grant usage, select on all sequences in schema public to service_role;

-- ---- identity ----------------------------------------------------------------
-- Customers read and edit a few of their own profile columns.
grant select (id, email, full_name, units, marketing_opt_in, created_at, updated_at) on public.profiles to authenticated;
grant insert (id, email, full_name, units, marketing_opt_in) on public.profiles to authenticated;
grant update (full_name, units, marketing_opt_in) on public.profiles to authenticated;

drop policy if exists profiles_owner_select on public.profiles;
create policy profiles_owner_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.has_any_role('{admin,support,operator}'));
drop policy if exists profiles_owner_insert on public.profiles;
create policy profiles_owner_insert on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));
drop policy if exists profiles_owner_update on public.profiles;
create policy profiles_owner_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Write privileges exist so a customer's attempt fails on RLS, not on grants.
grant select, insert, update, delete on public.staff_roles to authenticated;
drop policy if exists staff_roles_read on public.staff_roles;
create policy staff_roles_read on public.staff_roles for select to authenticated
  using (user_id = (select auth.uid()) or public.has_any_role('{admin}'));
drop policy if exists staff_roles_admin_write on public.staff_roles;
create policy staff_roles_admin_write on public.staff_roles for all to authenticated
  using (public.has_any_role('{admin}')) with check (public.has_any_role('{admin}'));

-- ---- admin shell -------------------------------------------------------------
grant select on public.feature_flags to anon, authenticated;
grant insert, update, delete on public.feature_flags to authenticated;
drop policy if exists flags_read on public.feature_flags;
create policy flags_read on public.feature_flags for select to anon, authenticated using (true);
drop policy if exists flags_admin_write on public.feature_flags;
create policy flags_admin_write on public.feature_flags for all to authenticated
  using (public.has_any_role('{admin}')) with check (public.has_any_role('{admin}'));

grant select, insert, update, delete on public.app_settings to authenticated;
drop policy if exists settings_staff_read on public.app_settings;
create policy settings_staff_read on public.app_settings for select to authenticated using (public.is_staff());
drop policy if exists settings_admin_write on public.app_settings;
create policy settings_admin_write on public.app_settings for all to authenticated
  using (public.has_any_role('{admin}')) with check (public.has_any_role('{admin}'));

-- No deletes: tickets are kept for the support history.
grant select, insert, update on public.support_tickets to authenticated;
drop policy if exists tickets_owner on public.support_tickets;
create policy tickets_owner on public.support_tickets for select to authenticated
  using (user_id = (select auth.uid()) or public.has_any_role('{admin,support,operator}'));
drop policy if exists tickets_owner_insert on public.support_tickets;
create policy tickets_owner_insert on public.support_tickets for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists tickets_staff_update on public.support_tickets;
create policy tickets_staff_update on public.support_tickets for update to authenticated
  using (public.has_any_role('{admin,support,operator}')) with check (public.has_any_role('{admin,support,operator}'));

-- Readable by admins only; anon may query and always gets zero rows.
grant select on public.audit_logs to anon, authenticated;
drop policy if exists audit_logs_admin on public.audit_logs;
create policy audit_logs_admin on public.audit_logs for select to authenticated
  using (public.has_any_role('{admin}'));

grant select on public.integration_events to authenticated;
drop policy if exists integration_events_staff on public.integration_events;
create policy integration_events_staff on public.integration_events for select to authenticated
  using (public.has_any_role('{admin,operator}'));

-- jobs, rate_limits, webhook_events, external_api_usage, provider_throttle,
-- weather_cache and demo_checkout_sessions: server-only (no grants above).
