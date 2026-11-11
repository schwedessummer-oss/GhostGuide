/**
 * Minimal promise wrapper around IndexedDB (no dependencies).
 *
 * Database `ghostguide`:
 *   bundles    keyPath tripId — downloaded trip bundles + verification record
 *   hikeState  keyPath tripId — active-hike state (resume after reload/crash)
 *   outbox     keyPath id, index byTripSeq [tripId, seq] — queued points/events
 */
export const DB_NAME = "ghostguide";
export const DB_VERSION = 1;
export type StoreName = "bundles" | "hikeState" | "outbox";

let dbPromise: Promise<IDBDatabase> | null = null;

export function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

export function openDb(): Promise<IDBDatabase> {
  if (!idbAvailable()) return Promise.reject(new Error("This browser cannot store data offline (IndexedDB unavailable)."));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("bundles")) db.createObjectStore("bundles", { keyPath: "tripId" });
      if (!db.objectStoreNames.contains("hikeState")) db.createObjectStore("hikeState", { keyPath: "tripId" });
      if (!db.objectStoreNames.contains("outbox")) {
        const s = db.createObjectStore("outbox", { keyPath: "id" });
        s.createIndex("byTripSeq", ["tripId", "seq"]);
      }
    };
    open.onsuccess = () => {
      const db = open.result;
      // Another tab upgraded the schema: close so it can proceed; reopen lazily.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    open.onerror = () => {
      dbPromise = null;
      reject(open.error ?? new Error("Could not open offline storage"));
    };
    open.onblocked = () => {
      /* wait for other tabs to close */
    };
  });
  return dbPromise;
}

export async function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return req(db.transaction(store, "readonly").objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function idbPut<T>(store: StoreName, value: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value);
  await done(tx);
}

export async function idbPutMany<T>(store: StoreName, values: T[]): Promise<void> {
  if (!values.length) return;
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  const s = tx.objectStore(store);
  for (const v of values) s.put(v);
  await done(tx);
}

export async function idbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await done(tx);
}

export async function idbDeleteMany(store: StoreName, keys: IDBValidKey[]): Promise<void> {
  if (!keys.length) return;
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  const s = tx.objectStore(store);
  for (const k of keys) s.delete(k);
  await done(tx);
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return req(db.transaction(store, "readonly").objectStore(store).getAll()) as Promise<T[]>;
}

/** Outbox entries for one trip, in recording order. */
export async function idbOutboxForTrip<T>(tripId: string, limit?: number): Promise<T[]> {
  const db = await openDb();
  const range = IDBKeyRange.bound([tripId, -Infinity], [tripId, Infinity]);
  return req(db.transaction("outbox", "readonly").objectStore("outbox").index("byTripSeq").getAll(range, limit)) as Promise<T[]>;
}

export async function idbOutboxCount(tripId: string): Promise<number> {
  const db = await openDb();
  const range = IDBKeyRange.bound([tripId, -Infinity], [tripId, Infinity]);
  return req(db.transaction("outbox", "readonly").objectStore("outbox").index("byTripSeq").count(range));
}

/** Delete every queued outbox entry of one trip. */
export async function idbOutboxDeleteForTrip(tripId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("outbox", "readwrite");
  const range = IDBKeyRange.bound([tripId, -Infinity], [tripId, Infinity]);
  const store = tx.objectStore("outbox");
  const keys = await req(store.index("byTripSeq").getAllKeys(range));
  for (const k of keys) store.delete(k);
  await done(tx);
}

/** Empty a whole store. */
export async function idbClear(store: StoreName): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).clear();
  await done(tx);
}
