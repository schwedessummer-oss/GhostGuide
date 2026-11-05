-- ============================================================================
-- LOCAL DEVELOPMENT ONLY. Never apply this file to a Supabase project.
--
-- Recreates the small part of Supabase's platform schema that our migrations
-- depend on (the `auth` schema, `auth.uid()`, and the anon/authenticated/
-- service_role roles), so the exact same migrations in supabase/migrations
-- run on a plain PostgreSQL 15+ server for local demos and integration tests.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant anon, authenticated, service_role to current_user;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create extension if not exists pgcrypto;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  -- Local demo auth only: scrypt hash "scrypt$<salt>$<hash>". Supabase manages
  -- its own auth.users table and this column is never read in supabase mode.
  encrypted_password text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Same semantics as Supabase's auth.uid(): read the `sub` claim of the JWT
-- claims that the server sets per transaction.
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;

-- Supabase grants public-schema usage to the API roles by default.
grant usage on schema public to anon, authenticated, service_role;
