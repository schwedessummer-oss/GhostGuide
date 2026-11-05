import { afterAll, describe, expect, it } from "vitest";
import { closeDb, sql, withSystem } from "@/server/db";
import { DEMO_SIGNATURE_HEADER, signDemoWebhook } from "@/integrations/payments/demo-signature";
import { expireStaleHolds, reconcilePendingPayments } from "@/server/commerce/reconcile";
import { isReceiptNumber } from "@/domain/booking";
import { POST as demoWebhookRoute } from "@/app/api/webhooks/demo-payments/route";
import { createCustomer } from "../../helpers/db";
import { booking, checkoutFor, deliver, freshDate, jobsFor, payAndDeliver, pendingBooking, savedTrip, setCapacity, settle, tripStatus } from "./helpers";

afterAll(closeDb);

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";

async function counts(bookingId: string) {
  const [c] = await sql()<{ payments: number; confirmations: number; fulfillments: number; jobs: number }[]>`
    select
      (select count(*)::int from public.payments where booking_id = ${bookingId}) as payments,
      (select count(*)::int from public.audit_logs where entity_id = ${bookingId} and action = 'booking.confirmed') as confirmations,
      (select count(*)::int from public.fulfillments where booking_id = ${bookingId}) as fulfillments,
      (select count(*)::int from public.jobs j join public.fulfillments f on j.dedup_key = 'fulfill:' || f.id
        where f.booking_id = ${bookingId} and j.kind = 'fulfillment.process') as jobs`;
  return c;
}

