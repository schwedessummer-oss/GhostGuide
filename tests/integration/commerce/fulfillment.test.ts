import { afterAll, describe, expect, it } from "vitest";
import { closeDb, sql, withSystem } from "@/server/db";
import { MAX_FULFILLMENT_ATTEMPTS, processFulfillment } from "@/server/fulfillment/process";
import { confirmShuttleQuote, getShuttleForOwner, requestNewShuttleQuote, requestShuttleRide } from "@/server/fulfillment/shuttle";
import { revealAccessCodes } from "@/server/fulfillment/access-codes";
import { getTripBookingView } from "@/server/commerce/queries";
import { ShuttleConfirmationRequiredError } from "@/integrations/partners";
import { deriveAccessCode } from "@/integrations/partners/gear-locker/access-code";
import { createCustomer } from "../../helpers/db";
import { booking, fulfillmentsOf, jobsFor, payAndDeliver, pendingBooking, runJobs } from "./helpers";

afterAll(closeDb);

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";

async function confirmedBooking(opts: Parameters<typeof pendingBooking>[0]) {
  const p = await pendingBooking(opts);
  const res = await payAndDeliver(p.sessionId);
  if (res.body.outcome !== "confirmed") throw new Error(`not confirmed: ${JSON.stringify(res.body)}`);
  return p;
}

async function runFulfillment(fulfillmentId: string) {
  return runJobs(["fulfillment.process"], `fulfill:${fulfillmentId}`);
}

describe("partner fulfillment", () => {
  it("reserves locker gear and issues a code that is never stored in clear", async () => {
    const { bookingId, user, trip } = await confirmedBooking({ addonCodes: ["gear-poles-pack"], partySize: 2, trail: "whisper-falls" });
    const [f] = await fulfillmentsOf(bookingId);
    await runFulfillment(f.id);
    const [done] = await fulfillmentsOf(bookingId);
    expect(done.status).toBe("confirmed");
    expect(done.details.codeHint).toMatch(/^\d{2}$/);
    const reservations = await sql()<{ id: string; status: string; accessCodeHash: string; accessCodeHint: string; reservedFor: string }[]>`
      select id, status, access_code_hash, access_code_hint, to_char(reserved_for, 'YYYY-MM-DD') as reserved_for
      from public.gear_reservations where fulfillment_id = ${f.id}`;
    expect(reservations).toHaveLength(4); // poles + daypack per person
    expect(reservations.every((r) => r.status === "reserved" && r.reservedFor === trip.plannedDate)).toBe(true);
    const code = deriveAccessCode(SECRET, String(done.details.primaryReservationId));
    // only a hash + hint are stored; the code appears nowhere in the row
    const raw = await sql()`select row_to_json(gr)::text as j from public.gear_reservations gr where fulfillment_id = ${f.id}`;
    expect(raw.every((r) => !String(r.j).includes(`"${code}"`))).toBe(true);
    expect(reservations[0].accessCodeHint).toBe(code.slice(-2));
    // the owner sees the code; nobody else does
    expect(await revealAccessCodes(user, bookingId)).toEqual({ [f.id]: code });
    const other = await createCustomer("snoop");
    expect(await revealAccessCodes(other, bookingId)).toEqual({});
    const view = await getTripBookingView(user, trip.id);
    expect(view?.fulfillments[0].accessCode).toBe(code);
    // re-running the job is a no-op (idempotent)
    expect(await processFulfillment(f.id)).toMatchObject({ outcome: "noop" });
    expect(await sql()`select id from public.gear_reservations where fulfillment_id = ${f.id}`).toHaveLength(4);
  });

  it("retries a failing partner, then flags needs_attention while the booking stays confirmed", async () => {
    const { bookingId } = await confirmedBooking({ addonCodes: ["meal-pack"], simulate: { "meal-pack": "fail" } });
    const [f] = await fulfillmentsOf(bookingId);
    for (let i = 1; i <= MAX_FULFILLMENT_ATTEMPTS; i++) {
      await runFulfillment(f.id);
      const [cur] = await fulfillmentsOf(bookingId);
      expect(cur.attempts).toBe(i);
      expect(cur.status).toBe(i < MAX_FULFILLMENT_ATTEMPTS ? "failed" : "needs_attention");
    }
    const [final] = await fulfillmentsOf(bookingId);
    expect(final.lastError).toMatch(/Simulated meal pack timeout/);
    expect((await booking(bookingId)).status).toBe("confirmed");
    const [job] = await jobsFor(`fulfill:${f.id}`);
    expect(job.status).toBe("succeeded"); // the job finished; the fulfillment is flagged for staff
    const failures = await sql()`select id from public.integration_events where entity_id = ${f.id} and outcome = 'failure'`;
    expect(failures).toHaveLength(MAX_FULFILLMENT_ATTEMPTS);
  });

  it("succeeds on retry with fail_once", async () => {
    const { bookingId } = await confirmedBooking({ addonCodes: ["meal-pack"], simulate: { "meal-pack": "fail_once" } });
    const [f] = await fulfillmentsOf(bookingId);
    await runFulfillment(f.id);
    expect((await fulfillmentsOf(bookingId))[0].status).toBe("failed");
    await runFulfillment(f.id);
    const [done] = await fulfillmentsOf(bookingId);
    expect(done.status).toBe("confirmed");
    expect(done.details.orderRef).toBe(`demo_meal_${f.id}`);
  });

  it("partial fulfillment: one add-on rejected, the other succeeds, booking unaffected", async () => {
    // demo kitchen rejects parties of exactly 7
    const { bookingId, user, trip } = await confirmedBooking({ addonCodes: ["meal-pack", "sat-communicator"], partySize: 7, trail: "hollow-pine-ridge" });
    const fs = await fulfillmentsOf(bookingId);
    for (const f of fs) await runFulfillment(f.id);
    const byKind = Object.fromEntries((await fulfillmentsOf(bookingId)).map((f) => [f.providerKind, f]));
    expect(byKind.meal_pack.status).toBe("needs_attention");
    expect(byKind.meal_pack.attempts).toBe(1); // permanent rejection: not retried
    expect(byKind.satellite_device.status).toBe("confirmed");
    expect(String(byKind.satellite_device.details.disclaimer)).toMatch(/does not provide, monitor or relay SOS/);
    expect((await booking(bookingId)).status).toBe("confirmed");
    const view = await getTripBookingView(user, trip.id);
    expect(view?.fulfillments.map((f) => f.status).sort()).toEqual(["confirmed", "needs_attention"]);
  });
});

