-- ============================================================================
-- Archive the v0 ("hiking companion") schema on the HOSTED database at go-live.
--
-- NOT run by any script. Run it once, by hand, after a fresh backup and only
-- with the owner's explicit OK (docs/PLAN.md §2 and §12, "Database reset"):
--
--   1. Take a backup (Supabase dashboard > Database > Backups, or pg_dump).
--   2. psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/archive-v0-hosted.sql
--   3. Apply the new migrations in supabase/migrations (20261115000000 onward):
--        - Supabase CLI: the remote migration history still lists the v0
--          versions (now in supabase/migrations_v0). Mark them reverted, then
--          push:
--            npx supabase migration repair --status reverted 20261105000000 20261105002000 \
--              20261105002100 20261105003000 20261105004000 20261105004100 20261105005000 \
--              20261105009000 20261105009100 20261112000000 20261112001000 20261112002000 \
--              20261112003000 20261112004000
--            npx supabase db push
--        - or this repo's runner: DATABASE_URL=... DATABASE_SSL=true npm run db:migrate
--   4. Seed nothing: hikes come from the ingest pipeline. Real accounts stay.
--
-- What it does, in ONE transaction (all or nothing):
--   * creates schema legacy_v0 (fails if it already exists, so it cannot run twice);
--   * keeps copies of the v0 values the new baseline drops from reused tables
--     (profiles: phone, location retention, location sharing; support ticket
--     links to trips/bookings; staff roles with the retired 'safety' role);
--   * moves every v0 public table the new baseline does not reuse into
--     legacy_v0 (ALTER TABLE ... SET SCHEMA keeps rows, indexes, constraints,
--     triggers, policies and owned sequences), plus the v0-only functions and
--     enum types, so their names are free for the new schema;
--   * cancels pending v0 background jobs;
--   * revokes every privilege on legacy_v0 from the API roles.
--
-- It never touches auth.*: user accounts, sessions and the on_auth_user_created
-- trigger survive. Archived tables keep their foreign keys to auth.users, so
-- deleting an account still deletes that person's archived rows.
--
-- Tables that ALREADY EXIST on the hosted database and are REUSED by the new
-- baseline (20261115000000_baseline.sql creates them only if missing and
-- alters them with guarded statements):
--   profiles         baseline drops phone, location_retention_days,
--                    share_location_with_contacts (copied below first)
--   support_tickets  baseline drops trip_id, booking_id (links copied below)
--   staff_roles      the hosted enum public.app_role keeps the unused value
--                    'safety' (Postgres cannot drop enum values in place);
--                    rows with it are moved out below
--   feature_flags, app_settings, audit_logs, jobs, integration_events,
--   rate_limits, webhook_events, external_api_usage, provider_throttle,
--   weather_cache   unchanged; the baseline resets their grants and policies
-- Reused functions (CREATE OR REPLACE): set_updated_at, handle_new_user,
-- has_any_role, is_staff, prevent_last_admin_removal. Reused enums: app_role,
-- job_status. demo_checkout_sessions is archived (it referenced v0 bookings)
-- and recreated empty by the baseline.
--
-- RESTORE (undo):
--   Preferred: restore the backup taken in step 1.
--   By hand, before anything new depends on the freed names:
--     begin;
--     drop view if exists public.hike_public;
--     drop schema osm cascade;                -- then drop the other new public
--                                             -- tables (see supabase/migrations)
--     -- move tables, types and functions back:
--     do $$ declare r record; begin
--       for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
--                where n.nspname = 'legacy_v0' and c.relkind = 'r'
--                  and c.relname not in ('profiles_v0_columns', 'support_ticket_v0_links', 'staff_roles_safety')
--       loop execute format('alter table legacy_v0.%I set schema public', r.relname); end loop;
--       for r in select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
--                where n.nspname = 'legacy_v0' and t.typtype = 'e'
--       loop execute format('alter type legacy_v0.%I set schema public', r.typname); end loop;
--       for r in select p.oid::regprocedure as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--                where n.nspname = 'legacy_v0'
--       loop execute format('alter function %s set schema public', r.fn); end loop;
--     end $$;
--     -- re-add the dropped columns and copy values back from the *_v0_* tables,
--     -- re-insert legacy_v0.staff_roles_safety, re-apply the v0 grants
--     -- (supabase/migrations_v0), then: drop schema legacy_v0 cascade;
--     commit;
--
-- DROP LATER (once nobody needs the archive, after another backup):
--   Check nothing outside legacy_v0 depends on it:
--     select distinct classid::regclass, objid, refobjid
--     from pg_depend d join pg_namespace n on n.oid = d.refobjid
--     where n.nspname = 'legacy_v0';
--   then: drop schema legacy_v0 cascade;
-- ============================================================================

