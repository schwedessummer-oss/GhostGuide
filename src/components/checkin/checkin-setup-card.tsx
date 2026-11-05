/**
 * CROSS-SLICE CONTRACT — implemented by the safety slice.
 * Rendered on the pre-hike page (hike slice) to let the customer opt in to
 * trip check-ins. Server component; loads its own data for `tripId`.
 */
export async function CheckinSetupCard({ tripId }: { tripId: string }) {
  void tripId;
  return null;
}
