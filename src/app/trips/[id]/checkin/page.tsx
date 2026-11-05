import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChevronLeft, Phone } from "lucide-react";
import { Alert, Card, Container, PageHeader, SimulatedBadge } from "@/components/ui";
import { getCurrentUser, requireUser } from "@/server/auth";
import { getOwnedTrip } from "@/server/trips/queries";
import { listCheckinEvents, listTripNotifications } from "@/server/checkins/manage";
import { loadCheckinCardData } from "@/components/checkin/data";
import { CheckinSetupCard, setupFormProps } from "@/components/checkin/checkin-setup-card";
import { CheckinStatusSummary } from "@/components/checkin/status-summary";
import { CheckinOptOutForm, CheckinQuickActions } from "@/components/checkin/quick-actions";
import { CheckinSetupForm } from "@/components/checkin/setup-form";
import { CheckinTimeline, NotificationHistory } from "@/components/checkin/history";
import { CHECKIN_EXPLANATION, CHECKIN_LIMITS_NOTE } from "@/components/checkin/copy";
import { isAwaiting, isOpen } from "@/domain/checkin";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/trips/[id]/checkin">): Promise<Metadata> {
  const { id } = await params;
  const user = await getCurrentUser();
  const trip = user ? await getOwnedTrip(user, id) : null;
  return { title: trip ? `Check-ins — ${trip.trailName}` : "Trip check-ins" };
}

export default async function TripCheckinPage({ params }: PageProps<"/trips/[id]/checkin">) {
  const { id } = await params;
  const user = await requireUser(`/trips/${id}/checkin`);
  const trip = await getOwnedTrip(user, id);
  if (!trip) notFound();

  const d = await loadCheckinCardData(user, trip);
  const c = d.checkin && d.checkin.status !== "cancelled" ? d.checkin : null;
  const [events, notifications] = await Promise.all([d.checkin ? listCheckinEvents(user, d.checkin.id) : Promise.resolve([]), listTripNotifications(user, trip.id)]);

  return (
    <Container className="py-8 sm:py-10">
      <p className="mb-4">
        <Link href={`/trips/${trip.id}`} className="inline-flex min-h-11 items-center gap-1 font-semibold text-forest-800 hover:underline">
          <ChevronLeft aria-hidden className="size-4" /> Back to trip
        </Link>
      </p>
      <PageHeader
        eyebrow="Trip check-ins"
        title={trip.trailName}
        description={trip.plannedDate ? formatDate(trip.plannedDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : undefined}
        actions={d.notificationsSimulated ? <SimulatedBadge label="Demo: notices are simulated, nothing is sent" /> : null}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {c ? (
            <Card aria-labelledby="checkin-status-heading">
              <h2 id="checkin-status-heading" className="text-xl font-bold">
                Status
              </h2>
              <div className="mt-4">
                <CheckinStatusSummary checkin={c} contact={d.contact} timeZone={d.timeZone} tripId={trip.id} />
              </div>
            </Card>
          ) : (
            <CheckinSetupCard tripId={trip.id} />
          )}

          {c && isOpen(c.status) ? (
            <Card aria-labelledby="actions-heading">
              <h2 id="actions-heading" className="text-xl font-bold">
                Let us know how it&apos;s going
              </h2>
              <div className="mt-4 max-w-md">
                <CheckinQuickActions tripId={trip.id} minExtendLocal={d.minExtendLocal} tzAbbrev={d.tzAbbrev} />
              </div>
            </Card>
          ) : null}

          {c && isAwaiting(c.status) ? (
            <Card aria-labelledby="change-heading" id="change">
              <h2 id="change-heading" className="text-xl font-bold">
                Change check-in details
              </h2>
              <p className="mt-1 text-muted">Update your contact, expected return, grace period or reminders. Saving reschedules everything.</p>
              <div className="mt-4 space-y-6">
                <CheckinSetupForm {...setupFormProps(d, "update")} />
                <CheckinOptOutForm tripId={trip.id} />
              </div>
            </Card>
          ) : null}

          <Card aria-labelledby="history-heading">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="history-heading" className="text-xl font-bold">
                Notices and reminders
              </h2>
              {d.notificationsSimulated ? <SimulatedBadge label="Simulated delivery" /> : null}
            </div>
            <p className="mt-1 text-sm text-muted">
              Everything Ghost Guide sent (or would send) about this trip, with the exact text. Phone numbers and emails are partly hidden.
              {d.notificationsSimulated ? " In this demo, no text messages or emails are actually delivered." : ""}
            </p>
            <div className="mt-4">
              <NotificationHistory notifications={notifications} timeZone={d.timeZone} />
            </div>
          </Card>

          {d.checkin ? (
            <Card aria-labelledby="timeline-heading">
              <h2 id="timeline-heading" className="text-xl font-bold">
                Check-in activity
              </h2>
              <div className="mt-4">
                <CheckinTimeline events={events} timeZone={d.timeZone} />
              </div>
            </Card>
          ) : null}
        </div>

        <aside className="space-y-6" aria-label="Check-in actions and help">
          <Card aria-labelledby="how-heading">
            <h2 id="how-heading" className="text-lg font-bold">
              How check-ins work
            </h2>
            {c ? <p className="mt-2 text-[0.95rem]">{CHECKIN_EXPLANATION}</p> : null}
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
              <li>“I&apos;m okay” before your expected return keeps your plan; reminders continue.</li>
              <li>“I&apos;m okay” after your expected return moves it 60 minutes later, so silence is still noticed.</li>
              <li>“Finish trip” ends check-ins. If your contact already got a notice, we send them a follow-up.</li>
              <li>A notice means only that we haven&apos;t heard from you — not that something is wrong.</li>
            </ul>
            <p className="mt-3 text-sm text-muted">{CHECKIN_LIMITS_NOTE}</p>
          </Card>

          <Alert tone="red" title="In an emergency">
            <p className="flex items-start gap-2">
              <Phone aria-hidden className="mt-1 size-4 shrink-0" />
              <span>{d.emergencyGuidance || `Call ${d.emergencyNumber} yourself. Ghost Guide cannot contact emergency services for you.`}</span>
            </p>
          </Alert>
        </aside>
      </div>
    </Container>
  );
}
