/**
 * Partner (logistics) provider interfaces. Ghost Guide integrates NO real
 * partner APIs yet: every implementation in this folder is a clearly labeled
 * DEMO adapter. A live adapter must implement the same interface against the
 * partner's official, approved API (see README.md in this folder).
 */
import type { Tx } from "@/server/db";

export type GearKind =
  | "trekking_poles"
  | "daypack"
  | "bear_canister"
  | "headlamp"
  | "first_aid_kit"
  | "water_filter"
  | "satellite_communicator"
  | "other";

/** Retryable failure (timeout, 5xx, partner temporarily unavailable). */
export class PartnerTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartnerTransientError";
  }
}

/** Permanent failure (partner declined, nothing available). Not retried automatically. */
export class PartnerRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartnerRejectedError";
  }
}

/** Deterministic failure-injection knob for demos/tests (booking_addons.details.simulate). */
export type SimulateMode = "fail" | "fail_once" | "reject";

export interface GearKindRequest {
  kind: GearKind;
  count: number;
}

export interface GearAvailability {
  ok: boolean;
  byKind: { kind: GearKind; requested: number; available: number }[];
}

export interface GearReservationResult {
  lockerId: string | null;
  lockerName: string;
  locationDescription: string;
  reservationIds: string[];
  primaryReservationId: string;
  itemLabels: string[];
}

export interface PartnerCallContext {
  fulfillmentId: string;
  /** 1-based attempt number (fulfillments.attempts after increment) */
  attempt: number;
  simulate?: SimulateMode | null;
}

export interface GearLockerProvider {
  readonly key: string;
  readonly simulated: boolean;
  checkAvailability(tx: Tx, regionId: string, date: string, kinds: GearKindRequest[]): Promise<GearAvailability>;
  reserve(tx: Tx, ctx: PartnerCallContext & { regionId: string }, date: string, kinds: GearKindRequest[]): Promise<GearReservationResult>;
  /** Issue the locker access code. The code itself is never stored, only its hash + last-2-digit hint. */
  issueAccessCode(tx: Tx, reservation: Pick<GearReservationResult, "primaryReservationId" | "reservationIds">, expiresAt: Date): Promise<{ hint: string; expiresAt: Date }>;
  /** Cancel active reservations of a fulfillment and free the items. */
  release(tx: Tx, fulfillmentId: string): Promise<number>;
  markPickedUp(tx: Tx, reservationId: string): Promise<boolean>;
  markReturned(tx: Tx, reservationId: string): Promise<boolean>;
  reportMaintenance(tx: Tx, gearItemId: string, note: string): Promise<boolean>;
}

export interface SatelliteDeviceRentalProvider {
  readonly key: string;
  readonly simulated: boolean;
  /** Reserve one satellite communicator (gear_items kind 'satellite_communicator'). */
  reserve(tx: Tx, ctx: PartnerCallContext & { regionId: string }, date: string): Promise<GearReservationResult>;
  release(tx: Tx, fulfillmentId: string): Promise<number>;
}

export interface ShuttlePlace {
  description: string;
  lat?: number | null;
  lng?: number | null;
}

export interface ShuttleQuoteRequest {
  pickup: ShuttlePlace;
  dropoff: ShuttlePlace;
  pickupAt: Date;
  partySize: number;
  /** amount the customer prepaid for the shuttle add-on */
  prepaidCents: number;
}

export interface ShuttleQuote {
  quoteRef: string;
  priceCents: number;
  expiresAt: Date;
}

export interface ShuttleRideRequest {
  shuttleRequestId: string;
  /** MUST be set: a paid ride is never requested without explicit customer confirmation */
  customerConfirmedAt: Date | null;
  pickup: ShuttlePlace;
  dropoff: ShuttlePlace;
  pickupAt: Date;
  priceCents: number;
  partySize: number;
}

export interface ShuttleProvider {
  readonly key: string;
  readonly simulated: boolean;
  requestQuote(req: ShuttleQuoteRequest, ctx: PartnerCallContext): Promise<ShuttleQuote>;
  requestRide(req: ShuttleRideRequest, ctx: PartnerCallContext): Promise<{ rideRef: string; status: "requested" | "confirmed" }>;
  cancelRide(rideRef: string, ctx: PartnerCallContext): Promise<void>;
}

export interface MealPackOrder {
  hikeDate: string;
  quantity: number;
  partySize: number;
  pickupLocation: string;
}

export interface MealPackProvider {
  readonly key: string;
  readonly simulated: boolean;
  placeOrder(order: MealPackOrder, ctx: PartnerCallContext): Promise<{ orderRef: string }>;
  cancelOrder(orderRef: string, ctx: PartnerCallContext): Promise<void>;
}

export class ShuttleConfirmationRequiredError extends Error {
  constructor() {
    super("Refusing to request a paid ride: the customer has not confirmed pickup location, price and time.");
    this.name = "ShuttleConfirmationRequiredError";
  }
}
