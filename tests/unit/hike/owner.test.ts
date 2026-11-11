import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/offline/idb", async () => await import("./fake-idb"));

import { putStoredBundle, type StoredBundle } from "@/lib/offline/bundle-store";
import { initialHikeState, mirrorKey, saveHikeState } from "@/lib/offline/hike-state";
import { enqueuePoint } from "@/lib/offline/outbox";
import { enforceDeviceOwner, ownershipDecision, parseOwnerCookie } from "@/lib/offline/owner";
import { fakeStore, MemoryStorage, resetFakeIdb } from "./fake-idb";
import { makeBundle, storedBundle } from "./bundle-fixture";

const A = "owner-a-aaaaaaaaaaaa";
const B = "owner-b-bbbbbbbbbbbb";
const TRIP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TRIP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("owner cookie and decision rules", () => {
  it("reads gg_owner from a cookie string", () => {
    expect(parseOwnerCookie(`x=1; gg_owner=${A}; y=2`)).toBe(A);
    expect(parseOwnerCookie(`gg_owner=${encodeURIComponent(A)}`)).toBe(A);
    expect(parseOwnerCookie("gg_ownerx=abcdefghijkl")).toBeNull();
    expect(parseOwnerCookie("gg_owner=")).toBeNull();
    expect(parseOwnerCookie("gg_owner=<script>")).toBeNull();
    expect(parseOwnerCookie("")).toBeNull();
  });

  it("keeps only data tagged for the signed-in account (or re-tags what the server just confirmed)", () => {
    expect(ownershipDecision({ owner: A, hints: [A, A] })).toBe("keep");
    expect(ownershipDecision({ owner: A, hints: [B] })).toBe("purge");
    expect(ownershipDecision({ owner: A, hints: [undefined] })).toBe("purge"); // untagged (old) data
    expect(ownershipDecision({ owner: null, hints: [A] })).toBe("purge"); // signed out
    expect(ownershipDecision({ owner: A, hints: [undefined], confirmedHint: A })).toBe("retag");
    expect(ownershipDecision({ owner: A, hints: [B], confirmedHint: B })).toBe("purge"); // confirmation for someone else
  });
});

describe("enforceDeviceOwner", () => {
  let ls: MemoryStorage;
  const cookie = { value: "" };
  const deleted: string[] = [];
  beforeEach(async () => {
    resetFakeIdb();
    ls = new MemoryStorage();
    deleted.length = 0;
    vi.stubGlobal("localStorage", ls);
    vi.stubGlobal("document", {
      get cookie() {
        return cookie.value;
      },
    });
    vi.stubGlobal("caches", {
      delete: vi.fn(async (n: string) => (deleted.push(n), true)),
      keys: vi.fn(async () => [`gg-trip-v1-${TRIP_A}`, "gg-static-x"]),
    });
    const mk = (tripId: string, owner: string) => {
      const b = makeBundle({ ownerHint: owner });
      return storedBundle({ ...b, trip: { ...b.trip, id: tripId } });
    };
    await putStoredBundle(mk(TRIP_A, A));
    await putStoredBundle(mk(TRIP_B, B));
    await saveHikeState({ ...initialHikeState(TRIP_A), ownerHint: A });
    await saveHikeState({ ...initialHikeState(TRIP_B), ownerHint: B });
    await enqueuePoint(TRIP_A, { lat: 1, lng: 1, accuracyM: 5, altitudeM: null, recordedAt: new Date().toISOString() });
    await enqueuePoint(TRIP_B, { lat: 2, lng: 2, accuracyM: 5, altitudeM: null, recordedAt: new Date().toISOString() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("purges another account's trips and keeps the signed-in account's", async () => {
    cookie.value = `gg_owner=${A}`;
    const r = await enforceDeviceOwner();
    expect(r).toEqual({ owner: A, purged: [TRIP_B] });
    expect([...fakeStore("bundles").keys()]).toEqual([TRIP_A]);
    expect([...fakeStore("hikeState").keys()]).toEqual([TRIP_A]);
    expect([...fakeStore("outbox").values()].map((v) => (v as { tripId: string }).tripId)).toEqual([TRIP_A]);
    expect(ls.getItem(mirrorKey(TRIP_B))).toBeNull();
    expect(ls.getItem(mirrorKey(TRIP_A))).not.toBeNull();
    expect(deleted).toEqual([`gg-trip-v1-${TRIP_B}`]);
  });

  it("signed out: everything goes (bundles, states, mirrors, outbox, trip caches)", async () => {
    cookie.value = "";
    const r = await enforceDeviceOwner();
    expect(r.owner).toBeNull();
    expect(r.purged.sort()).toEqual([TRIP_A, TRIP_B].sort());
    expect(fakeStore("bundles").size + fakeStore("hikeState").size + fakeStore("outbox").size).toBe(0);
    expect(ls.length).toBe(0);
    expect(deleted).toContain(`gg-trip-v1-${TRIP_A}`);
    expect(deleted).not.toContain("gg-static-x");
  });

  it("re-tags a trip the server just confirmed for the signed-in account", async () => {
    cookie.value = `gg_owner=${A}`;
    await saveHikeState({ ...initialHikeState(TRIP_B), ownerHint: null });
    const b = fakeStore("bundles").get(TRIP_B) as StoredBundle;
    await putStoredBundle({ ...b, bundle: { ...b.bundle, ownerHint: "old-hint-cccccccccccc" } });
    const r = await enforceDeviceOwner({ confirmed: { tripId: TRIP_B, ownerHint: A } });
    expect(r.purged).toEqual([]);
    expect((fakeStore("bundles").get(TRIP_B) as { bundle: { ownerHint: string } }).bundle.ownerHint).toBe(A);
    expect((fakeStore("hikeState").get(TRIP_B) as { ownerHint: string }).ownerHint).toBe(A);
  });
});
