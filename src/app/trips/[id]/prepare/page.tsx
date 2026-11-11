import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChevronLeft, ExternalLink, Footprints, Package, ScrollText } from "lucide-react";
import { Alert, Badge, ButtonLink, Card, Container, PageHeader, SimulatedBadge } from "@/components/ui";
import { ClosureNotice } from "@/components/hike/closure-notice";
import { AddonDetailsList } from "@/components/hike/trip-logistics";
import { CheckinSetupCard } from "@/components/checkin/checkin-setup-card";
import { PrepareChecklist } from "@/components/hike/prepare-checklist";
import { PermissionCheck } from "@/components/hike/permission-check";
import { DownloadPanel } from "@/components/hike/download-panel";
import { PermitStatusForm } from "@/components/hike/permit-status-form";
import { LimitationsCallout, LimitationsList } from "@/components/hike/limitations";
import { getCurrentUser, requireUser } from "@/server/auth";
import { getOwnedTrip } from "@/server/trips/queries";
import { getPrepareView } from "@/server/hike/queries";
import { formatDate, titleCase } from "@/lib/format";
import { updatePermitAction } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/trips/[id]/prepare">): Promise<Metadata> {
  const { id } = await params;
  const user = await getCurrentUser();
  const trip = user ? await getOwnedTrip(user, id) : null;
  return { title: trip ? `Get ready — ${trip.trailName}` : "Get ready" };
}