describe("payment webhooks", () => {
  it("confirms a booking only via a signed webhook", async () => {
    const { bookingId, sessionId, trip } = await pendingBooking({ addonCodes: ["gear-poles-pack", "meal-pack"] });
    expect((await booking(bookingId)).status).toBe("pending_payment");
    const res = await payAndDeliver(sessionId);
    expect(res).toMatchObject({ status: 200, body: { outcome: "confirmed" } });
    const b = await booking(bookingId);
    expect(b.status).toBe("confirmed");
    expect(isReceiptNumber(b.receiptNumber!)).toBe(true);
    expect(b.paidAt).not.toBeNull();
    expect(await tripStatus(trip.id)).toBe("booked");
    expect(await counts(bookingId)).toEqual({ payments: 1, confirmations: 1, fulfillments: 2, jobs: 2 });
    // stored webhook payload is reduced to non-PII fields
    const [we] = await sql()<{ payload: Record<string, unknown>; status: string }[]>`
      select payload, status from public.webhook_events where provider = 'demo' and payload ->> 'bookingId' = ${bookingId}`;
    expect(we.status).toBe("processed");
    expect(Object.keys(we.payload).sort()).toEqual(
      ["amountRefunded", "amountTotal", "bookingId", "currency", "occurredAt", "paymentIntentId", "paymentStatus", "rawType", "sessionId"].sort(),
    );
  });

  it("treats sequential duplicate deliveries as no-ops", async () => {
    const { bookingId, sessionId } = await pendingBooking({ addonCodes: ["meal-pack"] });
    const body = await settle(sessionId);
    const first = await deliver(body);
    const second = await deliver(body);
    const third = await deliver(body);
    expect(first.body.outcome).toBe("confirmed");
    expect(second).toMatchObject({ status: 200, body: { outcome: "duplicate" } });
    expect(third.body.outcome).toBe("duplicate");
    expect(await counts(bookingId)).toEqual({ payments: 1, confirmations: 1, fulfillments: 1, jobs: 1 });
  });

  it("handles concurrent duplicate deliveries exactly once", async () => {
    const { bookingId, sessionId } = await pendingBooking({ addonCodes: ["meal-pack", "gear-poles-pack"] });
    const body = await settle(sessionId);
    const results = await Promise.all(Array.from({ length: 6 }, () => deliver(body)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.outcome === "confirmed")).toHaveLength(1);
    expect(results.filter((r) => r.body.outcome === "duplicate")).toHaveLength(5);
    expect(await counts(bookingId)).toEqual({ payments: 1, confirmations: 1, fulfillments: 2, jobs: 2 });
  });

  it("rejects bad, tampered and stale signatures through the route handler", async () => {
    const { bookingId, sessionId } = await pendingBooking();
    const body = await settle(sessionId);
    const post = (b: string, header: string | null) =>
      demoWebhookRoute(new Request("http://localhost/api/webhooks/demo-payments", { method: "POST", body: b, headers: header ? { [DEMO_SIGNATURE_HEADER]: header } : {} }));
    expect((await post(body, null)).status).toBe(400);
    expect((await post(body.replace(/"amount_total":\d+/, '"amount_total":1'), signDemoWebhook(SECRET, body))).status).toBe(400);
    expect((await post(body, signDemoWebhook("wrong-secret-0123456789abcdef0123456789", body))).status).toBe(400);
    expect((await post(body, signDemoWebhook(SECRET, body, Math.floor(Date.now() / 1000) - 3600))).status).toBe(400);
    expect((await booking(bookingId)).status).toBe("pending_payment");
    const ok = await post(body, signDemoWebhook(SECRET, body));
    expect(ok.status).toBe(200);
    expect((await booking(bookingId)).status).toBe("confirmed");
  });

  it("flags an amount mismatch for attention and refunds automatically", async () => {
    const { bookingId, sessionId, user } = await pendingBooking();
    const total = (await booking(bookingId)).totalCents;
    const res = await deliver(await settle(sessionId, "paid", total - 100));
    expect(res.body.outcome).toBe("needs_attention");
    expect((await booking(bookingId)).status).toBe("needs_attention");
    const refunds = await sql()<{ id: string; amountCents: number; status: string }[]>`select id, amount_cents, status from public.refunds where booking_id = ${bookingId}`;
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amountCents).toBe(total - 100);
    expect(await jobsFor(`refund:${refunds[0].id}`)).toHaveLength(1);
    const tickets = await sql()`select id from public.support_tickets where booking_id = ${bookingId} and priority = 'high'`;
    expect(tickets).toHaveLength(1);
    expect(await sql()`select id from public.fulfillments where booking_id = ${bookingId}`).toHaveLength(0);
    void user;
  });

  it("late payment after the hold expired with capacity gone → needs_attention + refund job", async () => {
    const day = await freshDate();
    const a = await createCustomer("lateA");
    const b = await createCustomer("lateB");
    const tripA = await savedTrip(a, { plannedDate: day });
    const tripB = await savedTrip(b, { plannedDate: day });
    await setCapacity(tripA.trailId, day, 2);
    const ra = await checkoutFor(a, tripA, { partySize: 2 });
    if (!ra.ok) throw new Error(ra.error);
    // A's hold lapses; B takes the spots and pays
    await withSystem((tx) => tx`update public.bookings set hold_expires_at = now() - interval '1 minute' where id = ${ra.bookingId}`);
    const rb = await checkoutFor(b, tripB, { partySize: 2 });
    if (!rb.ok) throw new Error(rb.error);
    await payAndDeliver((await booking(rb.bookingId)).checkoutSessionId!);
    expect((await booking(rb.bookingId)).status).toBe("confirmed");
    // A pays late
    const res = await payAndDeliver((await booking(ra.bookingId)).checkoutSessionId!);
    expect(res.body.outcome).toBe("needs_attention");
    expect((await booking(ra.bookingId)).status).toBe("needs_attention");
    const [refund] = await sql()<{ id: string; amountCents: number }[]>`select id, amount_cents from public.refunds where booking_id = ${ra.bookingId}`;
    expect(refund.amountCents).toBe((await booking(ra.bookingId)).totalCents);
    expect(await jobsFor(`refund:${refund.id}`)).toHaveLength(1);
    expect(await tripStatus(tripA.id)).toBe("saved");
  });

  it("late payment after the hold expired with capacity still available → confirmed", async () => {
    const { bookingId, sessionId } = await pendingBooking();
    await withSystem((tx) => tx`update public.bookings set hold_expires_at = now() - interval '1 minute' where id = ${bookingId}`);
    const res = await payAndDeliver(sessionId);
    expect(res.body.outcome).toBe("confirmed");
  });

  it("payment failure releases the hold so others can book", async () => {
    const day = await freshDate();
    const a = await createCustomer("failA");
    const b = await createCustomer("failB");
    const tripA = await savedTrip(a, { plannedDate: day });
    const tripB = await savedTrip(b, { plannedDate: day });
    await setCapacity(tripA.trailId, day, 2);
    const ra = await checkoutFor(a, tripA, { partySize: 2 });
    if (!ra.ok) throw new Error(ra.error);
    expect(await checkoutFor(b, tripB, { partySize: 2 })).toMatchObject({ ok: false, code: "sold_out" });
    const res = await deliver(await settle((await booking(ra.bookingId)).checkoutSessionId!, "declined"));
    expect(res.body.outcome).toBe("payment_failed");
    expect((await booking(ra.bookingId)).status).toBe("payment_failed");
    expect((await checkoutFor(b, tripB, { partySize: 2 })).ok).toBe(true);
    // the failed booking no longer blocks a fresh checkout for the same trip (another date)
    expect((await checkoutFor(a, { ...tripA, plannedDate: await freshDate() }, { partySize: 1 })).ok).toBe(true);
  });

  it("expires the booking when the session expires (customer cancelled)", async () => {
    const { bookingId, sessionId } = await pendingBooking();
    const res = await deliver(await settle(sessionId, "cancelled"));
    expect(res.body.outcome).toBe("expired");
    expect((await booking(bookingId)).status).toBe("expired");
  });
});

