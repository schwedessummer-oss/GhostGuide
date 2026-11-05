import { afterAll, describe, expect, it } from "vitest";
import { closeDb, sql } from "@/server/db";
import { staffCancelBooking, staffRefundBooking, staffRetryFulfillment, staffSetFulfillmentStatus } from "@/server/commerce/staff-actions";
import { getOwnedBooking, getReceipt, getTripBookingView, listTripBookingSummaries } from "@/server/commerce/queries";
import { getDemoCheckoutView } from "@/server/commerce/demo-checkout";
import { getShuttleForOwner } from "@/server/fulfillment/shuttle";
import { createCustomer, demoUser } from "../../helpers/db";
import { booking, fulfillmentsOf, jobsFor, payAndDeliver, pendingBooking, runJobs, tripStatus } from "./helpers";

afterAll(closeDb);

async function confirmed(opts: Parameters<typeof pendingBooking>[0] = {}) {
  const p = await pendingBooking(opts);
  const r = await payAndDeliver(p.sessionId);
  if (r.body.outcome !== "confirmed") throw new Error("not confirmed");
  return p;
}

const audits = (entityId: string, action: string) =>
  sql()<{ actorId: string; metadata: Record<string, unknown> }[]>`select actor_id, metadata from public.audit_logs where entity_id = ${entityId} and action = ${action}`;

