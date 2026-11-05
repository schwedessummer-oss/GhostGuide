/**
 * Active-hike state persisted in IndexedDB so a hike survives reloads,
 * crashes and the browser discarding a background tab. Also read by the
 * help screen for the last known location.
 */
import { INITIAL_DEVIATION_STATE, type DeviationState } from "@/domain/deviation";
import { INITIAL_GEOFENCE_STATE, type GeofenceState } from "@/domain/geofence";
import { DEFAULT_SIMULATOR_CONFIG, type SimulatorConfig, type SimulatorState } from "@/domain/gps-simulator";
import { INITIAL_LOCATION_FILTER, type GeoFix, type LocationFilterState } from "@/domain/location-quality";
import { INITIAL_PROGRESS, type PauseInterval, type ProgressState } from "@/domain/progress";
import { INITIAL_REMINDER_STATE, defaultReminderSettings, type ReminderState } from "@/domain/reminders";
import type { Itinerary } from "@/domain/types";
import { idbGet, idbPut } from "./idb";

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

export async function loadHikeState(tripId: string): Promise<PersistedHikeState | null> {
  const s = await idbGet<PersistedHikeState>("hikeState", tripId);
  if (!s || s.version !== 1) return null;
  return s;
}

export async function saveHikeState(state: PersistedHikeState): Promise<void> {
  await idbPut("hikeState", { ...state, updatedAt: Date.now() });
}
