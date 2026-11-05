import type { Metadata } from "next";
import { CloudOff, Phone } from "lucide-react";
import { Container } from "@/components/ui";
import { OfflineTrips } from "@/components/hike/offline-trips";

export const metadata: Metadata = { title: "You're offline" };

/**
 * Offline fallback, precached by the service worker and served for any
 * navigation that fails without a cached copy. Lists trips downloaded on
 * this device (from IndexedDB) and the emergency basics.
 */
export default function OfflinePage() {
  return (
    <Container className="max-w-2xl py-10">
      <h1 className="flex items-center gap-3 text-3xl font-bold">
        <CloudOff aria-hidden className="size-8 text-forest-700" /> You&apos;re offline
      </h1>
      <p className="mt-3 text-lg text-muted">This page isn&apos;t saved on this device. Trips you downloaded still work:</p>
      <div className="mt-6">
        <OfflineTrips />
      </div>
      <div className="mt-8 rounded-2xl border-2 border-red-ink/40 bg-red-bg p-5 text-red-ink">
        <p className="flex items-center gap-2 text-lg font-bold">
          <Phone aria-hidden className="size-5" /> In an emergency call 911
        </p>
        <p className="mt-1 text-ink">
          Call if you have any signal; if a call fails, try texting 911 where supported. With no signal, use your own satellite communicator&apos;s SOS.
          Ghost Guide cannot contact help for you.
        </p>
        <a href="tel:911" className="mt-3 inline-flex min-h-12 items-center rounded-xl bg-red-ink px-5 font-bold text-white">
          Call 911
        </a>
      </div>
    </Container>
  );
}
