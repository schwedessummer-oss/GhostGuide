-- ============================================================================
-- Provenance hardening (docs/PLAN.md §3 "every value carries its source",
-- §4.2-4.4, §6 "Review").
--
--  1. ODbL separation in both directions: catalog tables never cite an OSM
--     source record, and osm.* rows only cite records of the 'osm' data source.
--  2. Source record provenance (data source, licence) is immutable.
--  3. Photos: full credit data, a licence tied to the source record's licence,
--     and an image for every published photo.
--  4. areas and agencies need a source record.
--  5. OSM route metrics: any DEM-derived value needs a DEM source record; a
--     route needs its source records.
--  6. Publish gate: every published fact column needs a current verified fact
--     with a source record and the same value; photo credit data is checked.
--  7. Licence flags cannot be edited casually.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ODbL separation
-- ---------------------------------------------------------------------------
create or replace function public.reject_osm_source_record() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.source_record_id is not null and exists (
    select 1
    from public.source_records sr
    join public.data_sources ds on ds.id = sr.data_source_id
    where sr.id = new.source_record_id and (ds.key = 'osm' or sr.license_code = 'ODbL-1.0')
  ) then
    raise exception 'OSM-derived values belong in schema osm: % cannot cite an OpenStreetMap source record', tg_table_name
      using errcode = 'check_violation', hint = 'PLAN section 4.4: only schema osm holds OSM data, so it can be exported under ODbL.';
  end if;
  return new;
end;
$$;

create or replace function osm.require_osm_source() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if tg_table_name = 'routes' then
    v_ids := new.built_from;
  else
    v_ids := array[new.source_record_id];
  end if;
  if exists (
    select 1
    from unnest(v_ids) as s(id)
    left join public.source_records sr on sr.id = s.id
    left join public.data_sources ds on ds.id = sr.data_source_id
    where ds.key is distinct from 'osm'
  ) then
    raise exception 'osm.% rows must cite source records of the osm data source', tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.reject_osm_source_record() from public, anon, authenticated;
revoke all on function osm.require_osm_source() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    'fx_rates', 'agencies', 'areas', 'hike_facts', 'official_routes', 'hike_stages', 'permits', 'fees',
    'hike_rules', 'hike_hazards', 'area_texts', 'places', 'photos'
  ] loop
    execute format(
      'create trigger %I before insert or update of source_record_id on public.%I
         for each row execute function public.reject_osm_source_record()',
      t || '_no_osm_source', t);
  end loop;
end $$;

create trigger elements_osm_source before insert or update of source_record_id on osm.elements
  for each row execute function osm.require_osm_source();
create trigger points_osm_source before insert or update of source_record_id on osm.points
  for each row execute function osm.require_osm_source();
create trigger routes_osm_source before insert or update of built_from on osm.routes
  for each row execute function osm.require_osm_source();

-- ---------------------------------------------------------------------------
-- 2. A source record's data source and licence never change after the fact
-- ---------------------------------------------------------------------------
create or replace function public.source_records_immutable() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.data_source_id is distinct from old.data_source_id or new.license_code is distinct from old.license_code then
    raise exception 'source_records.data_source_id and license_code are immutable'
      using errcode = 'check_violation', hint = 'Insert a new source record for the new source or licence.';
  end if;
  return new;
end;
$$;
revoke all on function public.source_records_immutable() from public, anon, authenticated;
create trigger source_records_immutable before update on public.source_records
  for each row execute function public.source_records_immutable();

-- ---------------------------------------------------------------------------
-- 3. Photos
-- ---------------------------------------------------------------------------
alter table public.photos
  add constraint photos_imported_have_credit check (
    origin = 'user'
    or (license_url is not null and title is not null and (author is not null or credit_line is not null))
  ),
  add constraint photos_published_have_image check (
    status <> 'published' or image_url is not null or storage_path is not null
  ),
  -- Nullable for user uploads (MATCH SIMPLE): imported photos always have a record.
  add constraint photos_source_license foreign key (source_record_id, license_code)
    references public.source_records (id, license_code);

-- ---------------------------------------------------------------------------
-- 4. areas and agencies need a source record
-- ---------------------------------------------------------------------------
alter table public.areas alter column source_record_id set not null;
alter table public.agencies alter column source_record_id set not null;

-- ---------------------------------------------------------------------------
-- 5. OSM routes and metrics
-- ---------------------------------------------------------------------------
alter table osm.routes
  add constraint routes_built_from_required check (cardinality(built_from) > 0);

-- Length comes from the OSM line alone; elevation values need a DEM record.
alter table osm.route_metrics
  add constraint route_metrics_dem_required check (
    dem_source_record_id is not null
    or (gain_m is null and loss_m is null and high_point_m is null and low_point_m is null and profile is null)
  );

