import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Node has no IndexedDB / audio / wake lock: in-memory stand-ins (same as hike-engine.test.ts).
vi.mock("@/lib/offline/idb", async () => await import("./fake-idb"));
vi.mock("@/components/hike/engine/audio", () => ({
  NarrationPlayer: class {
    unlocked = false;
    unlock() {
      this.unlocked = true;
    }
    stop() {}
    async play() {
      return "text_only";
    }
  },
  vibrate: () => {},
  speechAvailable: () => false,
}));
vi.mock("@/components/hike/engine/wake-lock", () => ({
  WakeLockController: class {
    status = "unsupported";
    request() {}
    release() {}
    dispose() {}
  },
  wakeLockSupported: () => false,
}));

import { HikeEngine } from "@/components/hike/engine/hike-engine";
import { putStoredBundle } from "@/lib/offline/bundle-store";
import { localDateInZone } from "@/lib/time";
import type { TripBundle } from "@/lib/offline/wire";
import { fakeStore, MemoryStorage, resetFakeIdb } from "./fake-idb";
import { OWNER, TRIP_ID, TZ, makeBundle, storedBundle } from "./bundle-fixture";

const SESSION = "33333333-3333-4333-8333-333333333333";
let engines: HikeEngine[] = [];
const noop = () => {};

beforeEach(() => {
  resetFakeIdb();
  const target = { addEventListener: noop, removeEventListener: noop };
  vi.stubGlobal("window", { ...target, matchMedia: () => ({ matches: false }) });
  vi.stubGlobal("document", { ...target, cookie: `gg_owner=${OWNER}`, visibilityState: "visible" });
  vi.stubGlobal("navigator", { onLine: false });
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("caches", { delete: vi.fn(async () => true), keys: vi.fn(async () => []) });
});

