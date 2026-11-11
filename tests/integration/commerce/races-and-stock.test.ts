import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, sql, withSystem, withUser } from "@/server/db";
import { cancelTripByCustomer, getCancellationPreview } from "@/server/commerce/cancellation";
import { staffCancelBooking, staffRefundBooking, staffRetryFulfillment, staffSetFulfillmentStatus } from "@/server/commerce/staff-actions";
import { getGearKitsAvailable, loadOfferedAddons } from "@/server/commerce/checkout";
import { confirmShuttleQuote, getShuttleForOwner, requestNewShuttleQuote } from "@/server/fulfillment/shuttle";
import { getMealPackProvider, getShuttleProvider } from "@/integrations/partners";
import { getPaymentProviderByName } from "@/integrations/payments";
import { zonedTimeToUtc } from "@/lib/time";
import { createCustomer, demoUser } from "../../helpers/db";
import { booking, checkoutFor, deliver, freshDate, fulfillmentsOf, jobsFor, payAndDeliver, pendingBooking, runJobs, savedTrip, settle, TZ } from "./helpers";

afterAll(closeDb);

async function confirmedBooking(opts: Parameters<typeof pendingBooking>[0]) {
  const p = await pendingBooking(opts);
  const res = await payAndDeliver(p.sessionId);
  if (res.body.outcome !== "confirmed") throw new Error(`not confirmed: ${JSON.stringify(res.body)}`);
  return p;
}

async function fulfillmentRow(id: string) {
  const [f] = await sql()<{ status: string; externalRef: string | null; details: Record<string, unknown> }[]>`
    select status, external_ref, details from public.fulfillments where id = ${id}`;
  return f;
}

async function quotedShuttle() {
  const p = await confirmedBooking({ addonCodes: ["shuttle-trailhead"] });
  const [f] = await fulfillmentsOf(p.bookingId);
  await runJobs(["fulfillment.process"], `fulfill:${f.id}`);
  const view = (await getShuttleForOwner(p.user, p.trip.id, f.id))!;
  const confirmInput = {
    tripId: p.trip.id,
    fulfillmentId: f.id,
    confirmPickup: true as const,
    quotedPriceCents: view.quotedPriceCents!,
    pickupAt: new Date(view.pickupAt!).toISOString(),
  };
  return { ...p, fulfillmentId: f.id, view, confirmInput };
}

describe("refund tier and partner timing use the start frozen at booking (COMMERCE-3)", () => {
  it("stores hike_start_at and ignores later edits of the trip's start time", async () => {
    const { user, trip, bookingId, sessionId } = await pendingBooking({ startTime: "07:00" });
    expect((await payAndDeliver(sessionId)).body.outcome).toBe("confirmed");
    const [b] = await sql()<{ hikeDate: string; hikeStartAt: Date; totalCents: number }[]>`
      select to_char(hike_date, 'YYYY-MM-DD') as hike_date, hike_start_at, total_cents from public.bookings where id = ${bookingId}`;
    const start = zonedTimeToUtc(b.hikeDate, "07:00", TZ);
    expect(new Date(b.hikeStartAt).toISOString()).toBe(start.toISOString());

    // The customer can no longer move the start of a booked trip through the Data API…
    await expect(withUser(user, (tx) => tx`update public.trips set start_time = '23:30' where id = ${trip.id}`)).rejects.toThrow(/cannot be changed/);
    // …and even if the trip's start time changes, the refund window is measured from the booked start.
    await withSystem((tx) => tx`update public.trips set start_time = '23:30' where id = ${trip.id}`);
    const now = new Date(start.getTime() - 40 * 3_600_000); // 40 h before the booked start: the 50% tier
    const preview = await getCancellationPreview(user, trip.id, now);
    expect(preview?.refund).toMatchObject({ tier: "partial", refundCents: Math.floor(b.totalCents / 2) });
    expect(preview?.hikeStart?.toISOString()).toBe(start.toISOString());
    const res = await cancelTripByCustomer(user, trip.id, now);
    expect(res).toMatchObject({ ok: true, refundCents: Math.floor(b.totalCents / 2) });
  });

  it("a saved (unbooked) trip stays editable by its owner", async () => {
    const user = await createCustomer("editable");
    const trip = await savedTrip(user);
    const rows = await withUser(user, (tx) => tx`update public.trips set start_time = '10:15', party_size = 3 where id = ${trip.id} returning id`);
    expect(rows).toHaveLength(1);
  });

  it("times the shuttle pickup from the booked start, not an edited trip start", async () => {
    const { trip, bookingId } = await confirmedBooking({ addonCodes: ["shuttle-trailhead"], startTime: "07:00" });
    await withSystem((tx) => tx`update public.trips set start_time = '23:30' where id = ${trip.id}`);
    const [f] = await fulfillmentsOf(bookingId);
    await runJobs(["fulfillment.process"], `fulfill:${f.id}`);
    const [row] = await sql()<{ pickupAt: Date; hikeStartAt: Date }[]>`
      select sr.pickup_at, b.hike_start_at from public.shuttle_requests sr join public.fulfillments f on f.id = sr.fulfillment_id
      join public.bookings b on b.id = f.booking_id where sr.fulfillment_id = ${f.id}`;
    expect(new Date(row.pickupAt).getTime()).toBeLessThan(new Date(row.hikeStartAt).getTime());
  });
});

