import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/server/checkins/service", () => ({
  onHikeStarted: vi.fn(async () => {}),
  onCheckinConfirmedFromDevice: vi.fn(async () => {}),
  onCheckinExtendedFromDevice: vi.fn(async () => ({ applied: true })),
  onTripFinished: vi.fn(async () => {}),
}));

import { closeDb, sql, withUser } from "@/server/db";
import { onCheckinConfirmedFromDevice, onCheckinExtendedFromDevice } from "@/server/checkins/service";
import { startHike } from "@/server/hike/sessions";
import { syncHike } from "@/server/hike/sync";
import { syncRequestSchema } from "@/server/hike/schemas";
import type { SessionUser } from "@/server/auth";
import { createCustomer } from "../../helpers/db";
import { createTrip, iso, point, syncInput } from "./helpers";

afterAll(closeDb);
beforeEach(() => vi.clearAllMocks());

async function startedSession(label: string): Promise<{ user: SessionUser; tripId: string; sessionId: string }> {
  const user = await createCustomer(label);
  const tripId = await createTrip(user, "booked");
  const r = await startHike(user, { tripId });
  if (!r.ok) throw new Error(`start failed: ${r.error}`);
  return { user, tripId, sessionId: r.value.session.id };
}

const count = async (table: "location_points" | "hike_events", sessionId: string) =>
  Number((await sql()`select count(*)::int as n from ${sql()("public." + table)} where hike_session_id = ${sessionId}`)[0].n);

const lastLocation = async (sessionId: string) =>
  (await sql()<{ lat: number; recordedAt: Date }[]>`select lat, recorded_at from public.hike_last_locations where hike_session_id = ${sessionId}`)[0];

