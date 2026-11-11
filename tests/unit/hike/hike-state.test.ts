import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/offline/idb", async () => await import("./fake-idb"));

import { initialHikeState, listHikeStates, loadHikeState, mirrorKey, newestHikeState, parseHikeStateMirror, saveHikeState } from "@/lib/offline/hike-state";
import { fakeStore, freezeWrites, MemoryStorage, resetFakeIdb } from "./fake-idb";

const TRIP = "11111111-1111-4111-8111-111111111111";
let ls: MemoryStorage;
beforeEach(() => {
  resetFakeIdb();
  ls = new MemoryStorage();
  vi.stubGlobal("localStorage", ls);
});
afterEach(() => vi.unstubAllGlobals());

describe("hike state persistence (IndexedDB + synchronous localStorage mirror)", () => {
  it("newest copy wins; IndexedDB wins a tie", () => {
    const a = { ...initialHikeState(TRIP), updatedAt: 100 };
    const b = { ...initialHikeState(TRIP), updatedAt: 200 };
    expect(newestHikeState(a, b)).toBe(b);
    expect(newestHikeState(b, a)).toBe(b);
    expect(newestHikeState(a, { ...a })).toBe(a);
    expect(newestHikeState(null, a)).toBe(a);
    expect(newestHikeState(undefined, null)).toBeNull();
  });

  it("parses only valid mirrors for the right trip", () => {
    const s = initialHikeState(TRIP);
    expect(parseHikeStateMirror(JSON.stringify(s), TRIP)).toEqual(s);
    expect(parseHikeStateMirror(JSON.stringify(s), "another-trip")).toBeNull();
    expect(parseHikeStateMirror("{not json", TRIP)).toBeNull();
    expect(parseHikeStateMirror(JSON.stringify({ ...s, version: 2 }), TRIP)).toBeNull();
    expect(parseHikeStateMirror(null, TRIP)).toBeNull();
  });

  it("save writes the mirror synchronously, before IndexedDB commits", async () => {
    const s = { ...initialHikeState(TRIP), status: "active" as const };
    const p = saveHikeState(s);
    expect(parseHikeStateMirror(ls.getItem(mirrorKey(TRIP)), TRIP)?.status).toBe("active"); // already there
    await p;
    expect((fakeStore("hikeState").get(TRIP) as { status: string }).status).toBe("active");
  });

  it("load returns the mirror when the last IndexedDB write was lost during unload", async () => {
    await saveHikeState({ ...initialHikeState(TRIP), status: "active" as const, updatedAt: 1 }, 1000);
    freezeWrites();
    void saveHikeState({ ...initialHikeState(TRIP), status: "paused" as const }, 2000);
    expect(((await loadHikeState(TRIP)) ?? { status: "?" }).status).toBe("paused");
    expect((await listHikeStates()).map((x) => x.status)).toEqual(["paused"]);
  });
});
