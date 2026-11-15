-- ============================================================================
-- Commerce: freeze the hike start instant on the booking.
--
-- The cancellation refund tier and partner timing (shuttle pickup) must be
-- measured against the start time that was SOLD, not the trip's current
-- start_time, which the customer can edit through the Data API.
--
--  * bookings.hike_start_at: hike_date + price_breakdown.startTime (HH:MM,
--    default 08:00) in the trail region's time zone. Filled on insert by a
--    trigger (so every writer gets it), backfilled for existing rows, and
--    never recomputed afterwards.
--  * Customers can no longer change the date, start time or group size of a
--    trip once it is booked (or active/completed/cancelled); trusted server
--    code (which re-plans a trip for what was paid for) is not affected.
-- ============================================================================

alter table public.bookings add column if not exists hike_start_at timestamptz;

create or replace function public.bookings_fill_hike_start() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.hike_start_at is null then
    select (new.hike_date
            + case when coalesce(new.price_breakdown ->> 'startTime', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]'
                   then substr(new.price_breakdown ->> 'startTime', 1, 5)::time
                   else time '08:00' end)
           at time zone r.timezone
      into new.hike_start_at
    from public.trails t join public.regions r on r.id = t.region_id
    where t.id = new.trail_id;
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_fill_hike_start on public.bookings;
create trigger bookings_fill_hike_start before insert on public.bookings
  for each row execute function public.bookings_fill_hike_start();

update public.bookings b
set hike_start_at = (b.hike_date
                     + case when coalesce(b.price_breakdown ->> 'startTime', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]'
                            then substr(b.price_breakdown ->> 'startTime', 1, 5)::time
                            else time '08:00' end)
                    at time zone r.timezone
from public.trails t join public.regions r on r.id = t.region_id
where t.id = b.trail_id and b.hike_start_at is null;

-- Lookups of live bookings by trail/day for gear and add-on demand.
create index if not exists bookings_hike_date_status_idx on public.bookings (hike_date, status);

-- ---- Booked trips: date, start time and group are fixed for the customer ----
-- SECURITY INVOKER on purpose: current_user must be the caller's role.
create or replace function public.guard_booked_trip_changes() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' and old.status <> 'saved'
     and (new.planned_date is distinct from old.planned_date
          or new.start_time is distinct from old.start_time
          or new.party_size is distinct from old.party_size) then
    raise exception 'The date, start time and group size of a booked trip cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trips_guard_booked_changes on public.trips;
create trigger trips_guard_booked_changes before update on public.trips
  for each row execute function public.guard_booked_trip_changes();
