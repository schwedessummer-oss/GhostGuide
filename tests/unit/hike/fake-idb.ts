/**
 * In-memory stand-in for src/lib/offline/idb.ts (unit tests run in node,
 * without IndexedDB). Writes land one microtask after the call, like a real
 * transaction; `freezeWrites()` drops every write not yet landed and all
 * later ones — what happens to an IndexedDB transaction started while the
 * page unloads (reload, a full-page navigation).
 */
type StoreName = "bundles" | "hikeState" | "outbox";

const stores: Record<StoreName, Map<string, unknown>> = { bundles: new Map(), hikeState: new Map(), outbox: new Map() };
const keyOf = (store: StoreName, v: unknown) => String((v as Record<string, unknown>)[store === "outbox" ? "id" : "tripId"]);
let frozen = false;

export function resetFakeIdb() {
  for (const s of Object.values(stores)) s.clear();
  frozen = false;
}
export const freezeWrites = () => {
  frozen = true;
};
export const thawWrites = () => {
  frozen = false;
};
export const fakeStore = (s: StoreName) => stores[s];

async function write(fn: () => void) {
  if (frozen) return;
  await Promise.resolve();
  if (frozen) return;
  fn();
}

export const DB_NAME = "ghostguide";
export const DB_VERSION = 1;
export const idbAvailable = () => true;
export const openDb = async () => ({}) as IDBDatabase;
export const idbGet = async <T>(store: StoreName, key: IDBValidKey) => structuredClone(stores[store].get(String(key))) as T | undefined;
export const idbPut = async <T>(store: StoreName, value: T) => write(() => stores[store].set(keyOf(store, value), structuredClone(value)));
export const idbPutMany = async <T>(store: StoreName, values: T[]) => write(() => values.forEach((v) => stores[store].set(keyOf(store, v), structuredClone(v))));
export const idbDelete = async (store: StoreName, key: IDBValidKey) => write(() => void stores[store].delete(String(key)));
export const idbDeleteMany = async (store: StoreName, keys: IDBValidKey[]) => write(() => keys.forEach((k) => stores[store].delete(String(k))));
export const idbGetAll = async <T>(store: StoreName) => [...stores[store].values()].map((v) => structuredClone(v)) as T[];
const outboxOf = (tripId: string) =>
  [...stores.outbox.values()]
    .map((v) => v as { tripId: string; seq: number })
    .filter((v) => v.tripId === tripId)
    .sort((a, b) => a.seq - b.seq);
export const idbOutboxForTrip = async <T>(tripId: string, limit?: number) => structuredClone(outboxOf(tripId).slice(0, limit)) as T[];
export const idbOutboxCount = async (tripId: string) => outboxOf(tripId).length;
export const idbOutboxDeleteForTrip = async (tripId: string) =>
  write(() => {
    for (const [k, v] of stores.outbox) if ((v as { tripId: string }).tripId === tripId) stores.outbox.delete(k);
  });
export const idbClear = async (store: StoreName) => write(() => stores[store].clear());

/** A minimal synchronous Storage (localStorage) for node. */
export class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
