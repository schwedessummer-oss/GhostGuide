import type postgres from "postgres";
import { localDateInZone } from "../../src/lib/time";

/**
 * Additional demo data for the admin slice (runs after the core seed, on a
 * fresh database). Everything here is DEMONSTRATION data and labeled so:
 *
 *  - a BOOKED Echo Basin trip (permit required) for hiker2 ~6 days out with a
 *    simulated paid booking, permit status "applied" → shows up in the
 *    permit tracker and produces an in-app permit reminder when the
 *    `permits.remind` job runs;
 *  - two support tickets (one urgent, unassigned);
 *  - one dead job (a housekeeping job whose last attempt failed with a
 *    simulated error) to demonstrate the retry queue;
 *  - one failed integration event and one failed webhook delivery (simulated);
 *  - the first `permits.remind` run (it re-schedules itself daily).
 *
 * Uses only core-schema columns and pure modules (runs under tsx).
 */
export async function seedAdmin(sql: postgres.Sql) {
  const [hiker2] = await sql<{ id: string }[]>`select id from auth.users where email = 'hiker2@demo.ghostguide.test'`;
  const [hiker] = await sql<{ id: string }[]>`select id from auth.users where email = 'hiker@demo.ghostguide.test'`;
  const [trail] = await sql<{ id: string; regionId: string; basePriceCents: number; timezone: string }[]>`
    select t.id, t.region_id as "regionId", t.base_price_cents as "basePriceCents", r.timezone
    from public.trails t join public.regions r on r.id = t.region_id where t.slug = 'echo-basin-traverse'`;
  if (!hiker2 || !trail) {
    console.log("admin seed: core data missing; skipping.");
    return;
  }
  const [permit] = await sql<{ id: string }[]>`select id from public.permit_requirements where trail_id = ${trail.id} limit 1`;

  // ---- booked permit trip (simulated payment) -------------------------------
  const today = localDateInZone(new Date(), trail.timezone);
  const hikeDate = new Date(Date.parse(`${today}T12:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
  const party = 2;
  const total = trail.basePriceCents * party;
  const [trip] = await sql<{ id: string }[]>`
    insert into public.trips (user_id, region_id, trail_id, status, planned_date, start_time, party_size)
    values (${hiker2.id}, ${trail.regionId}, ${trail.id}, 'booked', ${hikeDate}::date, '07:00', ${party})
    returning id`;
  const breakdown = {
    currency: "usd",
    lines: [{ kind: "base", label: `Self-guided experience × ${party}`, amountCents: total, quantity: party }],
    baseCents: total,
    adjustmentsCents: 0,
    subtotalCents: total,
    addonsCents: 0,
    totalCents: total,
    pricingVersion: 1,
    trailName: "Echo Basin Traverse",
    hikeDate,
    startTime: "07:00",
    partySize: party,
    occupancy: 0,
    timezone: trail.timezone,
    note: "Demonstration booking created by the admin seed (simulated payment).",
  };
  const [booking] = await sql<{ id: string }[]>`
    insert into public.bookings (user_id, trip_id, trail_id, hike_date, party_size, status, currency, subtotal_cents, addons_cents, total_cents,
                                 price_breakdown, payment_provider, payment_intent_id, paid_at, receipt_number, idempotency_key)
    values (${hiker2.id}, ${trip.id}, ${trail.id}, ${hikeDate}::date, ${party}, 'confirmed', 'usd', ${total}, 0, ${total},
            ${sql.json(breakdown as unknown as postgres.JSONValue)}, 'demo', 'demo_pi_admin_seed_0001', now() - interval '2 days', 'GG-DEMO-ADMIN-0001', 'seed-admin-permit-trip')
    returning id`;
  await sql`
    insert into public.payments (booking_id, provider, provider_payment_id, amount_cents, currency, status, created_at)
    values (${booking.id}, 'demo', 'demo_pi_admin_seed_0001', ${total}, 'usd', 'succeeded', now() - interval '2 days')`;
  if (permit) {
    await sql`
      insert into public.trip_permits (trip_id, permit_requirement_id, status, notes)
      values (${trip.id}, ${permit.id}, 'applied', 'Demo: customer says they applied on the (fictional) agency site.')`;
  }

  // ---- support tickets -------------------------------------------------------
  await sql`
    insert into public.support_tickets (user_id, trip_id, booking_id, subject, body, status, priority)
    values
      (${hiker2.id}, ${trip.id}, ${booking.id}, 'Do I need one permit per person? (demo)',
       'Demonstration ticket: I applied for the Echo Basin permit but I am not sure if my friend needs their own.', 'open', 'urgent'),
      (${hiker?.id ?? hiker2.id}, null, null, 'Audio did not play with my screen locked (demo)',
       'Demonstration ticket: narration stopped when my phone screen locked. Is that expected?', 'pending', 'normal')`;

  // ---- operations examples (simulated failures) --------------------------------
  await sql`
    insert into public.jobs (kind, payload, run_at, status, attempts, max_attempts, last_error, finished_at, dedup_key)
    values ('ops.purge_rate_limits', '{}'::jsonb, now() - interval '3 hours', 'dead', 3, 3,
            'Simulated failure (demo seed): database statement timeout', now() - interval '2 hours', 'seed:admin:dead-job-example')`;
  await sql`
    insert into public.integration_events (provider_kind, provider_key, operation, outcome, entity_type, error, duration_ms, created_at)
    values ('weather', 'nws', 'forecast', 'failure', 'trail', 'Simulated outage (demo seed): api.weather.gov returned HTTP 503', 8000, now() - interval '3 hours')`;
  await sql`
    insert into public.webhook_events (provider, event_id, type, status, attempts, error, payload, received_at)
    values ('demo', 'evt_demo_admin_seed_failed', 'checkout.session.completed', 'failed', 3,
            'Simulated failure (demo seed): signature verification failed', ${sql.json({ demo: true, note: "Simulated webhook for the admin retry view" })},
            now() - interval '5 hours')`;

  // ---- first permit-reminder run (re-schedules itself daily) -------------------
  await sql`
    insert into public.jobs (kind, payload, run_at, dedup_key, max_attempts)
    values ('permits.remind', '{}'::jsonb, now(), ${`periodic:permits.remind:${today}`}, 3)
    on conflict (dedup_key) where dedup_key is not null do nothing`;

  console.log("Seeded admin demo data: permit trip + booking, support tickets, retry-queue and integration examples.");
}