describe("a cancellation during a partner call never orphans a partner order (COMMERCE-4)", () => {
  it("meal pack: the order placed while the booking was cancelled is cancelled with the partner", async () => {
    const { bookingId } = await confirmedBooking({ addonCodes: ["meal-pack"] });
    const [f] = await fulfillmentsOf(bookingId);
    const admin = await demoUser("admin");
    const meal = getMealPackProvider("demo");
    const original = meal.placeOrder;
    meal.placeOrder = async (order, ctx) => {
      const r = await original.call(meal, order, ctx);
      expect(await staffCancelBooking(admin, bookingId, "Cancelled during the partner call (test)")).toMatchObject({ ok: true });
      return r;
    };
    try {
      await runJobs(["fulfillment.process"], `fulfill:${f.id}`);
    } finally {
      meal.placeOrder = original;
    }
    const after = await fulfillmentRow(f.id);
    expect(after.status).toBe("cancelled");
    expect(after.externalRef).toBe(`demo_meal_${f.id}`);
    const cancelJobs = await jobsFor(`fulfill-cancel:${f.id}`);
    expect(cancelJobs).toHaveLength(1);
    await runJobs(["fulfillment.cancel"], `fulfill-cancel:${f.id}`);
    expect((await fulfillmentRow(f.id)).details.partnerCancelledAt).toBeTruthy();
    expect(await sql()`select id from public.integration_events where entity_id = ${f.id} and operation = 'cancel_order'`).toHaveLength(1);
  });

  it("shuttle: a ride booked while the booking was cancelled is cancelled with the partner", async () => {
    const s = await quotedShuttle();
    expect(await confirmShuttleQuote(s.user, s.confirmInput)).toMatchObject({ ok: true });
    const admin = await demoUser("admin");
    const shuttle = getShuttleProvider("demo");
    const original = shuttle.requestRide;
    shuttle.requestRide = async (req, ctx) => {
      const r = await original.call(shuttle, req, ctx);
      expect(await staffCancelBooking(admin, s.bookingId, "Cancelled during the ride request (test)")).toMatchObject({ ok: true });
      return r;
    };
    try {
      await runJobs(["shuttle.request_ride"], `shuttle:${s.fulfillmentId}:`);
    } finally {
      shuttle.requestRide = original;
    }
    const after = await fulfillmentRow(s.fulfillmentId);
    expect(after.status).toBe("cancelled");
    expect(after.externalRef).toMatch(/^demo_ride_/);
    expect(await jobsFor(`fulfill-cancel:${s.fulfillmentId}`)).toHaveLength(1);
    await runJobs(["fulfillment.cancel"], `fulfill-cancel:${s.fulfillmentId}`);
    expect((await fulfillmentRow(s.fulfillmentId)).details.partnerCancelledAt).toBeTruthy();
    expect(await sql()`select id from public.integration_events where entity_id = ${s.fulfillmentId} and operation = 'cancel_ride'`).toHaveLength(1);
  });
});

