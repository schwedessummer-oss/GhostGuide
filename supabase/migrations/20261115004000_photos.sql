-- ============================================================================
-- Photos (docs/PLAN.md §3 "Photos", §4.2-4.3).
--
--  * Two licence gates: the general one (license_code, license_allowed) and a
--    stricter photo gate (license_code, license_photo_ok) -> licenses
--    (code, photo_ok). Only CC0, public domain, CC BY, CC BY-SA and our own
--    user-upload grant licences have photo_ok = true; government licences
--    such as OGL are allowed for data but not for photos.
--  * Every photo needs attribution text. Commons and government photos also
--    need their file page, licence evidence as retrieved and a source record.
--  * User photos (Phase 4) carry the uploader's ownership confirmation and
--    the version of the licence grant they accepted.
-- ============================================================================

create table public.license_grants (
  version text primary key check (version ~ '^[A-Za-z0-9][A-Za-z0-9.-]*$'),
  license_code text not null references public.licenses (code),
  text text not null check (btrim(text) <> ''),
  effective_at timestamptz not null
);

insert into public.licenses
  (code, name, url, spdx_id, commercial_ok, nc, nd, share_alike, attribution_required, allowed, photo_ok, notes)
values
  ('GG-USER-GRANT-1', 'GhostGuide user photo licence grant, version 1', null, null, true, false, false, false, true, true, true,
   'Non-exclusive licence granted by the uploader, who keeps ownership. Draft text pending legal review.');

insert into public.license_grants (version, license_code, text, effective_at) values
  ('1', 'GG-USER-GRANT-1',
   'DRAFT, pending legal review. You confirm that you took this photo or own all rights to it. You keep '
   'ownership and grant GhostGuide a worldwide, non-exclusive, royalty-free licence to host, resize, display '
   'and distribute it on GhostGuide with credit to you. You can ask us to remove it at any time.',
   '2026-11-15T00:00:00Z');

create type public.photo_origin as enum ('commons', 'government', 'user');
create type public.photo_status as enum ('pending', 'published', 'rejected', 'removed');

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  origin public.photo_origin not null,
  file_page_url text check (file_page_url ~ '^https?://'),
  image_url text check (image_url ~ '^https?://'),
  thumb_url text check (thumb_url ~ '^https?://'),
  width integer check (width > 0),
  height integer check (height > 0),
  title text,
  author text,
  credit_line text,
  license_code text not null,
  license_allowed boolean not null default true check (license_allowed),
  license_photo_ok boolean not null default true check (license_photo_ok),
  license_url text check (license_url ~ '^https?://'),
  attribution_text text not null check (btrim(attribution_text) <> ''),
  -- The licence metadata exactly as retrieved (e.g. Commons extmetadata).
  license_evidence jsonb check (license_evidence is null or jsonb_typeof(license_evidence) = 'object'),
  source_record_id uuid references public.source_records (id),
  retrieved_at timestamptz,
  last_verified_at timestamptz,
  status public.photo_status not null default 'pending',
  -- Object path in Supabase Storage (public bucket once approved, quarantine before).
  storage_path text,
  uploader_user_id uuid references auth.users (id) on delete set null,
  ownership_confirmed_at timestamptz,
  license_grant_version text references public.license_grants (version),
  exif_stripped boolean not null default false,
  phash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint photos_license_gate foreign key (license_code, license_allowed)
    references public.licenses (code, allowed),
  constraint photos_photo_license_gate foreign key (license_code, license_photo_ok)
    references public.licenses (code, photo_ok),
  -- Imported photos keep their evidence; our grant licence is for uploads only.
  constraint photos_imported_have_evidence check (
    origin = 'user'
    or (file_page_url is not null and source_record_id is not null and license_evidence is not null and retrieved_at is not null)
  ),
  constraint photos_grant_license_for_uploads_only check ((origin = 'user') = (license_code like 'GG-USER-GRANT-%')),
  constraint photos_uploads_have_grant check (
    origin <> 'user' or (ownership_confirmed_at is not null and license_grant_version is not null)
  ),
  constraint photos_published_uploads_stripped check (origin <> 'user' or status <> 'published' or exif_stripped)
);
create index photos_status_idx on public.photos (status);
create index photos_source_record_idx on public.photos (source_record_id);
create index photos_uploader_idx on public.photos (uploader_user_id);
create unique index photos_file_page_unique on public.photos (file_page_url) where file_page_url is not null;
create trigger photos_updated_at before update on public.photos
  for each row execute function public.set_updated_at();

create table public.photo_links (
  id uuid primary key default gen_random_uuid(),
  photo_id uuid not null references public.photos (id) on delete cascade,
  hike_id uuid references public.hikes (id) on delete cascade,
  area_id uuid references public.areas (id) on delete cascade,
  position smallint not null default 0 check (position >= 0),
  is_hero boolean not null default false,
  created_at timestamptz not null default now(),
  constraint photo_links_one_target check (num_nonnulls(hike_id, area_id) = 1),
  unique nulls not distinct (photo_id, hike_id, area_id)
);
create index photo_links_photo_idx on public.photo_links (photo_id);
create index photo_links_hike_idx on public.photo_links (hike_id, position);
create index photo_links_area_idx on public.photo_links (area_id, position);
create unique index photo_links_one_hero_per_hike on public.photo_links (hike_id) where is_hero and hike_id is not null;
create unique index photo_links_one_hero_per_area on public.photo_links (area_id) where is_hero and area_id is not null;

alter table public.license_grants enable row level security;
alter table public.photos enable row level security;
alter table public.photo_links enable row level security;
