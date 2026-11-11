/**
 * IndexedDB-backed outbox for hike data recorded on the device, and the
 * syncer that flushes it to the server. Pure ordering / batching / backoff
 * rules live in src/domain/outbox.ts; this module adds storage and I/O.
 *
 * Order of operations per flush (each step only after the previous one
 * succeeded): register the session (/api/hike/start, idempotent) → upload
 * queued points/events in recording order (/api/hike/sync, ≤ 500 points and
 * ≤ 200 events per request) → if the hike was finished on the device, send
 * /api/hike/finish. The queue is kept on 401/5xx/network errors.
 *
 * Every request carries `sentAt` (this device's clock) so the server can
 * correct timestamps from a phone whose clock is wrong. Items the server
 * definitively refuses are removed (so the queue cannot jam) but REPORTED via
 * `SyncHost.onDropped` — never silently. One flush per trip at a time across
 * tabs (Web Locks, where supported). After queueing, a Background Sync is
 * requested where the browser supports it (best effort; see public/sw.js).
 */
import {
  INITIAL_SYNC_SCHEDULE,
  applyAck,
  isSafetyEventKind,
  classifySyncStatus,
  nextBatch,
  onReconnect,
  onSyncFailure,
  onSyncStart,
  onSyncSuccess,
  shouldAttemptSync,
  type OutboxEntry,
  type SyncSchedule,
} from "@/domain/outbox";
import { idbDeleteMany, idbOutboxCount, idbOutboxForTrip, idbPut } from "./idb";
import { uuid } from "./hash";
import type { FinishResponse, HikeEventData, HikeEventKind, SessionView, StartResponse, SyncEvent, SyncPoint, SyncResponse } from "./wire";

/** Background Sync tag handled by public/sw.js. */
export const OUTBOX_SYNC_TAG = "gg-outbox";

/**
 * Ask the browser to wake the service worker and send queued hike data when
 * connectivity returns, even if the page is closed. Best effort: only some
 * browsers (Chromium-based) support it, and they may delay or skip it.
 */
export async function requestBackgroundSync(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
    const reg = (await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
    ])) as (ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }) | null;
    if (!reg?.sync) return false;
    await reg.sync.register(OUTBOX_SYNC_TAG);
    return true;
  } catch {
    return false;
  }
}

export const LOCK_BUSY = Symbol("lock-busy");

/**
 * Run `fn` holding this trip's outbox lock (shared with other tabs and the
 * service worker), or return LOCK_BUSY when someone else is flushing it.
 * Browsers without Web Locks just run `fn` (the server is idempotent).
 */
export async function withTripLock<T>(tripId: string, fn: () => Promise<T>): Promise<T | typeof LOCK_BUSY> {
  const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (!locks || typeof locks.request !== "function") return fn();
  return locks.request(`gg-outbox-${tripId}`, { ifAvailable: true }, async (lock) => (lock ? fn() : LOCK_BUSY));
}

export type PointBody = Omit<SyncPoint, "id">;
export type EventBody = Omit<SyncEvent, "id">;

export interface OutboxRecord extends OutboxEntry<PointBody | EventBody> {
  tripId: string;
}

let lastSeq = 0;
/** Monotonic across the page's lifetime and across reloads (time-based). */
function nextSeq(): number {
  lastSeq = Math.max(lastSeq + 1, Date.now() * 1000);
  return lastSeq;
}

export async function enqueuePoint(tripId: string, body: PointBody): Promise<string> {
  const id = uuid();
  await idbPut<OutboxRecord>("outbox", { id, tripId, seq: nextSeq(), kind: "point", payload: body, createdAt: Date.now() });
  return id;
}

export async function enqueueEvent(tripId: string, kind: HikeEventKind, payload: HikeEventData = {}, occurredAt = new Date()): Promise<string> {
  const id = uuid();
  await idbPut<OutboxRecord>("outbox", {
    id,
    tripId,
    seq: nextSeq(),
    kind: "event",
    payload: { kind, occurredAt: occurredAt.toISOString(), payload },
    createdAt: Date.now(),
  });
  return id;
}

export const queuedCount = (tripId: string) => idbOutboxCount(tripId);

/** Ids of queued safety events ("I'm okay", extend, finish) for a trip: still on this device, not yet accepted. */
export async function queuedSafetyEventIds(tripId: string): Promise<Set<string>> {
  const entries = await idbOutboxForTrip<OutboxRecord>(tripId);
  return new Set(
    entries.filter((e) => e.kind === "event" && isSafetyEventKind((e.payload as EventBody).kind)).map((e) => e.id),
  );
}

