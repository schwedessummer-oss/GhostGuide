import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { closeDb, sql, withSystem } from "@/server/db";
import { createCheckout, getGearKitsAvailable, loadOfferedAddons, releasePendingCheckout, validateHikeDate } from "@/server/commerce/checkout";
import { getDayAvailability } from "@/server/commerce/inventory";
import { getClosuresOnDay } from "@/server/commerce/trip-plan";
import { zonedTimeToUtc } from "@/lib/time";
import { quotePrice } from "@/domain/pricing";
import { createCustomer } from "../../helpers/db";
import { booking, checkoutFor, freshDate, regionDate, savedTrip, setCapacity, settle } from "./helpers";

afterAll(closeDb);

describe("checkout creation", () => {
  it("is idempotent: the same key returns the same booking and session", async () => {
    const user = await createCustomer("idem");
    const trip = await savedTrip(user);
    const key = randomUUID();
    const input = { tripId: trip.id, hikeDate: trip.plannedDate, partySize: 2, addonCodes: ["meal-pack"], idempotencyKey: key };
    const a = await createCheckout(user, input);
    const b = await createCheckout(user, input);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.bookingId).toBe(a.bookingId);
    expect(b.url).toBe(a.url);
    expect(b.resumed).toBe(true);
    expect(a.url).toMatch(/^\/checkout\/demo\/demo_cs_/);
    const rows = await sql()`select id from public.bookings where trip_id = ${trip.id}`;
    expect(rows).toHaveLength(1);
    const sessions = await sql()`select id from public.demo_checkout_sessions where booking_id = ${a.bookingId}`;
    expect(sessions).toHaveLength(1);
    // concurrent double-submit of the same form also yields one booking
    const user2 = await createCustomer("idem2");
    const trip2 = await savedTrip(user2);
    const key2 = randomUUID();
    const input2 = { tripId: trip2.id, hikeDate: trip2.plannedDate, partySize: 1, addonCodes: [], idempotencyKey: key2 };
    const results = await Promise.all([createCheckout(user2, input2), createCheckout(user2, input2), createCheckout(user2, input2)]);
    const ids = new Set(results.map((r) => (r.ok ? r.bookingId : r.error)));
    expect(ids.size).toBe(1);
    expect(await sql()`select id from public.bookings where trip_id = ${trip2.id}`).toHaveLength(1);
  });

  it("computes the price server-side from catalog, rules and add-ons", async () => {
    const user = await createCustomer("price");
    const trip = await savedTrip(user, { trail: "hollow-pine-ridge", partySize: 4 });
    const r = await checkoutFor(user, trip, { partySize: 4, addonCodes: ["gear-poles-pack", "shuttle-trailhead"], shuttlePickup: "visitor-center" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [b] = await sql()<{ totalCents: number; subtotalCents: number; addonsCents: number; priceBreakdown: { lines: unknown[]; trailName: string } }[]>`
      select total_cents, subtotal_cents, addons_cents, price_breakdown from public.bookings where id = ${r.bookingId}`;
    const [trail] = await sql()<{ basePriceCents: number; regionId: string; id: string }[]>`select id, base_price_cents, region_id from public.trails where slug = 'hollow-pine-ridge'`;
    const rules = await sql()`select id, name, kind, value, params, region_id, trail_id, active, priority, null as effective_from, null as effective_to from public.pricing_rules`;
    const expected = quotePrice({
      basePriceCents: trail.basePriceCents,
      partySize: 4,
      hikeDate: trip.plannedDate,
      occupancy: 0,
      regionId: trail.regionId,
      trailId: trail.id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rules: rules as any,
      addons: [
        { code: "gear-poles-pack", name: "Trailhead gear locker kit", priceCents: 1200, pricingUnit: "per_person" },
        { code: "shuttle-trailhead", name: "Trailhead shuttle", priceCents: 3500, pricingUnit: "per_booking" },
      ],
      currency: "usd",
    });
    expect(b.totalCents).toBe(expected.totalCents);
    expect(b.addonsCents).toBe(1200 * 4 + 3500);
    expect(b.priceBreakdown.trailName).toBe("Hollow Pine Ridge");
    const addons = await sql()<{ quantity: number; details: Record<string, string> }[]>`
      select ba.quantity, ba.details from public.booking_addons ba join public.addons a on a.id = ba.addon_id
      where ba.booking_id = ${r.bookingId} order by a.code`;
    expect(addons.map((a) => a.quantity)).toEqual([4, 1]);
    expect(addons[1].details.shuttlePickup).toBe("visitor-center");
  });

  it("rejects other customers' trips, booked trips, past dates and unknown add-ons", async () => {
    const owner = await createCustomer("owner");
    const intruder = await createCustomer("intruder");
    const trip = await savedTrip(owner);
    const r1 = await checkoutFor(intruder, trip);
    expect(r1).toMatchObject({ ok: false, code: "not_found" });
    const r2 = await checkoutFor(owner, { ...trip, plannedDate: regionDate(-2) });
    expect(r2).toMatchObject({ ok: false, code: "invalid" });
    const r3 = await checkoutFor(owner, trip, { addonCodes: ["no-such-addon"] });
    expect(r3).toMatchObject({ ok: false, code: "invalid" });
    const r4 = await checkoutFor(owner, trip, { partySize: 13 });
    expect(r4).toMatchObject({ ok: false, code: "invalid" });
    await withSystem((tx) => tx`update public.trips set status = 'booked' where id = ${trip.id}`);
    const r5 = await checkoutFor(owner, trip);
    expect(r5).toMatchObject({ ok: false, code: "already_booked" });
  });

  it("respects the checkout_enabled flag and add-on flags", async () => {
    const user = await createCustomer("flags");
    const trip = await savedTrip(user);
    await withSystem((tx) => tx`update public.feature_flags set enabled = false where key = 'addon_meal_pack'`);
    try {
      expect(await checkoutFor(user, trip, { addonCodes: ["meal-pack"] })).toMatchObject({ ok: false, code: "invalid" });
    } finally {
      await withSystem((tx) => tx`update public.feature_flags set enabled = true where key = 'addon_meal_pack'`);
    }
    await withSystem((tx) => tx`update public.feature_flags set enabled = false where key = 'checkout_enabled'`);
    try {
      expect(await checkoutFor(user, trip)).toMatchObject({ ok: false, code: "disabled" });
    } finally {
      await withSystem((tx) => tx`update public.feature_flags set enabled = true where key = 'checkout_enabled'`);
    }
  });

  it("refuses closed trails", async () => {
    const user = await createCustomer("closed");
    const trip = await savedTrip(user, { trail: "whisper-falls" });
    const [c] = await withSystem(
      (tx) => tx<{ id: string }[]>`
        insert into public.trail_closures (trail_id, severity, reason) values (${trip.trailId}, 'closed', 'test closure') returning id`,
    );
    try {
      expect(await checkoutFor(user, trip)).toMatchObject({ ok: false, code: "unavailable" });
    } finally {
      await withSystem((tx) => tx`delete from public.trail_closures where id = ${c.id}`);
    }
  });
});

describe("capacity", () => {
  it("prevents overbooking and blocked days", async () => {
    const day = await freshDate();
    const a = await createCustomer("capA");
    const b = await createCustomer("capB");
    const tripA = await savedTrip(a, { plannedDate: day });
    const tripB = await savedTrip(b, { plannedDate: day });
    await setCapacity(tripA.trailId, day, 3);
    expect((await checkoutFor(a, tripA, { partySize: 2 })).ok).toBe(true);
    const rb = await checkoutFor(b, tripB, { partySize: 2 });
    expect(rb).toMatchObject({ ok: false, code: "sold_out" });
    if (!rb.ok) expect(rb.error).toMatch(/Only 1 spot left/);
    expect((await checkoutFor(b, tripB, { partySize: 1 })).ok).toBe(true);

    const day2 = await freshDate();
    const c = await createCustomer("capC");
    const tripC = await savedTrip(c, { plannedDate: day2 });
    await setCapacity(tripC.trailId, day2, 10, true);
    expect(await checkoutFor(c, tripC)).toMatchObject({ ok: false, code: "sold_out" });
  });

  it("lets exactly one of two concurrent checkouts take the last spots", async () => {
    const day = await freshDate();
    const users = await Promise.all([createCustomer("race1"), createCustomer("race2"), createCustomer("race3")]);
    const trips = await Promise.all(users.map((u) => savedTrip(u, { plannedDate: day })));
    await setCapacity(trips[0].trailId, day, 2);
    const results = await Promise.all(users.map((u, i) => checkoutFor(u, trips[i], { partySize: 2 })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "sold_out")).toHaveLength(2);
    const [{ held }] = await sql()<{ held: number }[]>`
      select coalesce(sum(party_size), 0)::int as held from public.bookings
      where trail_id = ${trips[0].trailId} and hike_date = ${day}::date and status = 'pending_payment'`;
    expect(held).toBe(2);
  });

  it("enforces add-on daily capacity", async () => {
    const day = await freshDate();
    // the satellite rental add-on has daily_capacity 3 (per booking)
    const results = [];
    for (let i = 0; i < 4; i++) {
      const u = await createCustomer(`sat${i}`);
      const t = await savedTrip(u, { plannedDate: day, trail: "miners-meadow-loop" });
      results.push(await checkoutFor(u, t, { partySize: 1, addonCodes: ["sat-communicator"] }));
    }
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results[3]).toMatchObject({ ok: false, code: "sold_out" });
  });

  it("does not sell a gear kit when the locker lacks gear for the group", async () => {
    // demo locker: 8 trekking poles, 6 daypacks (1 in maintenance) → at most 5 kits per day
    const user = await createCustomer("gear");
    const trip = await savedTrip(user, { trail: "miners-meadow-loop", partySize: 6 });
    const r = await checkoutFor(user, trip, { partySize: 6, addonCodes: ["gear-poles-pack"] });
    expect(r).toMatchObject({ ok: false, code: "sold_out" });
    if (!r.ok) expect(r.error).toMatch(/Not enough locker gear/);
    expect((await checkoutFor(user, trip, { partySize: 5, addonCodes: ["gear-poles-pack"] })).ok).toBe(true);
  });

  it("allows only one live booking per trip; a second key resumes the pending checkout", async () => {
    const user = await createCustomer("onelive");
    const trip = await savedTrip(user);
    const first = await checkoutFor(user, trip);
    const second = await checkoutFor(user, trip);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.bookingId).toBe(first.bookingId);
      expect(second.resumed).toBe(true);
    }
    const b = await booking(first.ok ? first.bookingId : "");
    expect(b.status).toBe("pending_payment");
  });
});

