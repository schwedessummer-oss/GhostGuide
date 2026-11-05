import { afterAll, describe, expect, it } from "vitest";
import { closeDb, sql } from "@/server/db";
import { cancelTripByCustomer, getCancellationPreview } from "@/server/commerce/cancellation";
import { createCustomer } from "../../helpers/db";
import { booking, fulfillmentsOf, jobsFor, payAndDeliver, pendingBooking, runJobs, savedTrip, TZ, tripStatus } from "./helpers";
import { localDateInZone, localTimeInZone } from "@/lib/time";

afterAll(closeDb);

async function confirmed(opts: Parameters<typeof pendingBooking>[0]) {
  const p = await pendingBooking(opts);
  const r = await payAndDeliver(p.sessionId);
  if (r.body.outcome !== "confirmed") throw new Error("not confirmed");
  return p;
}

/** Planned date + start time (region-local) for a hike starting `hours` from now. */
function startIn(hours: number) {
  const at = new Date(Date.now() + hours * 3_600_000);
  return { plannedDate: localDateInZone(at, TZ), startTime: localTimeInZone(at, TZ) };
}

describe("customer cancellation", () => {
  it("full refund, cancels fulfillments + queued jobs + gear, cancels trip; repeat is a no-op", async () => {
    const { bookingId, user, trip } = await confirmed({ addonCodes: ["gear-poles-pack", "meal-pack", "shuttle-trailhead"], partySize: 2 });
    const fs = await fulfillmentsOf(bookingId);
    // run only the gear job so a reservation exists; meal + shuttle jobs stay queued
    const gear = fs.find((f) => f.providerKind === "gear_locker")!;
    await runJobs(["fulfillment.process"], `fulfill:${gear.id}`);
    const itemIds = (await sql()<{ gearItemId: string }[]>`select gear_item_id from public.gear_reservations where fulfillment_id = ${gear.id}`).map((r) => r.gearItemId);
    expect(itemIds).toHaveLength(4);

    const preview = await getCancellationPreview(user, trip.id);
    expect(preview).toMatchObject({ canCancel: true, refund: { tier: "full" } });
    const total = (await booking(bookingId)).totalCents;
    expect(preview?.refund?.refundCents).toBe(total);

    const res = await cancelTripByCustomer(user, trip.id);
    expect(res).toMatchObject({ ok: true, alreadyCancelled: false, refundCents: total, bookingStatus: "refund_pending" });
    expect(await tripStatus(trip.id)).toBe("cancelled");
    expect((await fulfillmentsOf(bookingId)).every((f) => f.status === "cancelled")).toBe(true);
    const reservations = await sql()<{ status: string }[]>`select status from public.gear_reservations where fulfillment_id = ${gear.id}`;
    expect(reservations.every((r) => r.status === "cancelled")).toBe(true);
    // released items are available again unless another day's reservation still holds them
    const items = await sql()<{ status: string; otherActive: boolean }[]>`
      select gi.status, exists (select 1 from public.gear_reservations gr where gr.gear_item_id = gi.id and gr.status in ('reserved', 'picked_up')) as other_active
      from public.gear_items gi where gi.id = any(${itemIds}::uuid[])`;
    expect(items.every((i) => i.status === "available" || (i.status === "reserved" && i.otherActive))).toBe(true);
    for (const f of fs.filter((x) => x.id !== gear.id)) {
      const [job] = await jobsFor(`fulfill:${f.id}`);
      expect(job.status).toBe("cancelled");
    }
    const [refund] = await sql()<{ id: string; amountCents: number; status: string }[]>`select id, amount_cents, status from public.refunds where booking_id = ${bookingId}`;
    expect(refund).toMatchObject({ amountCents: total, status: "requested" });

    // repeat cancel: no-op, no second refund
    expect(await cancelTripByCustomer(user, trip.id)).toMatchObject({ ok: true, alreadyCancelled: true, refundCents: 0 });
    expect(await sql()`select id from public.refunds where booking_id = ${bookingId}`).toHaveLength(1);

    // the refund job settles the booking; re-running it never refunds twice
    await runJobs(["refunds.process"], `refund:${refund.id}`);
    const b = await booking(bookingId);
    expect(b).toMatchObject({ status: "refunded", refundedCents: total });
    const [pay] = await sql()<{ status: string }[]>`select status from public.payments where booking_id = ${bookingId}`;
    expect(pay.status).toBe("refunded");
    await sql()`update public.jobs set status = 'queued', run_at = now() where dedup_key = ${`refund:${refund.id}`}`;
    await runJobs(["refunds.process"], `refund:${refund.id}`);
    expect((await booking(bookingId)).refundedCents).toBe(total);
  });

  it("partial refund inside the partial window ends as cancelled (partially refunded)", async () => {
    const { bookingId, user, trip } = await confirmed({ ...startIn(24) });
    const total = (await booking(bookingId)).totalCents;
    const res = await cancelTripByCustomer(user, trip.id);
    expect(res).toMatchObject({ ok: true, refundCents: Math.floor(total / 2) });
    const [refund] = await sql()<{ id: string }[]>`select id from public.refunds where booking_id = ${bookingId}`;
    await runJobs(["refunds.process"], `refund:${refund.id}`);
    expect(await booking(bookingId)).toMatchObject({ status: "cancelled", refundedCents: Math.floor(total / 2) });
    const [pay] = await sql()<{ status: string }[]>`select status from public.payments where booking_id = ${bookingId}`;
    expect(pay.status).toBe("partially_refunded");
  });

  it("no refund inside the final window", async () => {
    const { bookingId, user, trip } = await confirmed({ ...startIn(3) });
    const res = await cancelTripByCustomer(user, trip.id);
    expect(res).toMatchObject({ ok: true, refundCents: 0, bookingStatus: "cancelled" });
    expect(await sql()`select id from public.refunds where booking_id = ${bookingId}`).toHaveLength(0);
    expect((await booking(bookingId)).status).toBe("cancelled");
  });

  it("cancels a saved trip without a booking, but not a pending checkout", async () => {
    const user = await createCustomer("saver");
    const trip = await savedTrip(user);
    expect(await cancelTripByCustomer(user, trip.id)).toMatchObject({ ok: true, refundCents: 0, bookingStatus: null });
    expect(await tripStatus(trip.id)).toBe("cancelled");

    const pending = await pendingBooking();
    expect(await cancelTripByCustomer(pending.user, pending.trip.id)).toMatchObject({ ok: false, code: "not_allowed" });
    expect((await getCancellationPreview(pending.user, pending.trip.id))?.canCancel).toBe(false);
  });

  it("another customer cannot see or cancel the trip", async () => {
    const { user, trip, bookingId } = await confirmed({});
    const other = await createCustomer("mallory");
    expect(await getCancellationPreview(other, trip.id)).toBeNull();
    expect(await cancelTripByCustomer(other, trip.id)).toMatchObject({ ok: false, code: "not_found" });
    expect((await booking(bookingId)).status).toBe("confirmed");
    void user;
  });
});