/** What the syncer needs to know about (and report back to) the hike. */
export interface SyncHost {
  session(): {
    localSessionId: string | null;
    serverSessionId: string | null;
    startSynced: boolean;
    startedAt: number | null;
    finishPending: boolean;
    finishedAt: number | null;
    progressM: number;
    /** demo only: the hiker chose "Start anyway (demo)" off the booked date */
    demoStartAnyway?: boolean;
  };
  onStartConfirmed(session: SessionView): void;
  onStartRejected(message: string): void;
  onFinishConfirmed(res: FinishResponse): void;
  onSynced(at: number): void;
  /** every successful /api/hike/sync response (accepted ids, check-in results, clock skew) */
  onSyncResponse?(res: SyncResponse): void;
  /** items the server refused for good and that were removed from the queue (must be shown to the hiker) */
  onDropped?(info: { count: number; safety: number; reason: string; ids: string[] }): void;
}

export type SyncStatus = "idle" | "syncing" | "waiting" | "offline" | "auth_required" | "error";

export interface SyncSnapshot {
  online: boolean;
  status: SyncStatus;
  queued: number;
  lastSyncAt: number | null;
  nextAttemptAt: number | null;
  message: string | null;
  /** items refused by the server and removed from the queue since this page opened */
  dropped: number;
}

export type FlushOutcome = "ok" | "busy" | { kind: SyncStatus; message: string };

type Listener = (s: SyncSnapshot) => void;

const MAX_BATCHES_PER_FLUSH = 10;

export class OutboxSyncer {
  private schedule: SyncSchedule = INITIAL_SYNC_SCHEDULE;
  private snapshot: SyncSnapshot;
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private readonly onOnline = () => {
    this.schedule = onReconnect(this.schedule, Date.now());
    this.update({ online: true });
    void this.maybeFlush();
  };
  private readonly onOffline = () => this.update({ online: false, status: "offline" });

  constructor(
    private readonly tripId: string,
    private readonly host: SyncHost,
    lastSyncAt: number | null,
  ) {
    this.snapshot = {
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      status: "idle",
      queued: 0,
      lastSyncAt,
      nextAttemptAt: null,
      message: null,
      dropped: 0,
    };
  }