begin;

create schema legacy_v0;
comment on schema legacy_v0 is
  'Archived v0 hiking-companion schema (moved by scripts/db/archive-v0-hosted.sql). Not used by the app. Drop when no longer needed.';

-- ---- 1. copies of v0 values the new baseline drops --------------------------
create table legacy_v0.profiles_v0_columns as
  select id, phone, location_retention_days, share_location_with_contacts from public.profiles;

create table legacy_v0.support_ticket_v0_links as
  select id as ticket_id, trip_id, booking_id from public.support_tickets
  where trip_id is not null or booking_id is not null;

create table legacy_v0.staff_roles_safety as
  select * from public.staff_roles where role::text = 'safety';
delete from public.staff_roles where role::text = 'safety';

-- ---- 2. move v0 tables the baseline does not reuse ---------------------------
do $$
declare t text;
begin
  foreach t in array array[
    -- demo region, trails and narration
    'regions', 'sources', 'trails', 'trail_field_provenance', 'trail_sources', 'route_files',
    'trail_closures', 'trail_pois', 'narrations', 'permit_requirements',
    -- single-trail booking, pricing, payments, add-ons and fulfilment
    'addons', 'pricing_rules', 'trail_day_inventory', 'trips', 'bookings', 'booking_addons',
    'payments', 'refunds', 'fulfillments', 'gear_lockers', 'gear_items', 'gear_reservations',
    'shuttle_requests', 'trip_permits', 'demo_checkout_sessions',
    -- GPS hike screen, downloads, feedback
    'hike_sessions', 'hike_last_locations', 'location_points', 'hike_events', 'trip_downloads',
    'trip_feedback',
    -- Ghost Guard safety
    'emergency_contacts', 'trip_checkins', 'checkin_events', 'notifications', 'trip_shares',
    'contact_optout_tokens',
    -- weather snapshots and marketing drafts
    'weather_snapshots', 'marketing_drafts',
    -- on-demand OSM trail catalog
    'catalog_trails', 'catalog_pois', 'catalog_tiles', 'catalog_trail_parts', 'catalog_trail_redirects',
    'geocode_cache', 'geo_admin_cache', 'saved_trails'
  ] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I set schema legacy_v0', t);
    end if;
  end loop;
end $$;

-- ---- 3. move v0-only functions and enum types ---------------------------------
do $$
declare f text; t text;
begin
  foreach f in array array[
    'public.bookings_fill_hike_start()', 'public.guard_booked_trip_changes()',
    'public.guard_trail_price_changes()', 'public.guard_marketing_approval()',
    'public.catalog_trails_reserved_path()', 'public.profile_phone(uuid)', 'public.profile_has_phone(uuid)'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('alter function %s set schema legacy_v0', f);
    end if;
  end loop;

  foreach t in array array[
    'trail_status', 'difficulty', 'route_type', 'fact_kind', 'content_status', 'trip_status',
    'booking_status', 'fulfillment_status', 'hike_status', 'checkin_status', 'notification_status'
  ] loop
    if to_regtype(format('public.%I', t)) is not null then
      execute format('alter type public.%I set schema legacy_v0', t);
    end if;
  end loop;
end $$;

-- ---- 4. pending v0 background work is obsolete ----------------------------------
update public.jobs
set status = 'cancelled', finished_at = now(), last_error = 'Cancelled when the v0 schema was archived'
where status in ('queued', 'running', 'failed') and kind <> 'ops.purge_rate_limits';

-- ---- 5. the archive is invisible to the API roles ---------------------------------
revoke all on all tables in schema legacy_v0 from public, anon, authenticated, service_role;
revoke all on all sequences in schema legacy_v0 from public, anon, authenticated, service_role;
revoke all on all functions in schema legacy_v0 from public, anon, authenticated, service_role;
revoke all on schema legacy_v0 from public, anon, authenticated, service_role;

-- ---- 6. report anything unexpected left in public -----------------------------------
do $$
declare leftover text;
begin
  select string_agg(tablename, ', ' order by tablename) into leftover
  from pg_tables
  where schemaname = 'public'
    and tablename not in (
      'profiles', 'staff_roles', 'support_tickets', 'feature_flags', 'app_settings', 'audit_logs', 'jobs',
      'integration_events', 'rate_limits', 'webhook_events', 'external_api_usage', 'provider_throttle',
      'weather_cache', 'spatial_ref_sys'
    );
  if leftover is not null then
    raise notice 'Tables left in public that are not part of the new baseline (review by hand): %', leftover;
  end if;
end $$;

commit;
