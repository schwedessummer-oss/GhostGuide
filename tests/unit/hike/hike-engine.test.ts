import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Node has no IndexedDB / audio / wake lock: in-memory stand-ins.
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
import { mirrorKey, saveHikeState, initialHikeState } from "@/lib/offline/hike-state";
import { enqueuePoint } from "@/lib/offline/outbox";
import { localDateInZone } from "@/lib/time";
import { fakeStore, freezeWrites, MemoryStorage, resetFakeIdb, thawWrites } from "./fake-idb";
import { NARR_B, OWNER, POI_A, POI_B, TRIP_ID, TZ, makeBundle, storedBundle } from "./bundle-fixture";
import { at } from "./fixtures";

const listeners: Record<string, Set<() => void>> = {};
const fire = (type: string) => listeners[type]?.forEach((l) => l());
let engines: HikeEngine[] = [];
let ls: MemoryStorage;
const doc = { cookie: "", visibilityState: "visible" };

beforeEach(() => {
  resetFakeIdb();
  for (const k of Object.keys(listeners)) delete listeners[k];
  const target = {
    addEventListener: (t: string, l: () => void) => void (listeners[t] ??= new Set()).add(l),
    removeEventListener: (t: string, l: () => void) => void listeners[t]?.delete(l),
  };
  ls = new MemoryStorage();
  doc.cookie = `gg_owner=${OWNER}`;
  vi.stubGlobal("window", { ...target, matchMedia: () => ({ matches: false }) });
  vi.stubGlobal("document", Object.assign(doc, target));
  vi.stubGlobal("navigator", { onLine: false });
  vi.stubGlobal("localStorage", ls);
  vi.stubGlobal("caches", { delete: vi.fn(async () => true), keys: vi.fn(async () => []) });
});

afterEach(() => {
  vi.useRealTimers();
  for (const e of engines) e.dispose();
  engines = [];
  vi.unstubAllGlobals();
});

async function boot(demo = true) {
  const e = new HikeEngine(TRIP_ID, demo);
  engines.push(e);
  await e.init();
  return e;
}
const heard = (e: HikeEngine, poiId: string) => e.getSnapshot().pois.find((p) => p.id === poiId)?.heard;
const fixAt = (eastM: number, t: number) => ({ ...at(eastM), accuracyM: 5, altitudeM: null, timestamp: t });

async function startedHike() {
  await putStoredBundle(storedBundle());
  const e = await boot();
  expect(e.getSnapshot().phase).toBe("ready");
  e.acknowledgeLimitations(true);
  e.start();
  expect(e.getSnapshot().phase).toBe("active");
  await new Promise((r) => setTimeout(r, 0));
  return e;
}

/** Walk the first `toM` metres in 15 m steps, one good fix every 10 s (timestamps in the past). */
function walk(e: HikeEngine, fromM: number, toM: number, t0 = Date.now() - 30 * 60_000) {
  let t = t0;
  for (let m = fromM; m <= toM; m += 15) e.onFix(fixAt(m, (t += 10_000)));
  return t;
}