describe("staff refunds", () => {
  it("requires bookings.refund, writes an audit log, and cannot exceed the paid amount", async () => {
    const { bookingId } = await confirmed();
    const total = (await booking(bookingId)).totalCents;
    const support = await demoUser("support");
    const hiker = await demoUser("hiker");
    const operator = await demoUser("operator");

    expect(await staffRefundBooking(support, bookingId, 100, "goodwill")).toMatchObject({ ok: false });
    expect(await staffRefundBooking(hiker, bookingId, 100, "goodwill")).toMatchObject({ ok: false });
    expect(await sql()`select id from public.refunds where booking_id = ${bookingId}`).toHaveLength(0);

    expect(await staffRefundBooking(operator, bookingId, total + 1, "too much")).toMatchObject({ ok: false });
    expect(await staffRefundBooking(operator, bookingId, 0, "zero")).toMatchObject({ ok: false });
    expect(await staffRefundBooking(operator, bookingId, 500, "x")).toMatchObject({ ok: false }); // reason too short

    expect(await staffRefundBooking(operator, bookingId, 500, "Trail was muddy — goodwill")).toMatchObject({ ok: true });
    const [log] = await audits(bookingId, "booking.staff_refund");
    expect(log.actorId).toBe(operator.id);
    expect(log.metadata).toMatchObject({ amountCents: 500 });

    // the pending 500 counts against the balance: total - 500 + 1 must fail
    expect(await staffRefundBooking(operator, bookingId, total - 500 + 1, "rest plus one")).toMatchObject({ ok: false });
    // concurrent attempts to refund the remainder: only one can win
    const results = await Promise.all([
      staffRefundBooking(operator, bookingId, total - 500, "remainder one"),
      staffRefundBooking(operator, bookingId, total - 500, "remainder two"),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const [{ sum }] = await sql()<{ sum: number }[]>`select coalesce(sum(amount_cents), 0)::int as sum from public.refunds where booking_id = ${bookingId}`;
    expect(sum).toBe(total);

    const refunds = await sql()<{ id: string }[]>`select id from public.refunds where booking_id = ${bookingId}`;
    for (const r of refunds) await runJobs(["refunds.process"], `refund:${r.id}`);
    expect((await booking(bookingId)).refundedCents).toBe(total);
    expect((await booking(bookingId)).status).toBe("confirmed"); // a goodwill refund does not cancel the hike
    expect(await staffRefundBooking(operator, bookingId, 1, "one more cent")).toMatchObject({ ok: false });
  });
});

describe("staff cancel and fulfillment actions", () => {
  it("cancels with a full refund, audits, and is idempotent", async () => {
    const { bookingId, trip } = await confirmed({ addonCodes: ["meal-pack"] });
    const support = await demoUser("support");
    expect(await staffCancelBooking(support, bookingId, "closure")).toMatchObject({ ok: false });
    const admin = await demoUser("admin");
    expect(await staffCancelBooking(admin, bookingId, "Trail closure (demo)")).toMatchObject({ ok: true });
    expect(await staffCancelBooking(admin, bookingId, "Trail closure (demo)")).toMatchObject({ ok: true, message: expect.stringMatching(/already/) });
    const b = await booking(bookingId);
    expect(b.status).toBe("refund_pending");
    expect(await tripStatus(trip.id)).toBe("cancelled");
    const refunds = await sql()<{ amountCents: number }[]>`select amount_cents from public.refunds where booking_id = ${bookingId}`;
    expect(refunds).toEqual([{ amountCents: b.totalCents }]);
    expect(await audits(bookingId, "booking.staff_cancelled")).toHaveLength(1);
    expect((await fulfillmentsOf(bookingId))[0].status).toBe("cancelled");
  });

  it("retries a needs_attention fulfillment and sets statuses with permission + audit", async () => {
    const { bookingId } = await confirmed({ addonCodes: ["meal-pack"], simulate: { "meal-pack": "reject" } });
    const [f] = await fulfillmentsOf(bookingId);
    await runJobs(["fulfillment.process"], `fulfill:${f.id}`);
    expect((await fulfillmentsOf(bookingId))[0].status).toBe("needs_attention");

    const support = await demoUser("support");
    const operator = await demoUser("operator");
    expect(await staffRetryFulfillment(support, f.id)).toMatchObject({ ok: false });
    expect(await staffRetryFulfillment(operator, f.id)).toMatchObject({ ok: true });
    expect(await staffRetryFulfillment(operator, f.id)).toMatchObject({ ok: true, message: expect.stringMatching(/Already queued/) });
    const [reset] = await fulfillmentsOf(bookingId);
    expect(reset).toMatchObject({ status: "pending", attempts: 0 });
    expect((await jobsFor(`fulfill:${f.id}:retry:`)).length).toBe(1);
    expect(await audits(f.id, "fulfillment.staff_retry")).toHaveLength(1);

    expect(await staffSetFulfillmentStatus(support, f.id, "confirmed", "called partner")).toMatchObject({ ok: false });
    expect(await staffSetFulfillmentStatus(operator, f.id, "confirmed", "Confirmed by phone with the kitchen")).toMatchObject({ ok: true });
    expect((await fulfillmentsOf(bookingId))[0].status).toBe("confirmed");
    // the queued automatic retry was superseded
    expect((await jobsFor(`fulfill:${f.id}:retry:`))[0].status).toBe("cancelled");
    expect(await audits(f.id, "fulfillment.staff_set_status")).toHaveLength(1);
    expect(await staffSetFulfillmentStatus(operator, f.id, "confirmed", "again")).toMatchObject({ ok: true, message: "Status unchanged." });
  });
});

describe("ownership", () => {
  it("another customer gets null (404) for someone else's booking, receipt, trip view, shuttle and checkout", async () => {
    const { bookingId, user, trip, sessionId } = await confirmed({ addonCodes: ["shuttle-trailhead"] });
    const [f] = await fulfillmentsOf(bookingId);
    const other = await createCustomer("eve");
    expect(await getOwnedBooking(user, bookingId)).not.toBeNull();
    expect((await getReceipt(user, bookingId))?.booking.receiptNumber).toMatch(/^GG-/);
    expect(await getOwnedBooking(other, bookingId)).toBeNull();
    expect(await getReceipt(other, bookingId)).toBeNull();
    expect(await getTripBookingView(other, trip.id)).toBeNull();
    expect(await getShuttleForOwner(other, trip.id, f.id)).toBeNull();
    expect(await getDemoCheckoutView(other, sessionId)).toBeNull();
    expect(await listTripBookingSummaries(other)).toEqual({});
    expect(await getOwnedBooking(other, "not-a-uuid")).toBeNull();
    // staff without a customer relationship use admin tools, not customer receipts
    const operator = await demoUser("operator");
    expect(await getReceipt(operator, bookingId)).toBeNull();
  });

  it("no receipt exists before payment", async () => {
    const { bookingId, user } = await pendingBooking();
    expect(await getOwnedBooking(user, bookingId)).not.toBeNull();
    expect(await getReceipt(user, bookingId)).toBeNull();
  });
});
