import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Container } from "@/components/ui";
import { HikeApp } from "@/components/hike/hike-app";
import { requireUser } from "@/server/auth";
import { getOwnedTrip } from "@/server/trips/queries";
import { isDemoMode } from "@/config/env";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Active hike" };

/**
 * Active-hike shell. Renders only the trip id: everything else is loaded on
 * the device from the downloaded bundle (IndexedDB), so this page works
 * offline when served from the service-worker trip cache.
 */
export default async function HikePage({ params }: PageProps<"/trips/[id]/hike">) {
  const { id } = await params;
  const user = await requireUser(`/trips/${id}/hike`);
  const trip = await getOwnedTrip(user, id);
  if (!trip) notFound();
  return (
    <Container className="max-w-3xl py-6">
      <HikeApp tripId={trip.id} demoMode={isDemoMode()} />
    </Container>
  );
}