describe("hike sync", () => {
  it("a duplicate (retried) batch is inserted once and fully acknowledged both times", async () => {
    const { user, sessionId } = await startedSession("dup");
    const batch = syncInput(sessionId, {
      points: [point(5), point(4), point(3)],
      events: [
        { id: randomUUID(), kind: "poi_triggered", occurredAt: iso(-4 * 60_000), payload: { poiId: randomUUID(), source: "gps" } },
        { id: randomUUID(), kind: "reminder", occurredAt: iso(-3 * 60_000), payload: { reminder: "hydration" } },
      ],
      progressM: 812.6,
    });
    const r1 = await syncHike(user, batch);
    const r2 = await syncHike(user, batch);
    for (const r of [r1, r2]) {
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.acceptedPointIds.sort()).toEqual(batch.points.map((p) => p.id).sort());
      expect(r.value.acceptedEventIds.sort()).toEqual(batch.events.map((e) => e.id).sort());
      expect(r.value.rejected).toEqual([]);
    }
    expect(await count("location_points", sessionId)).toBe(3);
    expect(await count("hike_events", sessionId)).toBe(2);
    const [s] = await sql()`select distance_completed_m, last_sync_at, last_location_at from public.hike_sessions where id = ${sessionId}`;
    expect(s.distanceCompletedM).toBe(813);
    expect(s.lastSyncAt).not.toBeNull();
    expect(new Date(s.lastLocationAt).toISOString()).toBe(batch.points[2].recordedAt);
  });

  it("a delayed / out-of-order batch never moves the last-known location backwards", async () => {
    const { user, sessionId } = await startedSession("ooo");
    const newer = syncInput(sessionId, { points: [point(2, 47.6), point(1, 47.61)] });
    const older = syncInput(sessionId, { points: [point(30, 47.4), point(20, 47.41)], progressM: 10 });
    expect((await syncHike(user, newer)).ok).toBe(true);
    const before = await lastLocation(sessionId);
    expect(before.lat).toBeCloseTo(47.61, 6);
    expect((await syncHike(user, older)).ok).toBe(true);
    const after = await lastLocation(sessionId);
    expect(after.lat).toBeCloseTo(47.61, 6);
    expect(after.recordedAt.toISOString()).toBe(before.recordedAt.toISOString());
    // the delayed points are still stored for the history
    expect(await count("location_points", sessionId)).toBe(4);
    const [s] = await sql()`select last_location_at, distance_completed_m from public.hike_sessions where id = ${sessionId}`;
    expect(new Date(s.lastLocationAt).toISOString()).toBe(newer.points[1].recordedAt);
    // a newer batch does move it forward
    await syncHike(user, syncInput(sessionId, { points: [point(0.5, 47.62)] }));
    expect((await lastLocation(sessionId)).lat).toBeCloseTo(47.62, 6);
  });

  it("without a send time: points and ordinary events > 2 min ahead are rejected, but 'I'm okay' is kept (clamped to now)", async () => {
    const { user, tripId, sessionId } = await startedSession("future");
    const ok1 = { ...point(0), recordedAt: iso(60_000) }; // +1 min clock skew is tolerated
    const bad = { ...point(0), recordedAt: iso(10 * 60_000) };
    const badReminder = { id: randomUUID(), kind: "reminder" as const, occurredAt: iso(30 * 60_000), payload: { reminder: "hydration" as const } };
    const tap = { id: randomUUID(), kind: "checkin_ok" as const, occurredAt: iso(30 * 60_000), payload: {} };
    const before = Date.now();
    const r = await syncHike(user, syncInput(sessionId, { points: [ok1, bad], events: [badReminder, tap] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.acceptedPointIds).toEqual([ok1.id]);
    expect(r.value.acceptedEventIds).toEqual([tap.id]);
    expect(r.value.rejected).toEqual(
      expect.arrayContaining([
        { id: bad.id, kind: "point", reason: "future_timestamp" },
        { id: badReminder.id, kind: "event", reason: "future_timestamp" },
      ]),
    );
    expect(r.value.rejected.some((x) => x.id === tap.id)).toBe(false);
    expect(await count("location_points", sessionId)).toBe(1);
    // the tap reached the check-in contract, stamped "now" (never in the future)
    const call = vi.mocked(onCheckinConfirmedFromDevice).mock.calls[0];
    expect(call.slice(1, 3)).toEqual([tripId, user.id]);
    expect((call[3] as Date).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((call[3] as Date).getTime()).toBeLessThanOrEqual(Date.now());
    const [stored] = await sql()<{ occurredAt: Date; payload: Record<string, unknown> }[]>`
      select occurred_at, payload from public.hike_events where hike_session_id = ${sessionId} and client_event_id = ${tap.id}`;
    expect(stored.payload.deviceOccurredAt).toBe(tap.occurredAt);
    expect(stored.occurredAt.getTime()).toBeLessThanOrEqual(Date.now());
    // and the future point did not become the last-known location
    expect((await lastLocation(sessionId)).recordedAt.toISOString()).toBe(ok1.recordedAt);
  });

  it("a phone clock 5 min fast: points and taps are accepted and stored at the corrected (real) time", async () => {
    const { user, tripId, sessionId } = await startedSession("skew");
    const skew = 5 * 60_000;
    const fast = (msFromNow: number) => iso(msFromNow + skew); // what the fast phone writes
    const points = [{ ...point(0), recordedAt: fast(-60_000) }, { ...point(0), recordedAt: fast(0) }];
    const tap = { id: randomUUID(), kind: "checkin_ok" as const, occurredAt: fast(-30_000), payload: {} };
    const r = await syncHike(user, syncInput(sessionId, { points, events: [tap], sentAt: fast(0) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rejected).toEqual([]);
    expect(r.value.acceptedPointIds.sort()).toEqual(points.map((p) => p.id).sort());
    expect(r.value.clockSkewMs).toBeGreaterThan(skew - 10_000);
    expect(r.value.clockSkewMs).toBeLessThanOrEqual(skew + 1_000);
    const rows = await sql()<{ recordedAt: Date }[]>`select recorded_at from public.location_points where hike_session_id = ${sessionId} order by recorded_at`;
    expect(Math.abs(rows[1].recordedAt.getTime() - Date.now())).toBeLessThan(15_000);
    expect(Math.abs((await lastLocation(sessionId)).recordedAt.getTime() - Date.now())).toBeLessThan(15_000);
    const call = vi.mocked(onCheckinConfirmedFromDevice).mock.calls[0];
    expect(call[1]).toBe(tripId);
    expect(Math.abs((call[3] as Date).getTime() - (Date.now() - 30_000))).toBeLessThan(15_000);
  });

  it("forwards 'Extend my trip' to the check-in contract in device order, with corrected times, and reports the outcome", async () => {
    const { user, tripId, sessionId } = await startedSession("extend");
    vi.mocked(onCheckinExtendedFromDevice).mockResolvedValueOnce({ applied: true }).mockResolvedValueOnce({ applied: false, reason: "stale" });
    const skew = -10 * 60_000; // phone 10 min slow
    const at = (msFromNow: number) => iso(msFromNow + skew);
    const later = { id: randomUUID(), kind: "checkin_extend" as const, occurredAt: at(-60_000), payload: { newExpectedReturnAt: at(2 * 3600_000) } };
    const earlier = { id: randomUUID(), kind: "checkin_extend" as const, occurredAt: at(-5 * 60_000), payload: { newExpectedReturnAt: at(3600_000) } };
    const r = await syncHike(user, syncInput(sessionId, { events: [later, earlier], sentAt: at(0) }));
    if (!r.ok) throw new Error(r.error);
    const calls = vi.mocked(onCheckinExtendedFromDevice).mock.calls;
    expect(calls.map((c) => c[5])).toEqual([earlier.id, later.id]); // in the order they happened
    expect(calls[0].slice(1, 3)).toEqual([tripId, user.id]);
    expect(Math.abs((calls[0][4] as Date).getTime() - (Date.now() + 3600_000))).toBeLessThan(15_000); // corrected new return time
    expect(Math.abs((calls[0][3] as Date).getTime() - (Date.now() - 5 * 60_000))).toBeLessThan(15_000);
    expect(r.value.checkin).toEqual([
      { eventId: earlier.id, kind: "checkin_extend", applied: true },
      { eventId: later.id, kind: "checkin_extend", applied: false, reason: "stale" },
    ]);
    const [stored] = await sql()<{ payload: Record<string, unknown> }[]>`
      select payload from public.hike_events where hike_session_id = ${sessionId} and client_event_id = ${earlier.id}`;
    expect(Date.parse(String(stored.payload.newExpectedReturnAt))).toBeCloseTo(Date.parse(earlier.payload.newExpectedReturnAt) - skew, -5);
    expect(stored.payload.deviceOccurredAt).toBe(earlier.occurredAt);
  });

  it("another user's session is 404 and RLS keeps their points private", async () => {
    const alice = await startedSession("alice");
    const bob = await createCustomer("bob");
    await syncHike(alice.user, syncInput(alice.sessionId, { points: [point(1)] }));
    expect(await syncHike(bob, syncInput(alice.sessionId, { points: [point(0)] }))).toMatchObject({ ok: false, status: 404 });
    expect(await syncHike(bob, syncInput(randomUUID(), { points: [point(0)] }))).toMatchObject({ ok: false, status: 404 });
    expect(await count("location_points", alice.sessionId)).toBe(1);

    // RLS: Bob cannot read Alice's points, last location, events or session
    const peek = await withUser(bob, async (tx) => ({
      points: await tx`select id from public.location_points where hike_session_id = ${alice.sessionId}`,
      last: await tx`select 1 from public.hike_last_locations where hike_session_id = ${alice.sessionId}`,
      sessions: await tx`select 1 from public.hike_sessions where id = ${alice.sessionId}`,
    }));
    expect(peek).toEqual({ points: [], last: [], sessions: [] });
    // ...and cannot inject rows into her session through the Data API either (restrictive policy)
    await expect(
      withUser(bob, (tx) => tx`
        insert into public.location_points (hike_session_id, user_id, client_point_id, lat, lng, recorded_at)
        values (${alice.sessionId}, ${bob.id}, 'evil', 1, 1, now())`),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withUser(bob, (tx) => tx`insert into public.hike_sessions (trip_id, user_id) values (${alice.tripId}, ${bob.id})`),
    ).rejects.toThrow(/row-level security/);
    // support staff never see precise points; safety staff can
    const support = await withUser({ id: (await sql()`select id from auth.users where email = 'support@demo.ghostguide.test'`)[0].id }, (tx) =>
      tx`select 1 from public.location_points where hike_session_id = ${alice.sessionId}`,
    );
    expect(support).toHaveLength(0);
  });

  it("forwards 'I'm okay' taps to the check-in contract with the device time", async () => {
    const { user, tripId, sessionId } = await startedSession("okay");
    const okEvent = { id: randomUUID(), kind: "checkin_ok" as const, occurredAt: iso(-15 * 60_000), payload: {} };
    await syncHike(user, syncInput(sessionId, { events: [okEvent] }));
    await syncHike(user, syncInput(sessionId, { events: [okEvent] })); // retried batch
    expect(onCheckinConfirmedFromDevice).toHaveBeenCalled();
    const call = vi.mocked(onCheckinConfirmedFromDevice).mock.calls[0];
    expect(call.slice(1)).toEqual([tripId, user.id, new Date(okEvent.occurredAt), okEvent.id]);
  });

  it("derives pause state from the latest pause/resume event, even when batches arrive out of order", async () => {
    const { user, sessionId } = await startedSession("pauser");
    const status = async () => (await sql()<{ status: string; pausedAt: Date | null }[]>`select status, paused_at from public.hike_sessions where id = ${sessionId}`)[0];
    const pause = { id: randomUUID(), kind: "pause" as const, occurredAt: iso(-10 * 60_000), payload: {} };
    const resume = { id: randomUUID(), kind: "resume" as const, occurredAt: iso(-5 * 60_000), payload: {} };
    const pause2 = { id: randomUUID(), kind: "pause" as const, occurredAt: iso(-60_000), payload: {} };
    await syncHike(user, syncInput(sessionId, { events: [resume] }));
    expect((await status()).status).toBe("active");
    await syncHike(user, syncInput(sessionId, { events: [pause] })); // delayed, older than the resume
    expect((await status()).status).toBe("active");
    await syncHike(user, syncInput(sessionId, { events: [pause2] }));
    const s = await status();
    expect(s.status).toBe("paused");
    expect(s.pausedAt?.toISOString()).toBe(pause2.occurredAt);
  });

  it("validates input: limits, whitelisted payloads without coordinates", async () => {
    const sessionId = randomUUID();
    const many = Array.from({ length: 501 }, (_, i) => point(i));
    expect(syncRequestSchema.safeParse({ sessionId, points: many }).success).toBe(false);
    expect(syncRequestSchema.safeParse({ sessionId, points: many.slice(0, 500) }).success).toBe(true);
    const withCoords = { sessionId, events: [{ id: "e1", kind: "checkin_ok", occurredAt: iso(0), payload: { lat: 1, lng: 2 } }] };
    expect(syncRequestSchema.safeParse(withCoords).success).toBe(false);
    expect(syncRequestSchema.safeParse({ sessionId, events: [{ id: "e1", kind: "teleport", occurredAt: iso(0) }] }).success).toBe(false);
    // an extension must say until when
    expect(syncRequestSchema.safeParse({ sessionId, events: [{ id: "e1", kind: "checkin_extend", occurredAt: iso(0) }] }).success).toBe(false);
    expect(
      syncRequestSchema.safeParse({ sessionId, events: [{ id: "e1", kind: "checkin_extend", occurredAt: iso(0), payload: { newExpectedReturnAt: iso(3600_000) } }] }).success,
    ).toBe(true);
    expect(syncRequestSchema.safeParse({ sessionId, points: [{ ...point(0), lat: 123 }] }).success).toBe(false);
    // defense in depth: the database refuses coordinates in event payloads too
    const { user, sessionId: real } = await startedSession("coords");
    await expect(
      withUser(user, (tx) => tx`
        insert into public.hike_events (hike_session_id, user_id, client_event_id, kind, payload, occurred_at)
        values (${real}, ${user.id}, 'x', 'checkin_ok', ${tx.json({ lat: 1, lng: 2 })}, now())`),
    ).rejects.toThrow(/hike_events_payload_no_coordinates/);
  });
});
