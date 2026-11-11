import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { closeDb, sql, withSystem } from "@/server/db";
import { getTripBundle } from "@/server/hike/bundle";
import { getHikeOverview, getPrepareView } from "@/server/hike/queries";
import { updatePermitStatus } from "@/server/hike/records";
import { startHike } from "@/server/hike/sessions";
import { syncHike } from "@/server/hike/sync";
import { deriveAccessCode, hashAccessCode } from "@/integrations/partners/gear-locker/access-code";
import { createCustomer, trailBySlug } from "../../helpers/db";
import { checkinRow, consentedContact, optIn } from "../safety/helpers";
import { confirmBooking, createTrip, iso, regionDate, syncInput } from "./helpers";

/**
 * Round-2 hike fixes, against the REAL check-in service (no mocks):
 * device extensions, clock-skew correction of starts, full-closure start
 * refusal, closures / booking logistics / stable audio keys in the bundle.
 * Closures created here are removed afterwards (other files share trails).
 */
const MARK = `hike-r2-test-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await sql()`delete from public.trail_closures where reason like ${`${MARK}%`}`;
  await closeDb();
});

async function addClosure(slug: string, severity: "closed" | "partial" | "advisory", startsInMs: number, endsInMs: number | null, label: string = severity) {
  const trail = await trailBySlug(slug);
  await sql()`
    insert into public.trail_closures (trail_id, severity, reason, starts_at, ends_at)
    values (${trail.id}, ${severity}, ${`${MARK} ${label}`}, ${new Date(Date.now() + startsInMs)}::timestamptz,
            ${endsInMs === null ? null : new Date(Date.now() + endsInMs)}::timestamptz)`;
}
const clearClosures = () => sql()`delete from public.trail_closures where reason like ${`${MARK}%`}`;

describe("'Extend my trip' recorded on the device reaches the check-in (contract A)", () => {
  it("applies the extension at the corrected time, idempotently, and reports it", async () => {
    const user = await createCustomer("r2-extend");
    const tripId = await createTrip(user, "booked");
    const contact = await consentedContact(user);
    const before = await optIn(user, tripId, contact, { minutesAhead: 60, graceMinutes: 30 });
    const started = await startHike(user, { tripId });
    if (!started.ok) throw new Error(started.error);
    const sessionId = started.value.session.id;

    const skew = 5 * 60_000; // the phone's clock is 5 min fast
    const target = Date.now() + 3 * 3600_000;
    // made just now (after opting in) on the fast phone
    const ev = { id: randomUUID(), kind: "checkin_extend" as const, occurredAt: iso(skew), payload: { newExpectedReturnAt: new Date(target + skew).toISOString() } };
    const r = await syncHike(user, syncInput(sessionId, { events: [ev], sentAt: iso(skew) }));
    if (!r.ok) throw new Error(r.error);
    expect(r.value.checkin).toEqual([{ eventId: ev.id, kind: "checkin_extend", applied: true }]);
    const after = await checkinRow(tripId);
    expect(Math.abs(after.expectedReturnAt.getTime() - target)).toBeLessThan(15_000);
    expect(after.version).toBeGreaterThan(before.version);
    const [event] = await sql()<{ actor: string; details: Record<string, unknown> }[]>`
      select actor, details from public.checkin_events where checkin_id = ${after.id} and details ->> 'clientEventId' = ${ev.id}`;
    expect(event).toMatchObject({ actor: "user", details: expect.objectContaining({ source: "device" }) });

    // a retried batch changes nothing
    const again = await syncHike(user, syncInput(sessionId, { events: [ev], sentAt: iso(skew) }));
    if (!again.ok) throw new Error(again.error);
    expect(again.value.checkin?.[0]).toMatchObject({ eventId: ev.id, applied: true });
    expect((await checkinRow(tripId)).version).toBe(after.version);
  });

  it("an 'I'm okay' from a phone whose clock is fast is not lost", async () => {
    const user = await createCustomer("r2-fast-ok");
    const tripId = await createTrip(user, "booked");
    await optIn(user, tripId, await consentedContact(user), { minutesAhead: 60 });
    const started = await startHike(user, { tripId });
    if (!started.ok) throw new Error(started.error);
    const tap = { id: randomUUID(), kind: "checkin_ok" as const, occurredAt: iso(8 * 60_000), payload: {} }; // 8 min "in the future"
    const r = await syncHike(user, syncInput(started.value.session.id, { events: [tap], sentAt: iso(8 * 60_000 + 1000) }));
    if (!r.ok) throw new Error(r.error);
    expect(r.value.acceptedEventIds).toEqual([tap.id]);
    const c = await checkinRow(tripId);
    expect(c.lastOkAt).not.toBeNull();
    expect(Math.abs(c.lastOkAt!.getTime() - Date.now())).toBeLessThan(15_000);
  });
});

describe("starting a hike", () => {
  it("is refused on a day with a FULL closure — even 'start anyway' in demo mode — but not for a partial closure", async () => {
    const user = await createCustomer("r2-closed");
    try {
      const tripId = await createTrip(user, "booked", "hollow-pine-ridge");
      await addClosure("hollow-pine-ridge", "partial", -3600_000, 3600_000);
      const partialOk = await startHike(user, { tripId: await createTrip(user, "booked", "hollow-pine-ridge") });
      expect(partialOk.ok, JSON.stringify(partialOk)).toBe(true);

      await addClosure("hollow-pine-ridge", "closed", -3600_000, 2 * 86_400_000, "rockfall");
      const r = await startHike(user, { tripId }, new Date(), { demoMode: true });
      expect(r).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/closed.*rockfall.*can't be started/i) });
      const anyway = await startHike(user, { tripId, demoStartAnyway: true }, new Date(), { demoMode: true });
      expect(anyway).toMatchObject({ ok: false, status: 409 });
      expect((await sql()`select status from public.trips where id = ${tripId}`)[0].status).toBe("booked");
      expect(await sql()`select 1 from public.hike_sessions where trip_id = ${tripId}`).toHaveLength(0);
    } finally {
      await clearClosures();
    }
  });

  it("corrects the device's start time by its clock skew", async () => {
    const user = await createCustomer("r2-start-skew");
    const tripId = await createTrip(user, "booked");
    const skew = 7 * 60_000;
    const r = await startHike(user, { tripId, startedAt: iso(-2 * 60_000 + skew), sentAt: iso(skew) });
    if (!r.ok) throw new Error(r.error);
    expect(Math.abs(Date.parse(r.value.session.startedAt) - (Date.now() - 2 * 60_000))).toBeLessThan(15_000);
  });
});

describe("offline bundle: closures, booking details, stable audio keys", () => {
  it("includes closures active now or scheduled for the booked date (not ended or later ones)", async () => {
    const user = await createCustomer("r2-bundle-closures");
    const tripId = await createTrip(user, "booked", "whisper-falls", 5);
    try {
      const day = 86_400_000;
      await addClosure("whisper-falls", "partial", -day, day, "active-now");
      await addClosure("whisper-falls", "closed", 4.5 * day, 6 * day, "on-booked-date");
      await addClosure("whisper-falls", "closed", -3 * day, -day, "ended");
      await addClosure("whisper-falls", "advisory", 9 * day, 10 * day, "after-the-hike");
      const r = await getTripBundle(user, tripId);
      if (!r.ok) throw new Error(r.error);
      const mine = r.value.trail.closures.filter((c) => c.reason.startsWith(MARK));
      expect(mine.map((c) => c.reason.replace(`${MARK} `, ""))).toEqual(["on-booked-date", "active-now"]); // full closures first
      expect(mine.every((c) => typeof c.startsAt === "string")).toBe(true);

      const view = await getPrepareView(user, tripId);
      expect(view?.bookedDate).toBe(await regionDate("whisper-falls", 5));
      expect(view?.closedOnBookedDate?.reason).toBe(`${MARK} on-booked-date`);
      expect(view?.closures.map((c) => c.reason)).toContain(`${MARK} active-now`);
    } finally {
      await clearClosures();
    }
  });

  it("carries booked add-on details (locker + owner's access code, shuttle pickup, meal pickup) and permit status", async () => {
    const owner = await createCustomer("r2-logistics");
    const slug = "echo-basin-traverse";
    const tripId = await createTrip(owner, "booked", slug, 3);
    await confirmBooking(owner, tripId, await regionDate(slug, 3));
    const [booking] = await sql()<{ id: string }[]>`select id from public.bookings where trip_id = ${tripId}`;
    const secret = process.env.AUTH_SECRET!;
    const reservationId = randomUUID();
    const code = deriveAccessCode(secret, reservationId);

    const fulfillment = async (addonCode: string, kind: string, details: Record<string, unknown>) =>
      withSystem(async (tx) => {
        const [ba] = await tx<{ id: string }[]>`
          insert into public.booking_addons (booking_id, addon_id, quantity, unit_price_cents, total_cents)
          select ${booking.id}, id, 1, 1000, 1000 from public.addons where code = ${addonCode} returning id`;
        const [f] = await tx<{ id: string }[]>`
          insert into public.fulfillments (booking_id, booking_addon_id, provider_kind, provider_key, status, details)
          values (${booking.id}, ${ba.id}, ${kind}, 'demo', 'confirmed', ${tx.json(details as never)}) returning id`;
        return f.id;
      });
    const lockerF = await fulfillment("gear-poles-pack", "gear_locker", {
      simulated: true,
      lockerName: "Test Locker",
      locationDescription: "Behind the visitor kiosk",
      items: ["Trekking poles"],
      primaryReservationId: reservationId,
      codeHint: code.slice(-2),
      codeExpiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });
    // a far-future, random day so the one-reservation-per-item-per-day index can't collide with other tests
    const reservedFor = `2031-0${1 + Math.floor(Math.random() * 9)}-1${Math.floor(Math.random() * 9)}`;
    await withSystem(
      (tx) => tx`
        insert into public.gear_reservations (id, fulfillment_id, gear_item_id, locker_id, reserved_for, access_code_hash, access_code_expires_at, status)
        select ${reservationId}, ${lockerF}, gi.id, gi.locker_id, ${reservedFor}::date, ${hashAccessCode(secret, reservationId, code)},
               now() + interval '5 days', 'reserved'
        from public.gear_items gi where gi.locker_id is not null order by random() limit 1`,
    );
    const shuttleF = await fulfillment("shuttle-trailhead", "shuttle", { simulated: true });
    await withSystem(
      (tx) => tx`
        insert into public.shuttle_requests (fulfillment_id, pickup_description, dropoff_description, pickup_at, status, customer_confirmed_at)
        values (${shuttleF}, 'Town square bus stop', 'Echo Basin trailhead', now() + interval '3 days', 'confirmed', now())`,
    );
    await fulfillment("meal-pack", "meal_pack", { simulated: true, pickup: "Collect on your hike date at Test Locker — behind the visitor kiosk." });
    const [req] = await sql()<{ id: string }[]>`
      select pr.id from public.permit_requirements pr join public.trails t on t.id = pr.trail_id where t.slug = ${slug} limit 1`;
    expect((await updatePermitStatus(owner, tripId, { permitRequirementId: req.id, status: "applied", confirmationRef: "APP-42" })).ok).toBe(true);

    const r = await getTripBundle(owner, tripId);
    if (!r.ok) throw new Error(r.error);
    const l = r.value.logistics!;
    expect(l.bookingStatus).toBe("confirmed");
    const locker = l.addons.find((a) => a.kind === "gear_locker")!;
    expect(locker.locker).toMatchObject({ name: "Test Locker", location: "Behind the visitor kiosk", items: ["Trekking poles"], accessCode: code, codeHint: null });
    expect(locker.simulated).toBe(true);
    const shuttle = l.addons.find((a) => a.kind === "shuttle")!;
    expect(shuttle.shuttle).toMatchObject({ pickup: "Town square bus stop", dropoff: "Echo Basin trailhead", confirmed: true });
    expect(shuttle.shuttle?.pickupAt).toEqual(expect.any(String));
    expect(l.addons.find((a) => a.kind === "meal_pack")?.meal?.pickup).toMatch(/Collect on your hike date/);
    expect(l.permits).toEqual([expect.objectContaining({ status: "applied", confirmationRef: "APP-42", officialUrl: expect.stringMatching(/^https?:\/\//) })]);

    // the prepare page shows the same details
    expect((await getPrepareView(owner, tripId))?.logistics.addons).toHaveLength(3);
    // nobody else gets them
    expect(await getTripBundle(await createCustomer("r2-logistics-other"), tripId)).toMatchObject({ ok: false, status: 404 });
  });

  it("stores narration audio under a stable key (narration id + version), whatever the signed URL", async () => {
    const owner = await createCustomer("r2-audio");
    const tripId = await createTrip(owner, "booked", "miners-meadow-loop");
    const trail = await trailBySlug("miners-meadow-loop");
    const [n] = await withSystem(
      (tx) => tx<{ id: string; version: number }[]>`
        insert into public.narrations (trail_id, title, transcript, audio_path, status, source_id, source_citation, approved_at)
        select ${trail.id}, 'Recorded story r2', 'Recorded transcript', 'narration/test/r2.mp3', 'approved', id, 'Demo', now()
        from public.sources limit 1
        returning id, version`,
    );
    const items = async () => {
      const r = await getTripBundle(owner, tripId);
      if (!r.ok) throw new Error(r.error);
      return r.value.manifest.items.find((i) => i.key === `audio:${n.id}`)!;
    };
    const a = await items();
    expect(a.url).toMatch(/^\/api\/media\/narration\/test\/r2\.mp3\?exp=/);
    expect(a.cacheAs).toBe(`/__gg/audio/${n.id}/v${n.version}`);
    expect((await items()).cacheAs).toBe(a.cacheAs);
  });

  it("the trip dashboard card knows the booked date", async () => {
    const owner = await createCustomer("r2-overview");
    const tripId = await createTrip(owner, "booked", "lantern-creek-loop", 60);
    const o = await getHikeOverview(owner, tripId);
    expect(o?.booked).toEqual({ bookedDate: await regionDate("lantern-creek-loop", 60), timezone: expect.any(String) });
  });
});

describe("starting a hike after a closure ended earlier the same day", () => {
  it("is allowed: an ended full closure no longer blocks the start", async () => {
    const user = await createCustomer("r2-ended");
    try {
      const tripId = await createTrip(user, "booked", "hollow-pine-ridge");
      // a full closure that started 3 h ago and ended 1 min ago
      await addClosure("hollow-pine-ridge", "closed", -3 * 3600_000, -60_000, "morning storm");
      const r = await startHike(user, { tripId });
      expect(r.ok, JSON.stringify(r)).toBe(true);
    } finally {
      await clearClosures();
    }
  });
});