  getSnapshot = (): SyncSnapshot => this.snapshot;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<SyncSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch, nextAttemptAt: this.schedule.nextAttemptAt };
    for (const l of this.listeners) l(this.snapshot);
  }

  start() {
    if (this.timer) return;
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    this.timer = setInterval(() => void this.maybeFlush(), 5_000);
    void this.refreshCount().then(() => this.maybeFlush());
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
  }

  async refreshCount() {
    try {
      this.update({ queued: await queuedCount(this.tripId) });
    } catch {
      /* storage unavailable: count stays as is */
    }
  }

  /** Call after enqueueing: updates the count and flushes when due. */
  async notifyEnqueued() {
    await this.refreshCount();
    if (!this.snapshot.online) void requestBackgroundSync();
    await this.maybeFlush();
  }

  private hasWork(): boolean {
    const s = this.host.session();
    if (!s.localSessionId && !s.serverSessionId) return false;
    return this.snapshot.queued > 0 || !s.startSynced || (s.finishPending && !!s.serverSessionId);
  }

  /** Flush now if online, not in backoff and there is work. `force` ignores the backoff (manual "Sync now"). */
  async maybeFlush(force = false): Promise<void> {
    const online = typeof navigator === "undefined" ? true : navigator.onLine;
    if (online !== this.snapshot.online) this.update({ online, status: online ? this.snapshot.status : "offline" });
    if (force) this.schedule = onReconnect(this.schedule, Date.now());
    if (this.flushing || !shouldAttemptSync(this.schedule, { online, hasWork: this.hasWork(), now: Date.now() })) return;
    this.flushing = true;
    this.schedule = onSyncStart(this.schedule);
    this.update({ status: "syncing", message: null });
    try {
      const outcome = await this.flushLocked();
      if (outcome === "busy") {
        // Another tab (or the service worker) is sending this trip's data right now: check again shortly.
        this.schedule = { ...this.schedule, inFlight: false, nextAttemptAt: Date.now() + 3_000 };
        this.update({ status: "idle" });
      } else if (outcome === "ok") {
        this.schedule = onSyncSuccess(this.schedule, Date.now());
        this.host.onSynced(Date.now());
        this.update({ status: "idle", lastSyncAt: Date.now(), message: null });
      } else {
        this.schedule = onSyncFailure(this.schedule, Date.now(), outcome.message);
        this.update({ status: outcome.kind, message: outcome.message });
        if (outcome.kind === "offline") void requestBackgroundSync();
      }
    } finally {
      this.flushing = false;
      this.schedule = { ...this.schedule, inFlight: false };
      await this.refreshCount();
    }
  }

  /** One flush now (ignores backoff, no timers): for the site-wide flusher and sign-out. */
  async flushOnce(): Promise<FlushOutcome> {
    if (this.flushing) return "busy";
    this.flushing = true;
    try {
      const outcome = await this.flushLocked();
      if (outcome === "ok") this.host.onSynced(Date.now());
      return outcome;
    } finally {
      this.flushing = false;
    }
  }

  private async flushLocked(): Promise<FlushOutcome> {
    const r = await withTripLock(this.tripId, () => this.flush());
    return r === LOCK_BUSY ? "busy" : r;
  }

  private dropped(entries: OutboxRecord[], reason: string) {
    if (!entries.length) return;
    const safety = entries.filter((e) => e.kind === "event" && isSafetyEventKind((e.payload as EventBody).kind)).length;
    this.update({ dropped: this.snapshot.dropped + entries.length });
    this.host.onDropped?.({ count: entries.length, safety, reason, ids: entries.map((e) => e.id) });
  }

  private async post<T>(url: string, body: unknown): Promise<{ status: number | "network_error"; data: T | null; error: string | null }> {
    try {
      const res = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
      return { status: res.status, data: res.ok ? json : null, error: res.ok ? null : (json?.error ?? `HTTP ${res.status}`) };
    } catch {
      return { status: "network_error", data: null, error: "No connection" };
    }
  }

  private failure(status: number | "network_error", error: string | null): { kind: SyncStatus; message: string } {
    const c = classifySyncStatus(status);
    if (c === "auth_required") return { kind: "auth_required", message: "Sign in again to sync. Your hike data is kept on this device." };
    if (status === "network_error") return { kind: "offline", message: "No connection — will retry automatically." };
    return { kind: "waiting", message: `Sync failed (${error ?? status}) — will retry.` };
  }

  private async flush(): Promise<"ok" | { kind: SyncStatus; message: string }> {
    let s = this.host.session();
    if (!s.startSynced) {
      const r = await this.post<StartResponse>("/api/hike/start", {
        tripId: this.tripId,
        clientSessionId: s.localSessionId ?? undefined,
        startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : undefined,
        demoStartAnyway: s.demoStartAnyway || undefined,
        sentAt: new Date().toISOString(),
      });
      if (r.data) this.host.onStartConfirmed(r.data.session);
      else if (classifySyncStatus(r.status) === "rejected") {
        this.host.onStartRejected(r.error ?? "The server could not register this hike.");
        return { kind: "error", message: r.error ?? "The server could not register this hike." };
      } else return this.failure(r.status, r.error);
      s = this.host.session();
    }
    const sessionId = s.serverSessionId;
    if (!sessionId) return { kind: "error", message: "Hike not registered with the server yet." };

    for (let i = 0; i < MAX_BATCHES_PER_FLUSH; i++) {
      const entries = await idbOutboxForTrip<OutboxRecord>(this.tripId, 800);
      const batch = nextBatch(entries);
      if (!batch.ids.length) break;
      const body = {
        sessionId,
        points: batch.points.map((p) => ({ id: p.id, ...(p.payload as PointBody) })),
        events: batch.events.map((e) => ({ id: e.id, ...(e.payload as EventBody) })),
        progressM: Math.round(s.progressM),
        // this device's clock right now: lets the server correct timestamps from a wrong clock
        sentAt: new Date().toISOString(),
      };
      const r = await this.post<SyncResponse>("/api/hike/sync", body);
      if (r.data) {
        const rejectedIds = new Set(r.data.rejected.map((x) => x.id));
        const acked = [...r.data.acceptedPointIds, ...r.data.acceptedEventIds, ...rejectedIds];
        await idbDeleteMany("outbox", acked);
        this.host.onSyncResponse?.(r.data);
        if (rejectedIds.size) {
          const why = r.data.rejected.some((x) => x.reason === "future_timestamp")
            ? "their time stamps were in the future (check this phone's date and time)"
            : "the server could not use them";
          this.dropped(entries.filter((e) => rejectedIds.has(e.id)), why);
        }
        // Anything the server neither accepted nor rejected stays queued (defensive).
        if (applyAck(batch.ids.map((id) => ({ id })), acked).length) break;
        continue;
      }
      if (classifySyncStatus(r.status) === "rejected") {
        // A definitive client error (e.g. malformed data): drop this batch so the queue cannot jam — and say so.
        await idbDeleteMany("outbox", batch.ids);
        const ids = new Set(batch.ids);
        this.dropped(entries.filter((e) => ids.has(e.id)), r.error ?? `error ${String(r.status)}`);
        continue;
      }
      return this.failure(r.status, r.error);
    }

    const remaining = await queuedCount(this.tripId);
    s = this.host.session();
    if (remaining === 0 && s.finishPending) {
      const r = await this.post<FinishResponse>("/api/hike/finish", {
        tripId: this.tripId,
        sessionId,
        finishedAt: s.finishedAt ? new Date(s.finishedAt).toISOString() : undefined,
        distanceCompletedM: Math.round(s.progressM),
        sentAt: new Date().toISOString(),
      });
      if (r.data) this.host.onFinishConfirmed(r.data);
      else return this.failure(r.status, r.error);
    }
    return "ok";
  }
}
