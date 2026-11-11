import Link from "next/link";
import { Share2, ShieldCheck } from "lucide-react";
import { ButtonLink, Card, SimulatedBadge } from "@/components/ui";
import { getCurrentUser } from "@/server/auth";
import { getOwnedTrip } from "@/server/trips/queries";
import { formatCheckinTime, isOpen } from "@/domain/checkin";
import { loadCheckinCardData, loadShares } from "./data";
import { CheckinQuickActions } from "./quick-actions";
import { CheckinStatusSummary } from "./status-summary";
import { ShareManager, type ShareListItem } from "./share-manager";

/**
 * CROSS-SLICE CONTRACT — implemented by the safety slice.
 * Shown on the trip dashboard (/trips/[id], commerce slice): check-in status
 * with "I'm okay" / "Extend my trip" / "Finish trip" actions, and trip-share
 * link management. Server component; loads its own data.
 */
export async function CheckinStatusCard({ tripId }: { tripId: string }) {
  const user = await getCurrentUser();
  if (!user) return null;
  const trip = await getOwnedTrip(user, tripId);
  if (!trip) return null;
  const d = await loadCheckinCardData(user, trip);
  const c = d.checkin && d.checkin.status !== "cancelled" ? d.checkin : null;
  // Sharing ends with the trip: no new links once the trip or its check-in is finished.
  const canShare = d.sharingEnabled && (trip.status === "booked" || trip.status === "active") && d.checkin?.status !== "completed";
  const shares = canShare ? await loadShares(user, trip.id) : [];
  const shareItems: ShareListItem[] = shares.map((s) => ({
    id: s.id,
    active: s.active,
    includeLastLocation: s.includeLastLocation,
    statusText: s.revokedAt
      ? `Turned off ${formatCheckinTime(s.revokedAt, d.timeZone)}`
      : s.active
        ? `Works until ${formatCheckinTime(s.expiresAt, d.timeZone)}`
        : `Expired ${formatCheckinTime(s.expiresAt, d.timeZone)}`,
  }));

  return (
    <Card aria-labelledby={`checkin-status-${trip.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`checkin-status-${trip.id}`} className="flex items-center gap-2 text-lg font-bold">
          <ShieldCheck aria-hidden className="size-5 text-forest-700" /> Check-ins
        </h2>
        {d.notificationsSimulated ? <SimulatedBadge label="Simulated notices" /> : null}
      </div>

      <div className="mt-3 space-y-4">
        {c ? (
          <>
            <CheckinStatusSummary
              checkin={c}
              contact={d.contact}
              contactReachable={d.contactReachable}
              simulated={d.notificationsSimulated}
              timeZone={d.timeZone}
              tripId={trip.id}
              compact
            />
            {isOpen(c.status) ? <CheckinQuickActions tripId={trip.id} minExtendLocal={d.minExtendLocal} tzLabel={d.tzLabel} compact /> : null}
          </>
        ) : trip.status === "booked" || trip.status === "active" ? (
          <>
            <p className="text-[0.95rem]">
              {d.checkinsEnabled
                ? "Check-ins are off. Choose a trusted contact and a return time — we'll send them a notice only if we don't hear “I'm okay” or “Finish trip” from you."
                : "Check-ins are unavailable right now. Tell someone you trust where you're going and when you'll be back."}
            </p>
            {d.checkinsEnabled ? (
              <ButtonLink href={`/trips/${trip.id}/checkin`} variant="secondary" className="w-full">
                Set up check-ins
              </ButtonLink>
            ) : null}
          </>
        ) : (
          <p className="text-[0.95rem] text-muted">Check-ins are available for booked trips.</p>
        )}
        <Link href={`/trips/${trip.id}/checkin`} className="inline-flex min-h-11 items-center font-semibold text-forest-800 underline">
          Check-in details and notice history
        </Link>
      </div>

      {canShare ? (
        <div className="mt-5 border-t border-sand-200 pt-5">
          <h3 className="flex items-center gap-2 font-bold">
            <Share2 aria-hidden className="size-4 text-forest-700" /> Share your trip
          </h3>
          <p className="mt-1 text-sm text-muted">
            Send a temporary link to family or friends. It shows your trail, date, expected return and check-in status. It is not live tracking and not an
            emergency service.
          </p>
          <div className="mt-3">
            <ShareManager tripId={trip.id} shares={shareItems} />
          </div>
        </div>
      ) : null}
    </Card>
  );
}
