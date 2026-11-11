/**
 * Active-hike state persisted in IndexedDB so a hike survives reloads,
 * crashes and the browser discarding a background tab. Also read by the
 * help screen for the last known location.
 *
 * Every save also writes a synchronous localStorage mirror (`gg-hike-<tripId>`):
 * an IndexedDB transaction started while the page unloads (reload, the Help
 * link, an offline full-page navigation) is often never committed, while
 * localStorage.setItem completes before the page goes away. Loading takes
 * whichever copy is newer. Sign-out wipes both (gg* localStorage keys and the
 * "ghostguide" database).
 */
import { INITIAL_DEVIATION_STATE, type DeviationState } from "@/domain/deviation";
import { INITIAL_GEOFENCE_STATE, type GeofenceState } from "@/domain/geofence";
import { DEFAULT_SIMULATOR_CONFIG, type SimulatorConfig, type SimulatorState } from "@/domain/gps-simulator";
import { INITIAL_LOCATION_FILTER, type GeoFix, type LocationFilterState } from "@/domain/location-quality";
import { INITIAL_PROGRESS, type PauseInterval, type ProgressState } from "@/domain/progress";
import { INITIAL_REMINDER_STATE, defaultReminderSettings, type ReminderState } from "@/domain/reminders";
import type { Itinerary } from "@/domain/types";
import { idbDelete, idbGet, idbGetAll, idbPut } from "./idb";

export interface HikeSettings {
  /** narration trigger distance multiplier (0.5×–2×) */
  triggerMultiplier: number;
  /** fixed trigger distance in metres, overriding POI radii */
  triggerOverrideM: number | null;
  muted: boolean;
  vibrate: boolean;
  highContrast: boolean;
  hydrationEveryMin: number | null;
  paceCheckEveryMin: number | null;
}

export interface SimulatorPersisted {
  enabled: boolean;
  seed: number;
  config: SimulatorConfig;
  state: SimulatorState | null;
}

export interface OkTap {
  id: string;
  at: number;
}

export type HikeStatus = "not_started" | "active" | "paused" | "finished";

export interface PersistedHikeState {
  tripId: string;
  version: 1;
  /** owner tag of the account this hike belongs to (TripBundle.ownerHint); see src/lib/offline/owner.ts */
  ownerHint?: string | null;
  /** demo only: the hiker chose "Start anyway (demo)" on a day other than the booked date */
  demoStartAnyway?: boolean;
  /** client-generated session id proposed to the server (offline start) */
  localSessionId: string | null;
  /** the server's session id once /api/hike/start succeeded */
  serverSessionId: string | null;
  startSynced: boolean;
  startError: string | null;
  status: HikeStatus;
  startedAt: number | null;
  pauses: PauseInterval[];
  finishedAt: number | null;
  finishPending: boolean;
  finishSynced: boolean;
  filter: LocationFilterState;
  progress: ProgressState;
  geofence: GeofenceState;
  deviation: DeviationState;
  reminders: ReminderState;
  settings: HikeSettings;
  /** last accepted fix (any accuracy) — the "last known location" */
  lastFix: GeoFix | null;
  /** last location point queued for upload (sampling) */
  lastSample: { lat: number; lng: number; at: number } | null;
  lastSyncAt: number | null;
  limitationsAckAt: number | null;
  okTaps: OkTap[];
  simulator: SimulatorPersisted;
  updatedAt: number;
}

export function defaultSettings(itinerary?: Partial<Itinerary> | null): HikeSettings {
  const r = defaultReminderSettings(itinerary?.reminders ?? null);
  return {
    triggerMultiplier: 1,
    triggerOverrideM: null,
    muted: false,
    vibrate: true,
    highContrast: false,
    hydrationEveryMin: r.hydrationEveryMin,
    paceCheckEveryMin: r.paceCheckEveryMin,
  };
}

export function initialHikeState(tripId: string, itinerary?: Partial<Itinerary> | null, now = Date.now()): PersistedHikeState {
  return {
    tripId,
    version: 1,
    localSessionId: null,
    serverSessionId: null,
    startSynced: false,
    startError: null,
    status: "not_started",
    startedAt: null,
    pauses: [],
    finishedAt: null,
    finishPending: false,
    finishSynced: false,
    filter: INITIAL_LOCATION_FILTER,
    progress: INITIAL_PROGRESS,
    geofence: INITIAL_GEOFENCE_STATE,
    deviation: INITIAL_DEVIATION_STATE,
    reminders: INITIAL_REMINDER_STATE,
    settings: defaultSettings(itinerary),
    lastFix: null,
    lastSample: null,
    lastSyncAt: null,
    limitationsAckAt: null,
    okTaps: [],
    simulator: { enabled: false, seed: Math.floor(now % 2_147_483_647) || 1, config: DEFAULT_SIMULATOR_CONFIG, state: null },
    updatedAt: now,
  };
}

