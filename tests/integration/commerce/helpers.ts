import { randomUUID } from "node:crypto";
import { sql, withSystem, withUser, type JsonValue } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { createCheckout, type CheckoutInput } from "@/server/commerce/checkout";
import { receivePaymentWebhook } from "@/server/commerce/payments";
import { demoWebhookHeaders, settleDemoSession, type DemoOutcome } from "@/integrations/payments/demo";
import { runDueJobs } from "@/server/jobs/queue";
import { commerceHandlers } from "@/server/jobs/handlers/commerce";
import { localDateInZone, localTimeInZone } from "@/lib/time";
import { createCustomer, trailBySlug } from "../../helpers/db";

export const TZ = "America/Los_Angeles";

/** Local (region) date N days from now. */
export function regionDate(daysAhead: number): string {
  return localDateInZone(new Date(Date.now() + daysAhead * 86_400_000), TZ);
}

/**
 * A date no other test has used yet (test files share one database), so
 * capacity/blocked-day tests never collide. Claimed under an advisory lock
 * by inserting a marker inventory row (default capacity) for that day.
 */
export async function freshDate(): Promise<string> {
  return withSystem(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('commerce-test-dates'))`;
    for (let i = 0; i < 400; i++) {
      const day = regionDate(30 + Math.floor(Math.random() * 320));
      const [used] = await tx`
        select 1 from public.trail_day_inventory where day = ${day}::date
        union all select 1 from public.trips where planned_date = ${day}::date limit 1`;
      if (used) continue;
      await tx`
        insert into public.trail_day_inventory (trail_id, day, note)
        select id, ${day}::date, 'test date claim' from public.trails where slug = 'cinder-spur-draft'`;
      return day;
    }
    throw new Error("no free test date");
  });
}

/**
 * Like freshDate, but in a given calendar month (YYYY-MM) within the booking
 * window, for tests that depend on the month's latest-finish estimate.
 */
export async function freshDateInMonth(yearMonth: string): Promise<string> {
  return withSystem(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('commerce-test-dates'))`;
    const today = regionDate(1);
    const max = regionDate(360);
    for (let d = 1; d <= 28; d++) {
      const day = `${yearMonth}-${String(d).padStart(2, "0")}`;
      if (day < today || day > max) continue;
      const [used] = await tx`
        select 1 from public.trail_day_inventory where day = ${day}::date
        union all select 1 from public.trips where planned_date = ${day}::date limit 1`;
      if (used) continue;
      await tx`
        insert into public.trail_day_inventory (trail_id, day, note)
        select id, ${day}::date, 'test date claim' from public.trails where slug = 'cinder-spur-draft'`;
      return day;
    }
    throw new Error(`no free test date in ${yearMonth}`);
  });
}

/** The next occurrence of a month (1–12) as YYYY-MM, at least ~2 weeks out (region time). */
export function upcomingMonth(month: number): string {
  const start = regionDate(14);
  let y = Number(start.slice(0, 4));
  if (Number(start.slice(5, 7)) > month) y += 1;
  return `${y}-${String(month).padStart(2, "0")}`;
}

export async function savedTrip(
  user: SessionUser,
  opts: {
    trail?: string;
    plannedDate?: string;
    startTime?: string;
    partySize?: number;
    preferences?: Record<string, unknown>;
    itinerary?: Record<string, unknown>;
    aiSummary?: string;
  } = {},
): Promise<{ id: string; trailId: string; regionId: string; plannedDate: string }> {
  const trail = await trailBySlug(opts.trail ?? "lantern-creek-loop");
  const plannedDate = opts.plannedDate ?? (await freshDate());
  const [trip] = await withUser(user, (tx) =>
    tx<{ id: string }[]>`
      insert into public.trips (user_id, region_id, trail_id, planned_date, start_time, party_size, preferences, itinerary, ai_summary, ai_provider)
      values (${user.id}, ${trail.regionId}, ${trail.id}, ${plannedDate}::date, ${opts.startTime ?? "09:00"}::time, ${opts.partySize ?? 2},
              ${tx.json((opts.preferences ?? {}) as JsonValue)}, ${tx.json((opts.itinerary ?? {}) as JsonValue)},
              ${opts.aiSummary ?? null}, ${opts.aiSummary ? "demo-template" : null})
      returning id`,
  );
  return { id: trip.id, trailId: trail.id, regionId: trail.regionId, plannedDate };
}

