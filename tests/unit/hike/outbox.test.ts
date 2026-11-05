import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKOFF,
  INITIAL_SYNC_SCHEDULE,
  applyAck,
  backoffDelayMs,
  classifySyncStatus,
  nextBatch,
  onReconnect,
  onSyncFailure,
  onSyncStart,
  onSyncSuccess,
  shouldAttemptSync,
  shouldSamplePoint,
  type OutboxEntry,
} from "@/domain/outbox";
import { at } from "./fixtures";

const entry = (id: string, seq: number, kind: "point" | "event"): OutboxEntry => ({ id, seq, kind, payload: {}, createdAt: seq });

describe("outbox queue", () => {
  it("preserves recording order regardless of insertion order", () => {
    const q = [entry("c", 3, "event"), entry("a", 1, "point"), entry("b", 2, "point")];
    expect(nextBatch(q).ids).toEqual(["a", "b", "c"]);
  });

  it("batches within the server limits and stops at the first item that does not fit", () => {
    const q: OutboxEntry[] = [];
    for (let i = 0; i < 7; i++) q.push(entry(`p${i}`, i, "point"));
    q.push(entry("e0", 7, "event"));
    q.push(entry("p7", 8, "point"));
    const b1 = nextBatch(q, { maxPoints: 5, maxEvents: 10 });
    expect(b1.ids).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(b1.points).toHaveLength(5);
    // the event must not overtake points recorded before it
    const rest = applyAck(q, b1.ids);
    const b2 = nextBatch(rest, { maxPoints: 5, maxEvents: 10 });
    expect(b2.ids).toEqual(["p5", "p6", "e0", "p7"]);
    expect(b2.events.map((e) => e.id)).toEqual(["e0"]);
    expect(applyAck(rest, b2.ids)).toEqual([]);
  });

  it("backoff grows exponentially with jitter and is capped", () => {
    const mid = () => 0.5;
    expect(backoffDelayMs(1, DEFAULT_BACKOFF, mid)).toBe(2000);
    expect(backoffDelayMs(2, DEFAULT_BACKOFF, mid)).toBe(4000);
    expect(backoffDelayMs(5, DEFAULT_BACKOFF, mid)).toBe(32_000);
    expect(backoffDelayMs(50, DEFAULT_BACKOFF, mid)).toBe(DEFAULT_BACKOFF.maxMs);
    expect(backoffDelayMs(50, DEFAULT_BACKOFF, () => 1)).toBe(DEFAULT_BACKOFF.maxMs);
    expect(backoffDelayMs(3, DEFAULT_BACKOFF, () => 0)).toBe(Math.round(8000 * 0.7));
    expect(backoffDelayMs(3, DEFAULT_BACKOFF, () => 0.999)).toBeLessThanOrEqual(Math.round(8000 * 1.3));
  });

  it("keeps the queue on auth, server and network failures", () => {
    expect(classifySyncStatus(200)).toBe("success");
    expect(classifySyncStatus(401)).toBe("auth_required");
    expect(classifySyncStatus(500)).toBe("retry");
    expect(classifySyncStatus(503)).toBe("retry");
    expect(classifySyncStatus(429)).toBe("retry");
    expect(classifySyncStatus("network_error")).toBe("retry");
    expect(classifySyncStatus(400)).toBe("rejected");
  });

  it("schedules retries and flushes immediately on reconnection", () => {
    const now = 1_000_000;
    let s = onSyncStart(INITIAL_SYNC_SCHEDULE);
    expect(shouldAttemptSync(s, { online: true, hasWork: true, now })).toBe(false); // in flight
    s = onSyncFailure(s, now, "offline", DEFAULT_BACKOFF, () => 0.5);
    expect(s.attempt).toBe(1);
    expect(s.nextAttemptAt).toBe(now + 2000);
    expect(shouldAttemptSync(s, { online: true, hasWork: true, now: now + 1000 })).toBe(false);
    s = onSyncFailure(onSyncStart(s), now + 2000, "offline", DEFAULT_BACKOFF, () => 0.5);
    expect(s.nextAttemptAt).toBe(now + 2000 + 4000);
    // offline → never attempt; reconnect → attempt right away with the backoff reset
    expect(shouldAttemptSync(s, { online: false, hasWork: true, now: now + 10_000 })).toBe(false);
    s = onReconnect(s, now + 3000);
    expect(s.attempt).toBe(0);
    expect(shouldAttemptSync(s, { online: true, hasWork: true, now: now + 3000 })).toBe(true);
    expect(shouldAttemptSync(s, { online: true, hasWork: false, now: now + 3000 })).toBe(false);
    s = onSyncSuccess(onSyncStart(s), now + 3500);
    expect(s).toMatchObject({ attempt: 0, nextAttemptAt: null, inFlight: false, lastSuccessAt: now + 3500, lastError: null });
  });

  it("samples a point every 30 s or 50 m", () => {
    const last = { ...at(0), at: 0 };
    expect(shouldSamplePoint(null, { ...at(0), timestamp: 0 })).toBe(true);
    expect(shouldSamplePoint(last, { ...at(10), timestamp: 10_000 })).toBe(false);
    expect(shouldSamplePoint(last, { ...at(10), timestamp: 30_000 })).toBe(true);
    expect(shouldSamplePoint(last, { ...at(55), timestamp: 5_000 })).toBe(true);
  });
});
