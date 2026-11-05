import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Container } from "@/components/ui";
import { HelpScreen } from "@/components/hike/help-screen";
import { requireUser } from "@/server/auth";
import { getOwnedTrip } from "@/server/trips/queries";
import { getRegionById } from "@/server/catalog/trails";
import { getServerLastLocation, getStaleLocationMinutes } from "@/server/hike/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Help & emergency" };

/**
 * Help screen. Cached by the service worker when the trip is downloaded;
 * offline, the client reads the last location saved on the device. The
 * server-provided location below is a fallback when online.
 */
export default async function HelpPage({ params }: PageProps<"/trips/[id]/help">) {
  const { id } = await params;
  const user = await requireUser(`/trips/${id}/help`);
  const trip = await getOwnedTrip(user, id);
  if (!trip) notFound();
  const [region, last, staleMinutes] = await Promise.all([getRegionById(trip.regionId), getServerLastLocation(user, trip.id), getStaleLocationMinutes()]);
  return (
    <Container className="max-w-3xl py-6">
      <header className="mb-5">
        <p className="text-sm font-semibold uppercase tracking-wide text-red-ink">Help</p>
        <h1 className="text-3xl font-bold">Need help on {trip.trailName}?</h1>
      </header>
      <HelpScreen
        tripId={trip.id}
        serverLocation={
          last ? { lat: last.lat, lng: last.lng, accuracyM: last.accuracyM, recordedAt: last.recordedAt.getTime(), source: "server" } : null
        }
        region={region ? { name: region.name, emergencyNumber: region.emergencyNumber, emergencyGuidance: region.emergencyGuidance } : null}
        staleMinutes={staleMinutes}
      />
    </Container>
  );
}
