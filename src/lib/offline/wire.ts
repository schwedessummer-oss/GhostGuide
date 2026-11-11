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
    /**
     * Closures that have not ended and start before the end of the booked day
     * (active now or scheduled for the hike date). `startsAt` is absent in
     * bundles downloaded before it was added: treat those as active now.
     */
    closures: BundleClosure[];
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
  /**
   * Booked add-on details and permit status for offline use (help and
   * pre-start screens). Absent in bundles downloaded before it was added.
   */
  logistics?: BundleLogistics;
  manifest: OfflineManifest;
}

export interface BundleClosure {
  severity: "closed" | "partial" | "advisory" | string;
  reason: string;
  startsAt?: string;
  endsAt: string | null;
}

export interface BundleAddon {
  /** fulfillment id */
  id: string;
  kind: "gear_locker" | "shuttle" | "meal_pack" | "satellite_device" | "other";
  name: string;
  quantity: number;
  status: string;
  /** plain-language status, e.g. "Gear locker: confirmed — code ready" */
  statusText: string;
  simulated: boolean;
  /** gear locker / satellite device pickup */
  locker: {
    name: string | null;
    location: string | null;
    items: string[];
    /** owner-only locker access code (derived at download time; null when not yet revealable) */
    accessCode: string | null;
    /** last digits shown when the full code is not available yet */
    codeHint: string | null;
    codeExpiresAt: string | null;
    disclaimer: string | null;
  } | null;
  /** shuttle pickup (only a confirmed/requested ride is a booked ride) */
  shuttle: {
    pickup: string | null;
    dropoff: string | null;
    pickupAt: string | null;
    confirmed: boolean;
  } | null;
  /** meal pack pickup instruction */
  meal: { pickup: string | null } | null;
}

export interface BundlePermit {
  name: string;
  authority: string;
  officialUrl: string;
  requirementSummary: string;
  howToObtain: string;
  status: "not_started" | "applied" | "obtained" | "denied" | "not_required";
  confirmationRef: string | null;
}

export interface BundleLogistics {
  /** booking status of the live booking, null when none */
  bookingStatus: string | null;
  addons: BundleAddon[];
  permits: BundlePermit[];
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
  "checkin_extend",
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
  /** checkin_extend: the new expected return time (device clock), ISO */
  newExpectedReturnAt?: string;
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
  /** the device clock when this request was sent: the server corrects device timestamps by the estimated skew */
  sentAt?: string;
}

export interface SyncRejection {
  id: string;
  kind: "point" | "event";
  /** future_timestamp: still in the future after clock correction; invalid: unusable data */
  reason: "future_timestamp" | "invalid";
}

/** What the check-in contract did with a device "I'm okay" / "Extend my trip". */
export interface CheckinSyncResult {
  eventId: string;
  kind: "checkin_ok" | "checkin_extend";
  applied: boolean;
  reason?: string;
}

export interface SyncResponse {
  serverTime: string;
  acceptedPointIds: string[];
  acceptedEventIds: string[];
  rejected: SyncRejection[];
  session: { id: string; status: string; lastSyncAt: string | null };
  /** device clock − server clock applied to this batch's timestamps (0 = none) */
  clockSkewMs?: number;
  checkin?: CheckinSyncResult[];
}

export interface StartRequest {
  tripId: string;
  clientSessionId?: string;
  startedAt?: string;
  /** APP_MODE=demo only: the hiker explicitly chose "Start anyway (demo)" on a day other than the booked date */
  demoStartAnyway?: boolean;
  /** device clock at send time (clock-skew correction of startedAt) */
  sentAt?: string;
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
  /** device clock at send time (clock-skew correction of finishedAt) */
  sentAt?: string;
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
