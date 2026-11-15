-- ============================================================================
-- Safety slice: contact-side consent (one-click opt-out). Additive only.
--
-- Every notice to an emergency contact carries a link
-- /contact/opt-out/<token>. The random token is issued per notice; only its
-- SHA-256 hash is stored (server-only table, no API-role access), scoped to
-- one emergency_contacts row. Using it withdraws consent immediately
-- (consent_confirmed_at/consent_statement cleared) and records when the
-- CONTACT opted out (contact_opted_out_at) so the hiker can be told.
-- ============================================================================

alter table public.emergency_contacts add column if not exists contact_opted_out_at timestamptz;
comment on column public.emergency_contacts.contact_opted_out_at is
  'When the contact withdrew consent themselves via an opt-out link (written by the server only)';

create table if not exists public.contact_optout_tokens (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.emergency_contacts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists contact_optout_tokens_contact_idx on public.contact_optout_tokens (contact_id);
create index if not exists contact_optout_tokens_expires_idx on public.contact_optout_tokens (expires_at);

-- Server-only: RLS on with no policies, and no privileges for API roles.
alter table public.contact_optout_tokens enable row level security;
revoke all on public.contact_optout_tokens from anon, authenticated;
grant all on public.contact_optout_tokens to service_role;

-- Customers keep managing their own contacts, but contact_opted_out_at is a
-- record of the CONTACT's choice: API roles may not write it.
revoke insert, update on public.emergency_contacts from anon, authenticated;
grant insert (user_id, name, phone, email, relationship, consent_confirmed_at, consent_statement)
  on public.emergency_contacts to authenticated;
grant update (name, phone, email, relationship, consent_confirmed_at, consent_statement)
  on public.emergency_contacts to authenticated;
