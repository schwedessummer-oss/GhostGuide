import Link from "next/link";
import { CheckCircle2, CloudDownload, Footprints, LifeBuoy, MessageSquareHeart, Play } from "lucide-react";
import { Badge, Card } from "@/components/ui";
import { getCurrentUser } from "@/server/auth";
import { getHikeOverview } from "@/server/hike/queries";
import { getRegionById } from "@/server/catalog/trails";
import { formatInZone } from "@/lib/time";

/**
 * CROSS-SLICE CONTRACT — implemented by the hike slice.
 * Shown on the trip dashboard (/trips/[id], commerce slice) for booked trips:
 * links to pre-hike checklist/download, start/resume hike, help, completion.
 * Server component; loads its own data.
 */
const step = "flex min-h-11 items-center gap-3 rounded-xl border border-sand-200 p-3 font-semibold text-ink hover:bg-forest-50";

export async function HikeActionsCard({ tripId }: { tripId: string }) {
  const user = await getCurrentUser();
  if (!user) return null;
  const o = await getHikeOverview(user, tripId);
  if (!o) return null;
  const { trip } = o;
  if (trip.status !== "booked" && trip.status !== "active" && trip.status !== "completed") return null;
  const base = `/trips/${trip.id}`;
  const tz = (await getRegionById(trip.regionId))?.timezone ?? "America/Los_Angeles";
  const fmt = (d: Date) => formatInZone(d, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <Card aria-labelledby="hike-actions-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="hike-actions-heading" className="text-xl font-bold">
          {trip.status === "completed" ? "Your hike" : trip.status === "active" ? "Hike in progress" : "Next steps for your hike"}
        </h2>
        {trip.status === "active" ? <Badge tone="blue">{o.openSession?.status === "paused" ? "Paused" : "Active"}</Badge> : null}
        {trip.status === "completed" ? <Badge tone="forest">Completed</Badge> : null}
      </div>

      {trip.status === "completed" ? (
        <div className="mt-4 space-y-3">
          <p className="flex items-center gap-2 text-muted">
            <CheckCircle2 aria-hidden className="size-5 text-forest-700" />
            {o.latestSession?.finishedAt ? `Finished ${fmt(o.latestSession.finishedAt)}.` : "Finished."}
          </p>
          <Link href={`${base}/complete`} className={step}>
            <MessageSquareHeart aria-hidden className="size-5 text-forest-700" />
            {o.feedback ? `Hike summary (you rated it ${o.feedback.rating}/5)` : "Hike summary & feedback"}
          </Link>
        </div>
      ) : (
        <ol className="mt-4 space-y-2">
          <li>
            <Link href={`${base}/prepare`} className={step}>
              <CloudDownload aria-hidden className="size-5 text-forest-700" />
              <span className="flex-1">
                Prepare &amp; download for offline use
                <span className="block text-sm font-normal text-muted">
                  {o.lastDownload
                    ? `Last download ${fmt(o.lastDownload.createdAt)} — ${o.lastDownload.verifiedComplete ? "verified complete" : "incomplete, download again"}`
                    : "Checklist, permits, phone check and offline download"}
                </span>
              </span>
            </Link>
          </li>
          <li>
            {/* Plain anchors: full page loads the service worker can serve offline. */}
            <a href={`${base}/hike`} className={`${step} border-forest-200 bg-forest-50`}>
              {trip.status === "active" ? <Play aria-hidden className="size-5 text-forest-700" /> : <Footprints aria-hidden className="size-5 text-forest-700" />}
              <span className="flex-1">
                {trip.status === "active" ? "Resume hike" : "Start hike"}
                <span className="block text-sm font-normal text-muted">
                  {trip.status === "active" && o.openSession ? `Started ${fmt(o.openSession.startedAt)}` : "Open at the trailhead"}
                </span>
              </span>
            </a>
          </li>
          <li>
            <a href={`${base}/help`} className={step}>
              <LifeBuoy aria-hidden className="size-5 text-red-ink" />
              <span className="flex-1">
                Help &amp; emergency info
                <span className="block text-sm font-normal text-muted">Last known location, how to call or text 911</span>
              </span>
            </a>
          </li>
        </ol>
      )}
    </Card>
  );
}