describe("shuttle re-quotes never overwrite a confirmed shuttle (COMMERCE-6)", () => {
  it("a confirmation made while a re-quote is in flight wins; the ride is requested", async () => {
    const s = await quotedShuttle();
    const shuttle = getShuttleProvider("demo");
    const original = shuttle.requestQuote;
    let confirmed: unknown = null;
    shuttle.requestQuote = async (req, ctx) => {
      confirmed = await confirmShuttleQuote(s.user, s.confirmInput); // e.g. another tab
      return original.call(shuttle, req, ctx);
    };
    let requote;
    try {
      requote = await requestNewShuttleQuote(s.user, s.trip.id, s.fulfillmentId, "pinecrest-park-ride");
    } finally {
      shuttle.requestQuote = original;
    }
    expect(confirmed).toMatchObject({ ok: true });
    expect(requote).toMatchObject({ ok: false, code: "state" });
    const view = (await getShuttleForOwner(s.user, s.trip.id, s.fulfillmentId))!;
    expect(view).toMatchObject({ fulfillmentStatus: "requested", requestStatus: "confirmed", pickupDescription: s.view.pickupDescription });
    expect(view.customerConfirmedAt).not.toBeNull();

    await runJobs(["shuttle.request_ride"], `shuttle:${s.fulfillmentId}:`);
    const after = await fulfillmentRow(s.fulfillmentId);
    expect(after.status).toBe("confirmed");
    expect(String(after.details.rideRef)).toMatch(/^demo_ride_/);
  });

  it("each confirmation gets its own ride job (no dedup swallowing a re-confirmation)", async () => {
    const s = await quotedShuttle();
    expect(await confirmShuttleQuote(s.user, s.confirmInput)).toMatchObject({ ok: true });
    // Simulate the earlier ride job having ended and the quote having been offered again.
    await sql()`update public.jobs set status = 'succeeded' where dedup_key like ${`shuttle:${s.fulfillmentId}:%`}`;
    await sql()`update public.shuttle_requests set status = 'quoted', customer_confirmed_at = null where fulfillment_id = ${s.fulfillmentId}`;
    await sql()`update public.fulfillments set status = 'awaiting_customer' where id = ${s.fulfillmentId}`;
    expect(await confirmShuttleQuote(s.user, s.confirmInput)).toMatchObject({ ok: true });
    const jobs = await jobsFor(`shuttle:${s.fulfillmentId}:ride:`);
    expect(jobs).toHaveLength(2);
    expect(jobs.filter((j) => j.status === "queued")).toHaveLength(1);
  });

  it("a ride job that finds its quote no longer confirmed hands the shuttle back to the customer instead of leaving it 'requested'", async () => {
    const s = await quotedShuttle();
    expect(await confirmShuttleQuote(s.user, s.confirmInput)).toMatchObject({ ok: true });
    // An (older, unguarded) re-quote reset the request after the confirmation.
    await sql()`update public.shuttle_requests set status = 'quoted', customer_confirmed_at = null where fulfillment_id = ${s.fulfillmentId}`;
    await runJobs(["shuttle.request_ride"], `shuttle:${s.fulfillmentId}:`);
    const view = (await getShuttleForOwner(s.user, s.trip.id, s.fulfillmentId))!;
    expect(view).toMatchObject({ fulfillmentStatus: "awaiting_customer", requestStatus: "quoted", customerConfirmedAt: null });
    // …and the customer can confirm again, which queues a fresh ride job
    const again = { ...s.confirmInput, quotedPriceCents: view.quotedPriceCents!, pickupAt: new Date(view.pickupAt!).toISOString() };
    expect(await confirmShuttleQuote(s.user, again)).toMatchObject({ ok: true });
    await runJobs(["shuttle.request_ride"], `shuttle:${s.fulfillmentId}:`);
    expect((await fulfillmentRow(s.fulfillmentId)).status).toBe("confirmed");
  });

  it("staff can retry a 'requested' shuttle that has no job left; with a job queued it is a no-op", async () => {
    const s = await quotedShuttle();
    expect(await confirmShuttleQuote(s.user, s.confirmInput)).toMatchObject({ ok: true });
    await sql()`update public.jobs set status = 'cancelled' where dedup_key like ${`shuttle:${s.fulfillmentId}:%`}`;
    const operator = await demoUser("operator");
    expect(await staffRetryFulfillment(operator, s.fulfillmentId)).toMatchObject({ ok: true, message: "Retry queued." });
    const retry = (await jobsFor(`shuttle:${s.fulfillmentId}:ride:`)).filter((j) => j.status === "queued");
    expect(retry).toHaveLength(1);
    expect(retry[0].dedupKey).toMatch(/:retry:/);
    expect(await staffRetryFulfillment(operator, s.fulfillmentId)).toMatchObject({ ok: true, message: expect.stringMatching(/Already queued/) });
    await runJobs(["shuttle.request_ride"], `shuttle:${s.fulfillmentId}:`);
    expect((await fulfillmentRow(s.fulfillmentId)).status).toBe("confirmed");
  });
});

