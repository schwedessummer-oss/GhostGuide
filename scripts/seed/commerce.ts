import { randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { cumulativeDistancesM, projectOntoLine, type Position } from "../../src/domain/geo";
import { formatReceiptNumber, toProviderLineItems, type StoredPriceBreakdown } from "../../src/domain/booking";
import { quotePrice, type PricingRule } from "../../src/domain/pricing";
import { addMinutesToClock, localDateInZone, zonedTimeToUtc } from "../../src/lib/time";
import { accessCodeHint, deriveAccessCode, hashAccessCode } from "../../src/integrations/partners/gear-locker/access-code";
import { DEMO_PICKUP_POINTS } from "../../src/integrations/partners/shuttle/pickup-points";

/**
 * Commerce demo data (runs after the core seed, on a fresh database), all
 * for the demo hiker (hiker@demo.ghostguide.test) and all SIMULATED:
 *
 *  1. A BOOKED trip on Whisper Falls ~10 days out with a confirmed booking
 *     paid through the simulated provider (receipt, payment row) and three
 *     add-ons showing separate partner statuses:
 *       gear locker   → confirmed, access code ready (stored hashed only)
 *       shuttle       → awaiting the customer's confirmation of a quote
 *       meal pack     → needs attention after 3 failed simulated attempts
 *  2. A SAVED trip on Lantern Creek Loop ~14 days out, ready to book.
 *
 * Only pure modules are imported (no server-only code), so this runs under tsx.
 */
const TZ_FALLBACK = "America/Los_Angeles";

interface TrailRow {
  id: string;
  regionId: string;
  name: string;
  basePriceCents: number;
  currency: string;
  estimatedDurationMin: number;
  geometry: { coordinates: Position[] } | null;
  trailheadName: string | null;
  trailheadLat: number;
  trailheadLng: number;
}

async function trail(sql: postgres.Sql, slug: string): Promise<TrailRow> {
  const [t] = await sql<TrailRow[]>`
    select id, region_id as "regionId", name, base_price_cents as "basePriceCents", currency,
           estimated_duration_min as "estimatedDurationMin", geometry, trailhead_name as "trailheadName",
           trailhead_lat as "trailheadLat", trailhead_lng as "trailheadLng"
    from public.trails where slug = ${slug}`;
  if (!t) throw new Error(`commerce seed: trail ${slug} missing`);
  return t;
}

/** Simple deterministic itinerary (estimates) so the trip dashboard has content. */
async function itineraryFor(sql: postgres.Sql, t: TrailRow, plannedDate: string, startTime: string) {
  const pois = await sql<{ id: string; name: string; lat: number; lng: number }[]>`
    select id, name, lat, lng from public.trail_pois where trail_id = ${t.id} order by seq`;
  const coords = t.geometry?.coordinates ?? [];
  const cum = coords.length > 1 ? cumulativeDistancesM(coords) : [0];
  const total = cum[cum.length - 1] || 1;
  const paceFactor = 1.1;
  const duration = Math.round(t.estimatedDurationMin * paceFactor);
  let hint = 0;
  const stops = pois.map((p) => {
    const along = coords.length > 1 ? projectOntoLine({ lat: p.lat, lng: p.lng }, coords, cum, hint).alongM : 0;
    hint = along;
    return { poiId: p.id, name: p.name, alongM: Math.round(along), etaOffsetMin: Math.round((along / total) * duration) };
  });
  return {
    version: 1,
    trailId: t.id,
    plannedDate,
    startTime,
    paceFactor,
    estimatedDurationMin: duration,
    estimatedFinishTime: addMinutesToClock(startTime, duration),
    stops,
    reminders: { hydrationEveryMin: 30, paceCheckEveryMin: 45 },
    notes: ["Demonstration itinerary: times are estimates for a fictional trail."],
    generatedAt: new Date().toISOString(),
  };
}

export async function seedCommerce(sql: postgres.Sql) {
  const [hiker] = await sql<{ id: string }[]>`select id from auth.users where email = 'hiker@demo.ghostguide.test'`;
  if (!hiker) throw new Error("commerce seed: demo hiker missing");
  const [region] = await sql<{ timezone: string }[]>`select timezone from public.regions where slug = 'demo-ghost-ridge'`;
  const tz = region?.timezone ?? TZ_FALLBACK;
  const secret = process.env.AUTH_SECRET ?? "dev-only-insecure-secret-change-me-0123456789";
  const dayIn = (n: number) => localDateInZone(new Date(Date.now() + n * 86_400_000), tz);

  // ---- 1. booked trip with mixed partner statuses ----------------------------
  const wf = await trail(sql, "whisper-falls");
  const bookedDate = dayIn(10);
  const startTime = "09:00";
  const partySize = 2;
  const [bookedTrip] = await sql<{ id: string }[]>`
    insert into public.trips (user_id, region_id, trail_id, status, planned_date, start_time, party_size, itinerary, ai_summary, ai_provider, ai_generated_at)
    values (${hiker.id}, ${wf.regionId}, ${wf.id}, 'booked', ${bookedDate}::date, ${startTime}::time, ${partySize},
            ${sql.json((await itineraryFor(sql, wf, bookedDate, startTime)) as unknown as postgres.JSONValue)},
            ${"A relaxed river walk to a two-tier waterfall (demonstration trail). Start at 9:00, take the seasonal crossing carefully, and plan to be back by early afternoon. This summary is simulated AI text."},
            'demo', now())
    returning id`;

  const addons = await sql<{ id: string; code: string; name: string; kind: string; providerKey: string; priceCents: number; pricingUnit: "per_person" | "per_booking" }[]>`
    select id, code, name, kind, provider_key as "providerKey", price_cents as "priceCents", pricing_unit as "pricingUnit" from public.addons
    where code in ('gear-poles-pack', 'shuttle-trailhead', 'meal-pack') order by code`;
  const rules = await sql<PricingRule[]>`
    select id, name, kind, value::float8 as value, params, region_id as "regionId", trail_id as "trailId", active, priority,
           to_char(effective_from, 'YYYY-MM-DD') as "effectiveFrom", to_char(effective_to, 'YYYY-MM-DD') as "effectiveTo"
    from public.pricing_rules where active`;
  const quote = quotePrice({
    basePriceCents: wf.basePriceCents,
    partySize,
    hikeDate: bookedDate,
    occupancy: 0,
    regionId: wf.regionId,
    trailId: wf.id,
    rules,
    addons: addons.map((a) => ({ code: a.code, name: a.name, priceCents: a.priceCents, pricingUnit: a.pricingUnit })),
    currency: wf.currency,
  });
  const breakdown: StoredPriceBreakdown = { ...quote, trailName: wf.name, hikeDate: bookedDate, startTime, partySize, occupancy: 0, timezone: tz };
  const bookingId = randomUUID();
  const sessionId = `demo_cs_${randomUUID()}`;
  const paymentIntent = `demo_pi_${randomUUID()}`;
  const paidAt = new Date(Date.now() - 2 * 86_400_000);
  await sql`
    insert into public.bookings (id, user_id, trip_id, trail_id, hike_date, party_size, status, currency, subtotal_cents, addons_cents, total_cents,
                                 price_breakdown, payment_provider, checkout_session_id, payment_intent_id, hold_expires_at, paid_at,
                                 receipt_number, idempotency_key, created_at)
    values (${bookingId}, ${hiker.id}, ${bookedTrip.id}, ${wf.id}, ${bookedDate}::date, ${partySize}, 'confirmed', ${quote.currency},
            ${quote.subtotalCents}, ${quote.addonsCents}, ${quote.totalCents}, ${sql.json(breakdown as unknown as postgres.JSONValue)}, 'demo',
            ${sessionId}, ${paymentIntent}, ${new Date(paidAt.getTime() + 25 * 60_000)}::timestamptz, ${paidAt}::timestamptz,
            ${formatReceiptNumber(paidAt, randomBytes(6))}, ${randomUUID()}, ${new Date(paidAt.getTime() - 5 * 60_000)}::timestamptz)`;
  await sql`
    insert into public.demo_checkout_sessions (id, booking_id, user_id, amount_total, currency, line_items, success_url, cancel_url, status,
                                               payment_status, payment_intent_id, idempotency_key, expires_at)
    values (${sessionId}, ${bookingId}, ${hiker.id}, ${quote.totalCents}, ${quote.currency},
            ${sql.json(toProviderLineItems(quote, `Self-guided hike: ${wf.name} × ${partySize}`) as unknown as postgres.JSONValue)},
            ${`/checkout/success?booking=${bookingId}`}, ${`/checkout/cancelled?booking=${bookingId}`}, 'complete', 'paid', ${paymentIntent},
            ${`checkout:${bookingId}`}, ${new Date(paidAt.getTime() + 25 * 60_000)}::timestamptz)`;
  await sql`
    insert into public.payments (booking_id, provider, provider_payment_id, amount_cents, currency, status, created_at)
    values (${bookingId}, 'demo', ${paymentIntent}, ${quote.totalCents}, ${quote.currency}, 'succeeded', ${paidAt}::timestamptz)`;

  const byCode = Object.fromEntries(addons.map((a) => [a.code, a]));
  const baIds: Record<string, string> = {};
  for (const a of addons) {
    const qty = a.pricingUnit === "per_person" ? partySize : 1;
    const details = a.kind === "shuttle" ? { shuttlePickup: DEMO_PICKUP_POINTS[0].key } : {};
    const [ba] = await sql<{ id: string }[]>`
      insert into public.booking_addons (booking_id, addon_id, quantity, unit_price_cents, total_cents, details)
      values (${bookingId}, ${a.id}, ${qty}, ${a.priceCents}, ${a.priceCents * qty}, ${sql.json(details)}) returning id`;
    baIds[a.code] = ba.id;
  }

  // gear locker: confirmed, reservations with a hashed access code
  const [gearF] = await sql<{ id: string }[]>`
    insert into public.fulfillments (booking_id, booking_addon_id, provider_kind, provider_key, status, attempts)
    values (${bookingId}, ${baIds["gear-poles-pack"]}, 'gear_locker', ${byCode["gear-poles-pack"].providerKey}, 'confirmed', 1) returning id`;
  const items = await sql<{ id: string; lockerId: string; label: string; kind: string }[]>`
    select distinct on (kind, label) id, locker_id as "lockerId", label, kind from public.gear_items
    where kind in ('trekking_poles', 'daypack') and status = 'available' order by kind, label limit 100`;
  const pick = [...items.filter((i) => i.kind === "trekking_poles").slice(0, partySize), ...items.filter((i) => i.kind === "daypack").slice(0, partySize)];
  const reservationIds: string[] = [];
  for (const it of pick) {
    const [r] = await sql<{ id: string }[]>`
      insert into public.gear_reservations (fulfillment_id, gear_item_id, locker_id, reserved_for, status)
      values (${gearF.id}, ${it.id}, ${it.lockerId}, ${bookedDate}::date, 'reserved') returning id`;
    reservationIds.push(r.id);
  }
  await sql`update public.gear_items set status = 'reserved' where id = any(${pick.map((p) => p.id)}::uuid[])`;
  const primary = reservationIds[0];
  const code = deriveAccessCode(secret, primary);
  const codeExpires = zonedTimeToUtc(bookedDate, "23:59", tz);
  await sql`
    update public.gear_reservations set access_code_hash = ${hashAccessCode(secret, primary, code)}, access_code_hint = null,
      access_code_expires_at = ${codeExpires}::timestamptz
    where id = any(${reservationIds}::uuid[])`;
  const [locker] = await sql<{ name: string; locationDescription: string }[]>`
    select name, location_description as "locationDescription" from public.gear_lockers where id = ${pick[0]?.lockerId ?? null}`;
  await sql`
    update public.fulfillments set external_ref = ${primary}, details = ${sql.json({
      simulated: true,
      lockerName: locker?.name ?? "Demo locker",
      locationDescription: locker?.locationDescription ?? "Trailhead (demo)",
      items: pick.map((p) => p.label),
      primaryReservationId: primary,
      codeHint: accessCodeHint(code),
      codeExpiresAt: codeExpires.toISOString(),
    })}
    where id = ${gearF.id}`;

  // shuttle: quoted, awaiting the customer's confirmation (no ride requested)
  const point = DEMO_PICKUP_POINTS[0];
  const pickupAt = zonedTimeToUtc(bookedDate, addMinutesToClock(startTime, -(point.driveMinutes + 15)), tz);
  const shuttlePrice = byCode["shuttle-trailhead"].priceCents;
  const quoteExpires = new Date(Date.now() + 3 * 86_400_000);
  const [shuttleF] = await sql<{ id: string }[]>`
    insert into public.fulfillments (booking_id, booking_addon_id, provider_kind, provider_key, status, attempts, details)
    values (${bookingId}, ${baIds["shuttle-trailhead"]}, 'shuttle', ${byCode["shuttle-trailhead"].providerKey}, 'awaiting_customer', 1,
            ${sql.json({
              simulated: true,
              pickupKey: point.key,
              pickup: point.label,
              dropoff: wf.trailheadName ?? "Trailhead",
              pickupAt: pickupAt.toISOString(),
              priceCents: shuttlePrice,
              prepaidCents: shuttlePrice,
              quoteRef: `demo_sq_seed_${randomUUID().slice(0, 8)}`,
              quoteExpiresAt: quoteExpires.toISOString(),
            })})
    returning id`;
  await sql`
    insert into public.shuttle_requests (fulfillment_id, pickup_description, pickup_lat, pickup_lng, dropoff_description, pickup_at,
                                         quoted_price_cents, quote_expires_at, status)
    values (${shuttleF.id}, ${point.label}, ${point.lat}, ${point.lng}, ${wf.trailheadName ?? "Trailhead"}, ${pickupAt}::timestamptz,
            ${shuttlePrice}, ${quoteExpires}::timestamptz, 'quoted')`;

  // meal pack: failed 3 simulated attempts → needs attention (booking unaffected)
  await sql`
    insert into public.fulfillments (booking_id, booking_addon_id, provider_kind, provider_key, status, attempts, last_error, details)
    values (${bookingId}, ${baIds["meal-pack"]}, 'meal_pack', ${byCode["meal-pack"].providerKey}, 'needs_attention', 3,
            'Simulated meal pack timeout (failure injection: fail)', ${sql.json({ simulated: true })})`;

  await sql`
    insert into public.audit_logs (actor_id, actor_roles, action, entity_type, entity_id, metadata)
    values (null, '{system}', 'booking.confirmed', 'booking', ${bookingId}, ${sql.json({ seeded: true })})`;

  // ---- 2. saved trip, ready to book ----------------------------------------
  const lc = await trail(sql, "lantern-creek-loop");
  const savedDate = dayIn(14);
  await sql`
    insert into public.trips (user_id, region_id, trail_id, status, planned_date, start_time, party_size, itinerary)
    values (${hiker.id}, ${lc.regionId}, ${lc.id}, 'saved', ${savedDate}::date, '10:00'::time, 2,
            ${sql.json((await itineraryFor(sql, lc, savedDate, "10:00")) as unknown as postgres.JSONValue)})`;

  console.log("Seeded commerce demo: 1 booked trip (gear confirmed, shuttle awaiting confirmation, meal pack needs attention) and 1 saved trip.");
}
