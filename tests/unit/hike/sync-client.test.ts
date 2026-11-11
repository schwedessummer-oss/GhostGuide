import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/offline/idb", async () => await import("./fake-idb"));

import { CLOCK_SKEW_MAX_MS, correctDeviceTime, estimateClockSkewMs, isSafetyEventKind } from "@/domain/outbox";
import { audioCacheKey, canonicalManifestJson, isAudioCacheKey, storedUrlOf, type OfflineManifest } from "@/domain/offline-manifest";
import { audioSources } from "@/components/hike/engine/audio";
import { applySyncResponse, initialHikeState, loadHikeState, recordDropped, saveHikeState } from "@/lib/offline/hike-state";
import { enqueueEvent, enqueuePoint, OutboxSyncer, queuedSafetyEventIds, type SyncHost } from "@/lib/offline/outbox";
import { describePending, flushPendingHikeUpdates, hasSafetyUpdates, pendingHikeUpdates } from "@/lib/offline/background-sync";
import { putStoredBundle, getStoredBundle } from "@/lib/offline/bundle-store";
import { fakeStore, MemoryStorage, resetFakeIdb } from "./fake-idb";
import { NARR_A, OWNER, TRIP_ID, storedBundle } from "./bundle-fixture";

const SESSION = "33333333-3333-4333-8333-333333333333";
const OTHER_TRIP = "44444444-4444-4444-8444-444444444444";

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[];

/** A fake hike API: accepts everything unless told otherwise. */
function api(opts: { rejectIds?: string[]; syncStatus?: number } = {}) {
  calls = [];
  return vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (url === "/api/hike/start") {
      return json(200, { session: { id: SESSION, tripId: body.tripId, status: "active", startedAt: new Date().toISOString(), finishedAt: null, lastSyncAt: null, distanceCompletedM: 0 }, created: true, tripStatus: "active" });
    }
    if (url === "/api/hike/sync") {
      if (opts.syncStatus && opts.syncStatus !== 200) return json(opts.syncStatus, { error: "Invalid request: points" });
      const reject = new Set(opts.rejectIds ?? []);
      const points = (body.points as { id: string }[]).map((p) => p.id);
      const events = (body.events as { id: string; kind: string }[]).map((e) => e.id);
      return json(200, {
        serverTime: new Date().toISOString(),
        acceptedPointIds: points.filter((id) => !reject.has(id)),
        acceptedEventIds: events.filter((id) => !reject.has(id)),
        rejected: [...points, ...events].filter((id) => reject.has(id)).map((id) => ({ id, kind: points.includes(id) ? "point" : "event", reason: "future_timestamp" })),
        session: { id: SESSION, status: "active", lastSyncAt: new Date().toISOString() },
        clockSkewMs: 300_000,
        checkin: (body.events as { id: string; kind: string }[])
          .filter((e) => e.kind === "checkin_extend")
          .map((e) => ({ eventId: e.id, kind: "checkin_extend", applied: true })),
      });
    }
    if (url === "/api/hike/finish") {
      return json(200, { session: { id: SESSION, tripId: TRIP_ID, status: "finished", startedAt: "", finishedAt: "", lastSyncAt: null, distanceCompletedM: 0 }, alreadyFinished: false, tripStatus: "completed" });
    }
    return json(404, { error: "not found" });
  });
}

beforeEach(() => {
  resetFakeIdb();
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("document", { cookie: `gg_owner=${OWNER}` });
  vi.stubGlobal("localStorage", new MemoryStorage());
});
afterEach(() => vi.unstubAllGlobals());

describe("device clock skew (pure)", () => {
  it("estimates the skew from the device's send time and corrects timestamps", () => {
    const server = Date.parse("2026-11-11T12:00:00Z");
    expect(estimateClockSkewMs("2026-11-11T12:05:00Z", server)).toBe(300_000); // 5 min fast
    expect(estimateClockSkewMs("2026-11-11T11:50:00Z", server)).toBe(-600_000); // 10 min slow
    expect(correctDeviceTime(Date.parse("2026-11-11T12:04:00Z"), 300_000)).toBe(Date.parse("2026-11-11T11:59:00Z"));
  });

  it("ignores latency noise, missing or garbage send times, and bounds the correction", () => {
    const server = Date.now();
    expect(estimateClockSkewMs(new Date(server - 4_000).toISOString(), server)).toBe(0);
    expect(estimateClockSkewMs(undefined, server)).toBe(0);
    expect(estimateClockSkewMs("not a date", server)).toBe(0);
    expect(estimateClockSkewMs(server + CLOCK_SKEW_MAX_MS + 1, server)).toBe(0);
  });

  it("knows which events must never be dropped for clock reasons", () => {
    expect(["checkin_ok", "checkin_extend", "finish"].every(isSafetyEventKind)).toBe(true);
    expect(isSafetyEventKind("reminder")).toBe(false);
  });
});

