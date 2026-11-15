-- ============================================================================
-- Commerce slice (additive).
--
--  * demo_checkout_sessions: sessions of the SIMULATED payment provider
--    ("demo_cs_<uuid>"). They play the role Stripe Checkout Sessions play in
--    live mode, so the demo checkout page, webhook redelivery and the
--    reconciliation job behave like the real integration. Rows hold no card
--    data and no customer contact details.
--  * Supporting indexes for booking/payment/refund/fulfillment lookups.
-- ============================================================================

create table public.demo_checkout_sessions (
  id text primary key check (id ~ '^demo_cs_[0-9a-f-]{36}$'),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  amount_total integer not null check (amount_total >= 0),
  currency text not null,
  -- [{label, amountCents}] as shown on the simulated payment page
  line_items jsonb not null default '[]'::jsonb,
  success_url text not null,
  cancel_url text not null,
  status text not null default 'open' check (status in ('open', 'complete', 'expired')),
  payment_status text not null default 'unpaid' check (payment_status in ('paid', 'unpaid', 'no_payment_required')),
  payment_intent_id text unique,
  -- provider-level idempotency: a repeated create with the same key returns the same session
  idempotency_key text not null unique,
  expires_at timestamptz,
  -- last simulated webhook body (no PII) so the demo page can re-deliver it
  last_event_body text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index demo_checkout_sessions_booking_idx on public.demo_checkout_sessions (booking_id);
create trigger demo_checkout_sessions_updated_at before update on public.demo_checkout_sessions
  for each row execute function public.set_updated_at();

alter table public.demo_checkout_sessions enable row level security;

-- Written only by trusted server code (the demo payment adapter). Owners and
-- payment staff may read their rows through the API roles.
revoke all on public.demo_checkout_sessions from anon, authenticated;
grant select on public.demo_checkout_sessions to authenticated;
grant all on public.demo_checkout_sessions to service_role;

create policy demo_checkout_sessions_read on public.demo_checkout_sessions for select to authenticated
  using (user_id = auth.uid() or public.has_any_role('{admin,operator}'));

-- Lookup indexes used by the webhook processor, receipts and fulfillment jobs.
create index if not exists payments_booking_idx on public.payments (booking_id);
create index if not exists refunds_booking_idx on public.refunds (booking_id);
create index if not exists refunds_status_idx on public.refunds (status);
create index if not exists fulfillments_booking_idx on public.fulfillments (booking_id);
create index if not exists gear_reservations_fulfillment_idx on public.gear_reservations (fulfillment_id);
create index if not exists booking_addons_booking_idx on public.booking_addons (booking_id);
create index if not exists bookings_pending_hold_idx on public.bookings (hold_expires_at) where status = 'pending_payment';
