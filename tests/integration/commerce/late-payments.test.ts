import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, sql, withSystem } from "@/server/db";
import { cancelTripByCustomer } from "@/server/commerce/cancellation";
import { staffCancelBooking } from "@/server/commerce/staff-actions";
import { reconcileEndedCheckouts } from "@/server/commerce/reconcile";
import { getReceipt } from "@/server/commerce/queries";
import { buildDemoEventBody, getDemoSession } from "@/integrations/payments/demo";
import { createCustomer, demoUser } from "../../helpers/db";
import { booking, checkoutFor, deliver, freshDate, jobsFor, payAndDeliver, pendingBooking, runJobs, savedTrip, settle, tripStatus } from "./helpers";

afterAll(closeDb);

/** Refund rows, support tickets, payments and fulfillments of one booking. */
async function sideEffects(bookingId: string) {
  const [refunds, tickets, payments, fulfillments] = await Promise.all([
    sql()<{ id: string; amountCents: number; status: string; reason: string }[]>`
      select id, amount_cents, status, reason from public.refunds where booking_id = ${bookingId} order by created_at`,
    sql()<{ subject: string; priority: string }[]>`select subject, priority from public.support_tickets where booking_id = ${bookingId}`,
    sql()<{ amountCents: number }[]>`select amount_cents from public.payments where booking_id = ${bookingId}`,
    sql()<{ id: string }[]>`select id from public.fulfillments where booking_id = ${bookingId}`,
  ]);
  return { refunds, tickets, payments, fulfillments };
}

/** Make the hold end exactly when the (held-back) payment event happened: paid in time, processed late. */
async function lapseHoldAtEventTime(bookingId: string, body: string) {
  const created = (JSON.parse(body) as { created: number }).created;
  await withSystem((tx) => tx`update public.bookings set hold_expires_at = to_timestamp(${created}) where id = ${bookingId}`);
}