describe("shuttle confirmation", () => {
  it("never requests a ride before the customer confirms pickup, price and time", async () => {
    const { bookingId, user, trip } = await confirmedBooking({ addonCodes: ["shuttle-trailhead"], shuttlePickup: "ridge-town-inn" });
    const [f] = await fulfillmentsOf(bookingId);
    await runFulfillment(f.id);
    const [quoted] = await fulfillmentsOf(bookingId);
    expect(quoted.status).toBe("awaiting_customer");
    const view = await getShuttleForOwner(user, trip.id, f.id);
    expect(view).toMatchObject({ requestStatus: "quoted", pickupDescription: "Ridge Town Inn (demo)", quotedPriceCents: 3500, customerConfirmedAt: null });

    // the ride request refuses without confirmation
    await expect(requestShuttleRide(f.id)).rejects.toBeInstanceOf(ShuttleConfirmationRequiredError);
    const [sr] = await sql()<{ status: string }[]>`select status from public.shuttle_requests where fulfillment_id = ${f.id}`;
    expect(sr.status).toBe("quoted");
    expect(await sql()`select id from public.integration_events where entity_id = ${f.id} and operation = 'request_ride'`).toHaveLength(0);
    expect(await jobsFor(`shuttle:${f.id}`)).toHaveLength(0);

    // confirmation requires the explicit checkbox and the exact quote shown
    const base = { tripId: trip.id, fulfillmentId: f.id, quotedPriceCents: view!.quotedPriceCents!, pickupAt: new Date(view!.pickupAt!).toISOString() };
    expect(await confirmShuttleQuote(user, { ...base, confirmPickup: false as unknown as true })).toMatchObject({ ok: false, code: "invalid" });
    expect(await confirmShuttleQuote(user, { ...base, confirmPickup: true, quotedPriceCents: 1 })).toMatchObject({ ok: false, code: "changed" });
    const other = await createCustomer("other");
    expect(await confirmShuttleQuote(other, { ...base, confirmPickup: true })).toMatchObject({ ok: false, code: "not_found" });

    expect(await confirmShuttleQuote(user, { ...base, confirmPickup: true })).toMatchObject({ ok: true });
    expect(await confirmShuttleQuote(user, { ...base, confirmPickup: true })).toMatchObject({ ok: true }); // idempotent
    expect(await jobsFor(`shuttle:${f.id}`)).toHaveLength(1);
    await runJobs(["shuttle.request_ride"], `shuttle:${f.id}`);
    const [ride] = await sql()<{ status: string; customerConfirmedAt: Date | null }[]>`
      select status, customer_confirmed_at from public.shuttle_requests where fulfillment_id = ${f.id}`;
    expect(ride.status).toBe("requested");
    expect(ride.customerConfirmedAt).not.toBeNull();
    const [final] = await fulfillmentsOf(bookingId);
    expect(final.status).toBe("confirmed");
    expect(String(final.details.rideRef)).toMatch(/^demo_ride_/);
  });

  it("an expired quote cannot be confirmed and must be re-quoted", async () => {
    const { bookingId, user, trip } = await confirmedBooking({ addonCodes: ["shuttle-trailhead"] });
    const [f] = await fulfillmentsOf(bookingId);
    await runFulfillment(f.id);
    await withSystem((tx) => tx`update public.shuttle_requests set quote_expires_at = now() - interval '1 minute' where fulfillment_id = ${f.id}`);
    const view = (await getShuttleForOwner(user, trip.id, f.id))!;
    expect(view.quoteExpired).toBe(true);
    const res = await confirmShuttleQuote(user, {
      tripId: trip.id,
      fulfillmentId: f.id,
      confirmPickup: true,
      quotedPriceCents: view.quotedPriceCents!,
      pickupAt: new Date(view.pickupAt!).toISOString(),
    });
    expect(res).toMatchObject({ ok: false, code: "expired" });
    expect(await requestNewShuttleQuote(user, trip.id, f.id, "pinecrest-park-ride")).toMatchObject({ ok: true });
    const fresh = (await getShuttleForOwner(user, trip.id, f.id))!;
    expect(fresh.quoteExpired).toBe(false);
    expect(fresh.pickupDescription).toBe("Pinecrest Park & Ride (demo)");
    expect(fresh.customerConfirmedAt).toBeNull();
  });
});