describe("hike state survives reloads and navigation (no replayed stories, no lost progress)", () => {
  it("a story played by hand right before a reload stays heard", async () => {
    const e1 = await startedHike();
    e1.playNarration(NARR_B);
    expect(heard(e1, POI_B)).toBe(true);
    freezeWrites(); // the page unloads now: IndexedDB writes still in flight never commit
    thawWrites();
    const e2 = await boot();
    expect(e2.getSnapshot().phase).toBe("active");
    expect(heard(e2, POI_B)).toBe(true);
  });

  it("a stop triggered by GPS is saved at once (no 5 s window where a reload replays it)", async () => {
    const e1 = await startedHike();
    walk(e1, 15, 330); // passes Stop A at 300 m
    expect(heard(e1, POI_A)).toBe(true);
    freezeWrites();
    thawWrites();
    const e2 = await boot();
    expect(heard(e2, POI_A)).toBe(true);
    // walking past the stop again does not trigger it a second time
    const before = [...fakeStore("outbox").values()].filter((v) => JSON.stringify(v).includes('"poi_triggered"')).length;
    walk(e2, 280, 330, Date.now() - 5 * 60_000);
    const after = [...fakeStore("outbox").values()].filter((v) => JSON.stringify(v).includes('"poi_triggered"')).length;
    expect(after).toBe(before);
  });

  it("pagehide writes a synchronous copy, so progress is restored after a reload", async () => {
    const e1 = await startedHike();
    walk(e1, 15, 600);
    const walked = e1.getSnapshot().progress.alongM;
    expect(walked).toBeGreaterThan(500);
    freezeWrites(); // IndexedDB transactions started during unload are lost…
    fire("pagehide"); // …but the localStorage mirror is written synchronously
    thawWrites();
    expect(ls.getItem(mirrorKey(TRIP_ID))).toBeTruthy();
    const e2 = await boot();
    expect(e2.getSnapshot().progress.alongM).toBeCloseTo(walked, 3);
    expect(heard(e2, POI_A)).toBe(true);
  });

  it("stops the server already saw in this session are never auto-played again (lost local state)", async () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    await putStoredBundle(
      storedBundle(makeBundle({ session: { id: sessionId, status: "active", startedAt: new Date(Date.now() - 3600_000).toISOString(), finishedAt: null, heardPoiIds: [POI_A] } })),
    );
    const e = await boot(); // no local hike state on this device
    expect(e.getSnapshot().phase).toBe("active");
    expect(heard(e, POI_A)).toBe(true);
    walk(e, 15, 330);
    const triggered = [...fakeStore("outbox").values()].filter((v) => JSON.stringify(v).includes('"poi_triggered"'));
    expect(triggered).toHaveLength(0);
  });

  it("'Saved on device' reflects the first fix right away", async () => {
    const e = await startedHike();
    e.onFix(fixAt(15, Date.now() - 1000));
    expect(e.getSnapshot().lastSavedAt).not.toBeNull();
  });
});

describe("shared device: another account's downloaded data is refused and purged", () => {
  async function seedOwnersData() {
    await putStoredBundle(storedBundle());
    await saveHikeState({ ...initialHikeState(TRIP_ID), ownerHint: OWNER, status: "active", startedAt: Date.now() - 60_000, lastFix: fixAt(100, Date.now() - 5000) });
    await enqueuePoint(TRIP_ID, { lat: 1, lng: 2, accuracyM: 5, altitudeM: null, recordedAt: new Date().toISOString() });
    expect(fakeStore("outbox").size).toBe(1);
  }

  it("signed out (no owner cookie): nothing is shown and the trip data is removed", async () => {
    await seedOwnersData();
    doc.cookie = "";
    const e = await boot();
    const s = e.getSnapshot();
    expect(s.phase).toBe("no_bundle");
    expect(s.errorKind).toBe("signed_out");
    expect(s.error).toMatch(/Sign in again to use this trip offline/);
    expect(s.lastFix).toBeNull();
    expect(fakeStore("bundles").size).toBe(0);
    expect(fakeStore("hikeState").size).toBe(0);
    expect(fakeStore("outbox").size).toBe(0);
    expect(ls.getItem(mirrorKey(TRIP_ID))).toBeNull();
  });

  it("a different account signed in: refused and purged too", async () => {
    await seedOwnersData();
    doc.cookie = "other=1; gg_owner=someone-else-bbbbbbbbbb";
    const e = await boot();
    expect(e.getSnapshot()).toMatchObject({ phase: "no_bundle", errorKind: "signed_out", bundle: null });
    expect(fakeStore("bundles").size).toBe(0);
    expect(fakeStore("outbox").size).toBe(0);
  });

  it("the owner (cookie matches) resumes normally", async () => {
    await seedOwnersData();
    const e = await boot();
    expect(e.getSnapshot()).toMatchObject({ phase: "active", errorKind: null });
    expect(e.getSnapshot().lastFix).not.toBeNull();
  });
});

