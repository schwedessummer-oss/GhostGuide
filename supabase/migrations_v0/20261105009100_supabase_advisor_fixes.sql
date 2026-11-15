-- ============================================================================
-- Supabase security-advisor follow-ups (found on the first hosted project).
--
--  * set_updated_at: pin search_path (lint 0011).
--  * handle_new_user: a trigger-only SECURITY DEFINER function. Triggers fire
--    without EXECUTE privilege, so it does not need to be callable through
--    the Data API (/rest/v1/rpc) by anyone (lint 0028/0029).
--  * profile_phone / profile_has_phone: identity-checked accessors for
--    signed-in users only. Supabase grants EXECUTE on new functions to anon
--    by default; revoke it explicitly (lint 0028).
--
-- Intentionally unchanged:
--  * has_any_role / is_staff stay executable by anon and authenticated: RLS
--    policies on the public catalog call them while evaluating anon queries.
--    They only report the CALLER's own staff roles (false for anon).
--  * jobs, webhook_events, rate_limits, contact_optout_tokens have RLS enabled
--    with no policies on purpose: they are server-only (lint 0008, INFO).
-- ============================================================================

alter function public.set_updated_at() set search_path = '';

revoke execute on function public.handle_new_user() from public, anon, authenticated;

revoke execute on function public.profile_phone(uuid) from public, anon;
revoke execute on function public.profile_has_phone(uuid) from public, anon;
grant execute on function public.profile_phone(uuid) to authenticated;
grant execute on function public.profile_has_phone(uuid) to authenticated;
