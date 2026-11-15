-- ============================================================================
-- Provenance and licensing (docs/PLAN.md §3 "Provenance and licensing", §4).
--
-- Every value we show carries its source. The LICENCE GATE is enforced by the
-- database, not by application code:
--
--   licenses has UNIQUE (code, allowed). A table that holds licensed content
--   stores license_code plus license_allowed, a column constrained to TRUE,
--   and a composite foreign key (license_code, license_allowed) ->
--   licenses (code, allowed). A row can therefore only reference a licence
--   whose allowed flag is true: NC, ND, proprietary and unknown licences are
--   rejected on insert. A licence cannot be switched to allowed = false while
--   rows still use it (the foreign key blocks the update), so withdrawing a
--   licence forces the affected records to be removed first.
--
-- Photos are stricter (§4.2): photos.sql adds a second gate on photo_ok.
-- ============================================================================

create table public.licenses (
  code text primary key check (code ~ '^[A-Za-z0-9][A-Za-z0-9.+-]*$'),
  name text not null,
  url text check (url is null or url ~ '^https?://'),
  spdx_id text,
  commercial_ok boolean not null,
  nc boolean not null,
  nd boolean not null,
  share_alike boolean not null,
  attribution_required boolean not null,
  allowed boolean not null,
  -- PLAN §4.2: photos only under CC0, public domain, CC BY or CC BY-SA (or our
  -- own user-upload grant), even when a government licence would allow more.
  photo_ok boolean not null default false,
  notes text,
  unique (code, allowed),
  unique (code, photo_ok),
  constraint licenses_allowed_means_open check (not allowed or (commercial_ok and not nc and not nd)),
  constraint licenses_photo_ok_means_allowed check (not photo_ok or allowed)
);
comment on table public.licenses is
  'Licence allow-list. Content tables reference (code, allowed) with allowed fixed to true: the licence gate.';

insert into public.licenses
  (code, name, url, spdx_id, commercial_ok, nc, nd, share_alike, attribution_required, allowed, photo_ok, notes)
