/**
 * Wire types shared by the hike API (server) and the offline client.
 * Type-only module: safe to import from client and server code. The server
 * validates every request with the zod schemas in src/server/hike/schemas.ts.
 */
import type { OfflineManifest } from "@/domain/offline-manifest";
import type { CheckinStatus, Itinerary, RouteType, TripStatus } from "@/domain/types";

export const BUNDLE_SCHEMA_VERSION = 2;

export interface BundlePoi {
  id: string;
  seq: number;
  name: string;
  kind: string;
  lat: number;
  lng: number;
  triggerRadiusM: number;
}

export interface BundleNarration {
  id: string;
  poiId: string | null;
  title: string;
  /** approved transcript — always shown (visible alternative to audio) */
  transcript: string;
  sourceCitation: string | null;
  /** signed audio URL when an approved recording exists */
  audioUrl: string | null;
  /** true → no recording; read the transcript with the device voice */
  tts: boolean;
  durationSec: number | null;
  version: number;
}

export interface TripBundle {
  schemaVersion: number;
  generatedAt: string;
  /**
   * Non-secret tag of the account this bundle was issued to (same value as the
   * readable `gg_owner` cookie, see src/server/auth/owner-hint.ts). Offline
   * screens refuse to show, and purge, on-device trip data whose tag does not
   * match the cookie, so the next person on a shared device cannot read it.
   */
  ownerHint: string;
  /** true when check-in notices are simulated (demo): screens must say no message is actually sent */
  notificationsSimulated: boolean;
  trip: {
    id: string;
    status: TripStatus;
    plannedDate: string | null;
    /** the date the hike is booked for (confirmed booking's hike date, else the planned date), region-local YYYY-MM-DD */
    bookedDate: string | null;
    startTime: string | null;
    partySize: number;
    itinerary: Partial<Itinerary>;
  };
  trail: {
    id: string;
    slug: string;
    name: string;
    summary: string;
    isDemo: boolean;
    distanceKm: number;
    elevationGainM: number;
    difficulty: string;
    routeType: RouteType;
    estimatedDurationMin: number;
    trailheadName: string | null;
    trailheadLat: number;
    trailheadLng: number;
    parkingInfo: string | null;
    permitRequired: boolean;
    provenance: { field: string; kind: string; note: string | null }[];
    provenanceSummary: string;
    closures: { severity: string; reason: string; endsAt: string | null }[];
  };
  /** the route GeoJSON LineString, pre-serialized so the checksum covers these exact bytes */
  geometryJson: string;
  /** sha256 hex of geometryJson */
  geometryChecksum: string;
  pois: BundlePoi[];
  narrations: BundleNarration[];
  region: { name: string; timezone: string; isDemo: boolean; emergencyNumber: string; emergencyGuidance: string };
  /** from the trip check-in, when the hiker set one up */
  expectedReturnAt: string | null;
  checkin: { status: CheckinStatus; expectedReturnAt: string; graceMinutes: number } | null;
  /** the open (or latest) hike session, so a reload on another device can resume */
  session: {
    id: string;
    status: "active" | "paused" | "finished" | "abandoned";
    startedAt: string;
    finishedAt: string | null;
    /** stops already narrated in this session (synced poi_triggered / poi_replayed events): never auto-play again */
    heardPoiIds: string[];
  } | null;
  settings: { staleLocationMinutes: number };
  manifest: OfflineManifest;
}

export const HIKE_EVENT_KINDS = [
  "start",
  "pause",
  "resume",
  "poi_triggered",
  "poi_replayed",
  "deviation_prompt",
  "deviation_cleared",
  "deviation_dismissed",
  "reminder",
  "checkin_ok",
  "simulator_on",
  "simulator_off",
  "finish",
] as const;
export type HikeEventKind = (typeof HIKE_EVENT_KINDS)[number];

/**
 * Event payloads deliberately carry NO coordinates: hike_events are visible
 * to operators, while precise location (location_points) is restricted to
 * the hiker and safety staff.
 */
export interface HikeEventData {
  poiId?: string;
  narrationId?: string;
  source?: "gps" | "manual";
  distanceM?: number;
  reason?: string;
  reminder?: "hydration" | "pace_check";
  progressM?: number;
  movingTimeSec?: number;
  simulated?: boolean;
}

export interface SyncPoint {
  id: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  altitudeM: number | null;
  recordedAt: string;
}

export interface SyncEvent {
  id: string;
  kind: HikeEventKind;
  occurredAt: string;
  payload: HikeEventData;
}

export interface SyncRequest {
  sessionId: string;
  points: SyncPoint[];
  events: SyncEvent[];
  /** client's route progress (m), for the session summary */
  progressM?: number;
}

export interface SyncRejection {
  id: string;
  kind: "point" | "event";
  reason: "future_timestamp";
}

export interface SyncResponse {
  serverTime: string;
  acceptedPointIds: string[];
  acceptedEventIds: string[];
  rejected: SyncRejection[];
  session: { id: string; status: string; lastSyncAt: string | null };
}

export interface StartRequest {
  tripId: string;
  clientSessionId?: string;
  startedAt?: string;
  /** APP_MODE=demo only: the hiker explicitly chose "Start anyway (demo)" on a day other than the booked date */
  demoStartAnyway?: boolean;
}

export interface SessionView {
  id: string;
  tripId: string;
  status: "active" | "paused" | "finished" | "abandoned";
  startedAt: string;
  finishedAt: string | null;
  lastSyncAt: string | null;
  distanceCompletedM: number;
}

export interface StartResponse {
  session: SessionView;
  created: boolean;
  tripStatus: TripStatus;
}

export interface FinishRequest {
  tripId: string;
  sessionId?: string;
  finishedAt?: string;
  distanceCompletedM?: number;
}

export interface FinishResponse {
  session: SessionView;
  alreadyFinished: boolean;
  tripStatus: TripStatus;
}

export interface DownloadRecordRequest {
  manifestVersion: number;
  manifestChecksum: string;
  itemCount: number;
  verifiedComplete: boolean;
}
