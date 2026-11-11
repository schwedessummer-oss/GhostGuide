/**
 * Site-wide sending of queued hike updates, and what is still unsent.
 *
 * The hike screen sends its own queue while it is open. A hiker who finished
 * (or tapped "I'm okay" / "Extend my trip") offline and then closed that
 * screen must not depend on reopening it, so:
 *  - every Ghost Guide page load while online calls `flushPendingHikeUpdates()`
 *    (src/components/site/service-worker-registrar.tsx), and so does coming
 *    back online while any page is open;
 *  - browsers with Background Sync may also send from the service worker
 *    with no page open (best effort, public/sw.js);
 *  - sign-out first checks `pendingHikeUpdates()` and tries to send them
 *    (src/components/hike/sign-out-guard.tsx), because signing out deletes
 *    everything stored on the device.
 *
 * Only the signed-in account's queued data is ever sent (owner hint check,
 * src/lib/offline/owner.ts); the server re-checks ownership of every session.
 */
import { getStoredBundle, putStoredBundle } from "./bundle-store";
import { applySyncResponse, listHikeStates, loadHikeState, recordDropped, saveHikeState, type PersistedHikeState } from "./hike-state";
import { idbAvailable, idbOutboxForTrip } from "./idb";
import { OutboxSyncer, type EventBody, type FlushOutcome, type OutboxRecord } from "./outbox";
import { currentOwnerHint } from "./owner";

export interface PendingTrip {
  tripId: string;
  /** queued items + an unsent finish */
  updates: number;
  points: number;
  okTaps: number;
  extensions: number;
  finish: boolean;
}

export interface PendingSummary {
  /** total unsent hike updates (location points, events, an unsent finish) */
  total: number;
  /** of which safety-relevant */
  okTaps: number;
  extensions: number;
  finishes: number;
  points: number;
  trips: PendingTrip[];
}

const EMPTY: PendingSummary = { total: 0, okTaps: 0, extensions: 0, finishes: 0, points: 0, trips: [] };

function isOwners(s: PersistedHikeState, owner: string | null): boolean {
  return !!owner && s.ownerHint === owner;
}

async function pendingForState(s: PersistedHikeState): Promise<PendingTrip | null> {
  const entries = await idbOutboxForTrip<OutboxRecord>(s.tripId).catch(() => [] as OutboxRecord[]);
  const kinds = entries.filter((e) => e.kind === "event").map((e) => (e.payload as EventBody).kind);
  const finishQueued = kinds.includes("finish");
  const finish = finishQueued || (s.finishPending && s.status === "finished");
  const updates = entries.length + (finish && !finishQueued ? 1 : 0);
  if (!updates) return null;
  return {
    tripId: s.tripId,
    updates,
    points: entries.filter((e) => e.kind === "point").length,
    okTaps: kinds.filter((k) => k === "checkin_ok").length,
    extensions: kinds.filter((k) => k === "checkin_extend").length,
    finish,
  };
}

/** Unsent hike updates on this device that belong to the signed-in account. */
export async function pendingHikeUpdates(): Promise<PendingSummary> {
  if (!idbAvailable()) return EMPTY;
  const owner = currentOwnerHint();
  if (!owner) return EMPTY;
  const states = (await listHikeStates().catch(() => [] as PersistedHikeState[])).filter((s) => isOwners(s, owner));
  const trips = (await Promise.all(states.map(pendingForState))).filter((t): t is PendingTrip => !!t);
  return {
    total: trips.reduce((n, t) => n + t.updates, 0),
    okTaps: trips.reduce((n, t) => n + t.okTaps, 0),
    extensions: trips.reduce((n, t) => n + t.extensions, 0),
    finishes: trips.filter((t) => t.finish).length,
    points: trips.reduce((n, t) => n + t.points, 0),
    trips,
  };
}

/** True when the queued data includes a safety-relevant update (finish, "I'm okay", extend). */
export const hasSafetyUpdates = (p: PendingSummary) => p.finishes + p.okTaps + p.extensions > 0;

/** Re-read the newest saved state and patch it (never resurrect another account's state). */
async function patchState(tripId: string, owner: string, fn: (s: PersistedHikeState) => PersistedHikeState): Promise<void> {
  const latest = await loadHikeState(tripId).catch(() => null);
  if (!latest || latest.ownerHint !== owner) return;
  await saveHikeState(fn(latest)).catch(() => undefined);
}

