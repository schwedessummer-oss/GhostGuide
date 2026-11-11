import { clientIpFrom } from "@/server/request";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Clock, MapPin, Phone } from "lucide-react";
import { Alert, Badge, Card, Container, SimulatedBadge } from "@/components/ui";
import { RouteView } from "@/components/map/route-view";
import { lookupShare } from "@/server/sharing/shares";
import { getTrailById } from "@/server/catalog/trails";
import { formatCheckinTime } from "@/domain/checkin";
import { formatCoords, mapLink } from "@/domain/notification-messages";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shared trip",
  description: "A temporary trip-share link from a Ghost Guide hiker.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

async function clientKey(): Promise<string> {
  const h = await headers();
  return clientIpFrom(h);
}

/** Public trip-share page (no sign-in). Unknown, expired and revoked links all show the same "not available" page. */
export default async function SharePage({ params }: PageProps<"/share/[token]">) {
  const { token } = await params;
  const result = await lookupShare(token, await clientKey());
  if (result.rateLimited) {
    return (
      <Container className="py-12">
        <Alert tone="amber" title="Too many requests" live="polite">
          Please wait a minute and reload this page.
        </Alert>
      </Container>
    );
  }
  const v = result.view;
  if (!v) notFound();

  const trail = await getTrailById(v.trailId);
  const who = v.hikerFirstName ?? "A Ghost Guide hiker";
  const loc = v.location;

  return (
    <Container className="max-w-3xl py-8 sm:py-10">
      <header className="mb-6">
        <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-forest-700">Shared trip</p>
        <h1 className="text-3xl font-bold text-ink sm:text-4xl">
          {who}&apos;s hike: {v.trailName}
        </h1>
        <p className="mt-2 text-lg text-muted">
          {v.regionName}
          {v.plannedDate ? ` · ${formatDate(v.plannedDate, { weekday: "long", month: "long", day: "numeric" })}` : ""}
        </p>
        {v.trailIsDemo ? (
          <p className="mt-2">
            <SimulatedBadge label="Demonstration trail (fictional)" />
          </p>
        ) : null}
      </header>

      <div className="space-y-6">
        <Card aria-labelledby="share-status">
          <h2 id="share-status" className="text-xl font-bold">
            Check-in status
          </h2>
          <p className="mt-3 text-lg font-semibold" aria-live="polite">
            {v.statusText}
          </p>
          {v.expectedReturnAt ? (
            <p className="mt-2 flex items-start gap-2">
              <Clock aria-hidden className="mt-1 size-4 shrink-0 text-forest-700" />
              <span>
                Expected back by <span className="font-semibold">{formatCheckinTime(v.expectedReturnAt, v.timeZone)}</span>
              </span>
            </p>
          ) : null}
          {v.showNoConfirmationNote ? (
            <p className="mt-3 text-sm text-muted">
              “No confirmation” only means Ghost Guide hasn&apos;t heard from {v.hikerFirstName ?? "them"} — phones often lose signal on trails.
            </p>
          ) : null}
        </Card>

        {v.locationIncluded ? (
          <Card aria-labelledby="share-location">
            <h2 id="share-location" className="flex items-center gap-2 text-xl font-bold">
              <MapPin aria-hidden className="size-5 text-forest-700" /> Last reported location
            </h2>
            {loc ? (
              <div className="mt-3 space-y-3">
                <p>
                  <span className="font-mono">{formatCoords(loc.lat, loc.lng)}</span>
                  {loc.accuracyM != null ? <span className="text-muted"> (±{Math.round(loc.accuracyM)} m)</span> : null}
                </p>
                <p className="flex flex-wrap items-center gap-2">
                  Reported {formatCheckinTime(loc.recordedAt, v.timeZone)}
                  <Badge tone={loc.freshness === "stale" ? "amber" : "forest"}>{loc.label}</Badge>
                </p>
                {loc.freshness === "stale" ? (
                  <p className="text-sm">This position is old. It shows where the phone was then, not where {v.hikerFirstName ? `${v.hikerFirstName} is` : "they are"} now.</p>
                ) : null}
                {trail?.geometry ? (
                  <RouteView
                    coordinates={trail.geometry.coordinates}
                    current={{ lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM, stale: loc.freshness === "stale" }}
                    label={`Route of ${v.trailName} with the last reported position`}
                    height={300}
                  />
                ) : null}
                <a href={mapLink(loc.lat, loc.lng)} rel="noreferrer noopener" target="_blank" className="inline-flex min-h-11 items-center font-semibold text-forest-800 underline">
                  Open this position in OpenStreetMap
                </a>
              </div>
            ) : (
              <p className="mt-3 text-muted">{v.locationNote ?? "No location has been reported."}</p>
            )}
          </Card>
        ) : null}

        <Alert tone="blue" title="Please read">
          <ul className="list-disc space-y-1 pl-5">
            <li>This page is not live tracking. It shows only what {v.hikerFirstName ?? "the hiker"}&apos;s phone last sent, which may be out of date.</li>
            <li>Ghost Guide is not an emergency service and does not contact emergency services or search teams.</li>
            <li>This link stops working {formatCheckinTime(v.expiresAt, v.timeZone)} or earlier if {v.hikerFirstName ?? "the hiker"} turns it off.</li>
          </ul>
        </Alert>

        <Alert tone="red" title="Worried about their safety?">
          <p className="flex items-start gap-2">
            <Phone aria-hidden className="mt-1 size-4 shrink-0" />
            <span>
              Try calling them first. If you are concerned, call local emergency services ({v.emergencyNumber}) and share the information on this page.
            </span>
          </p>
        </Alert>
      </div>
    </Container>
  );
}
