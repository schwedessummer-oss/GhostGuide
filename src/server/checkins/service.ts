import "server-only";
import type { Tx } from "@/server/db";

/**
 * CROSS-SLICE CONTRACT — implemented by the safety slice.
 * The hike slice calls these when a hike starts / finishes. Signatures are
 * fixed; implementations must be idempotent and must cancel obsolete jobs.
 */

/** Called (inside the caller's system transaction) when a hike session starts. No-op if the user has not opted in. */
export async function onHikeStarted(tx: Tx, tripId: string, userId: string): Promise<void> {
  void tx;
  void tripId;
  void userId;
}

/**
 * Called by hike sync when an "I'm okay" tap recorded on the device (possibly
 * offline, so `occurredAt` may be in the past) reaches the server. Must ignore
 * confirmations for completed/cancelled check-ins and be idempotent per
 * `clientEventId`.
 */
export async function onCheckinConfirmedFromDevice(
  tx: Tx,
  tripId: string,
  userId: string,
  occurredAt: Date,
  clientEventId: string,
): Promise<void> {
  void tx;
  void tripId;
  void userId;
  void occurredAt;
  void clientEventId;
}

/**
 * Called when the user finishes the trip (from the hike screen or the
 * check-in "Finish trip" action). Marks the check-in completed and cancels
 * every pending reminder / overdue job. Must be safe to call repeatedly.
 */
export async function onTripFinished(tx: Tx, tripId: string, userId: string): Promise<void> {
  void tx;
  void tripId;
  void userId;
}