values
  -- Public domain
  ('CC0-1.0', 'Creative Commons Zero v1.0 Universal', 'https://creativecommons.org/publicdomain/zero/1.0/', 'CC0-1.0', true, false, false, false, false, true, true, null),
  ('PDDL-1.0', 'Open Data Commons Public Domain Dedication and License v1.0', 'https://opendatacommons.org/licenses/pddl/1-0/', 'PDDL-1.0', true, false, false, false, false, true, true, null),
  ('PD-USGov', 'Public domain: work of the US federal government', 'https://www.usa.gov/government-copyright', null, true, false, false, false, false, true, true,
   '17 U.S.C. §105. Photos count only when credited to the agency with no © mark (PLAN §4.2).'),
  ('PD-other', 'Public domain (Public Domain Mark or expired copyright)', 'https://creativecommons.org/publicdomain/mark/1.0/', null, true, false, false, false, false, true, true,
   'Keep the evidence (e.g. Commons PD template) in license_evidence.'),
  -- Creative Commons Attribution
  ('CC-BY-2.0', 'Creative Commons Attribution 2.0', 'https://creativecommons.org/licenses/by/2.0/', 'CC-BY-2.0', true, false, false, false, true, true, true, null),
  ('CC-BY-2.5', 'Creative Commons Attribution 2.5', 'https://creativecommons.org/licenses/by/2.5/', 'CC-BY-2.5', true, false, false, false, true, true, true, null),
  ('CC-BY-3.0', 'Creative Commons Attribution 3.0', 'https://creativecommons.org/licenses/by/3.0/', 'CC-BY-3.0', true, false, false, false, true, true, true, null),
  ('CC-BY-4.0', 'Creative Commons Attribution 4.0 International', 'https://creativecommons.org/licenses/by/4.0/', 'CC-BY-4.0', true, false, false, false, true, true, true, null),
  ('CC-BY-3.0-AU', 'Creative Commons Attribution 3.0 Australia', 'https://creativecommons.org/licenses/by/3.0/au/', 'CC-BY-3.0-AU', true, false, false, false, true, true, true, null),
  -- Creative Commons Attribution-ShareAlike
  ('CC-BY-SA-2.0', 'Creative Commons Attribution-ShareAlike 2.0', 'https://creativecommons.org/licenses/by-sa/2.0/', 'CC-BY-SA-2.0', true, false, false, true, true, true, true, null),
  ('CC-BY-SA-2.5', 'Creative Commons Attribution-ShareAlike 2.5', 'https://creativecommons.org/licenses/by-sa/2.5/', 'CC-BY-SA-2.5', true, false, false, true, true, true, true, null),
  ('CC-BY-SA-3.0', 'Creative Commons Attribution-ShareAlike 3.0', 'https://creativecommons.org/licenses/by-sa/3.0/', 'CC-BY-SA-3.0', true, false, false, true, true, true, true, null),
  ('CC-BY-SA-4.0', 'Creative Commons Attribution-ShareAlike 4.0 International', 'https://creativecommons.org/licenses/by-sa/4.0/', 'CC-BY-SA-4.0', true, false, false, true, true, true, true, null),
  -- Open data and open government licences (data and facts, not photos)
  ('ODbL-1.0', 'Open Data Commons Open Database License v1.0', 'https://opendatacommons.org/licenses/odbl/1-0/', 'ODbL-1.0', true, false, false, true, true, true, false,
   'OpenStreetMap. Derived data lives only in schema osm (PLAN §4.4).'),
  ('OGL-UK-3.0', 'Open Government Licence v3.0 (UK)', 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/', 'OGL-UK-3.0', true, false, false, false, true, true, false, null),
  ('OGL-CA-2.0', 'Open Government Licence - Canada 2.0', 'https://open.canada.ca/en/open-government-licence-canada', 'OGL-Canada-2.0', true, false, false, false, true, true, false, null),
  ('Etalab-2.0', 'Licence Ouverte / Open Licence 2.0 (Etalab)', 'https://www.etalab.gouv.fr/licence-ouverte-open-licence/', 'etalab-2.0', true, false, false, false, true, true, false, null),
  ('DL-DE-BY-2.0', 'Data licence Germany - attribution - version 2.0', 'https://www.govdata.de/dl-de/by-2-0', 'DL-DE-BY-2.0', true, false, false, false, true, true, false, null),
  ('NLOD-2.0', 'Norwegian Licence for Open Government Data 2.0', 'https://data.norge.no/nlod/en/2.0', 'NLOD-2.0', true, false, false, false, true, true, false, null),
  ('GSI-JP', 'Geospatial Information Authority of Japan terms of use', null, null, true, false, false, false, true, true, false,
   'Open point (PLAN §5): whether derived maps need GSI approval under the Survey Act.'),
  ('OGDL-TW-1.0', 'Open Government Data License, version 1.0 (Taiwan)', 'https://data.gov.tw/license', 'OGDL-Taiwan-1.0', true, false, false, false, true, true, false, null),
  ('KOGL-1', 'Korea Open Government License Type 1 (attribution)', null, null, true, false, false, false, true, true, false,
   'Type 1 only. Types 2-4 add NC or ND and are not allowed.'),
  ('GODL-IN', 'Government Open Data License - India', 'https://data.gov.in/government-open-data-license-india', null, true, false, false, false, true, true, false, null),
  -- Facts read on official pages (PLAN decision Q1): no content reused.
  ('CITED-FACT', 'Fact cited from an official page; no content reused', null, null, true, false, false, false, true, true, false,
   'Individual facts in our own words, with the page URL and the date checked. Never copied text, never photos.'),
  -- NOT allowed (kept so skipped records and rejected inputs can name them)
  ('CC-BY-NC-2.0', 'Creative Commons Attribution-NonCommercial 2.0', 'https://creativecommons.org/licenses/by-nc/2.0/', 'CC-BY-NC-2.0', false, true, false, false, true, false, false, null),
  ('CC-BY-NC-3.0', 'Creative Commons Attribution-NonCommercial 3.0', 'https://creativecommons.org/licenses/by-nc/3.0/', 'CC-BY-NC-3.0', false, true, false, false, true, false, false, null),
  ('CC-BY-NC-4.0', 'Creative Commons Attribution-NonCommercial 4.0 International', 'https://creativecommons.org/licenses/by-nc/4.0/', 'CC-BY-NC-4.0', false, true, false, false, true, false, false, null),
  ('CC-BY-ND-2.0', 'Creative Commons Attribution-NoDerivs 2.0', 'https://creativecommons.org/licenses/by-nd/2.0/', 'CC-BY-ND-2.0', true, false, true, false, true, false, false, null),
  ('CC-BY-ND-3.0', 'Creative Commons Attribution-NoDerivs 3.0', 'https://creativecommons.org/licenses/by-nd/3.0/', 'CC-BY-ND-3.0', true, false, true, false, true, false, false, null),
  ('CC-BY-ND-4.0', 'Creative Commons Attribution-NoDerivatives 4.0 International', 'https://creativecommons.org/licenses/by-nd/4.0/', 'CC-BY-ND-4.0', true, false, true, false, true, false, false, null),
  ('CC-BY-NC-SA-2.0', 'Creative Commons Attribution-NonCommercial-ShareAlike 2.0', 'https://creativecommons.org/licenses/by-nc-sa/2.0/', 'CC-BY-NC-SA-2.0', false, true, false, true, true, false, false, null),
  ('CC-BY-NC-SA-3.0', 'Creative Commons Attribution-NonCommercial-ShareAlike 3.0', 'https://creativecommons.org/licenses/by-nc-sa/3.0/', 'CC-BY-NC-SA-3.0', false, true, false, true, true, false, false, null),
  ('CC-BY-NC-SA-4.0', 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International', 'https://creativecommons.org/licenses/by-nc-sa/4.0/', 'CC-BY-NC-SA-4.0', false, true, false, true, true, false, false, null),
  ('CC-BY-NC-ND-4.0', 'Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International', 'https://creativecommons.org/licenses/by-nc-nd/4.0/', 'CC-BY-NC-ND-4.0', false, true, true, false, true, false, false, null),
  ('PROPRIETARY', 'All rights reserved / proprietary terms', null, null, false, false, false, false, false, false, false, null),
  ('UNKNOWN', 'No licence found or licence unclear', null, null, false, false, false, false, false, false, false,
   'Treated as not allowed until a licence is confirmed.');

-- ---------------------------------------------------------------------------
-- Source registry
-- ---------------------------------------------------------------------------
create type public.data_source_kind as enum (
  'geodata', 'knowledge_base', 'media', 'encyclopedia', 'elevation', 'government_api', 'official_web'
);
create type public.data_source_status as enum ('active', 'skipped', 'pending_review');

create table public.data_sources (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  homepage text check (homepage is null or homepage ~ '^https?://'),
  terms_url text check (terms_url is null or terms_url ~ '^https?://'),
  -- Null when the licence is decided per record (e.g. Commons files, DEM tiles).
  -- URLs left null below are still to be confirmed against the primary page.
  default_license_code text references public.licenses (code),
  kind public.data_source_kind not null,
  status public.data_source_status not null default 'pending_review',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger data_sources_updated_at before update on public.data_sources
  for each row execute function public.set_updated_at();

insert into public.data_sources (key, name, homepage, terms_url, default_license_code, kind, status, notes) values
  ('osm', 'OpenStreetMap', 'https://www.openstreetmap.org', 'https://www.openstreetmap.org/copyright', 'ODbL-1.0', 'geodata', 'active',
   'Fetched in CI via Overpass (batched by id, cached). Credit "© OpenStreetMap contributors".'),
  ('wikidata', 'Wikidata', 'https://www.wikidata.org', 'https://www.wikidata.org/wiki/Wikidata:Licensing', 'CC0-1.0', 'knowledge_base', 'active',
   'Ids, coordinates, official websites, agencies, OSM relation ids (P402).'),
  ('commons', 'Wikimedia Commons', 'https://commons.wikimedia.org', 'https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia', null, 'media', 'active',
   'Licence per file, read from extmetadata.'),
  ('wikivoyage', 'Wikivoyage (English)', 'https://en.wikivoyage.org', 'https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use', 'CC-BY-SA-4.0', 'encyclopedia', 'active',
   'Short excerpts in area_texts only, pinned to a revision.'),
  ('wikipedia', 'Wikipedia (English)', 'https://en.wikipedia.org', 'https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use', 'CC-BY-SA-4.0', 'encyclopedia', 'active',
   'Short excerpts in area_texts only, pinned to a revision.'),
  ('aws_terrain_tiles', 'AWS Terrain Tiles (Mapzen/Tilezen)', 'https://registry.opendata.aws/terrain-tiles/', 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md', null, 'elevation', 'active',
   'Licence per underlying DEM (e.g. USGS 3DEP public domain); credited on /attributions.'),
  ('nps_api', 'US National Park Service API', 'https://www.nps.gov/subjects/developer/', 'https://www.nps.gov/aboutus/disclaimer.htm', 'PD-USGov', 'government_api', 'active',
   'Photos only when credited to NPS with no © mark.'),
  ('ridb', 'Recreation Information Database (RIDB)', 'https://ridb.recreation.gov', null, 'CC-BY-4.0', 'government_api', 'active',
   'Credit "Data Source: Recreation.gov". Treated as CC BY (CC BY vs CC0 open, PLAN §5). Photos skipped: mixed ownership.'),
  ('doc_nz', 'New Zealand Department of Conservation API', 'https://api.doc.govt.nz', null, 'CC-BY-4.0', 'government_api', 'active',
   'DOC photos and logos are excluded by DOC''s own terms.'),
  ('parks_canada_open_data', 'Parks Canada open data', 'https://open.canada.ca', 'https://open.canada.ca/en/open-government-licence-canada', 'OGL-CA-2.0', 'government_api', 'active',
   'Trails, facilities, accommodations. Parks Canada website text and photos are skipped.'),
  ('official_site', 'Official agency and park websites', null, null, 'CITED-FACT', 'official_web', 'active',
   'Individual facts in our own words with the page URL and date checked (PLAN decision Q1). No copied text, no scraping.');

-- ---------------------------------------------------------------------------
-- Ingest runs, source records, skipped records
-- ---------------------------------------------------------------------------
create table public.ingest_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'partial')),
  -- What ran: CLI arguments, region, adapters, git commit, runner (laptop or CI).
  scope jsonb not null default '{}'::jsonb check (jsonb_typeof(scope) = 'object'),
  report jsonb check (report is null or jsonb_typeof(report) = 'object'),
  error text,
  check (finished_at is null or finished_at >= started_at)
);

