/**
 * CROSS-SLICE CONTRACT — implemented by the safety slice.
 * Shown on the trip dashboard (/trips/[id], commerce slice): check-in status
 * with "I'm okay" / "Extend my trip" / "Finish trip" actions, and trip-share
 * link management. Server component; loads its own data.
 */
export async function CheckinStatusCard({ tripId }: { tripId: string }) {
  void tripId;
  return null;
}
