/**
 * Offline outbox: queueing, batching, ordering and retry policy for hike
 * location points and events recorded on the device (pure, no I/O).
 *
 * The device records with client-generated ids and `recordedAt` timestamps,
 * so the server can insert idempotently (ON CONFLICT DO NOTHING) no matter
 * how often a batch is retried. Items are flushed in the order they were
 * recorded; failed batches stay queued (401 / 5xx / network) and retry with
 * exponential backoff + jitter; reconnecting flushes immediately.
 */
import { haversineM } from "./geo";

export type OutboxKind = "point" | "event";

export interface OutboxEntry<P = unknown> {
  /** client-generated id (also the server's client_point_id / client_event_id) */
  id: string;
  /** monotonic sequence number assigned at enqueue time (preserves order) */
  seq: number;
  kind: OutboxKind;
  payload: P;
  createdAt: number;
}

export interface BatchLimits {
  maxPoints: number;
  maxEvents: number;
}

/** Server-side limits per sync request. */
export const SYNC_LIMITS: BatchLimits = { maxPoints: 500, maxEvents: 200 };

export function sortQueue<T extends Pick<OutboxEntry, "seq" | "id">>(entries: T[]): T[] {
  return [...entries].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The next batch to send: the longest PREFIX of the queue (in seq order)
 * that fits the limits. Stopping at the first item that does not fit keeps
 * the global order intact across kinds.
 */
export function nextBatch<P>(entries: OutboxEntry<P>[], limits: BatchLimits = SYNC_LIMITS): {
  points: OutboxEntry<P>[];
  events: OutboxEntry<P>[];
  ids: string[];
} {
  const points: OutboxEntry<P>[] = [];
  const events: OutboxEntry<P>[] = [];
  const ids: string[] = [];
  for (const e of sortQueue(entries)) {
    if (e.kind === "point") {
      if (points.length >= limits.maxPoints) break;
      points.push(e);
    } else {
      if (events.length >= limits.maxEvents) break;
      events.push(e);
    }
    ids.push(e.id);
  }
  return { points, events, ids };
}

/** Remove acknowledged (accepted or permanently rejected) entries. */
export function applyAck<T extends Pick<OutboxEntry, "id">>(entries: T[], ackedIds: Iterable<string>): T[] {
  const acked = new Set(ackedIds);
  return entries.filter((e) => !acked.has(e.id));
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  factor: number;
  /** ± fraction of randomness, e.g. 0.3 → 70%–130% */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 2_000, maxMs: 5 * 60_000, factor: 2, jitter: 0.3 };

/** Delay before retry number `attempt` (1-based), with jitter; never above maxMs. */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = Math.min(opts.maxMs, opts.baseMs * opts.factor ** (n - 1));
  const r = Math.min(1, Math.max(0, random()));
  const jittered = raw * (1 - opts.jitter + 2 * opts.jitter * r);
  return Math.round(Math.min(opts.maxMs, Math.max(0, jittered)));
}

export type SyncOutcome = "success" | "retry" | "auth_required" | "rejected";

/**
 * How to treat a sync response. Only definitive client errors drop the
 * batch; auth problems and server/network failures keep everything queued.
 */
export function classifySyncStatus(status: number | "network_error"): SyncOutcome {
  if (status === "network_error") return "retry";
  if (status >= 200 && status < 300) return "success";
  if (status === 401 || status === 403) return "auth_required";
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "retry";
  return "rejected";
}

export interface SyncSchedule {
  attempt: number;
  nextAttemptAt: number | null;
  inFlight: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
}

export const INITIAL_SYNC_SCHEDULE: SyncSchedule = { attempt: 0, nextAttemptAt: null, inFlight: false, lastSuccessAt: null, lastError: null };

export function shouldAttemptSync(s: SyncSchedule, ctx: { online: boolean; hasWork: boolean; now: number }): boolean {
  return ctx.online && ctx.hasWork && !s.inFlight && (s.nextAttemptAt === null || ctx.now >= s.nextAttemptAt);
}

export function onSyncStart(s: SyncSchedule): SyncSchedule {
  return { ...s, inFlight: true };
}

export function onSyncSuccess(s: SyncSchedule, now: number): SyncSchedule {
  return { attempt: 0, nextAttemptAt: null, inFlight: false, lastSuccessAt: now, lastError: null };
}

export function onSyncFailure(
  s: SyncSchedule,
  now: number,
  error: string,
  opts: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): SyncSchedule {
  const attempt = s.attempt + 1;
  return { ...s, attempt, inFlight: false, nextAttemptAt: now + backoffDelayMs(attempt, opts, random), lastError: error };
}

/** Connectivity came back: forget the backoff and flush right away. */
export function onReconnect(s: SyncSchedule, now: number): SyncSchedule {
  return { ...s, attempt: 0, nextAttemptAt: now };
}

export interface SamplingConfig {
  minIntervalMs: number;
  minDistanceM: number;
}

/** Record a location point every 30 s or 50 m, whichever comes first. */
export const DEFAULT_SAMPLING: SamplingConfig = { minIntervalMs: 30_000, minDistanceM: 50 };

export function shouldSamplePoint(
  last: { lat: number; lng: number; at: number } | null,
  fix: { lat: number; lng: number; timestamp: number },
  cfg: SamplingConfig = DEFAULT_SAMPLING,
): boolean {
  if (!last) return true;
  if (fix.timestamp - last.at >= cfg.minIntervalMs) return true;
  return haversineM(last, fix) >= cfg.minDistanceM;
}
