-- ============================================================================
-- Public read access to the catalog (docs/PLAN.md §3 "Security").
--
--  * anon and authenticated may SELECT published hikes and the rows that
--    belong to them, plus reference data (licences, data sources, currencies,
--    FX rates, macro-regions, places, the licence-grant text). Nothing that
--    belongs only to an unpublished hike is visible.
--  * They may never write catalog, provenance or osm tables: ingestion and
--    the admin data-review page use the server-side system connection.
--  * Policies on child tables check the hike's status explicitly. Subqueries
--    inside a policy also run under the caller's RLS, which the
--    source_records and osm policies rely on ("referenced by a visible row").
--  * Internal columns are left out of the column grants: source_records.raw_ref
--    and request_url, hike_facts evidence and verification notes, photos'
--    uploader id and perceptual hash.
-- ============================================================================

grant usage on schema osm to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Reference data: readable in full
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['licenses', 'data_sources', 'currencies', 'fx_rates', 'macro_regions', 'license_grants', 'places'] loop
    execute format('grant select on public.%I to anon, authenticated', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_public_read', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Hikes and rows that belong to a published hike
-- ---------------------------------------------------------------------------
grant select on public.hikes to anon, authenticated;
create policy hikes_public_read on public.hikes for select to anon, authenticated
  using (status = 'published');

do $$
declare t text;
begin
  foreach t in array array[
    'hike_routes', 'hike_stages', 'hike_permits', 'hike_rules', 'hike_hazards', 'hike_cost_estimates', 'hike_redirects'
  ] loop
    execute format('grant select on public.%I to anon, authenticated', t);
    execute format(
      'create policy %I on public.%I for select to anon, authenticated using ('
      'exists (select 1 from public.hikes h where h.id = %I.hike_id and h.status = ''published'''
      '))', t || '_public_read', t, t);
  end loop;
end $$;

-- Current, verified facts only; evidence and verification notes stay internal.
grant select (id, hike_id, field, value_key, value, basis, note, method, source_record_id, license_code,
              checked_at, verified, superseded_at, created_at)
  on public.hike_facts to anon, authenticated;
create policy hike_facts_public_read on public.hike_facts for select to anon, authenticated
  using (
    superseded_at is null and verified
    and exists (select 1 from public.hikes h where h.id = hike_facts.hike_id and h.status = 'published')
  );

grant select on public.official_routes to anon, authenticated;
create policy official_routes_public_read on public.official_routes for select to anon, authenticated
  using (exists (
    select 1 from public.hike_routes hr join public.hikes h on h.id = hr.hike_id
    where hr.official_route_id = official_routes.id and h.status = 'published'
  ));

grant select on public.permits to anon, authenticated;
create policy permits_public_read on public.permits for select to anon, authenticated
  using (exists (
    select 1 from public.hike_permits hp join public.hikes h on h.id = hp.hike_id
    where hp.permit_id = permits.id and h.status = 'published'
  ));

grant select on public.fees to anon, authenticated;
create policy fees_public_read on public.fees for select to anon, authenticated
  using (
    exists (select 1 from public.hikes h where h.id = fees.hike_id and h.status = 'published')
    or exists (
      select 1 from public.hike_permits hp join public.hikes h on h.id = hp.hike_id
      where hp.permit_id = fees.permit_id and h.status = 'published'
    )
  );

grant select on public.areas to anon, authenticated;
create policy areas_public_read on public.areas for select to anon, authenticated
  using (exists (select 1 from public.hikes h where h.area_id = areas.id and h.status = 'published'));

grant select on public.area_macro_regions to anon, authenticated;
create policy area_macro_regions_public_read on public.area_macro_regions for select to anon, authenticated
  using (exists (select 1 from public.hikes h where h.area_id = area_macro_regions.area_id and h.status = 'published'));

grant select on public.agencies to anon, authenticated;
create policy agencies_public_read on public.agencies for select to anon, authenticated
  using (
    exists (select 1 from public.hikes h where h.agency_id = agencies.id and h.status = 'published')
    or exists (
      select 1 from public.areas a join public.hikes h on h.area_id = a.id
      where a.agency_id = agencies.id and h.status = 'published'
    )
  );

grant select on public.area_texts to anon, authenticated;
create policy area_texts_public_read on public.area_texts for select to anon, authenticated
  using (
    exists (select 1 from public.hikes h where h.id = area_texts.hike_id and h.status = 'published')
    or exists (select 1 from public.hikes h where h.area_id = area_texts.area_id and h.status = 'published')
  );

-- ---------------------------------------------------------------------------
-- Photos: published photos linked to visible hikes or areas; uploaders also
-- see their own (Phase 4).
-- ---------------------------------------------------------------------------
grant select on public.photo_links to anon, authenticated;
create policy photo_links_public_read on public.photo_links for select to anon, authenticated
  using (
    exists (select 1 from public.hikes h where h.id = photo_links.hike_id and h.status = 'published')
    or exists (select 1 from public.hikes h where h.area_id = photo_links.area_id and h.status = 'published')
  );

grant select (id, origin, file_page_url, image_url, thumb_url, width, height, title, author, credit_line,
              license_code, license_url, attribution_text, license_evidence, source_record_id, retrieved_at,
              last_verified_at, status, storage_path, ownership_confirmed_at, license_grant_version,
              exif_stripped, created_at, updated_at)
  on public.photos to anon, authenticated;
create policy photos_public_read on public.photos for select to anon, authenticated
  using (status = 'published' and exists (select 1 from public.photo_links pl where pl.photo_id = photos.id));
create policy photos_uploader_read on public.photos for select to authenticated
  using (uploader_user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- OSM rows linked to published hikes
-- ---------------------------------------------------------------------------
grant select on osm.routes, osm.points, osm.route_metrics, osm.elements to anon, authenticated;

create policy routes_public_read on osm.routes for select to anon, authenticated
  using (
    exists (select 1 from public.hikes h where h.id = routes.hike_id and h.status = 'published')
    or exists (
      select 1 from public.hike_routes hr join public.hikes h on h.id = hr.hike_id
      where hr.osm_route_id = routes.id and h.status = 'published'
    )
  );

create policy points_public_read on osm.points for select to anon, authenticated
  using (exists (select 1 from public.hikes h where h.id = points.hike_id and h.status = 'published'));

-- Visible when the route is (osm.routes RLS applies inside the subquery).
create policy route_metrics_public_read on osm.route_metrics for select to anon, authenticated
  using (exists (select 1 from osm.routes r where r.id = route_metrics.route_id));

create policy elements_public_read on osm.elements for select to anon, authenticated
  using (
    exists (select 1 from osm.points p where p.osm_type = elements.osm_type and p.osm_id = elements.osm_id)
    or (elements.osm_type = 'r' and exists (select 1 from osm.routes r where r.relation_ids @> array[elements.osm_id]))
    or (elements.osm_type = 'w' and exists (select 1 from osm.routes r where r.way_ids @> array[elements.osm_id]))
  );

-- ---------------------------------------------------------------------------
-- Source records referenced by a visible row (each subquery runs under that
-- table's own policy). raw_ref and request_url are never exposed.
-- ---------------------------------------------------------------------------
create index routes_built_from_idx on osm.routes using gin (built_from);

grant select (id, data_source_id, external_id, version, title, source_url, license_code, attribution_text,
              retrieved_at, content_hash, etag, last_modified, created_at)
  on public.source_records to anon, authenticated;
create policy source_records_public_read on public.source_records for select to anon, authenticated
  using (
    exists (select 1 from public.hike_facts x where x.source_record_id = source_records.id)
    or exists (select 1 from public.fees x where x.source_record_id = source_records.id)
    or exists (select 1 from public.hike_rules x where x.source_record_id = source_records.id)
    or exists (select 1 from public.hike_hazards x where x.source_record_id = source_records.id)
    or exists (select 1 from public.permits x where x.source_record_id = source_records.id)
    or exists (select 1 from public.hike_stages x where x.source_record_id = source_records.id)
    or exists (select 1 from public.official_routes x where x.source_record_id = source_records.id)
    or exists (select 1 from public.areas x where x.source_record_id = source_records.id)
    or exists (select 1 from public.agencies x where x.source_record_id = source_records.id)
    or exists (select 1 from public.area_texts x where x.source_record_id = source_records.id)
    or exists (select 1 from public.places x where x.source_record_id = source_records.id)
    or exists (select 1 from public.fx_rates x where x.source_record_id = source_records.id)
    or exists (select 1 from public.photos x where x.source_record_id = source_records.id)
    or exists (select 1 from osm.elements x where x.source_record_id = source_records.id)
    or exists (select 1 from osm.points x where x.source_record_id = source_records.id)
    or exists (select 1 from osm.route_metrics x where x.dem_source_record_id = source_records.id)
    or exists (select 1 from osm.routes x where x.built_from @> array[source_records.id])
  );

-- ingest_runs and skipped_records: server-only (no grants, no policies).

-- ---------------------------------------------------------------------------
-- public.hike_public: what hike pages read (Phase 3).
--
-- Merges each published hike with the metrics of its primary OSM route and
-- labels every distance / gain / high-point value with its source (a
-- data_sources key: 'official_site', 'nps_api', ..., or 'osm') and licence.
-- An official value wins when present; otherwise the OSM-derived value is
-- used, labelled ODbL-1.0 (gain and high point also name the DEM licence).
-- SECURITY INVOKER: the caller's RLS applies to every table it reads.
-- ---------------------------------------------------------------------------
create view public.hike_public with (security_invoker = true) as
select
  h.id, h.slug, h.seed_no, h.name, h.alt_names, h.route_variant, h.region_group,
  h.countries, h.country_code, h.subdivision_codes, h.area_id, h.agency_id, h.wikidata_qid,
  h.official_url, h.trip_type, h.typical_days, h.access_mode, h.flags,
  h.duration_min_minutes, h.duration_max_minutes, h.duration_min_days, h.duration_max_days,
  h.route_type, h.difficulty_official, h.best_months, h.season_note, h.permit_required,
  h.parking, h.trailhead_access, h.public_transport, h.nearest_town,
  h.operating_status, h.last_verified_at, h.updated_at,

  coalesce(h.distance_km, round(m.length_m / 1000.0, 2)) as distance_km,
  case
    when h.distance_km is not null then h.distance_basis
    when m.length_m is not null then (case when h.route_type = 'loop' then 'loop' else 'one_way' end)::public.distance_basis
  end as distance_basis,
  case when h.distance_km is not null then fd.source_key when m.length_m is not null then 'osm' end as distance_source,
  case when h.distance_km is not null then fd.license_code when m.length_m is not null then 'ODbL-1.0' end as distance_license,
  case when h.distance_km is not null then fd.source_url end as distance_source_url,

  coalesce(h.elevation_gain_m, m.gain_m) as elevation_gain_m,
  case when h.elevation_gain_m is not null then fg.source_key when m.gain_m is not null then 'osm' end as elevation_gain_source,
  case when h.elevation_gain_m is not null then fg.license_code when m.gain_m is not null then 'ODbL-1.0' end as elevation_gain_license,
  case when h.elevation_gain_m is not null then fg.source_url end as elevation_gain_source_url,
  case when h.elevation_gain_m is null and m.gain_m is not null then dem.license_code end as elevation_gain_dem_license,

  coalesce(h.high_point_m, m.high_point_m) as high_point_m,
  case when h.high_point_m is not null then fh.source_key when m.high_point_m is not null then 'osm' end as high_point_source,
  case when h.high_point_m is not null then fh.license_code when m.high_point_m is not null then 'ODbL-1.0' end as high_point_license,
  case when h.high_point_m is not null then fh.source_url end as high_point_source_url,
  case when h.high_point_m is null and m.high_point_m is not null then dem.license_code end as high_point_dem_license,

  m.route_id as osm_route_id,
  -- True when the page must credit "© OpenStreetMap contributors".
  (m.route_id is not null
    and (h.distance_km is null or (h.elevation_gain_m is null and m.gain_m is not null)
         or (h.high_point_m is null and m.high_point_m is not null))) as uses_osm_values
from public.hikes h
left join lateral (
  select rm.route_id, rm.length_m, rm.gain_m, rm.high_point_m, rm.dem_source_record_id
  from public.hike_routes hr
  join osm.route_metrics rm on rm.route_id = hr.osm_route_id
  where hr.hike_id = h.id and hr.is_primary and hr.kind = 'osm'
) m on true
left join public.source_records dem on dem.id = m.dem_source_record_id
left join lateral (
  select ds.key as source_key, sr.license_code, sr.source_url
  from public.hike_facts f
  join public.source_records sr on sr.id = f.source_record_id
  join public.data_sources ds on ds.id = sr.data_source_id
  where f.hike_id = h.id and f.field = 'distance_km' and f.superseded_at is null and f.verified
) fd on true
left join lateral (
  select ds.key as source_key, sr.license_code, sr.source_url
  from public.hike_facts f
  join public.source_records sr on sr.id = f.source_record_id
  join public.data_sources ds on ds.id = sr.data_source_id
  where f.hike_id = h.id and f.field = 'elevation_gain_m' and f.superseded_at is null and f.verified
) fg on true
left join lateral (
  select ds.key as source_key, sr.license_code, sr.source_url
  from public.hike_facts f
  join public.source_records sr on sr.id = f.source_record_id
  join public.data_sources ds on ds.id = sr.data_source_id
  where f.hike_id = h.id and f.field = 'high_point_m' and f.superseded_at is null and f.verified
) fh on true
where h.status = 'published';

comment on view public.hike_public is
  'Published hikes with OSM route metrics merged in; every distance/gain/high-point value is labelled with its source and licence.';
revoke all on public.hike_public from public, anon, authenticated;
grant select on public.hike_public to anon, authenticated, service_role;

-- Service role (Supabase server key) keeps full access to the new tables.
grant all on all tables in schema public to service_role;
grant all on all tables in schema osm to service_role;