export const MIRROR_PREFIX = "gg-hike-";
export const mirrorKey = (tripId: string) => `${MIRROR_PREFIX}${tripId}`;

function valid(s: unknown, tripId?: string): s is PersistedHikeState {
  if (!s || typeof s !== "object") return false;
  const v = s as Partial<PersistedHikeState>;
  return v.version === 1 && typeof v.tripId === "string" && (tripId === undefined || v.tripId === tripId) && typeof v.updatedAt === "number";
}

/** The newer of two saved copies (IndexedDB wins a tie). */
export function newestHikeState(a: PersistedHikeState | null | undefined, b: PersistedHikeState | null | undefined): PersistedHikeState | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return b.updatedAt > a.updatedAt ? b : a;
}

/** Parse a localStorage mirror (null when missing, corrupt or for another trip). */
export function parseHikeStateMirror(raw: string | null | undefined, tripId?: string): PersistedHikeState | null {
  if (!raw) return null;
  try {
    const s: unknown = JSON.parse(raw);
    return valid(s, tripId) ? s : null;
  } catch {
    return null;
  }
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Synchronous copy for page unload. Returns false when localStorage is unavailable or full. */
export function writeHikeStateMirror(state: PersistedHikeState): boolean {
  const ls = storage();
  if (!ls) return false;
  try {
    ls.setItem(mirrorKey(state.tripId), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function readHikeStateMirror(tripId: string): PersistedHikeState | null {
  const ls = storage();
  if (!ls) return null;
  try {
    return parseHikeStateMirror(ls.getItem(mirrorKey(tripId)), tripId);
  } catch {
    return null;
  }
}

export function deleteHikeStateMirror(tripId: string): void {
  try {
    storage()?.removeItem(mirrorKey(tripId));
  } catch {
    /* ignore */
  }
}

/** Trip ids that have a mirror in localStorage. */
export function mirroredTripIds(): string[] {
  const ls = storage();
  if (!ls) return [];
  const out: string[] = [];
  try {
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k?.startsWith(MIRROR_PREFIX)) out.push(k.slice(MIRROR_PREFIX.length));
    }
  } catch {
    /* ignore */
  }
  return out;
}

export async function loadHikeState(tripId: string): Promise<PersistedHikeState | null> {
  const fromDb = await idbGet<PersistedHikeState>("hikeState", tripId).catch(() => undefined);
  return newestHikeState(valid(fromDb, tripId) ? fromDb : null, readHikeStateMirror(tripId));
}

/** Every saved hike state on this device (IndexedDB + mirrors, newest copy per trip). */
export async function listHikeStates(): Promise<PersistedHikeState[]> {
  const all = await idbGetAll<PersistedHikeState>("hikeState").catch(() => [] as PersistedHikeState[]);
  const byTrip = new Map<string, PersistedHikeState>();
  for (const s of all) if (valid(s)) byTrip.set(s.tripId, s);
  for (const id of mirroredTripIds()) {
    const m = readHikeStateMirror(id);
    const n = newestHikeState(byTrip.get(id), m);
    if (n) byTrip.set(id, n);
  }
  return [...byTrip.values()];
}

/**
 * Save: the synchronous mirror first (survives unload), then IndexedDB.
 * Returns the stored copy (with its `updatedAt`).
 */
export async function saveHikeState(state: PersistedHikeState, now = Date.now()): Promise<PersistedHikeState> {
  const r = beginSaveHikeState(state, now);
  await r.committed;
  return r.stored;
}

/** Like saveHikeState, but reports synchronously whether the unload-proof mirror was written. */
export function beginSaveHikeState(state: PersistedHikeState, now = Date.now()): { stored: PersistedHikeState; mirrored: boolean; committed: Promise<void> } {
  const stored = { ...state, updatedAt: Math.max(now, state.updatedAt + 1) };
  const mirrored = writeHikeStateMirror(stored);
  return { stored, mirrored, committed: idbPut("hikeState", stored) };
}

export async function deleteHikeState(tripId: string): Promise<void> {
  deleteHikeStateMirror(tripId);
  await idbDelete("hikeState", tripId);
}