export default async function PreparePage({ params }: PageProps<"/trips/[id]/prepare">) {
  const { id } = await params;
  const user = await requireUser(`/trips/${id}/prepare`);
  const view = await getPrepareView(user, id);
  if (!view) notFound();
  const { trip } = view;
  const bookable = trip.status === "booked" || trip.status === "active" || trip.status === "completed";

  return (
    <Container className="py-8 sm:py-10">
      <p className="mb-4">
        <Link href={`/trips/${trip.id}`} className="inline-flex min-h-11 items-center gap-1 font-semibold text-forest-800 hover:underline">
          <ChevronLeft aria-hidden className="size-4" /> Trip overview
        </Link>
      </p>
      <PageHeader
        eyebrow="Before your hike"
        title={`Get ready for ${trip.trailName}`}
        description={
          <span>
            {(view.bookedDate ?? trip.plannedDate) ? formatDate((view.bookedDate ?? trip.plannedDate)!, { weekday: "long", month: "long", day: "numeric" }) : "Date not set"}
            {trip.startTime ? ` · start ${trip.startTime}` : ""} · {trip.partySize} {trip.partySize === 1 ? "hiker" : "hikers"}
          </span>
        }
        actions={trip.trailIsDemo ? <SimulatedBadge label="Demonstration trail" /> : undefined}
      />

      {!bookable ? (
        <Alert tone="amber" title="This trip isn't booked">
          Book the trip first; then you can prepare, download it and start the hike. <Link href={`/trips/${trip.id}`} className="font-semibold underline">Go to your trip</Link>.
        </Alert>
      ) : (
        <div className="space-y-6">
          {trip.status === "active" ? (
            <Alert tone="blue" title="Your hike is in progress">
              <a href={`/trips/${trip.id}/hike`} className="font-semibold underline">Return to the hike screen</a>
            </Alert>
          ) : null}
          {trip.status === "completed" ? (
            <Alert tone="forest" title="This hike is finished">
              <Link href={`/trips/${trip.id}/complete`} className="font-semibold underline">See your summary</Link>
            </Alert>
          ) : null}
          {trip.status !== "completed" ? (
            <ClosureNotice closures={view.closures} blocking={view.closedOnBookedDate} timeZone={view.timezone} context="booked" />
          ) : null}
          <LimitationsCallout />

          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <Card aria-labelledby="checklist-heading">
                <h2 id="checklist-heading" className="text-xl font-bold">
                  Pack &amp; plan checklist
                </h2>
                <div className="mt-3">
                  <PrepareChecklist tripId={trip.id} />
                </div>
              </Card>

              <Card aria-labelledby="download-heading">
                <h2 id="download-heading" className="text-xl font-bold">
                  Download for offline use
                </h2>
                <p className="mt-1 text-muted">Do this at home on Wi-Fi. Trailheads often have no signal.</p>
                <div className="mt-4">
                  <DownloadPanel
                    tripId={trip.id}
                    serverLastDownload={view.lastDownload ? { at: view.lastDownload.createdAt.toISOString(), complete: view.lastDownload.verifiedComplete } : null}
                  />
                </div>
              </Card>

              <Card aria-labelledby="perm-heading">
                <h2 id="perm-heading" className="text-xl font-bold">
                  Check your phone
                </h2>
                <p className="mt-1 text-muted">Test these before you leave so there are no surprises at the trailhead.</p>
                <div className="mt-4">
                  <PermissionCheck />
                </div>
              </Card>
            </div>

            <aside className="space-y-6" aria-label="Permits, add-ons and check-in">
              <Card aria-labelledby="permit-heading">
                <h2 id="permit-heading" className="flex items-center gap-2 text-lg font-bold">
                  <ScrollText aria-hidden className="size-5" /> Permits
                </h2>
                {view.permits.length === 0 ? (
                  <p className="mt-2 text-muted">No permit is listed for this trail. Always check the land manager&apos;s current rules.</p>
                ) : (
                  <ul className="mt-3 space-y-4">
                    {view.permits.map((p) => (
                      <li key={p.requirementId} className="rounded-xl border border-sand-200 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-semibold">{p.name}</p>
                          <Badge tone={p.status === "obtained" || p.status === "not_required" ? "forest" : p.status === "denied" ? "red" : "amber"}>
                            {titleCase(p.status)}
                          </Badge>
                        </div>
                        <p className="mt-1 text-sm text-muted">{p.requirementSummary}</p>
                        <p className="mt-1 text-sm">{p.howToObtain}</p>
                        {p.leadTimeDays ? <p className="mt-1 text-sm text-muted">Apply at least {p.leadTimeDays} days ahead.</p> : null}
                        <a
                          href={p.officialUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-2 inline-flex min-h-11 items-center gap-1 font-semibold text-forest-800 underline"
                        >
                          Official permit page ({p.authority}) <ExternalLink aria-hidden className="size-4" />
                        </a>
                        <PermitStatusForm
                          action={updatePermitAction.bind(null, trip.id)}
                          permitRequirementId={p.requirementId}
                          status={p.status}
                          confirmationRef={p.confirmationRef}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card aria-labelledby="addon-heading">
                <h2 id="addon-heading" className="flex items-center gap-2 text-lg font-bold">
                  <Package aria-hidden className="size-5" /> Gear, shuttle &amp; meals
                </h2>
                <AddonDetailsList addons={view.logistics.addons} timeZone={view.timezone} />
                {view.logistics.addons.length ? (
                  <p className="mt-2 text-sm text-muted">
                    These details (and your permit status) are saved with your offline download — the Help screen shows them without signal.
                  </p>
                ) : null}
                <Link href={`/trips/${trip.id}`} className="mt-2 inline-flex min-h-11 items-center font-semibold text-forest-800 underline">
                  Details and actions on your trip page
                </Link>
              </Card>

              <CheckinSetupCard tripId={trip.id} />
            </aside>
          </div>

          <Card aria-labelledby="limits-full-heading" className="border-[#f1d9b0]">
            <h2 id="limits-full-heading" className="text-xl font-bold">
              Limitations to know before you start
            </h2>
            <p className="mt-1 text-muted">Ghost Guide runs in your browser. Here is what that means on the trail:</p>
            <LimitationsList className="mt-4" />
            <p className="mt-4 text-sm">
              <Link href="/how-it-works" className="font-semibold text-forest-800 underline">
                How Ghost Guide works, safety model and privacy
              </Link>
            </p>
          </Card>

          {trip.status === "booked" || trip.status === "active" ? (
            <div className="flex flex-col items-start gap-2 rounded-2xl bg-forest-50 p-5">
              <p className="font-semibold">At the trailhead?</p>
              <a
                href={`/trips/${trip.id}/hike`}
                className="inline-flex min-h-13 items-center gap-2 rounded-xl bg-forest-700 px-6 py-3 font-semibold text-white hover:bg-forest-800"
              >
                <Footprints aria-hidden className="size-5" /> {trip.status === "active" ? "Resume hike" : "Open the hike screen"}
              </a>
              <p className="text-sm text-muted">You&apos;ll confirm the limitations above before the hike starts.</p>
            </div>
          ) : (
            <ButtonLink href={`/trips/${trip.id}/complete`} variant="secondary">
              Hike summary
            </ButtonLink>
          )}
        </div>
      )}
    </Container>
  );
}