-- ---------------------------------------------------------------------------
-- 6. Publish gate
-- ---------------------------------------------------------------------------
create or replace function public.hike_publish_problems(p_hike uuid) returns text[]
language sql stable
set search_path = ''
as $$
  select array_remove(array[
    case when h.name is null or btrim(h.name) = '' then 'name is required' end,
    case when h.country_code is null then 'country_code is required' end,
    case when h.official_url is null or btrim(h.official_url) = '' then 'official_url is required' end,
    case when not exists (select 1 from public.hike_routes r where r.hike_id = h.id and r.is_primary)
          and not exists (select 1 from osm.points p where p.hike_id = h.id and p.kind = 'trailhead')
      then 'a primary route or an OSM trailhead is required' end,
    case when exists (
        select 1 from public.hike_routes r
        join osm.routes o on o.id = r.osm_route_id
        where r.hike_id = h.id and r.is_primary and cardinality(o.built_from) = 0
      ) then 'the primary OSM route needs source records' end,
    case when exists (
        select 1 from public.hike_routes r
        join osm.route_metrics m on m.route_id = r.osm_route_id
        where r.hike_id = h.id and r.is_primary and m.dem_source_record_id is null
          and (m.gain_m is not null or m.loss_m is not null or m.high_point_m is not null
               or m.low_point_m is not null or m.profile is not null)
      ) then 'the primary OSM route''s elevation values need a DEM source record' end,
    case when exists (
        select 1
        from (values
          ('distance_km', h.distance_km is not null),
          ('elevation_gain_m', h.elevation_gain_m is not null),
          ('high_point_m', h.high_point_m is not null),
          ('duration', h.duration_min_minutes is not null or h.duration_max_minutes is not null
                       or h.duration_min_days is not null or h.duration_max_days is not null),
          ('route_type', h.route_type is not null),
          ('difficulty_official', h.difficulty_official is not null),
          ('best_months', h.best_months is not null),
          ('season_note', h.season_note is not null),
          ('permit_required', h.permit_required is not null),
          ('parking', h.parking is not null),
          ('trailhead_access', h.trailhead_access is not null),
          ('public_transport', h.public_transport is not null),
          ('nearest_town', h.nearest_town is not null)
        ) as published(field, is_set)
        where published.is_set and not exists (
          select 1 from public.hike_facts f
          where f.hike_id = h.id and f.field = published.field and f.superseded_at is null
            and f.verified and f.source_record_id is not null
            and case published.field
              when 'distance_km' then (f.value #>> '{}')::numeric = h.distance_km
              when 'elevation_gain_m' then (f.value #>> '{}')::numeric = h.elevation_gain_m
              when 'high_point_m' then (f.value #>> '{}')::numeric = h.high_point_m
              when 'route_type' then f.value #>> '{}' = h.route_type::text
              when 'difficulty_official' then f.value = h.difficulty_official
              when 'best_months' then f.value = to_jsonb(h.best_months)
              when 'season_note' then f.value #>> '{}' = h.season_note
              when 'permit_required' then f.value #>> '{}' = h.permit_required::text
              when 'parking' then f.value #>> '{}' = h.parking
              when 'trailhead_access' then f.value #>> '{}' = h.trailhead_access
              when 'public_transport' then f.value #>> '{}' = h.public_transport
              else true
            end
        )
      ) then 'every published fact needs a current verified fact with a source record and the same value' end,
    case when exists (
        select 1
        from public.photo_links pl
        join public.photos ph on ph.id = pl.photo_id
        left join public.licenses l on l.code = ph.license_code
        where pl.hike_id = h.id
          and ph.status = 'published'
          and (l.allowed is not true or btrim(coalesce(ph.attribution_text, '')) = '')
      ) then 'every published photo needs an allowed licence and attribution' end,
    case when exists (
        select 1
        from public.photo_links pl
        join public.photos ph on ph.id = pl.photo_id
        where pl.hike_id = h.id
          and ph.status = 'published'
          and (ph.license_url is null
               or (ph.author is null and ph.credit_line is null)
               or (ph.image_url is null and ph.storage_path is null)
               or (ph.origin <> 'user' and (ph.title is null or ph.source_record_id is null)))
      ) then 'every published photo needs an image, author or credit line, and a licence link' end
  ], null)
  from public.hikes h
  where h.id = p_hike
$$;

-- hike_facts changes (a fact superseded or removed) re-run the gate at commit.
create or replace function public.hike_facts_publish_gate() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.assert_hike_publishable(old.hike_id);
  return null;
end;
$$;
revoke all on function public.hike_facts_publish_gate() from public, anon, authenticated;

create constraint trigger hike_facts_publish_gate
  after delete or update on public.hike_facts
  deferrable initially deferred
  for each row execute function public.hike_facts_publish_gate();

-- osm.routes and osm.route_metrics changes re-run the gate for the linked hike.
create or replace function public.route_publish_gate() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_route uuid;
  v_hike uuid;
begin
  if tg_table_name = 'route_metrics' then
    v_route := new.route_id;
  else
    v_route := new.id;
  end if;
  for v_hike in select r.hike_id from public.hike_routes r where r.osm_route_id = v_route loop
    perform public.assert_hike_publishable(v_hike);
  end loop;
  return null;
end;
$$;
revoke all on function public.route_publish_gate() from public, anon, authenticated;

create constraint trigger routes_publish_gate
  after update on osm.routes
  deferrable initially deferred
  for each row execute function public.route_publish_gate();
create constraint trigger route_metrics_publish_gate
  after insert or update on osm.route_metrics
  deferrable initially deferred
  for each row execute function public.route_publish_gate();

-- ---------------------------------------------------------------------------
-- 7. Licence flags
-- ---------------------------------------------------------------------------
alter table public.licenses
  add constraint licenses_nc_nd_unknown_not_allowed check (
    not allowed or (code !~ '-N[CD](-|$)' and code not in ('PROPRIETARY', 'UNKNOWN'))
  );

create or replace function public.licenses_guard_flags() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.nc, new.nd, new.commercial_ok, new.allowed, new.photo_ok)
       is distinct from (old.nc, old.nd, old.commercial_ok, old.allowed, old.photo_ok)
     and coalesce(current_setting('gg.licence_review', true), '') <> 'approved' then
    raise exception 'licence flags of % are fixed; changing them needs a reviewed migration', old.code
      using errcode = 'check_violation',
            hint = 'In a migration, run: select set_config(''gg.licence_review'', ''approved'', true);';
  end if;
  return new;
end;
$$;
revoke all on function public.licenses_guard_flags() from public, anon, authenticated;
create trigger licenses_guard_flags before update on public.licenses
  for each row execute function public.licenses_guard_flags();