describe("payments for deliberately ended bookings are refunded, never confirmed (COMMERCE-1)", () => {
  it("customer cancelled the trip after the checkout expired; the late payment is refunded and the trip stays cancelled", async () => {
    const { user, trip, bookingId, sessionId } = await pendingBooking({ addonCodes: ["meal-pack"] });
    const body = await settle(sessionId); // paid at the provider; webhook delayed
    // The hold lapsed and the booking expired (e.g. an async payment method still processing).
    await withSystem((tx) => tx`update public.bookings set status = 'expired', hold_expires_at = now() - interval '1 minute' where id = ${bookingId}`);
    expect(await cancelTripByCustomer(user, trip.id)).toMatchObject({ ok: true, alreadyCancelled: false });

    const res = await deliver(body);
    expect(res).toMatchObject({ status: 200, body: { outcome: "needs_attention" } });
    const b = await booking(bookingId);
    expect(b.status).toBe("expired");
    expect(b.receiptNumber).toBeNull();
    expect(b.paidAt).not.toBeNull();
    expect(await tripStatus(trip.id)).toBe("cancelled");
    const fx = await sideEffects(bookingId);
    expect(fx.fulfillments).toHaveLength(0);
    expect(fx.payments).toEqual([{ amountCents: b.totalCents }]);
    expect(fx.refunds).toHaveLength(1);
    expect(fx.refunds[0]).toMatchObject({ amountCents: b.totalCents, reason: expect.stringMatching(/trip was cancelled/) });
    expect(fx.tickets).toEqual([expect.objectContaining({ priority: "high" })]);
    expect(await jobsFor(`refund:${fx.refunds[0].id}`)).toHaveLength(1);

    await runJobs(["refunds.process"], `refund:${fx.refunds[0].id}`);
    const after = await booking(bookingId);
    expect(after.refundedCents).toBe(after.totalCents);
    expect(after.status).toBe("expired"); // never resurrected
    expect(await cancelTripByCustomer(user, trip.id)).toMatchObject({ ok: true, alreadyCancelled: true });
    // a redelivery changes nothing
    expect((await deliver(body)).body.outcome).toBe("duplicate");
    expect((await sideEffects(bookingId)).refunds).toHaveLength(1);
  });

  it("staff cancelled a checkout the customer had already paid: refunded at once, the later webhook is a no-op", async () => {
    const { trip, bookingId, sessionId } = await pendingBooking();
    const body = await settle(sessionId); // paid; webhook not delivered yet
    const admin = await demoUser("admin");
    const res = await staffCancelBooking(admin, bookingId, "Trail closed (test)");
    expect(res).toMatchObject({ ok: true, message: expect.stringMatching(/already paid.*refunded automatically/) });
    const b = await booking(bookingId);
    expect(b.status).toBe("expired");
    const fx = await sideEffects(bookingId);
    expect(fx.refunds).toEqual([expect.objectContaining({ amountCents: b.totalCents, reason: expect.stringMatching(/Trail closed \(test\)/) })]);

    expect((await deliver(body)).body.outcome).toBe("noop");
    expect((await booking(bookingId)).status).toBe("expired");
    expect(await tripStatus(trip.id)).toBe("saved");
    expect((await sideEffects(bookingId)).refunds).toHaveLength(1);
    expect((await sideEffects(bookingId)).payments).toHaveLength(1);
  });

  it("a payment that completes after staff cancelled the checkout is refunded, not confirmed", async () => {
    const { trip, bookingId, sessionId } = await pendingBooking({ addonCodes: ["meal-pack"] });
    const admin = await demoUser("admin");
    expect(await staffCancelBooking(admin, bookingId, "Trail closed (test)")).toMatchObject({ ok: true, message: expect.stringMatching(/No payment had been completed/) });
    // An async payment method succeeds afterwards (the session was already complete/processing).
    const pi = `demo_pi_${randomUUID()}`;
    await withSystem((tx) => tx`update public.demo_checkout_sessions set status = 'complete', payment_status = 'paid', payment_intent_id = ${pi} where id = ${sessionId}`);
    const s = (await getDemoSession(sessionId))!;
    const body = buildDemoEventBody(s, "checkout.session.async_payment_succeeded", { paymentStatus: "paid", status: "complete", paymentIntentId: pi });

    expect((await deliver(body)).body.outcome).toBe("needs_attention");
    const b = await booking(bookingId);
    expect(b.status).toBe("expired");
    expect(await tripStatus(trip.id)).toBe("saved");
    const fx = await sideEffects(bookingId);
    expect(fx.fulfillments).toHaveLength(0);
    expect(fx.refunds).toEqual([expect.objectContaining({ amountCents: b.totalCents, reason: expect.stringMatching(/checkout was ended/) })]);
    await runJobs(["refunds.process"], `refund:${fx.refunds[0].id}`);
    expect((await booking(bookingId)).refundedCents).toBe(b.totalCents);
  });

  it("a late payment that arrives after the booked hike start is refunded", async () => {
    const { trip, bookingId, sessionId } = await pendingBooking();
    await withSystem(
      (tx) => tx`update public.bookings set status = 'expired', hold_expires_at = now() - interval '4 days', hike_start_at = now() - interval '3 days' where id = ${bookingId}`,
    );
    const res = await payAndDeliver(sessionId);
    expect(res.body.outcome).toBe("needs_attention");
    expect((await booking(bookingId)).status).toBe("expired");
    expect(await tripStatus(trip.id)).toBe("saved");
    const fx = await sideEffects(bookingId);
    expect(fx.refunds).toEqual([expect.objectContaining({ reason: expect.stringMatching(/after the booked hike start/) })]);
  });

  it("a late payment for a checkout the customer released is refunded", async () => {
    const { trip, bookingId, sessionId } = await pendingBooking();
    const body = await settle(sessionId);
    await withSystem(
      (tx) => tx`update public.bookings set status = 'expired', hold_expires_at = now(), cancellation_reason = 'Checkout released by the customer to change details' where id = ${bookingId}`,
    );
    expect((await deliver(body)).body.outcome).toBe("needs_attention");
    expect((await booking(bookingId)).status).toBe("expired");
    expect(await tripStatus(trip.id)).toBe("saved");
  });

  it("a paid session of a staff-cancelled checkout whose webhook never arrives is found by the reconcile job and refunded", async () => {
    const { user, trip, bookingId, sessionId } = await pendingBooking();
    await settle(sessionId); // paid at the provider; the webhook is lost
    // Staff ended the checkout, but the provider could not be reached to check the session then.
    await withSystem(
      (tx) => tx`update public.bookings set status = 'expired', hold_expires_at = now(), cancellation_reason = 'Trail closed (test)' where id = ${bookingId}`,
    );
    const r = await reconcileEndedCheckouts();
    expect(r.refunded).toBeGreaterThanOrEqual(1);
    const b = await booking(bookingId);
    expect(b.status).toBe("expired");
    expect(b.paidAt).not.toBeNull();
    expect(await tripStatus(trip.id)).toBe("saved");
    const fx = await sideEffects(bookingId);
    expect(fx.refunds).toEqual([expect.objectContaining({ amountCents: b.totalCents, reason: expect.stringMatching(/checkout was ended/) })]);
    // idempotent: a second run finds nothing left to do for it
    await reconcileEndedCheckouts();
    expect((await sideEffects(bookingId)).refunds).toHaveLength(1);
    // the customer sees a payment record, not a booking receipt
    const receipt = await getReceipt(user, bookingId);
    expect(receipt?.booking).toMatchObject({ status: "expired", receiptNumber: null });
    expect(receipt?.refunds).toHaveLength(1);
  });

  it("an ordinary late payment with capacity left is still confirmed", async () => {
    const { trip, bookingId, sessionId } = await pendingBooking();
    await withSystem((tx) => tx`update public.bookings set status = 'expired', hold_expires_at = now() - interval '1 minute' where id = ${bookingId}`);
    expect((await payAndDeliver(sessionId)).body.outcome).toBe("confirmed");
    expect(await tripStatus(trip.id)).toBe("booked");
  });
});

