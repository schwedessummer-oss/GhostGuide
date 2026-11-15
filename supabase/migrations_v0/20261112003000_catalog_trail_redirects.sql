-- ============================================================================
-- Stable trail URLs (Phase 1, additive)
--
-- A catalog trail's page is /trail/<country_code>/<region_slug>/<slug>. The
-- path can change after a trail is first stored:
--   * reverse geocoding (Nominatim) was unavailable, so the region was stored
--     as "unknown"; a later refresh fills it in and the trail moves there;
--   * the stored country was wrong (it used to come from the centre of a
--     0.1° cell, which can lie across a border); a refresh moves the trail to
--     the country at its exact point.
-- Shared links, bookmarks and indexed URLs must keep working and must never
-- open a different trail. Every path a trail leaves is recorded here:
--
--   catalog_trail_redirects
--     (country_code, region_slug, slug) → trail_id. The trail page answers
--     an old path with a permanent redirect to the trail's CURRENT path (the
--     row points at the trail, so there are no redirect chains). An old path
--     is never given to another trail: ingestion skips it when allocating
--     slugs, and the trigger below refuses it as a slug conflict. A trail may
--     take one of its own old paths back (the row is then deleted). Rows go
--     away only with their trail.
--
-- Access: public read like catalog_trails (old public paths, no other data);
-- the page joins catalog_trails, whose RLS hides hidden trails. Writes by
-- trusted server code only.
-- ============================================================================

create table public.catalog_trail_redirects (
  country_code text not null check (country_code ~ '^[a-z]{2}$'),
  region_slug text not null check (region_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(region_slug) <= 80),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 120),
  trail_id uuid not null references public.catalog_trails (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (country_code, region_slug, slug)
);
create index catalog_trail_redirects_trail_idx on public.catalog_trail_redirects (trail_id);

alter table public.catalog_trail_redirects enable row level security;
revoke all on public.catalog_trail_redirects from anon, authenticated;
grant select on public.catalog_trail_redirects to anon, authenticated;
create policy catalog_trail_redirects_public_read on public.catalog_trail_redirects
  for select to anon, authenticated using (true);

-- A path that redirects to one trail is never the live path of another. Raised
-- as a unique violation on the slug constraint, so ingestion's slug allocation
-- retries with the next free slug exactly as for a live duplicate.
create or replace function public.catalog_trails_reserved_path() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.catalog_trail_redirects r
     where r.country_code = new.country_code and r.region_slug = new.region_slug and r.slug = new.slug
       and r.trail_id <> new.id
  ) then
    raise exception 'trail path /trail/%/%/% belongs to another trail (redirect)', new.country_code, new.region_slug, new.slug
      using errcode = 'unique_violation', constraint = 'catalog_trails_country_code_region_slug_slug_key';
  end if;
  return new;
end;
$$;

create trigger catalog_trails_reserved_path
  before insert or update of country_code, region_slug, slug on public.catalog_trails
  for each row execute function public.catalog_trails_reserved_path();
