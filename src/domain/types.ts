/**
 * Shared domain types. Pure TypeScript; safe on client and server.
 * These mirror database rows (camelCase) where relevant.
 */
import type { LineStringGeometry } from "./geo";

export type Difficulty = "easy" | "moderate" | "hard" | "strenuous";
export type RouteType = "loop" | "out_and_back" | "point_to_point";
export type FactKind = "verified" | "estimate" | "operator_note" | "demo";

export const TERRAIN_OPTIONS = ["forest", "ridge", "river", "lake", "meadow", "rocky", "canyon", "coastal", "paved", "gravel"] as const;
export type Terrain = (typeof TERRAIN_OPTIONS)[number];

export const ACCESSIBILITY_FEATURES = [
  "step_free_start",
  "firm_surface",
  "benches",
  "accessible_restroom",
  "accessible_parking",
  "gentle_grade",
  "shade",
  "no_exposure",
  "no_water_crossings",
] as const;
export type AccessibilityFeature = (typeof ACCESSIBILITY_FEATURES)[number];

export interface Source {
  id: string;
  label: string;
  url: string | null;
  publisher: string | null;
  sourceType: "official" | "land_manager" | "field_survey" | "publication" | "operator" | "demo";
  retrievedAt: Date | null;
  notes: string | null;
}

export interface FieldProvenance {
  field: string;
  kind: FactKind;
  sourceId: string | null;
  verifiedAt: Date | null;
  note: string | null;
}

export interface Trail {
  id: string;
  regionId: string;
  slug: string;
  name: string;
  summary: string;
  description: string;
  isDemo: boolean;
  status: "draft" | "published" | "closed" | "archived";
  distanceKm: number;
  elevationGainM: number;
  maxElevationM: number | null;
  difficulty: Difficulty;
  terrain: string[];
  routeType: RouteType;
  estimatedDurationMin: number;
  accessibilityFeatures: string[];
  dogsAllowed: boolean | null;
  permitRequired: boolean;
  trailheadName: string | null;
  trailheadLat: number;
  trailheadLng: number;
  parkingInfo: string | null;
  heroImageUrl: string | null;
  basePriceCents: number;
  currency: string;
  dailyCapacity: number;
  geometry: LineStringGeometry | null;
  geometryChecksum: string | null;
  geometryValidatedAt: Date | null;
  factsVerifiedAt: Date | null;
  updatedAt: Date;
}

export interface Closure {
  id: string;
  trailId: string;
  severity: "closed" | "partial" | "advisory";
  reason: string;
  sourceId: string | null;
  startsAt: Date;
  endsAt: Date | null;
}

export interface Poi {
  id: string;
  trailId: string;
  seq: number;
  name: string;
  kind: "history" | "ecology" | "safety" | "viewpoint" | "water" | "junction" | "trailhead";
  lat: number;
  lng: number;
  triggerRadiusM: number;
}

export interface Narration {
  id: string;
  trailId: string;
  poiId: string | null;
  title: string;
  transcript: string;
  audioPath: string | null;
  durationSec: number | null;
  status: "draft" | "in_review" | "approved" | "retired" | "rejected";
  sourceId: string | null;
  sourceCitation: string | null;
  version: number;
  approvedAt: Date | null;
}

/** Personalization questionnaire answers (validated server-side with zod). */
export interface TripPreferences {
  experience: "new" | "some" | "regular" | "expert";
  fitness: "low" | "moderate" | "high";
  preferredTerrain: string[];
  pace: "leisurely" | "steady" | "brisk";
  availableHours: number;
  distanceKmMin?: number;
  distanceKmMax?: number;
  maxElevationGainM?: number;
  plannedDate: string; // YYYY-MM-DD (region local date)
  startTime: string; // HH:MM (region local time)
  accessibilityNeeds: string[];
  partySize: number;
  equipment: string[];
  bringingDog?: boolean;
}

/** Deterministic itinerary stored on trips.itinerary. */
export interface Itinerary {
  version: 1;
  trailId: string;
  plannedDate: string;
  startTime: string;
  /** pace multiplier applied to the catalog estimate (estimate, not a fact) */
  paceFactor: number;
  estimatedDurationMin: number;
  estimatedFinishTime: string; // HH:MM
  /** suggested latest time to turn around / be off trail, if relevant */
  turnaroundBy?: string;
  stops: { poiId: string; name: string; alongM: number; etaOffsetMin: number }[];
  reminders: { hydrationEveryMin: number; paceCheckEveryMin: number };
  notes: string[];
  generatedAt: string;
}

export type TripStatus = "saved" | "booked" | "active" | "completed" | "cancelled";
export type BookingStatus =
  | "pending_payment"
  | "confirmed"
  | "cancellation_requested"
  | "cancelled"
  | "refund_pending"
  | "refunded"
  | "payment_failed"
  | "expired"
  | "needs_attention";
export type FulfillmentStatus =
  | "pending"
  | "requested"
  | "awaiting_customer"
  | "confirmed"
  | "completed"
  | "failed"
  | "cancelled"
  | "needs_attention";
export type CheckinStatus =
  | "scheduled"
  | "active"
  | "confirmed_ok"
  | "completed"
  | "overdue"
  | "contact_notified"
  | "cancelled";
