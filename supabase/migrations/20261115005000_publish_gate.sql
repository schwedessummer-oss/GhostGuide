-- ============================================================================
-- Publish gate (docs/PLAN.md §6 "Review").
--
-- A hike can be published only when it has a name, a primary country, an
-- official URL, and either a primary route (hike_routes.is_primary) or an OSM
-- trailhead, and when every published photo linked to it has an allowed
-- licence and attribution text. (The photo licence gates already make the
-- last check hold; the gate repeats it as defence in depth.)
--
-- The checks run as DEFERRED constraint triggers, at commit, so ingestion can
-- write a hike, its route and its trailhead in one transaction, and can
-- replace a published hike's route inside a transaction. They fire when:
--  * a hike is inserted or updated with status = 'published';
--  * a hike_routes row or an osm.points row is deleted or moved away from a
--    published hike (so a published hike cannot silently lose its route).
-- ============================================================================

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
        select 1
        from public.photo_links pl
        join public.photos ph on ph.id = pl.photo_id
        left join public.licenses l on l.code = ph.license_code
        where pl.hike_id = h.id
          and ph.status = 'published'
          and (l.allowed is not true or btrim(coalesce(ph.attribution_text, '')) = '')
      ) then 'every published photo needs an allowed licence and attribution' end
  ], null)
  from public.hikes h
  where h.id = p_hike
$$;
comment on function public.hike_publish_problems(uuid) is
  'Reasons a hike cannot be published (empty array when it can). Used by the publish gate and the data-review page.';

create or replace function public.assert_hike_publishable(p_hike uuid) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_problems text[];
begin
  -- Deferred: re-read the hike, it may have changed since the event.
  if not exists (select 1 from public.hikes h where h.id = p_hike and h.status = 'published') then
    return;
  end if;
  v_problems := public.hike_publish_problems(p_hike);
  if cardinality(v_problems) > 0 then
    raise exception 'Hike % cannot be published: %', p_hike, array_to_string(v_problems, '; ')
      using errcode = 'check_violation', hint = 'Fix the listed problems or keep the hike in draft or review.';
  end if;
end;
$$;

create or replace function public.hikes_publish_gate() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.assert_hike_publishable(new.id);
  return null;
end;
$$;

-- For tables whose rows carry hike_id (hike_routes, osm.points).
create or replace function public.hike_link_publish_gate() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.hike_id is not null then
    perform public.assert_hike_publishable(old.hike_id);
  end if;
  return null;
end;
$$;

revoke all on function public.hike_publish_problems(uuid) from public, anon, authenticated;
revoke all on function public.assert_hike_publishable(uuid) from public, anon, authenticated;
revoke all on function public.hikes_publish_gate() from public, anon, authenticated;
revoke all on function public.hike_link_publish_gate() from public, anon, authenticated;

create constraint trigger hikes_publish_gate
  after insert or update on public.hikes
  deferrable initially deferred
  for each row when (new.status = 'published')
  execute function public.hikes_publish_gate();

create constraint trigger hike_routes_publish_gate
  after delete or update on public.hike_routes
  deferrable initially deferred
  for each row execute function public.hike_link_publish_gate();

create constraint trigger points_publish_gate
  after delete or update on osm.points
  deferrable initially deferred
  for each row execute function public.hike_link_publish_gate();