describe("checkout date rules", () => {
  it("rejects impossible calendar dates without touching the database", async () => {
    const user = await createCustomer("baddate");
    const trip = await savedTrip(user);
    for (const hikeDate of ["2026-13-45", "2026-12-32", "2027-02-30"]) {
      const r = await checkoutFor(user, trip, { hikeDate });
      expect(r, hikeDate).toMatchObject({ ok: false, code: "invalid", error: "Choose a valid date." });
      expect(validateHikeDate(hikeDate, "09:00", "America/Los_Angeles"), hikeDate).toBe("Choose a valid date.");
    }
    expect(await sql()`select id from public.bookings where trip_id = ${trip.id}`).toHaveLength(0);
  });

  it("refuses a day with a SCHEDULED full closure (region-local day), allows the next day, and only warns for partial closures", async () => {
    const day = await freshDate();
    const user = await createCustomer("sched");
    const trip = await savedTrip(user, { trail: "whisper-falls", plannedDate: day });
    const tz = "America/Los_Angeles";
    const next = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const [c] = await withSystem(
      (tx) => tx<{ id: string }[]>`
        insert into public.trail_closures (trail_id, severity, reason, starts_at, ends_at)
        values (${trip.trailId}, 'closed', 'Bridge repair (test)', ${zonedTimeToUtc(day, "00:00", tz)}::timestamptz, ${zonedTimeToUtc(next, "00:00", tz)}::timestamptz)
        returning id`,
    );
    try {
      const r = await checkoutFor(user, trip);
      expect(r).toMatchObject({ ok: false, code: "unavailable" });
      if (!r.ok) expect(r.error).toBe("The trail is closed on that date: Bridge repair (test). Please choose another date.");
      expect((await getClosuresOnDay(trip.trailId, day, tz)).closed?.reason).toBe("Bridge repair (test)");
      expect((await getClosuresOnDay(trip.trailId, next, tz)).closed).toBeNull();
      expect(await sql()`select id from public.bookings where trip_id = ${trip.id}`).toHaveLength(0);
      // The day after the closure ends can be booked.
      expect((await checkoutFor(user, trip, { hikeDate: next })).ok).toBe(true);
    } finally {
      await withSystem((tx) => tx`delete from public.trail_closures where id = ${c.id}`);
    }

    const day2 = await freshDate();
    const u2 = await createCustomer("partial");
    const t2 = await savedTrip(u2, { trail: "whisper-falls", plannedDate: day2 });
    const [p] = await withSystem(
      (tx) => tx<{ id: string }[]>`
        insert into public.trail_closures (trail_id, severity, reason, starts_at, ends_at)
        values (${t2.trailId}, 'partial', 'Upper viewpoint closed (test)', ${zonedTimeToUtc(day2, "06:00", tz)}::timestamptz, ${zonedTimeToUtc(day2, "18:00", tz)}::timestamptz)
        returning id`,
    );
    try {
      expect((await getClosuresOnDay(t2.trailId, day2, tz)).notices.map((n) => n.reason)).toEqual(["Upper viewpoint closed (test)"]);
      expect((await checkoutFor(u2, t2)).ok).toBe(true);
    } finally {
      await withSystem((tx) => tx`delete from public.trail_closures where id = ${p.id}`);
    }
  });

  it("does not let a closure that ends before the hike block it", async () => {
    const user = await createCustomer("ended");
    const trip = await savedTrip(user, { trail: "whisper-falls" });
    const [c] = await withSystem(
      (tx) => tx<{ id: string }[]>`
        insert into public.trail_closures (trail_id, severity, reason, starts_at, ends_at)
        values (${trip.trailId}, 'closed', 'Short storm closure (test)', now() - interval '1 hour', now() + interval '1 day')
        returning id`,
    );
    try {
      expect((await checkoutFor(user, trip)).ok).toBe(true);
    } finally {
      await withSystem((tx) => tx`delete from public.trail_closures where id = ${c.id}`);
    }
  });
});

