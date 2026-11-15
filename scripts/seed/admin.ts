import type postgres from "postgres";

/**
 * Demo data for the admin area (runs after the core seed, on a fresh
 * database). Everything here is DEMONSTRATION data and labeled so:
 *
 *  - two support tickets (one urgent, unassigned);
 *  - one dead job (a housekeeping job whose last attempt failed with a
 *    simulated error) to demonstrate the retry queue;
 *  - one failed integration event (simulated).
 */
export async function seedAdmin(sql: postgres.Sql) {
  const [hiker] = await sql<{ id: string }[]>`select id from auth.users where email = 'hiker@demo.ghostguide.test'`;
  const [hiker2] = await sql<{ id: string }[]>`select id from auth.users where email = 'hiker2@demo.ghostguide.test'`;
  if (!hiker || !hiker2) {
    console.log("admin seed: demo users missing; skipping.");
    return;
  }

  // ---- support tickets -------------------------------------------------------
  await sql`
    insert into public.support_tickets (user_id, subject, body, status, priority)
    values
      (${hiker2.id}, 'I cannot sign in on my phone (demo)',
       'Demonstration ticket: signing in works on my laptop but the phone keeps showing the sign-in page.', 'open', 'urgent'),
      (${hiker.id}, 'Can I change the email on my account? (demo)',
       'Demonstration ticket: I would like to use a different email address for my account.', 'pending', 'normal')`;

  // ---- operations examples (simulated failures) --------------------------------
  await sql`
    insert into public.jobs (kind, payload, run_at, status, attempts, max_attempts, last_error, finished_at, dedup_key)
    values ('ops.purge_rate_limits', '{}'::jsonb, now() - interval '3 hours', 'dead', 3, 3,
            'Simulated failure (demo seed): database statement timeout', now() - interval '2 hours', 'seed:admin:dead-job-example')`;
  await sql`
    insert into public.integration_events (provider_kind, provider_key, operation, outcome, entity_type, error, duration_ms, created_at)
    values ('weather', 'nws', 'forecast', 'failure', 'trail', 'Simulated outage (demo seed): api.weather.gov returned HTTP 503', 8000, now() - interval '3 hours')`;

  console.log("Seeded admin demo data: support tickets, retry-queue and integration examples.");
}
