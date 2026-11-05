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
 */
import {
  INITIAL_SYNC_SCHEDULE,
  applyAck,
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
  };
  onStartConfirmed(session: SessionView): void;
  onStartRejected(message: string): void;
  onFinishConfirmed(res: FinishResponse): void;
  onSynced(at: number): void;
}

export type SyncStatus = "idle" | "syncing" | "waiting" | "offline" | "auth_required" | "error";

export interface SyncSnapshot {
  online: boolean;
  status: SyncStatus;
  queued: number;
  lastSyncAt: number | null;
  nextAttemptAt: number | null;
  message: string | null;
  dropped: number;
}

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
      const outcome = await this.flush();
      if (outcome === "ok") {
        this.schedule = onSyncSuccess(this.schedule, Date.now());
        this.host.onSynced(Date.now());
        this.update({ status: "idle", lastSyncAt: Date.now(), message: null });
      } else {
        this.schedule = onSyncFailure(this.schedule, Date.now(), outcome.message);
        this.update({ status: outcome.kind, message: outcome.message });
      }
    } finally {
      this.flushing = false;
      this.schedule = { ...this.schedule, inFlight: false };
      await this.refreshCount();
    }
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
      };
      const r = await this.post<SyncResponse>("/api/hike/sync", body);
      if (r.data) {
        const acked = [...r.data.acceptedPointIds, ...r.data.acceptedEventIds, ...r.data.rejected.map((x) => x.id)];
        await idbDeleteMany("outbox", acked);
        if (r.data.rejected.length) this.update({ dropped: this.snapshot.dropped + r.data.rejected.length });
        // Anything the server neither accepted nor rejected stays queued (defensive).
        if (applyAck(batch.ids.map((id) => ({ id })), acked).length) break;
        continue;
      }
      if (classifySyncStatus(r.status) === "rejected") {
        // A definitive client error (e.g. malformed data): drop this batch so the queue cannot jam.
        await idbDeleteMany("outbox", batch.ids);
        this.update({ dropped: this.snapshot.dropped + batch.ids.length });
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
      });
      if (r.data) this.host.onFinishConfirmed(r.data);
      else return this.failure(r.status, r.error);
    }
    return "ok";
  }
}