async function flushTrip(state: PersistedHikeState, owner: string): Promise<FlushOutcome> {
  let cur = state;
  const patch = (fn: (s: PersistedHikeState) => PersistedHikeState) => {
    cur = fn(cur);
    return patchState(state.tripId, owner, fn);
  };
  const pending: Promise<void>[] = [];
  const syncer = new OutboxSyncer(
    state.tripId,
    {
      session: () => ({
        localSessionId: cur.localSessionId,
        serverSessionId: cur.serverSessionId,
        startSynced: cur.startSynced,
        startedAt: cur.startedAt,
        finishPending: cur.finishPending,
        finishedAt: cur.finishedAt,
        progressM: cur.progress.alongM,
        demoStartAnyway: !!cur.demoStartAnyway,
      }),
      onStartConfirmed: (session) => void pending.push(patch((s) => ({ ...s, serverSessionId: session.id, startSynced: true, startError: null }))),
      onStartRejected: (message) => void pending.push(patch((s) => ({ ...s, startError: message }))),
      onFinishConfirmed: () => {
        pending.push(patch((s) => ({ ...s, finishPending: false, finishSynced: true })));
        pending.push(
          getStoredBundle(state.tripId)
            .then((b) => (b ? putStoredBundle({ ...b, bundle: { ...b.bundle, trip: { ...b.bundle.trip, status: "completed" } } }) : undefined))
            .catch(() => undefined),
        );
      },
      onSynced: (at) => void pending.push(patch((s) => ({ ...s, lastSyncAt: at }))),
      onSyncResponse: (res) => void pending.push(patch((s) => applySyncResponse(s, res))),
      onDropped: (info) => void pending.push(patch((s) => recordDropped(s, info))),
    },
    state.lastSyncAt,
  );
  const outcome = await syncer.flushOnce();
  await Promise.all(pending);
  return outcome;
}

let running: Promise<PendingSummary> | null = null;

async function flushAll(opts: { skipTripIds?: string[] }): Promise<PendingSummary> {
  if (!idbAvailable()) return EMPTY;
  const owner = currentOwnerHint();
  if (!owner) return EMPTY;
  if (typeof navigator !== "undefined" && !navigator.onLine) return pendingHikeUpdates();
  const skip = new Set(opts.skipTripIds ?? []);
  const states = (await listHikeStates().catch(() => [] as PersistedHikeState[])).filter(
    (s) => isOwners(s, owner) && !skip.has(s.tripId) && s.status !== "not_started",
  );
  for (const s of states) {
    const work = await pendingForState(s);
    if (!work && (s.startSynced || !s.localSessionId)) continue;
    await flushTrip(s, owner).catch(() => undefined);
  }
  return pendingHikeUpdates();
}

/**
 * Send every queued hike update of the signed-in account now (if online).
 * `skipTripIds`: trips whose hike screen is open in this tab (it sends its own).
 * Resolves with what is still unsent afterwards. Concurrent calls share one run.
 */
export function flushPendingHikeUpdates(opts: { skipTripIds?: string[] } = {}): Promise<PendingSummary> {
  if (running) return running;
  const job = flushAll(opts).catch(() => pendingHikeUpdates().catch(() => EMPTY));
  running = job;
  void job.finally(() => {
    if (running === job) running = null;
  });
  return job;
}

/** Plain-language list of what is waiting, e.g. "Finish, 2 × I'm okay". */
export function describePending(p: PendingSummary): string {
  const parts: string[] = [];
  if (p.finishes) parts.push(p.finishes === 1 ? "Finish" : `${p.finishes} × Finish`);
  if (p.okTaps) parts.push(p.okTaps === 1 ? "I'm okay" : `${p.okTaps} × I'm okay`);
  if (p.extensions) parts.push(p.extensions === 1 ? "Extend my trip" : `${p.extensions} × Extend my trip`);
  if (p.points) parts.push(`${p.points} location ${p.points === 1 ? "point" : "points"}`);
  const other = p.total - p.points - p.okTaps - p.extensions - p.finishes;
  if (other > 0) parts.push(`${other} other ${other === 1 ? "update" : "updates"}`);
  return parts.join(", ");
}
