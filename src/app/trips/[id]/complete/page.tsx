import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CheckCircle2, ChevronLeft } from "lucide-react";
import { Alert, ButtonLink, Card, Container, PageHeader, SimulatedBadge, Stat } from "@/components/ui";
import { FeedbackForm } from "@/components/hike/feedback-form";
import { formatDistanceBoth } from "@/components/hike/format";
import { getCurrentUser, requireUser } from "@/server/auth";
import { getOwnedTrip } from "@/server/trips/queries";
import { getCompletionView } from "@/server/hike/queries";
import { FEEDBACK_ISSUES } from "@/server/hike/schemas";
import { formatDuration } from "@/domain/geo";
import { submitFeedbackAction } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/trips/[id]/complete">): Promise<Metadata> {
  const { id } = await params;
  const user = await getCurrentUser();
  const trip = user ? await getOwnedTrip(user, id) : null;
  return { title: trip ? `Hike complete — ${trip.trailName}` : "Hike complete" };
}

export default async function CompletePage({ params }: PageProps<"/trips/[id]/complete">) {
  const { id } = await params;
  const user = await requireUser(`/trips/${id}/complete`);
  const view = await getCompletionView(user, id);
  if (!view) notFound();
  const { trip, summary } = view;

  if (trip.status !== "completed") {
    return (
      <Container className="max-w-3xl py-10">
        <PageHeader eyebrow="Your hike" title={trip.trailName} />
        <Alert tone="blue" title={trip.status === "active" ? "Your hike is still in progress" : "This hike hasn't been finished yet"}>
          {trip.status === "active" ? (
            <>
              Finish it from the <a href={`/trips/${trip.id}/hike`} className="font-semibold underline">hike screen</a>. If you finished offline, it will
              appear here once your phone syncs.
            </>
          ) : (
            <Link href={`/trips/${trip.id}`} className="font-semibold underline">
              Back to your trip
            </Link>
          )}
        </Alert>
      </Container>
    );
  }

  const existing = view.feedback;

  return (
    <Container className="max-w-3xl py-8 sm:py-10">
      <p className="mb-4">
        <Link href={`/trips/${trip.id}`} className="inline-flex min-h-11 items-center gap-1 font-semibold text-forest-800 hover:underline">
          <ChevronLeft aria-hidden className="size-4" /> Trip overview
        </Link>
      </p>
      <PageHeader
        eyebrow="Hike complete"
        title={
          <span className="flex items-center gap-3">
            <CheckCircle2 aria-hidden className="size-8 text-forest-700" /> Nice work on {trip.trailName}
          </span>
        }
        actions={trip.trailIsDemo ? <SimulatedBadge label="Demonstration trail" /> : undefined}
      />

      <Card aria-labelledby="summary-heading">
        <h2 id="summary-heading" className="text-xl font-bold">
          Your hike
        </h2>
        {summary ? (
          <>
            <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat label="Distance along route" value={formatDistanceBoth(summary.distanceM)} />
              <Stat label="Moving time" value={summary.movingTimeSec !== null ? formatDuration(summary.movingTimeSec / 60) : "—"} hint="Excludes pauses" />
              <Stat label="Stories heard" value={String(summary.stopsHeard.length)} />
            </dl>
            {summary.stopsHeard.length ? (
              <p className="mt-4 text-[0.95rem]">
                <span className="font-semibold">Stops:</span> {summary.stopsHeard.map((s) => s.name).join(" · ")}
              </p>
            ) : null}
            <p className="mt-3 text-sm text-muted">Figures come from the data your phone synced. If you finished offline, a few details may still be syncing.</p>
          </>
        ) : (
          <p className="mt-2 text-muted">No hike was recorded for this trip.</p>
        )}
      </Card>

      <Card aria-labelledby="feedback-heading" className="mt-6">
        <h2 id="feedback-heading" className="text-xl font-bold">
          {existing ? "Thanks for your feedback" : "Tell us how it went"}
        </h2>
        {existing ? <p className="mt-1 text-muted">You rated this hike {existing.rating} of 5. You can update your answers below.</p> : null}
        <div className="mt-4">
          <FeedbackForm action={submitFeedbackAction.bind(null, trip.id)} issues={FEEDBACK_ISSUES} initial={existing} />
        </div>
      </Card>

      <div className="mt-6 flex flex-wrap gap-3">
        <ButtonLink href={`/trips/${trip.id}`} variant="secondary">
          Back to your trip
        </ButtonLink>
        <ButtonLink href="/trails" variant="ghost">
          Find your next hike
        </ButtonLink>
      </div>
    </Container>
  );
}
