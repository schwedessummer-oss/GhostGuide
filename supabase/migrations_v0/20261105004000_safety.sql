-- ============================================================================
-- Safety slice (check-ins, notifications, sharing, retention). Additive only.
--
-- notifications: rows store ONLY the masked recipient and the message body.
-- `recipient_ref` points at the emergency_contacts row (recipient_kind =
-- 'emergency_contact') or the user (recipient_kind = 'user'); the real phone
-- number / email address is resolved from those tables at send time, so a
-- contact who is deleted (or whose consent is withdrawn) before delivery is
-- never messaged. `checkin_version` is the check-in version the notice was
-- created for (version guard at send time). `subject` is the email subject.
-- ============================================================================

alter table public.notifications
  add column if not exists recipient_ref uuid,
  add column if not exists checkin_version integer,
  add column if not exists subject text;

comment on column public.notifications.recipient_ref is
  'emergency_contacts.id or auth.users.id; the real address is resolved at send time and never stored on this row';
comment on column public.notifications.checkin_version is
  'trip_checkins.version this notice belongs to; obsolete versions are suppressed at send time';

-- Notification history per check-in (trip check-in page, operator views).
create index if not exists notifications_checkin_created_idx on public.notifications (checkin_id, created_at);

-- "I'm okay" taps recorded on the device are applied at most once per client event id.
create unique index if not exists checkin_events_client_event_uidx
  on public.checkin_events (checkin_id, (details ->> 'clientEventId'))
  where details ? 'clientEventId';

-- Share management lists a trip's links; public lookups use the unique token_hash.
create index if not exists trip_shares_trip_created_idx on public.trip_shares (trip_id, created_at desc);

-- Retention purge scans by age; last-location lookups go through the trip's sessions.
create index if not exists location_points_recorded_idx on public.location_points (recorded_at);
create index if not exists hike_last_locations_recorded_idx on public.hike_last_locations (recorded_at);
create index if not exists hike_sessions_trip_started_idx on public.hike_sessions (trip_id, started_at desc);

-- Column privileges: the new notification columns follow the table's
-- existing grants (select via RLS policy notifications_read; no API writes).
revoke insert, update, delete on public.notifications from anon, authenticated;