describe("reconciliation jobs", () => {
  it("confirms a paid booking whose webhook was missed, then ignores the late webhook", async () => {
    const { bookingId, sessionId } = await pendingBooking({ addonCodes: ["meal-pack"] });
    const body = await settle(sessionId); // paid at the provider, but the webhook is "lost"
    await withSystem((tx) => tx`update public.bookings set created_at = now() - interval '11 minutes' where id = ${bookingId}`);
    const r = await reconcilePendingPayments();
    expect(r.confirmed).toBeGreaterThanOrEqual(1);
    expect((await booking(bookingId)).status).toBe("confirmed");
    const events = await sql()`select id from public.integration_events where entity_id = ${bookingId} and operation = 'reconcile.get_session'`;
    expect(events.length).toBeGreaterThanOrEqual(1);
    const late = await deliver(body);
    expect(late.body.outcome).toBe("noop");
    expect(await counts(bookingId)).toEqual({ payments: 1, confirmations: 1, fulfillments: 1, jobs: 1 });
  });

  it("expire_holds expires unpaid holds but confirms holds that were paid", async () => {
    const unpaid = await pendingBooking();
    const paid = await pendingBooking();
    await settle(paid.sessionId); // paid, webhook missing
    await withSystem(
      (tx) => tx`update public.bookings set hold_expires_at = now() - interval '1 minute' where id = any(${[unpaid.bookingId, paid.bookingId]}::uuid[])`,
    );
    const totals = await expireStaleHolds();
    expect(totals.expired).toBeGreaterThanOrEqual(1);
    expect((await booking(unpaid.bookingId)).status).toBe("expired");
    expect((await booking(paid.bookingId)).status).toBe("confirmed");
    const [s] = await sql()<{ status: string }[]>`select status from public.demo_checkout_sessions where id = ${unpaid.sessionId}`;
    expect(s.status).toBe("expired"); // can no longer be paid
  });
});
