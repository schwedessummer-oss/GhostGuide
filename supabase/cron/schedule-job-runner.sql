-- ============================================================================
-- Per-minute job runner trigger for Supabase (run once in the SQL editor of
-- your Supabase project AFTER deploying the app). NOT a migration: it needs
-- your deployment URL and CRON_SECRET, which must not be committed.
--
-- Why: check-in reminders and overdue notices need ~1-minute precision.
-- Vercel Hobby crons run at most daily (Pro allows per-minute), so this uses
-- Supabase pg_cron + pg_net (documented Supabase pattern) to call the app's
-- protected /api/cron/jobs endpoint every minute. The Vercel daily cron in
-- vercel.json remains as a safety net.
--
-- Security: the secret is stored in Supabase Vault and read at call time.
-- pg_net briefly stores request headers in net.http_request_queue until sent,
-- so restrict which roles can log in to the database.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1) Store the deployment URL and the CRON_SECRET (same value as in Vercel env).
select vault.create_secret('https://YOUR-DEPLOYMENT.vercel.app', 'ghostguide_app_url');
select vault.create_secret('REPLACE_WITH_CRON_SECRET', 'ghostguide_cron_secret');

-- 2) Schedule the runner every minute.
select cron.schedule(
  'ghostguide-job-runner',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'ghostguide_app_url') || '/api/cron/jobs',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ghostguide_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Inspect recent calls:   select * from net._http_response order by created desc limit 20;
-- Inspect cron runs:      select * from cron.job_run_details order by start_time desc limit 20;
-- Remove the schedule:    select cron.unschedule('ghostguide-job-runner');