export async function setCapacity(trailId: string, day: string, capacity: number, blocked = false) {
  await withSystem(
    (tx) => tx`
      insert into public.trail_day_inventory (trail_id, day, capacity, blocked) values (${trailId}, ${day}::date, ${capacity}, ${blocked})
      on conflict (trail_id, day) do update set capacity = excluded.capacity, blocked = excluded.blocked`,
  );
}

export async function checkoutFor(
  user: SessionUser,
  trip: { id: string; plannedDate: string },
  extra: Partial<CheckoutInput> = {},
) {
  return createCheckout(user, {
    tripId: trip.id,
    hikeDate: trip.plannedDate,
    partySize: 2,
    addonCodes: [],
    idempotencyKey: randomUUID(),
    ...extra,
  });
}

/** Customer + saved trip + pending checkout in one step. */
export async function pendingBooking(opts: { partySize?: number; addonCodes?: string[]; trail?: string; plannedDate?: string; simulate?: Record<string, "fail" | "fail_once" | "reject">; shuttlePickup?: string; startTime?: string } = {}) {
  const user = await createCustomer("buyer");
  const trip = await savedTrip(user, { trail: opts.trail, plannedDate: opts.plannedDate, partySize: opts.partySize, startTime: opts.startTime });
  const result = await checkoutFor(user, trip, {
    partySize: opts.partySize ?? 2,
    addonCodes: opts.addonCodes ?? [],
    simulate: opts.simulate,
    shuttlePickup: opts.shuttlePickup,
  });
  if (!result.ok) throw new Error(`checkout failed: ${result.error}`);
  const b = await booking(result.bookingId);
  return { user, trip, bookingId: result.bookingId, sessionId: b.checkoutSessionId!, url: result.url };
}

export async function booking(id: string) {
  const [b] = await sql()<
    {
      id: string;
      status: string;
      tripId: string;
      totalCents: number;
      refundedCents: number;
      receiptNumber: string | null;
      checkoutSessionId: string | null;
      holdExpiresAt: Date | null;
      paidAt: Date | null;
    }[]
  >`select id, status, trip_id, total_cents, refunded_cents, receipt_number, checkout_session_id, hold_expires_at, paid_at from public.bookings where id = ${id}`;
  return b;
}

export async function tripStatus(id: string) {
  const [t] = await sql()<{ status: string }[]>`select status from public.trips where id = ${id}`;
  return t.status;
}

/** Settle a demo session and return the signed delivery (not yet delivered). */
export async function settle(sessionId: string, outcome: DemoOutcome = "paid", amountTotalOverride?: number) {
  const s = await settleDemoSession(sessionId, outcome, { amountTotalOverride });
  if (!s) throw new Error("session already settled");
  return s.body;
}

export async function deliver(body: string, headers?: Record<string, string>) {
  return receivePaymentWebhook("demo", body, new Headers(headers ?? demoWebhookHeaders(body)));
}

export async function payAndDeliver(sessionId: string) {
  return deliver(await settle(sessionId, "paid"));
}

/**
 * Run commerce jobs of the given kinds. With a dedup prefix, ONLY the matching
 * queued jobs run (they are made due; other queued jobs of those kinds are
 * pushed into the future so tests stay isolated from each other).
 */
export async function runJobs(kinds: string[], dedupPrefix?: string) {
  if (dedupPrefix) {
    await sql()`
      update public.jobs set run_at = case when dedup_key like ${dedupPrefix + "%"} then now() else now() + interval '1 day' end
      where status = 'queued' and kind = any(${kinds}::text[])`;
  }
  return runDueJobs(commerceHandlers, { kinds, limit: 50 });
}

export async function jobsFor(prefix: string) {
  return sql()<{ kind: string; status: string; dedupKey: string; attempts: number }[]>`
    select kind, status, dedup_key, attempts from public.jobs where dedup_key like ${prefix + "%"} order by id`;
}

export async function fulfillmentsOf(bookingId: string) {
  return sql()<{ id: string; providerKind: string; status: string; attempts: number; details: Record<string, unknown>; lastError: string | null }[]>`
    select id, provider_kind, status, attempts, details, last_error from public.fulfillments where booking_id = ${bookingId} order by provider_kind`;
}

export { localTimeInZone };