describe("narration audio has a stable on-device key", () => {
  it("narration id + version, not the signed URL", () => {
    const key = audioCacheKey(NARR_A, 3);
    expect(key).toBe(`/__gg/audio/${NARR_A}/v3`);
    expect(isAudioCacheKey(key)).toBe(true);
    expect(isAudioCacheKey("/__gg/audio/../../etc/v1")).toBe(false);
  });

  it("re-signed URLs leave the stored key (and the manifest checksum input) unchanged", () => {
    const m = (sig: string): OfflineManifest => ({
      version: 1,
      generatedAt: sig,
      items: [{ key: `audio:${NARR_A}`, kind: "audio", url: `/api/media/a.mp3?exp=1&sig=${sig}`, cacheAs: audioCacheKey(NARR_A, 1) }],
    });
    expect(storedUrlOf(m("a").items[0])).toBe(storedUrlOf(m("b").items[0]));
    expect(canonicalManifestJson(m("a"))).toBe(canonicalManifestJson(m("b")));
  });

  it("playback tries the stable key first when a service worker controls the page", () => {
    const n = { id: NARR_A, version: 2, audioUrl: "/api/media/a.mp3?sig=x" };
    expect(audioSources(n, true)).toEqual([`/__gg/audio/${NARR_A}/v2`, n.audioUrl]);
    expect(audioSources(n, false)).toEqual([n.audioUrl]);
    expect(audioSources({ ...n, audioUrl: null }, true)).toEqual([]);
  });
});

describe("hike state merges sync results", () => {
  it("records extension outcomes and the clock skew", () => {
    const s = { ...initialHikeState(TRIP_ID), extensions: [{ id: "x1", at: 1, newExpectedReturnAt: 2, result: null }] };
    const next = applySyncResponse(s, { clockSkewMs: 120_000, checkin: [{ eventId: "x1", kind: "checkin_extend", applied: false, reason: "stale" }] });
    expect(next.extensions?.[0].result).toEqual({ applied: false, reason: "stale" });
    expect(next.clockSkewMs).toBe(120_000);
  });

  it("dropped items are counted and safety ones marked failed", () => {
    const s = { ...initialHikeState(TRIP_ID), okTaps: [{ id: "ok1", at: 1 }] };
    const next = recordDropped(s, { count: 3, reason: "bad", ids: ["ok1", "p1", "p2"] }, 99);
    expect(next).toMatchObject({ droppedCount: 3, droppedAt: 99, droppedReason: "bad", failedSafetyIds: ["ok1"] });
  });
});

function host(over: Partial<SyncHost> = {}): SyncHost & { dropped: unknown[]; responses: unknown[] } {
  const dropped: unknown[] = [];
  const responses: unknown[] = [];
  return {
    dropped,
    responses,
    session: () => ({ localSessionId: SESSION, serverSessionId: SESSION, startSynced: true, startedAt: Date.now() - 60_000, finishPending: false, finishedAt: null, progressM: 10 }),
    onStartConfirmed: () => {},
    onStartRejected: () => {},
    onFinishConfirmed: () => {},
    onSynced: () => {},
    onSyncResponse: (r) => void responses.push(r),
    onDropped: (i) => void dropped.push(i),
    ...over,
  };
}

describe("OutboxSyncer", () => {
  it("sends the device's clock with every request", async () => {
    vi.stubGlobal("fetch", api());
    await enqueueEvent(TRIP_ID, "checkin_ok", {});
    const before = Date.now();
    await new OutboxSyncer(TRIP_ID, host(), null).flushOnce();
    const sync = calls.find((c) => c.url === "/api/hike/sync")!;
    expect(Date.parse(String(sync.body.sentAt))).toBeGreaterThanOrEqual(before - 1);
  });

  it("reports refused items (with ids) instead of dropping them silently, and passes sync results on", async () => {
    const tap = await enqueueEvent(TRIP_ID, "checkin_ok", {});
    const bad = await enqueuePoint(TRIP_ID, { lat: 1, lng: 2, accuracyM: 5, altitudeM: null, recordedAt: new Date(Date.now() + 3600_000).toISOString() });
    vi.stubGlobal("fetch", api({ rejectIds: [bad] }));
    const h = host();
    expect(await new OutboxSyncer(TRIP_ID, h, null).flushOnce()).toBe("ok");
    expect(fakeStore("outbox").size).toBe(0);
    expect(h.dropped).toEqual([{ count: 1, safety: 0, reason: expect.stringMatching(/future/), ids: [bad] }]);
    expect(h.responses).toHaveLength(1);
    expect((h.responses[0] as { acceptedEventIds: string[] }).acceptedEventIds).toEqual([tap]);
  });

  it("a batch refused outright (4xx) is removed so the queue can't jam — and reported, counting safety events", async () => {
    await enqueueEvent(TRIP_ID, "checkin_ok", {});
    await enqueuePoint(TRIP_ID, { lat: 1, lng: 2, accuracyM: 5, altitudeM: null, recordedAt: new Date().toISOString() });
    vi.stubGlobal("fetch", api({ syncStatus: 400 }));
    const h = host();
    await new OutboxSyncer(TRIP_ID, h, null).flushOnce();
    expect(h.dropped).toEqual([expect.objectContaining({ count: 2, safety: 1 })]);
  });

  it("knows which safety events are still queued", async () => {
    const ok = await enqueueEvent(TRIP_ID, "checkin_ok", {});
    const ext = await enqueueEvent(TRIP_ID, "checkin_extend", { newExpectedReturnAt: new Date().toISOString() });
    await enqueueEvent(TRIP_ID, "reminder", { reminder: "hydration" });
    expect([...(await queuedSafetyEventIds(TRIP_ID))].sort()).toEqual([ok, ext].sort());
  });
});