describe("a payment processed after the hold lapsed re-checks capacity (COMMERCE-2)", () => {
  it("paid inside the hold, webhook delayed past it, spots resold: needs_attention + refund, no overbooking", async () => {
    const day = await freshDate();
    const a = await createCustomer("inholdA");
    const bUser = await createCustomer("inholdB");
    const tripA = await savedTrip(a, { plannedDate: day });
    const tripB = await savedTrip(bUser, { plannedDate: day });
    await withSystem(
      (tx) => tx`
        insert into public.trail_day_inventory (trail_id, day, capacity) values (${tripA.trailId}, ${day}::date, 2)
        on conflict (trail_id, day) do update set capacity = 2, blocked = false`,
    );
    const ra = await checkoutFor(a, tripA, { partySize: 2 });
    if (!ra.ok) throw new Error(ra.error);
    const bodyA = await settle((await booking(ra.bookingId)).checkoutSessionId!); // A pays in time…
    await lapseHoldAtEventTime(ra.bookingId, bodyA); // …but the webhook only arrives after the hold

    const rb = await checkoutFor(bUser, tripB, { partySize: 2 });
    if (!rb.ok) throw new Error(rb.error);
    expect((await payAndDeliver((await booking(rb.bookingId)).checkoutSessionId!)).body.outcome).toBe("confirmed");

    expect((await deliver(bodyA)).body.outcome).toBe("needs_attention");
    expect((await booking(ra.bookingId)).status).toBe("needs_attention");
    const [{ confirmedHikers }] = await sql()<{ confirmedHikers: number }[]>`
      select coalesce(sum(party_size), 0)::int as confirmed_hikers from public.bookings
      where trail_id = ${tripA.trailId} and hike_date = ${day}::date and status = 'confirmed'`;
    expect(confirmedHikers).toBe(2);
    const fx = await sideEffects(ra.bookingId);
    expect(fx.refunds).toEqual([expect.objectContaining({ amountCents: (await booking(ra.bookingId)).totalCents, reason: expect.stringMatching(/fully booked/) })]);
    expect(await tripStatus(tripA.id)).toBe("saved");
  });

  it("re-checks add-on daily capacity, not only the trail", async () => {
    const [meal] = await sql()<{ id: string; dailyCapacity: number | null }[]>`select id, daily_capacity from public.addons where code = 'meal-pack'`;
    await withSystem((tx) => tx`update public.addons set daily_capacity = 2 where id = ${meal.id}`);
    try {
      const day = await freshDate();
      const a = await createCustomer("addonA");
      const bUser = await createCustomer("addonB");
      const tripA = await savedTrip(a, { plannedDate: day });
      const tripB = await savedTrip(bUser, { plannedDate: day });
      const ra = await checkoutFor(a, tripA, { partySize: 2, addonCodes: ["meal-pack"] });
      if (!ra.ok) throw new Error(ra.error);
      const bodyA = await settle((await booking(ra.bookingId)).checkoutSessionId!);
      await lapseHoldAtEventTime(ra.bookingId, bodyA);
      const rb = await checkoutFor(bUser, tripB, { partySize: 2, addonCodes: ["meal-pack"] });
      if (!rb.ok) throw new Error(rb.error);
      expect((await payAndDeliver((await booking(rb.bookingId)).checkoutSessionId!)).body.outcome).toBe("confirmed");

      expect((await deliver(bodyA)).body.outcome).toBe("needs_attention");
      const fx = await sideEffects(ra.bookingId);
      expect(fx.fulfillments).toHaveLength(0);
      expect(fx.refunds).toEqual([expect.objectContaining({ reason: expect.stringMatching(/meal pack is now sold out/i) })]);
    } finally {
      await withSystem((tx) => tx`update public.addons set daily_capacity = ${meal.dailyCapacity} where id = ${meal.id}`);
    }
  });

  it("paid inside the hold and processed while it is still valid: confirmed without a capacity re-check", async () => {
    const { bookingId, sessionId } = await pendingBooking();
    expect((await payAndDeliver(sessionId)).body.outcome).toBe("confirmed");
    expect((await booking(bookingId)).status).toBe("confirmed");
  });
});