create table public.source_records (
  id uuid primary key default gen_random_uuid(),
  data_source_id uuid not null references public.data_sources (id),
  external_id text not null check (btrim(external_id) <> ''),
  version text,
  -- Page or item title as shown upstream (used in credits).
  title text,
  source_url text not null check (source_url ~ '^https?://'),
  -- Never stores secrets: adapters strip API keys before saving. Not exposed
  -- to API roles all the same (column grants in catalog_rls.sql).
  request_url text check (request_url is null or request_url ~ '^https?://'),
  license_code text not null,
  license_allowed boolean not null default true check (license_allowed),
  attribution_text text not null check (btrim(attribution_text) <> ''),
  retrieved_at timestamptz not null,
  content_hash text,
  etag text,
  last_modified text,
  -- Path of the cached raw payload (ingest cache). Server-only.
  raw_ref text,
  ingest_run_id uuid references public.ingest_runs (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint source_records_license_gate foreign key (license_code, license_allowed)
    references public.licenses (code, allowed),
  -- A record is unique per upstream content: re-runs on unchanged upstream
  -- data find the existing row instead of adding one (NULL hashes compare equal).
  constraint source_records_content_unique unique nulls not distinct (data_source_id, external_id, content_hash),
  -- Lets dependent rows prove which licence they inherit (composite FKs).
  constraint source_records_id_license_unique unique (id, license_code)
);
create index source_records_license_idx on public.source_records (license_code);
create index source_records_ingest_run_idx on public.source_records (ingest_run_id);
comment on column public.source_records.license_allowed is
  'Always true. Part of the licence-gate foreign key (license_code, license_allowed) -> licenses (code, allowed).';

create type public.skip_reason as enum (
  'license_not_allowed', 'license_unknown', 'photo_license_not_allowed', 'copyright_mark',
  'source_excluded', 'robots_disallowed', 'terms_disallow', 'rights_claimed', 'not_found',
  'invalid_data', 'duplicate', 'other'
);

create table public.skipped_records (
  id uuid primary key default gen_random_uuid(),
  data_source_id uuid not null references public.data_sources (id),
  external_id text,
  source_url text check (source_url is null or source_url ~ '^https?://'),
  reason public.skip_reason not null,
  detail text,
  -- The licence text or code exactly as found upstream, for the skipped-sources log.
  license_text text,
  ingest_run_id uuid references public.ingest_runs (id) on delete set null,
  created_at timestamptz not null default now()
);
create index skipped_records_source_idx on public.skipped_records (data_source_id, created_at desc);
create index skipped_records_ingest_run_idx on public.skipped_records (ingest_run_id);

-- RLS on from the start; grants and public-read policies: catalog_rls.sql.
alter table public.licenses enable row level security;
alter table public.data_sources enable row level security;
alter table public.ingest_runs enable row level security;
alter table public.source_records enable row level security;
alter table public.skipped_records enable row level security;