afterEach(() => {
  for (const e of engines) e.dispose();
  engines = [];
  vi.unstubAllGlobals();
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const plusDays = (n: number) => {
  const d = new Date(`${localDateInZone(new Date(), TZ)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const queuedEvents = () =>
  [...fakeStore("outbox").values()].map((v) => v as { id: string; payload: { kind: string; payload: Record<string, unknown> } }).filter((v) => v.payload?.kind);

async function boot(bundle: TripBundle = makeBundle(), demo = true) {
  await putStoredBundle(storedBundle(bundle));
  const e = new HikeEngine(TRIP_ID, demo);
  engines.push(e);
  await e.init();
  return e;
}

async function started(bundle?: TripBundle) {
  const e = await boot(bundle);
  e.acknowledgeLimitations(true);
  e.start();
  expect(e.getSnapshot().phase).toBe("active");
  await tick();
  return e;
}

/** A fake hike API answering start/sync; `reject` makes sync refuse the batch outright. */
function goOnline(opts: { reject?: boolean } = {}) {
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { points?: { id: string }[]; events?: { id: string; kind: string }[] };
      const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
      if (url === "/api/hike/start") return json(200, { session: { id: SESSION, status: "active" }, created: true, tripStatus: "active" });
      if (url === "/api/hike/sync") {
        if (opts.reject) return json(400, { error: "Invalid request" });
        return json(200, {
          serverTime: new Date().toISOString(),
          acceptedPointIds: (body.points ?? []).map((p) => p.id),
          acceptedEventIds: (body.events ?? []).map((e) => e.id),
          rejected: [],
          session: { id: SESSION, status: "active", lastSyncAt: new Date().toISOString() },
          clockSkewMs: 0,
          checkin: (body.events ?? []).filter((e) => e.kind === "checkin_extend").map((e) => ({ eventId: e.id, kind: "checkin_extend", applied: true })),
        });
      }
      return json(404, { error: "not found" });
    }),
  );
}

async function settle(e: HikeEngine) {
  e.syncNow();
  for (let i = 0; i < 20; i++) await tick();
}

const withCheckin = (expectedInMin = 120) =>
  makeBundle({
    checkin: { status: "active", expectedReturnAt: new Date(Date.now() + expectedInMin * 60_000).toISOString(), graceMinutes: 30 },
    expectedReturnAt: new Date(Date.now() + expectedInMin * 60_000).toISOString(),
  });

describe('"I\'m okay" is shown as sent only once Ghost Guide accepted it', () => {
  it("offline: saved, not sent; online: sent after the server acknowledged it", async () => {
    const e = await started();
    e.imOkay();
    await tick();
    await tick();
    expect(e.getSnapshot().okTap).toMatchObject({ sent: false, failed: false });
    goOnline();
    await settle(e);
    expect(e.getSnapshot().okTap).toMatchObject({ sent: true, failed: false });
  });

  it("a tap the server refused is never shown as sent", async () => {
    const e = await started();
    e.imOkay();
    await tick();
    await tick();
    goOnline({ reject: true });
    await settle(e);
    expect(e.getSnapshot().okTap).toMatchObject({ sent: false, failed: true });
    expect(e.getSnapshot().syncIssues.dropped).toBeGreaterThan(0);
  });
});

describe("Extend my trip (works offline, honest status)", () => {
  it("is only possible with an open check-in during the hike", async () => {
    const e = await started(); // no check-in
    expect(e.getSnapshot().checkin).toBeNull();
    expect(await e.extendCheckin(Date.now() + 3600_000)).toMatch(/no active check-in/i);
  });

  it("queues a checkin_extend event with the new time and shows it as waiting until it is sent", async () => {
    const e = await started(withCheckin(60));
    const before = e.getSnapshot().checkin!;
    expect(before.notifyAfter - before.expectedReturnAt).toBe(30 * 60_000);
    const until = before.expectedReturnAt + 30 * 60_000;
    expect(await e.extendCheckin(until)).toBeNull();
    const ev = queuedEvents().find((v) => v.payload.kind === "checkin_extend")!;
    expect(ev.payload.payload).toEqual({ newExpectedReturnAt: new Date(until).toISOString() });
    const c = e.getSnapshot().checkin!;
    expect(c.extension).toMatchObject({ state: "queued", newExpectedReturnAt: until });
    expect(c.expectedReturnAt).toBe(until);
    expect(c.serverExpectedReturnAt).toBe(before.expectedReturnAt);
    expect(e.getSnapshot().announcement).toMatch(/sent when you're back online/);

    goOnline();
    await settle(e);
    expect(e.getSnapshot().checkin!.extension).toMatchObject({ state: "applied" });
  });

  it("refuses times too soon or more than 24 h ahead", async () => {
    const e = await started(withCheckin(60));
    expect(await e.extendCheckin(Date.now() + 60_000)).toMatch(/at least 5 minutes/);
    expect(await e.extendCheckin(Date.now() + 25 * 3600_000)).toMatch(/24 hours/);
    expect(queuedEvents().some((v) => v.payload.kind === "checkin_extend")).toBe(false);
  });

  it("is not offered for a finished or cancelled check-in", async () => {
    const e = await started(makeBundle({ checkin: { status: "completed", expectedReturnAt: new Date().toISOString(), graceMinutes: 30 } }));
    expect(e.getSnapshot().checkin?.open).toBe(false);
    expect(await e.extendCheckin(Date.now() + 3600_000)).toMatch(/no active check-in/i);
  });
});

describe("closures from the downloaded trip data", () => {
  const closure = (severity: string, startsInDays = -1, endsInDays: number | null = 3) => ({
    severity,
    reason: `${severity} for testing`,
    startsAt: new Date(Date.now() + startsInDays * 86_400_000).toISOString(),
    endsAt: endsInDays === null ? null : new Date(Date.now() + endsInDays * 86_400_000).toISOString(),
  });

  it("a full closure today blocks the start — even 'Start anyway (demo)'", async () => {
    const b = makeBundle();
    const e = await boot({ ...b, trail: { ...b.trail, closures: [closure("closed")] } });
    expect(e.getSnapshot().closures.closedToday).toMatchObject({ severity: "closed" });
    e.acknowledgeLimitations(true);
    e.start();
    e.start({ demoStartAnyway: true });
    expect(e.getSnapshot().phase).toBe("ready");
    expect(queuedEvents()).toHaveLength(0);
  });

  it("a partial closure is listed but does not block the start", async () => {
    const b = makeBundle();
    const e = await boot({ ...b, trail: { ...b.trail, closures: [closure("partial")] } });
    expect(e.getSnapshot().closures).toMatchObject({ closedToday: null, list: [expect.objectContaining({ severity: "partial" })] });
    e.acknowledgeLimitations(true);
    e.start();
    expect(e.getSnapshot().phase).toBe("active");
  });

  it("a closure scheduled for the booked date is flagged before the day", async () => {
    const b = makeBundle({ bookedDate: plusDays(5) });
    const e = await boot({ ...b, trail: { ...b.trail, closures: [closure("closed", 4, 7)] } });
    expect(e.getSnapshot().closures).toMatchObject({ closedToday: null, closedOnBookedDate: expect.objectContaining({ severity: "closed" }) });
  });

  it("closures downloaded before start times were included still count as active", async () => {
    const b = makeBundle();
    const e = await boot({ ...b, trail: { ...b.trail, closures: [{ severity: "closed", reason: "Old download", endsAt: null }] } });
    expect(e.getSnapshot().closures.closedToday).toMatchObject({ reason: "Old download" });
  });
});