describe("site-wide sending of queued hike updates (finish / I'm okay sent without the hike screen)", () => {
  async function finishedOffline(ownerHint = OWNER, tripId = TRIP_ID) {
    await putStoredBundle(storedBundle());
    await saveHikeState({
      ...initialHikeState(tripId),
      ownerHint,
      status: "finished",
      localSessionId: SESSION,
      startSynced: false,
      startedAt: Date.now() - 3600_000,
      finishedAt: Date.now() - 60_000,
      finishPending: true,
    });
    await enqueueEvent(tripId, "start", {}, new Date(Date.now() - 3600_000));
    await enqueueEvent(tripId, "checkin_ok", {}, new Date(Date.now() - 1800_000));
    await enqueueEvent(tripId, "finish", { progressM: 100 }, new Date(Date.now() - 60_000));
  }

  it("counts what is waiting, for the signed-in account only", async () => {
    await finishedOffline();
    await saveHikeState({ ...initialHikeState(OTHER_TRIP), ownerHint: "someone-else-bbbbbbbbbb", status: "active" });
    await enqueuePoint(OTHER_TRIP, { lat: 1, lng: 2, accuracyM: 5, altitudeM: null, recordedAt: new Date().toISOString() });
    const p = await pendingHikeUpdates();
    expect(p).toMatchObject({ total: 3, okTaps: 1, finishes: 1, points: 0 });
    expect(hasSafetyUpdates(p)).toBe(true);
    expect(describePending(p)).toBe("Finish, I'm okay, 1 other update");
  });

  it("registers the start, sends the queue in order, then the finish — and records it on the device", async () => {
    await finishedOffline();
    vi.stubGlobal("fetch", api());
    const left = await flushPendingHikeUpdates();
    expect(left.total).toBe(0);
    expect(calls.map((c) => c.url)).toEqual(["/api/hike/start", "/api/hike/sync", "/api/hike/finish"]);
    expect((calls[1].body.events as { kind: string }[]).map((e) => e.kind)).toEqual(["start", "checkin_ok", "finish"]);
    expect(calls.every((c) => typeof c.body.sentAt === "string")).toBe(true);
    const s = await loadHikeState(TRIP_ID);
    expect(s).toMatchObject({ startSynced: true, serverSessionId: SESSION, finishPending: false, finishSynced: true, clockSkewMs: 300_000 });
    expect((await getStoredBundle(TRIP_ID))?.bundle.trip.status).toBe("completed");
  });

  it("skips the trip whose hike screen is open, other accounts' data, and does nothing offline or signed out", async () => {
    await finishedOffline();
    vi.stubGlobal("fetch", api());
    expect((await flushPendingHikeUpdates({ skipTripIds: [TRIP_ID] })).total).toBe(3);
    expect(calls).toHaveLength(0);
    vi.stubGlobal("navigator", { onLine: false });
    expect((await flushPendingHikeUpdates()).total).toBe(3);
    expect(calls).toHaveLength(0);
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("document", { cookie: "gg_owner=someone-else-bbbbbbbbbb" });
    expect((await flushPendingHikeUpdates()).total).toBe(0); // nothing of theirs
    expect(calls).toHaveLength(0);
    expect(fakeStore("outbox").size).toBe(3); // and the first account's data is untouched
  });

  it("keeps everything queued when the server can't be reached", async () => {
    await finishedOffline();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const left = await flushPendingHikeUpdates();
    expect(left.total).toBe(3);
    expect((await loadHikeState(TRIP_ID))?.finishPending).toBe(true);
  });
});