describe("the hike screen says why it can't open", () => {
  const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }));

  it("409 (not booked) while online: the server's reason, not 'offline'", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", respond(409, { error: "Only booked, active or completed trips can be downloaded." }));
    const s = (await boot()).getSnapshot();
    expect(s).toMatchObject({ phase: "no_bundle", errorKind: "not_bookable" });
    expect(s.error).toMatch(/booked/);
    expect(s.error).not.toMatch(/offline/i);
  });

  it("401 and 5xx are reported as such", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", respond(401, { error: "Sign in required" }));
    expect((await boot()).getSnapshot()).toMatchObject({ errorKind: "auth", error: expect.stringMatching(/session expired/i) });
    vi.stubGlobal("fetch", respond(502, { error: "bad gateway" }));
    expect((await boot()).getSnapshot()).toMatchObject({ errorKind: "server", error: expect.stringMatching(/error 502/) });
  });

  it("offline only when the request really could not reach the network", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", respond(503, { error: "offline" }, { "x-gg-offline": "1" })); // the service worker's own answer
    expect((await boot()).getSnapshot()).toMatchObject({ errorKind: "offline", error: expect.stringMatching(/appear to be offline/) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect((await boot()).getSnapshot()).toMatchObject({ errorKind: "offline" });
  });

  it("a 409 is shown even when an older offline copy exists (e.g. the trip was cancelled)", async () => {
    await putStoredBundle(storedBundle());
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", respond(409, { error: "Only booked, active or completed trips can be downloaded." }));
    expect((await boot()).getSnapshot()).toMatchObject({ phase: "no_bundle", errorKind: "not_bookable" });
  });
});

describe("start only on the booked date", () => {
  const plusDays = (n: number) => {
    const d = new Date(`${localDateInZone(new Date(), TZ)}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  it("before the booked date Start does nothing; demo mode offers an explicit start-anyway", async () => {
    await putStoredBundle(storedBundle(makeBundle({ bookedDate: plusDays(10) })));
    const e = await boot(true);
    expect(e.getSnapshot().startWindow).toMatchObject({ status: "early", bookedDate: plusDays(10) });
    e.acknowledgeLimitations(true);
    e.start();
    expect(e.getSnapshot().phase).toBe("ready");
    e.start({ demoStartAnyway: true });
    expect(e.getSnapshot().phase).toBe("active");
    await new Promise((r) => setTimeout(r, 0));
    const saved = fakeStore("hikeState").get(TRIP_ID) as { demoStartAnyway?: boolean };
    expect(saved.demoStartAnyway).toBe(true);
  });

  it("outside demo mode there is no start-anyway", async () => {
    await putStoredBundle(storedBundle(makeBundle({ bookedDate: plusDays(-2) })));
    const e = await boot(false);
    expect(e.getSnapshot().startWindow?.status).toBe("late");
    e.acknowledgeLimitations(true);
    e.start({ demoStartAnyway: true });
    expect(e.getSnapshot().phase).toBe("ready");
  });

  it("on the booked date the hike starts normally", async () => {
    const e = await startedHike();
    expect(e.getSnapshot().startWindow?.status).toBe("today");
  });
});

describe("demo GPS simulator", () => {
  it("stands still while the hike is paused (no jump in progress after Resume)", async () => {
    const e = await startedHike();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    e.setSimulator({ enabled: true, config: { speedUp: 10 } });
    vi.advanceTimersByTime(3000);
    expect(e.getSnapshot().progress.alongM).toBeGreaterThan(0);
    e.pause();
    const atPause = e.getSnapshot().progress.alongM;
    vi.advanceTimersByTime(6000); // 6 s paused ≈ 78 m of simulated walking if it kept going
    expect(e.getSnapshot().lastFix).not.toBeNull(); // the position keeps being reported (stationary)
    e.resume();
    vi.advanceTimersByTime(1000);
    // one second at 10× ≈ 13 m: the walk continues from where it paused
    expect(e.getSnapshot().progress.alongM - atPause).toBeLessThan(40);
  });
});
