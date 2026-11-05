import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The check-in contract is implemented by the safety slice; spy on it here so
// these tests verify the hike slice's calls without depending on its schema.
vi.mock("@/server/checkins/service", () => ({
  onHikeStarted: vi.fn(async () => {}),
  onCheckinConfirmedFromDevice: vi.fn(async () => {}),
  onTripFinished: vi.fn(async () => {}),
}));

import { closeDb, sql, withSystem } from "@/server/db";
import { onHikeStarted, onTripFinished } from "@/server/checkins/service";
import { finishHike, startHike } from "@/server/hike/sessions";
import { hikeHandlers } from "@/server/jobs/handlers/hike";
import { createCustomer } from "../../helpers/db";
import { createTrip, iso } from "./helpers";

afterAll(closeDb);
beforeEach(() => vi.clearAllMocks());

const tripStatus = async (id: string) => (await sql()<{ status: string }[]>`select status from public.trips where id = ${id}`)[0].status;

describe("hike start", () => {
  it("is idempotent, returns the open session and moves the trip to active", async () => {
    const user = await createCustomer("starter");
    const tripId = await createTrip(user, "booked");
    const first = await startHike(user, { tripId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.created).toBe(true);
    expect(first.value.session.status).toBe("active");
    expect(await tripStatus(tripId)).toBe("active");
    expect(onHikeStarted).toHaveBeenCalledTimes(1);
    expect(vi.mocked(onHikeStarted).mock.calls[0].slice(1)).toEqual([tripId, user.id]);

    const again = await startHike(user, { tripId });
    expect(again.ok && again.value.created).toBe(false);
    expect(again.ok && again.value.session.id).toBe(first.value.session.id);
    expect(onHikeStarted).toHaveBeenCalledTimes(1);
    const sessions = await sql()`select id from public.hike_sessions where trip_id = ${tripId}`;
    expect(sessions).toHaveLength(1);

    // a housekeeping job was enqueued in the same transaction
    const jobs = await sql()`select kind from public.jobs where dedup_key = ${`hike:${first.value.session.id}:close_stale:0`}`;
    expect(jobs).toHaveLength(1);
  });

  it("uses the device's session id (offline start) and is safe to retry with it", async () => {
    const user = await createCustomer("offline-start");
    const tripId = await createTrip(user, "booked");
    const clientSessionId = randomUUID();
    const startedAt = iso(-20 * 60_000);
    const r1 = await startHike(user, { tripId, clientSessionId, startedAt });
    expect(r1.ok && r1.value.session.id).toBe(clientSessionId);
    expect(r1.ok && r1.value.session.startedAt).toBe(startedAt);
    const r2 = await startHike(user, { tripId, clientSessionId, startedAt });
    expect(r2.ok && r2.value).toMatchObject({ created: false, session: { id: clientSessionId } });
    // implausible device times are replaced by the server time
    const t2 = await createTrip(user, "booked");
    const r3 = await startHike(user, { tripId: t2, startedAt: iso(3 * 86_400_000) });
    expect(r3.ok && Math.abs(Date.parse(r3.value.session.startedAt) - Date.now())).toBeLessThan(60_000);
  });

  it("concurrent starts create exactly one session", async () => {
    const user = await createCustomer("racer");
    const tripId = await createTrip(user, "booked");
    const results = await Promise.all([startHike(user, { tripId }), startHike(user, { tripId }), startHike(user, { tripId })]);
    const ids = new Set(results.map((r) => (r.ok ? r.value.session.id : null)));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.ok && r.value.created)).toHaveLength(1);
  });

  it("returns 404 for another customer's trip and 409 for trips that are not booked", async () => {
    const owner = await createCustomer("owner");
    const other = await createCustomer("other");
    const tripId = await createTrip(owner, "booked");
    expect(await startHike(other, { tripId })).toMatchObject({ ok: false, status: 404 });
    expect(await startHike(other, { tripId: randomUUID() })).toMatchObject({ ok: false, status: 404 });
    expect(await tripStatus(tripId)).toBe("booked");
    const saved = await createTrip(owner, "saved");
    expect(await startHike(owner, { tripId: saved })).toMatchObject({ ok: false, status: 409 });
    const cancelled = await createTrip(owner, "cancelled");
    expect(await startHike(owner, { tripId: cancelled })).toMatchObject({ ok: false, status: 409 });
  });
});

describe("hike finish", () => {
  it("is idempotent, finishes the session and completes the trip", async () => {
    const user = await createCustomer("finisher");
    const tripId = await createTrip(user, "booked");
    const started = await startHike(user, { tripId });
    if (!started.ok) throw new Error("start failed");
    const f1 = await finishHike(user, { tripId, distanceCompletedM: 3123.4, finishedAt: iso(-1000) });
    expect(f1.ok).toBe(true);
    if (!f1.ok) return;
    expect(f1.value).toMatchObject({ alreadyFinished: false, tripStatus: "completed", session: { id: started.value.session.id, status: "finished" } });
    expect(f1.value.session.distanceCompletedM).toBe(3123);
    expect(await tripStatus(tripId)).toBe("completed");
    expect(onTripFinished).toHaveBeenCalledTimes(1);
    expect(vi.mocked(onTripFinished).mock.calls[0].slice(1)).toEqual([tripId, user.id]);

    const f2 = await finishHike(user, { tripId });
    expect(f2.ok && f2.value).toMatchObject({ alreadyFinished: true, tripStatus: "completed", session: { id: started.value.session.id } });
    // the contract is safe to call repeatedly; the finish time did not change
    expect(f2.ok && f2.value.session.finishedAt).toBe(f1.value.session.finishedAt);
    // a completed trip cannot be restarted
    expect(await startHike(user, { tripId })).toMatchObject({ ok: false, status: 409 });
  });

  it("rejects finishing a hike that never started, and other users' trips", async () => {
    const user = await createCustomer("early");
    const other = await createCustomer("nosy");
    const tripId = await createTrip(user, "booked");
    expect(await finishHike(user, { tripId })).toMatchObject({ ok: false, status: 409 });
    await startHike(user, { tripId });
    expect(await finishHike(other, { tripId })).toMatchObject({ ok: false, status: 404 });
    expect(await tripStatus(tripId)).toBe("active");
  });
});

describe("hike.close_stale_session job", () => {
  it("abandons a long-silent open session without completing the trip, and no-ops otherwise", async () => {
    const user = await createCustomer("ghost");
    const tripId = await createTrip(user, "booked");
    const s = await startHike(user, { tripId });
    if (!s.ok) throw new Error("start failed");
    const handler = hikeHandlers["hike.close_stale_session"];
    const job = { id: 1, kind: "hike.close_stale_session", payload: { sessionId: s.value.session.id }, runAt: new Date(), status: "running" as const, attempts: 1, maxAttempts: 5, dedupKey: null, lastError: null, createdAt: new Date() };
    // recently started: rescheduled, not abandoned
    expect(await handler(job, { now: new Date() })).toMatchObject({ outcome: "noop" });
    // 3 days without any sync
    expect(await handler(job, { now: new Date(Date.now() + 72 * 3600_000) })).toMatchObject({ outcome: "done" });
    const [row] = await sql()`select status from public.hike_sessions where id = ${s.value.session.id}`;
    expect(row.status).toBe("abandoned");
    expect(await tripStatus(tripId)).toBe("active");
    // idempotent
    expect(await handler(job, { now: new Date(Date.now() + 96 * 3600_000) })).toMatchObject({ outcome: "noop" });
    await withSystem((tx) => tx`select 1`);
  });
});