describe("charge.refunded never double-counts our own refunds (COMMERCE-5)", () => {
  function chargeRefundedBody(paymentIntentId: string, amountRefunded: number) {
    return JSON.stringify({
      id: `demo_evt_${randomUUID()}`,
      object: "event",
      type: "charge.refunded",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: `demo_ch_${randomUUID()}`, object: "charge", amount_refunded: amountRefunded, currency: "usd", payment_intent: paymentIntentId } },
    });
  }

  async function paymentIntentOf(bookingId: string) {
    const [p] = await sql()<{ providerPaymentId: string }[]>`select provider_payment_id from public.payments where booking_id = ${bookingId}`;
    return p.providerPaymentId;
  }

  it("a refund whose job failed after the provider processed it is not booked again as an external refund", async () => {
    const { bookingId } = await confirmedBooking({});
    const operator = await demoUser("operator");
    expect(await staffRefundBooking(operator, bookingId, 1000, "Goodwill refund (test)")).toMatchObject({ ok: true });
    const [r] = await sql()<{ id: string }[]>`select id from public.refunds where booking_id = ${bookingId}`;

    const provider = getPaymentProviderByName("demo");
    const original = provider.refund;
    provider.refund = async (input) => {
      await original.call(provider, input); // processed at the provider…
      throw new Error("Request timed out"); // …but the response is lost
    };
    try {
      await runJobs(["refunds.process"], `refund:${r.id}`);
    } finally {
      provider.refund = original;
    }
    const [failed] = await sql()<{ status: string }[]>`select status from public.refunds where id = ${r.id}`;
    expect(failed.status).toBe("failed");

    const pi = await paymentIntentOf(bookingId);
    expect((await deliver(chargeRefundedBody(pi, 1000))).body.outcome).toBe("refund_synced");
    expect(await sql()`select id from public.refunds where booking_id = ${bookingId}`).toHaveLength(1);

    await runJobs(["refunds.process"], `refund:${r.id}`); // the retry replays the same provider refund
    const b = await booking(bookingId);
    expect(b.refundedCents).toBe(1000);
    expect(b.status).toBe("confirmed");
    // a later redelivery of the provider's cumulative total changes nothing
    expect((await deliver(chargeRefundedBody(pi, 1000))).body.outcome).toBe("refund_synced");
    expect((await booking(bookingId)).refundedCents).toBe(1000);
  });

  it("a genuine dashboard refund is synced once, and refunded_cents never exceeds what was paid", async () => {
    const { bookingId } = await confirmedBooking({});
    const total = (await booking(bookingId)).totalCents;
    const pi = await paymentIntentOf(bookingId);
    expect((await deliver(chargeRefundedBody(pi, 700))).body.outcome).toBe("refund_synced");
    expect((await booking(bookingId)).refundedCents).toBe(700);
    expect((await deliver(chargeRefundedBody(pi, total + 5000))).body.outcome).toBe("refund_synced");
    expect((await booking(bookingId)).refundedCents).toBe(total);
    const rows = await sql()<{ amountCents: number }[]>`select amount_cents from public.refunds where booking_id = ${bookingId} order by created_at`;
    expect(rows.map((x) => x.amountCents)).toEqual([700, total - 700]);
  });
});

