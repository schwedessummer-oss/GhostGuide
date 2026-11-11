import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeDb, sql, withSystem } from "@/server/db";
import { redeliverLastDemoEvent, simulateDemoPayment } from "@/server/commerce/demo-checkout";
import { listTripReminders } from "@/server/commerce/queries";
import { createCustomer } from "../../helpers/db";
import { booking, pendingBooking, savedTrip } from "./helpers";

afterAll(closeDb);
afterEach(() => vi.restoreAllMocks());

describe("simulated checkout delivery (SSRF hardening)", () => {
  it("settles and delivers in-process: no outbound request, whatever origin a caller passes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { user, bookingId, sessionId } = await pendingBooking();
    // A forged X-Forwarded-Proto/Host used to become this origin; extra arguments must have no effect.
    const simulate = simulateDemoPayment as unknown as (...args: unknown[]) => ReturnType<typeof simulateDemoPayment>;
    const res = await simulate(user, sessionId, "paid", "http://169.254.169.254:80/latest#");
    expect(res).toMatchObject({ ok: true, delivery: { status: 200, outcome: "confirmed", via: "in-process" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await booking(bookingId)).status).toBe("confirmed");

    const again = await redeliverLastDemoEvent(user, sessionId);
    expect(again).toMatchObject({ ok: true, delivery: { outcome: "duplicate", via: "in-process" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("only the session owner can settle or redeliver", async () => {
    const { sessionId } = await pendingBooking();
    const other = await createCustomer("demo-other");
    expect(await simulateDemoPayment(other, sessionId, "paid")).toMatchObject({ ok: false });
    expect(await redeliverLastDemoEvent(other, sessionId)).toMatchObject({ ok: false });
  });
});

describe("trip reminders", () => {
  it("lists the owner's in-app permit reminders for the trip only", async () => {
    const owner = await createCustomer("rem-owner");
    const other = await createCustomer("rem-other");
    const trip = await savedTrip(owner, { trail: "old-signal-summit" });
    const otherTrip = await savedTrip(owner, { trail: "whisper-falls" });
    await withSystem(async (tx) => {
      const rows = [
        { trip: trip.id, channel: "in_app", template: "permit_reminder", body: "Reminder: your hike requires a permit." },
        { trip: trip.id, channel: "email", template: "permit_reminder", body: "email copy" },
        { trip: trip.id, channel: "in_app", template: "checkin_reminder", body: "other template" },
        { trip: otherTrip.id, channel: "in_app", template: "permit_reminder", body: "other trip" },
      ];
      for (const r of rows) {
        await tx`
          insert into public.notifications (user_id, trip_id, channel, recipient_kind, recipient_masked, template, body, status, provider)
          values (${owner.id}, ${r.trip}, ${r.channel}, 'user', 'In-app (your account)', ${r.template}, ${r.body}, 'simulated', 'demo')`;
      }
    });
    const mine = await listTripReminders(owner, trip.id);
    expect(mine.map((r) => r.body)).toEqual(["Reminder: your hike requires a permit."]);
    expect(await listTripReminders(other, trip.id)).toEqual([]);
    expect(await listTripReminders(owner, "not-a-uuid")).toEqual([]);
    const all = await sql()`select id from public.notifications where trip_id = ${trip.id}`;
    expect(all).toHaveLength(3);
  });
});
