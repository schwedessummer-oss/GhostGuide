-- ============================================================================
-- Admin slice (additive only).
--
--  1. Content review metadata
--     * narrations.supersedes_id — editing an APPROVED narration creates a new
--       version row (status in_review) that points at the row it replaces.
--       The old row stays approved (customers keep hearing it) until the new
--       version is approved; approval then retires the old row in the same
--       transaction.
--     * narrations.review_note / marketing_drafts.review_note — reviewer
--       feedback (e.g. the rejection reason) shown to editors.
--
--  2. RLS alignment with the RBAC matrix (src/server/auth/rbac.ts):
--     the `trails.manage` permission includes operators, but the core write
--     policies on per-field provenance, trail↔source links and POIs only
--     admitted admin/content_editor. These PERMISSIVE policies add operator
--     write access to exactly those three tables. Nothing is removed.
--     (Narration writes stay admin/content_editor: approval is a content
--     decision and operators may not approve content.)
--
--  3. Safety net: the last remaining `admin` role can never be deleted or
--     changed away, whichever code path tries (the use-case also checks
--     under a row lock and returns a friendly error).
--
--  4. Indexes for the admin queues and filters.
-- ============================================================================

-- ---- 1. content review metadata ---------------------------------------------
alter table public.narrations
  add column if not exists supersedes_id uuid references public.narrations (id) on delete set null,
  add column if not exists review_note text check (review_note is null or char_length(review_note) <= 1000);

comment on column public.narrations.supersedes_id is
  'Previous version this row replaces. The previous version stays approved until this one is approved, then it is retired.';
comment on column public.narrations.review_note is 'Reviewer feedback, e.g. the reason a version was rejected.';

-- At most one open (draft / in_review) revision per approved narration.
create unique index if not exists narrations_one_open_revision
  on public.narrations (supersedes_id)
  where supersedes_id is not null and status in ('draft', 'in_review');

alter table public.marketing_drafts
  add column if not exists review_note text check (review_note is null or char_length(review_note) <= 1000);

comment on column public.marketing_drafts.review_note is 'Reviewer feedback, e.g. the reason a draft was rejected.';

-- ---- 2. RLS alignment: operators manage trail facts, links and POIs --------------
create policy provenance_operator_write on public.trail_field_provenance for all to authenticated
  using (public.has_any_role('{operator}')) with check (public.has_any_role('{operator}'));

create policy trail_sources_operator_write on public.trail_sources for all to authenticated
  using (public.has_any_role('{operator}')) with check (public.has_any_role('{operator}'));

create policy pois_operator_write on public.trail_pois for all to authenticated
  using (public.has_any_role('{operator}')) with check (public.has_any_role('{operator}'));

-- ---- 3. never remove the last admin ---------------------------------------------
create or replace function public.prevent_last_admin_removal() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin') then
    if not exists (
      select 1 from public.staff_roles sr
      where sr.role = 'admin' and sr.user_id <> old.user_id
    ) then
      raise exception 'Cannot remove the last remaining admin role'
        using errcode = 'check_violation', hint = 'Grant admin to another user first.';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger staff_roles_keep_last_admin
  before delete or update of role on public.staff_roles
  for each row execute function public.prevent_last_admin_removal();

-- ---- 4. indexes for admin queues ---------------------------------------------------
create index if not exists jobs_status_kind_updated_idx on public.jobs (status, kind, updated_at desc);
create index if not exists audit_logs_action_created_idx on public.audit_logs (action, created_at desc);
create index if not exists audit_logs_actor_created_idx on public.audit_logs (actor_id, created_at desc);
create index if not exists webhook_events_status_received_idx on public.webhook_events (status, received_at desc);
create index if not exists integration_events_kind_created_idx on public.integration_events (provider_kind, created_at desc);
create index if not exists support_tickets_status_priority_idx on public.support_tickets (status, priority, created_at desc);
create index if not exists marketing_drafts_status_idx on public.marketing_drafts (status, updated_at desc);
create index if not exists trip_permits_status_idx on public.trip_permits (status);
create index if not exists route_files_trail_uploaded_idx on public.route_files (trail_id, uploaded_at desc);
create index if not exists gear_reservations_day_idx on public.gear_reservations (reserved_for, status);

-- No new tables: existing grants and RLS policies continue to apply to the new
-- columns (table-level privileges cover them).
