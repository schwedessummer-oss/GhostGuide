-- ============================================================================
-- saved_trails RLS: evaluate auth.uid() once per statement (Phase 1, additive)
--
-- Supabase advisor "auth_rls_initplan": a bare auth.uid() in a policy is
-- re-evaluated for every row. Wrapping it in a scalar subquery lets Postgres
-- evaluate it once (an InitPlan). Same rules as before: owner only.
-- ============================================================================
drop policy if exists saved_trails_owner_select on public.saved_trails;
drop policy if exists saved_trails_owner_insert on public.saved_trails;
drop policy if exists saved_trails_owner_delete on public.saved_trails;

create policy saved_trails_owner_select on public.saved_trails
  for select to authenticated using (user_id = (select auth.uid()));
create policy saved_trails_owner_insert on public.saved_trails
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy saved_trails_owner_delete on public.saved_trails
  for delete to authenticated using (user_id = (select auth.uid()));