describe("locker gear is never sold twice (COMMERCE-7)", () => {
  it("held and paid-but-unfulfilled gear kits count against the locker stock", async () => {
    const day = await freshDate();
    const a = await createCustomer("gearA");
    const bUser = await createCustomer("gearB");
    const tripA = await savedTrip(a, { plannedDate: day });
    const tripB = await savedTrip(bUser, { plannedDate: day });
    const offered = await loadOfferedAddons(tripA.regionId);
    const gear = offered.find((x) => x.code === "gear-poles-pack")!;
    expect((await getGearKitsAvailable(offered, tripA.regionId, day))[gear.id]).toBe(5);

    const ra = await checkoutFor(a, tripA, { partySize: 4, addonCodes: ["gear-poles-pack"] });
    if (!ra.ok) throw new Error(ra.error);
    // A's held checkout already takes 4 of the 5 usable kits
    expect((await getGearKitsAvailable(offered, tripA.regionId, day))[gear.id]).toBe(1);
    const held = await checkoutFor(bUser, tripB, { partySize: 4, addonCodes: ["gear-poles-pack"] });
    expect(held).toMatchObject({ ok: false, code: "sold_out", error: expect.stringMatching(/Not enough locker gear/) });

    // paid, fulfillment not run yet: still taken
    expect((await payAndDeliver((await booking(ra.bookingId)).checkoutSessionId!)).body.outcome).toBe("confirmed");
    expect(await checkoutFor(bUser, tripB, { partySize: 4, addonCodes: ["gear-poles-pack"] })).toMatchObject({ ok: false, code: "sold_out" });

    // fulfilled: the reservation replaces the demand (not counted twice)
    const [f] = await fulfillmentsOf(ra.bookingId);
    await runJobs(["fulfillment.process"], `fulfill:${f.id}`);
    expect((await fulfillmentsOf(ra.bookingId))[0].status).toBe("confirmed");
    expect((await getGearKitsAvailable(offered, tripA.regionId, day))[gear.id]).toBe(1);
    expect(await checkoutFor(bUser, tripB, { partySize: 4, addonCodes: ["gear-poles-pack"] })).toMatchObject({ ok: false, code: "sold_out" });
    expect((await checkoutFor(bUser, tripB, { partySize: 1, addonCodes: ["gear-poles-pack"] })).ok).toBe(true);
  });

  it("a paid gear kit whose fulfillment needs attention is still owed to the customer and not resold", async () => {
    const day = await freshDate();
    const a = await createCustomer("gearNA_A");
    const bUser = await createCustomer("gearNA_B");
    const tripA = await savedTrip(a, { plannedDate: day });
    const tripB = await savedTrip(bUser, { plannedDate: day });
    const offered = await loadOfferedAddons(tripA.regionId);
    const gear = offered.find((x) => x.code === "gear-poles-pack")!;
    const ra = await checkoutFor(a, tripA, { partySize: 3, addonCodes: ["gear-poles-pack"], simulate: { "gear-poles-pack": "reject" } });
    if (!ra.ok) throw new Error(ra.error);
    expect((await payAndDeliver((await booking(ra.bookingId)).checkoutSessionId!)).body.outcome).toBe("confirmed");
    const [f] = await fulfillmentsOf(ra.bookingId);
    await runJobs(["fulfillment.process"], `fulfill:${f.id}`);
    expect((await fulfillmentsOf(ra.bookingId))[0].status).toBe("needs_attention"); // partner rejected; staff will follow up
    expect((await getGearKitsAvailable(offered, tripA.regionId, day))[gear.id]).toBe(2);
    expect(await checkoutFor(bUser, tripB, { partySize: 3, addonCodes: ["gear-poles-pack"] })).toMatchObject({ ok: false, code: "sold_out" });
    // once staff cancel that add-on, its kits are free again
    const operator = await demoUser("operator");
    expect(await staffSetFulfillmentStatus(operator, f.id, "cancelled", "Customer took a refund for the gear (test)")).toMatchObject({ ok: true });
    expect((await getGearKitsAvailable(offered, tripA.regionId, day))[gear.id]).toBe(5);
  });

  it("checkout refuses a trip that is no longer saved, re-checked under the trip lock", async () => {
    const user = await createCustomer("lockedTrip");
    const trip = await savedTrip(user);
    await withSystem((tx) => tx`update public.trips set status = 'cancelled' where id = ${trip.id}`);
    expect(await checkoutFor(user, trip)).toMatchObject({ ok: false, code: "already_booked" });
    expect(await sql()`select id from public.bookings where trip_id = ${trip.id}`).toHaveLength(0);
  });

  it("a late payment whose gear was resold after the hold lapsed is refunded instead of overselling", async () => {
    const day = await freshDate();
    const a = await createCustomer("gearLateA");
    const bUser = await createCustomer("gearLateB");
    const tripA = await savedTrip(a, { plannedDate: day });
    const tripB = await savedTrip(bUser, { plannedDate: day });
    const ra = await checkoutFor(a, tripA, { partySize: 4, addonCodes: ["gear-poles-pack"] });
    if (!ra.ok) throw new Error(ra.error);
    const bodyA = await settle((await booking(ra.bookingId)).checkoutSessionId!);
    const created = (JSON.parse(bodyA) as { created: number }).created;
    await withSystem((tx) => tx`update public.bookings set hold_expires_at = to_timestamp(${created}) where id = ${ra.bookingId}`);

    const rb = await checkoutFor(bUser, tripB, { partySize: 4, addonCodes: ["gear-poles-pack"] });
    if (!rb.ok) throw new Error(rb.error);
    expect((await payAndDeliver((await booking(rb.bookingId)).checkoutSessionId!)).body.outcome).toBe("confirmed");

    expect((await deliver(bodyA)).body.outcome).toBe("needs_attention");
    const [refund] = await sql()<{ reason: string }[]>`select reason from public.refunds where booking_id = ${ra.bookingId}`;
    expect(refund.reason).toMatch(/no longer available/);
  });
});
