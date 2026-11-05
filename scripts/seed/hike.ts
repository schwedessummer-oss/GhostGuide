import { randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { Position } from "../../src/domain/geo";
import { buildRouteModel, poiAlongPositions } from "../../src/domain/progress";
import { DEFAULT_SIMULATOR_CONFIG, createSimulatorState, simulatorStep } from "../../src/domain/gps-simulator";
import { addMinutesToClock, localDateInZone, zonedTimeToUtc } from "../../src/lib/time";

/**
 * Hike-slice demo data (runs after the core seed, on a fresh database), for
 * the second demo customer (hiker2@demo.ghostguide.test), all SIMULATED:
 *
 *  1. A BOOKED trip on Lantern Creek Loop for TODAY (region time) with a
 *     confirmed booking paid through the simulated provider — ready to
 *     prepare, download and start in the demo.
 *  2. A COMPLETED trip on Hollow Pine Ridge six days ago with a finished
 *     hike session recorded by the GPS SIMULATOR (points, narration
 *     triggers, a pause), a verified offline download and feedback, so the
 *     completion summary and admin views have history. The session carries a
 *     `simulator_on` event marking its locations as simulated.
 *
 * Only pure modules are imported (no server-only code), so this runs under tsx.
 */
interface TrailRow {
  id: string;
  regionId: string;
  name: string;
  basePriceCents: number;
  currency: string;
  estimatedDurationMin: number;
  routeType: "loop" | "out_and_back" | "point_to_point";
  geometry: { coordinates: Position[] };
}

async function trail(sql: postgres.Sql, slug: string): Promise<TrailRow> {
  const [t] = await sql<TrailRow[]>`
    select id, region_id as "regionId", name, base_price_cents as "basePriceCents", currency,
           estimated_duration_min as "estimatedDurationMin", route_type as "routeType", geometry
    from public.trails where slug = ${slug}`;
  if (!t) throw new Error(`hike seed: trail ${slug} missing`);
  return t;
}

async function itinerary(sql: postgres.Sql, t: TrailRow, plannedDate: string, startTime: string) {
  const pois = await sql<{ id: string; seq: number; name: string; lat: number; lng: number }[]>`
    select id, seq, name, lat, lng from public.trail_pois where trail_id = ${t.id} order by seq`;
  const model = buildRouteModel(t.geometry.coordinates, t.routeType);
  const along = poiAlongPositions(model, pois);
  const duration = Math.round(t.estimatedDurationMin * 1.05);
  return {
    version: 1,
    trailId: t.id,
    plannedDate,
    startTime,
    paceFactor: 1.05,
    estimatedDurationMin: duration,
    estimatedFinishTime: addMinutesToClock(startTime, duration),
    stops: pois.map((p) => ({ poiId: p.id, name: p.name, alongM: Math.round(along[p.id]), etaOffsetMin: Math.round((along[p.id] / model.totalM) * duration) })),
    reminders: { hydrationEveryMin: 30, paceCheckEveryMin: 45 },
    notes: ["Demonstration itinerary: times are estimates for a fictional trail."],
    generatedAt: new Date().toISOString(),
  };
}

async function confirmedBooking(sql: postgres.Sql, userId: string, tripId: string, t: TrailRow, hikeDate: string, partySize: number, paidAt: Date) {
  const total = t.basePriceCents * partySize;
  const bookingId = randomUUID();
  const receipt = `GG-${hikeDate.replace(/-/g, "").slice(2)}-${randomBytes(3).toString("hex").toUpperCase()}`;
  await sql`
    insert into public.bookings (id, user_id, trip_id, trail_id, hike_date, party_size, status, currency, subtotal_cents, addons_cents,
                                 total_cents, price_breakdown, payment_provider, payment_intent_id, paid_at, receipt_number, idempotency_key, created_at)
    values (${bookingId}, ${userId}, ${tripId}, ${t.id}, ${hikeDate}::date, ${partySize}, 'confirmed', ${t.currency}, ${total}, 0, ${total},
            ${sql.json({ seeded: true, simulated: true })}, 'demo', ${`demo_pi_hike_${randomUUID()}`}, ${paidAt}::timestamptz, ${receipt},
            ${`seed-hike-${randomUUID()}`}, ${new Date(paidAt.getTime() - 5 * 60_000)}::timestamptz)`;
  await sql`
    insert into public.payments (booking_id, provider, provider_payment_id, amount_cents, currency, status, created_at)
    values (${bookingId}, 'demo', ${`demo_pay_hike_${randomUUID()}`}, ${total}, ${t.currency}, 'succeeded', ${paidAt}::timestamptz)`;
}

export async function seedHike(sql: postgres.Sql) {
  const [hiker] = await sql<{ id: string }[]>`select id from auth.users where email = 'hiker2@demo.ghostguide.test'`;
  if (!hiker) throw new Error("hike seed: demo hiker2 missing");
  const [region] = await sql<{ timezone: string }[]>`select timezone from public.regions where slug = 'demo-ghost-ridge'`;
  const tz = region?.timezone ?? "America/Los_Angeles";
  const dayIn = (n: number) => localDateInZone(new Date(Date.now() + n * 86_400_000), tz);

  // ---- 1. booked trip today --------------------------------------------------
  const lc = await trail(sql, "lantern-creek-loop");
  const today = dayIn(0);
  const [booked] = await sql<{ id: string }[]>`
    insert into public.trips (user_id, region_id, trail_id, status, planned_date, start_time, party_size, itinerary)
    values (${hiker.id}, ${lc.regionId}, ${lc.id}, 'booked', ${today}::date, '10:30'::time, 1,
            ${sql.json((await itinerary(sql, lc, today, "10:30")) as unknown as postgres.JSONValue)})
    returning id`;
  await confirmedBooking(sql, hiker.id, booked.id, lc, today, 1, new Date(Date.now() - 86_400_000));

  // ---- 2. completed trip with a simulated recorded hike ------------------------
  const hp = await trail(sql, "hollow-pine-ridge");
  const pastDate = dayIn(-6);
  const [done] = await sql<{ id: string }[]>`
    insert into public.trips (user_id, region_id, trail_id, status, planned_date, start_time, party_size, itinerary)
    values (${hiker.id}, ${hp.regionId}, ${hp.id}, 'completed', ${pastDate}::date, '09:00'::time, 2,
            ${sql.json((await itinerary(sql, hp, pastDate, "09:00")) as unknown as postgres.JSONValue)})
    returning id`;
  await confirmedBooking(sql, hiker.id, done.id, hp, pastDate, 2, new Date(Date.now() - 9 * 86_400_000));

  const model = buildRouteModel(hp.geometry.coordinates, hp.routeType);
  const pois = await sql<{ id: string; seq: number; lat: number; lng: number }[]>`
    select id, seq, lat, lng from public.trail_pois where trail_id = ${hp.id} order by seq`;
  const poiAlong = poiAlongPositions(model, pois);
  const startedAt = zonedTimeToUtc(pastDate, "09:05", tz);
  const stepMs = 30_000;
  const pauseAt = Math.round(model.totalM * 0.49); // lunch at the viewpoint
  const pauseMs = 20 * 60_000;
  let sim = createSimulatorState(20261105);
  let clock = startedAt.getTime();
  let paused = false;
  const points: { id: string; lat: number; lng: number; acc: number; at: Date }[] = [];
  const events: { id: string; kind: string; payload: Record<string, unknown>; at: Date }[] = [
    { id: randomUUID(), kind: "simulator_on", payload: { simulated: true }, at: new Date(clock) },
    { id: randomUUID(), kind: "start", payload: { simulated: true }, at: new Date(clock) },
  ];
  const heard = new Set<string>();
  while (!sim.finished && points.length < 2000) {
    const r = simulatorStep(sim, model, { ...DEFAULT_SIMULATOR_CONFIG, speedMps: 1.25, poorFixChance: 0 }, stepMs, clock);
    sim = r.state;
    if (r.fix) points.push({ id: randomUUID(), lat: r.fix.lat, lng: r.fix.lng, acc: r.fix.accuracyM, at: new Date(clock) });
    for (const p of pois) {
      if (!heard.has(p.id) && sim.alongM >= poiAlong[p.id]) {
        heard.add(p.id);
        events.push({ id: randomUUID(), kind: "poi_triggered", payload: { poiId: p.id, source: "gps", simulated: true }, at: new Date(clock) });
      }
    }
    if (!paused && sim.alongM >= pauseAt) {
      paused = true;
      events.push({ id: randomUUID(), kind: "pause", payload: {}, at: new Date(clock) });
      clock += pauseMs;
      events.push({ id: randomUUID(), kind: "resume", payload: {}, at: new Date(clock) });
    }
    clock += stepMs;
  }
  const finishedAt = new Date(clock);
  events.push({ id: randomUUID(), kind: "finish", payload: { progressM: Math.round(model.totalM) }, at: finishedAt });

  const [session] = await sql<{ id: string }[]>`
    insert into public.hike_sessions (trip_id, user_id, status, started_at, finished_at, distance_completed_m, last_sync_at, last_location_at)
    values (${done.id}, ${hiker.id}, 'finished', ${startedAt}::timestamptz, ${finishedAt}::timestamptz, ${Math.round(model.totalM)},
            ${finishedAt}::timestamptz, ${points[points.length - 1].at}::timestamptz)
    returning id`;
  const pointRows = points.map((p) => ({
    hike_session_id: session.id,
    user_id: hiker.id,
    client_point_id: p.id,
    lat: p.lat,
    lng: p.lng,
    accuracy_m: p.acc,
    recorded_at: p.at,
  }));
  for (let i = 0; i < pointRows.length; i += 500) {
    await sql`insert into public.location_points ${sql(pointRows.slice(i, i + 500), "hike_session_id", "user_id", "client_point_id", "lat", "lng", "accuracy_m", "recorded_at")}`;
  }
  for (const e of events) {
    await sql`
      insert into public.hike_events (hike_session_id, user_id, client_event_id, kind, payload, occurred_at)
      values (${session.id}, ${hiker.id}, ${e.id}, ${e.kind}, ${sql.json(e.payload as postgres.JSONValue)}, ${e.at}::timestamptz)`;
  }
  const last = points[points.length - 1];
  await sql`
    insert into public.hike_last_locations (hike_session_id, user_id, lat, lng, accuracy_m, recorded_at, received_at)
    values (${session.id}, ${hiker.id}, ${last.lat}, ${last.lng}, ${last.acc}, ${last.at}::timestamptz, ${finishedAt}::timestamptz)`;
  await sql`
    insert into public.trip_downloads (trip_id, user_id, manifest_version, manifest_checksum, item_count, verified_complete, created_at)
    values (${done.id}, ${hiker.id}, 1, ${randomBytes(32).toString("hex")}, 18, true, ${new Date(startedAt.getTime() - 86_400_000)}::timestamptz)`;
  await sql`
    insert into public.trip_feedback (trip_id, user_id, rating, comments, issues)
    values (${done.id}, ${hiker.id}, 4, 'Demo feedback: loved the viewpoint story; GPS was a bit slow under the trees.', ${["gps_inaccurate"]}::text[])`;

  console.log(`Seeded hike demo: 1 booked trip today and 1 completed trip with ${points.length} simulated location points.`);
}