describe("checkout in progress", () => {
  it("does not silently resume a held checkout for different details; releasing frees the spots and is idempotent", async () => {
    const day = await freshDate();
    const user = await createCustomer("release");
    const trip = await savedTrip(user, { plannedDate: day });
    const first = await checkoutFor(user, trip, { partySize: 2, addonCodes: ["meal-pack"] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const held = await booking(first.bookingId);

    // Back button + different group: refused with an explanation, not sent to pay the old booking.
    const changed = await checkoutFor(user, trip, { partySize: 5, addonCodes: ["meal-pack"] });
    expect(changed).toMatchObject({ ok: false, code: "in_progress" });
    if (!changed.ok) expect(changed.error).toMatch(/already in progress for .* · 2 hikers/);
    // Different add-ons are a different selection too; identical details still resume.
    expect(await checkoutFor(user, trip, { partySize: 2, addonCodes: [] })).toMatchObject({ ok: false, code: "in_progress" });
    expect(await checkoutFor(user, trip, { partySize: 2, addonCodes: ["meal-pack"] })).toMatchObject({ ok: true, bookingId: first.bookingId, resumed: true });

    // Another customer cannot release it.
    const intruder = await createCustomer("rel-intruder");
    expect(await releasePendingCheckout(intruder, trip.id, first.bookingId)).toMatchObject({ ok: false, code: "not_found" });

    const released = await releasePendingCheckout(user, trip.id, first.bookingId);
    expect(released).toMatchObject({ ok: true, outcome: "released", held: { hikeDate: day, partySize: 2, addonCodes: ["meal-pack"] } });
    expect((await booking(first.bookingId)).status).toBe("expired");
    const [session] = await sql()<{ status: string }[]>`select status from public.demo_checkout_sessions where id = ${held.checkoutSessionId}`;
    expect(session.status).toBe("expired"); // can no longer be paid
    expect((await getDayAvailability(trip.trailId, day)).used).toBe(0);
    expect(await releasePendingCheckout(user, trip.id, first.bookingId)).toMatchObject({ ok: true, outcome: "already_released" });

    // Now the new details can be booked.
    const second = await checkoutFor(user, trip, { partySize: 5 });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.bookingId).not.toBe(first.bookingId);
  });

  it("confirms instead of releasing when the session was already paid", async () => {
    const user = await createCustomer("rel-paid");
    const trip = await savedTrip(user);
    const r = await checkoutFor(user, trip);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await settle((await booking(r.bookingId)).checkoutSessionId!, "paid"); // paid, webhook not delivered yet
    expect(await releasePendingCheckout(user, trip.id, r.bookingId)).toMatchObject({ ok: true, outcome: "paid", bookingId: r.bookingId });
    expect((await booking(r.bookingId)).status).toBe("confirmed");
  });
});

describe("add-on availability shown before submitting", () => {
  it("reports locker kits available for the date (partner stock, not only the add-on's daily limit)", async () => {
    const day = await freshDate();
    const trail = await sql()<{ regionId: string }[]>`select region_id from public.trails where slug = 'miners-meadow-loop'`;
    const offered = await loadOfferedAddons(trail[0].regionId);
    const kits = await getGearKitsAvailable(offered, trail[0].regionId, day);
    const gear = offered.find((a) => a.code === "gear-poles-pack")!;
    // demo locker: 8 poles, 5 usable daypacks → 5 kits, although the add-on's daily limit is 10
    expect(gear.dailyCapacity).toBe(10);
    expect(kits[gear.id]).toBe(5);
    expect(Object.keys(kits)).toEqual([gear.id]);
  });
});
