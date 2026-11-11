-- ============================================================================
-- Security hardening (applies after all slice migrations).
-- Findings from the integrated security review:
--  1. Customers could DELETE their own trip through the Data API; FK cascades
--     (run as table owner, ignoring RLS) then wiped bookings, payments,
--     refunds, fulfillments, check-ins and notifications.
--  2. trips.region_id was client-chosen and not tied to the trail's region.
--  3. Staff RLS was broader than the RBAC matrix (src/server/auth/rbac.ts):
--     support/operator could read customer phone numbers; operators and
--     editors could change prices; editors could approve/publish marketing.
--  4. Locker access-code hashes/hints were readable through RLS.
-- ============================================================================

-- ---- 1. No customer deletes on lifecycle-bearing or audit-relevant tables ----
revoke delete on public.trips, public.profiles, public.hike_sessions, public.hike_events,
  public.location_points, public.hike_last_locations, public.trip_downloads, public.support_tickets
  from authenticated, anon;

-- ---- 2. A trip's region must be its trail's region ---------------------------
create policy trips_region_matches_trail on public.trips as restrictive for insert to authenticated
  with check (region_id = (select t.region_id from public.trails t where t.id = trail_id));

-- ---- 3a. Customer phone numbers: owner + admin/safety only --------------------
-- Column privileges are per role, and every signed-in user (customer or staff)
-- uses the `authenticated` role, so the phone column is removed from direct
-- SELECT and exposed through accessors that check identity.
revoke select on public.profiles from authenticated;
grant select (id, email, full_name, units, location_retention_days, share_location_with_contacts,
              marketing_opt_in, created_at, updated_at)
  on public.profiles to authenticated;

create or replace function public.profile_phone(p_user uuid) returns text
language sql stable security definer
set search_path = ''
as $$
  select p.phone from public.profiles p
  where p.id = p_user and (p_user = auth.uid() or public.has_any_role('{admin,safety}'))
$$;

create or replace function public.profile_has_phone(p_user uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(p.phone, '') <> '' from public.profiles p
  where p.id = p_user and (p_user = auth.uid() or public.is_staff())
$$;

revoke all on function public.profile_phone(uuid) from public;
revoke all on function public.profile_has_phone(uuid) from public;
grant execute on function public.profile_phone(uuid) to authenticated;
grant execute on function public.profile_has_phone(uuid) to authenticated;

-- ---- 3b. Prices are admin-only (pricing.manage) ------------------------------
drop policy if exists addons_admin_write on public.addons;
create policy addons_admin_write on public.addons for all to authenticated
  using (public.has_any_role('{admin}')) with check (public.has_any_role('{admin}'));

-- SECURITY INVOKER on purpose: current_user must be the caller's role.
create or replace function public.guard_trail_price_changes() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated'
     and (new.base_price_cents is distinct from old.base_price_cents or new.currency is distinct from old.currency)
     and not public.has_any_role('{admin}') then
    raise exception 'Only admins can change trail prices' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger trails_guard_price before update on public.trails
  for each row execute function public.guard_trail_price_changes();

-- ---- 3c. Marketing approval/publication: admin/operator only (marketing.approve)
create or replace function public.guard_marketing_approval() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Granting approval or publishing is restricted; clearing an approval
  -- (an edit sends an approved draft back to review) is allowed.
  if current_user = 'authenticated' and not public.has_any_role('{admin,operator}') then
    if (new.status in ('approved', 'published') and (tg_op = 'INSERT' or new.status is distinct from old.status))
       or (new.approved_at is not null and (tg_op = 'INSERT' or new.approved_at is distinct from old.approved_at))
       or (new.approved_by is not null and (tg_op = 'INSERT' or new.approved_by is distinct from old.approved_by))
       or (new.published_at is not null and (tg_op = 'INSERT' or new.published_at is distinct from old.published_at)) then
      raise exception 'Only admins and operators can approve or publish marketing drafts' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger marketing_drafts_guard_approval before insert or update on public.marketing_drafts
  for each row execute function public.guard_marketing_approval();

-- ---- 4. Locker access-code material is server-only -----------------------------
revoke select on public.gear_reservations from authenticated;
grant select (id, fulfillment_id, gear_item_id, locker_id, reserved_for, access_code_expires_at, status,
              picked_up_at, returned_at, created_at)
  on public.gear_reservations to authenticated;
