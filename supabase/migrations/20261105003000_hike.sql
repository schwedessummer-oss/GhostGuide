-- ============================================================================
-- Hike slice: additive hardening + indexes.
--
-- The core owner policies on hike data check `user_id = auth.uid()` only, so
-- through the Data API a customer could attach a session, point, event,
-- download receipt or feedback row to SOMEONE ELSE's trip/session id (the
-- foreign key alone would accept it). These RESTRICTIVE policies are AND-ed
-- with the existing permissive ones: rows may only reference the customer's
-- own trip / hike session. No existing policy or grant is changed.
-- ============================================================================

-- hike_sessions: must belong to one of the user's own trips
create policy hike_sessions_own_trip_insert on public.hike_sessions
  as restrictive for insert to authenticated
  with check (exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid()));
create policy hike_sessions_own_trip_update on public.hike_sessions
  as restrictive for update to authenticated
  using (exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid()))
  with check (exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid()));

-- location points, events and last-known location: must reference the user's own session
create policy location_points_own_session_insert on public.location_points
  as restrictive for insert to authenticated
  with check (exists (select 1 from public.hike_sessions s where s.id = hike_session_id and s.user_id = auth.uid()));

create policy hike_events_own_session_insert on public.hike_events
  as restrictive for insert to authenticated
  with check (exists (select 1 from public.hike_sessions s where s.id = hike_session_id and s.user_id = auth.uid()));

create policy last_location_own_session_insert on public.hike_last_locations
  as restrictive for insert to authenticated
  with check (exists (select 1 from public.hike_sessions s where s.id = hike_session_id and s.user_id = auth.uid()));
create policy last_location_own_session_update on public.hike_last_locations
  as restrictive for update to authenticated
  using (exists (select 1 from public.hike_sessions s where s.id = hike_session_id and s.user_id = auth.uid()))
  with check (exists (select 1 from public.hike_sessions s where s.id = hike_session_id and s.user_id = auth.uid()));

-- download receipts and feedback: must reference the user's own trip
create policy downloads_own_trip_insert on public.trip_downloads
  as restrictive for insert to authenticated
  with check (exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid()));

create policy feedback_own_trip_insert on public.trip_feedback
  as restrictive for insert to authenticated
  with check (exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid()));
create policy feedback_own_trip_update on public.trip_feedback
  as restrictive for update to authenticated
  using (exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid()))
  with check (exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid()));

-- Event payloads are operator-visible: they must never carry coordinates.
alter table public.hike_events
  add constraint hike_events_payload_no_coordinates
  check (not (payload ?| array['lat', 'lng', 'latitude', 'longitude', 'coords', 'location']));

-- ---------------------------------------------------------------------------
-- Indexes for the hike read paths
-- ---------------------------------------------------------------------------
create index if not exists hike_sessions_trip_started_idx on public.hike_sessions (trip_id, started_at desc);
create index if not exists hike_events_session_kind_idx on public.hike_events (hike_session_id, kind, occurred_at desc);
create index if not exists trip_downloads_trip_created_idx on public.trip_downloads (trip_id, created_at desc);
