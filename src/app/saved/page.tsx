import type { Metadata } from "next";
import Link from "next/link";
import { Bookmark, MapPin } from "lucide-react";
import { ButtonLink, Container, EmptyState, PageHeader } from "@/components/ui";
import {
  difficultyLabel,
  difficultyQualifier,
  formatDurationEstimate,
  formatRelativeAge,
  hikeFormLabel,
  locationParts,
} from "@/components/trail/format";
import { Measure } from "@/components/trail/measure";
import { UnitsSync } from "@/components/trail/units-toggle";
import type { TrailSummaryDto } from "@/domain/catalog";
import { requireUser } from "@/server/auth";
import { getTrailSummariesByIds } from "@/server/trails/read";
import { listSavedTrails, type SavedTrailRef } from "@/server/trails/saved";
import { removeSavedTrail } from "./actions";
import { RemoveSavedButton } from "./remove-button";

export const metadata: Metadata = { title: "Saved trails", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

function RemoveForm({ trailId, trailName }: { trailId: string; trailName: string }) {
  return (
    <form action={removeSavedTrail} className="shrink-0">
      <input type="hidden" name="trailId" value={trailId} />
      <RemoveSavedButton trailName={trailName} />
    </form>
  );
}

function SavedTrailRow({ saved, trail }: { saved: SavedTrailRef; trail: TrailSummaryDto }) {
  const duration = formatDurationEstimate(trail.hikeDurationMin);
  const qualifier = difficultyQualifier(trail.difficultySource, null, trail.hikeGainM !== null);
  const location = locationParts(trail);
  return (
    <li className="flex items-start justify-between gap-2 py-4 pl-4 pr-2 sm:gap-4 sm:px-5">
      <div className="min-w-0">
        <h2 className="text-lg font-bold leading-snug text-ink">
          <Link href={trail.path} className="underline-offset-4 hover:underline">
            {trail.name}
          </Link>
        </h2>
        {location.length ? (
          <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
            <MapPin aria-hidden className="size-3.5 shrink-0" /> {location.join(" · ")}
          </p>
        ) : null}
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[0.95rem] tabular-nums text-ink">
          <span>
            <Measure value={trail.hikeDistanceM} kind="distance" />{" "}
            <span className="text-muted">{hikeFormLabel(trail.routeType).toLowerCase()}</span>
          </span>
          {trail.hikeGainM !== null ? (
            <span>
              <Measure value={trail.hikeGainM} kind="climb" /> <span className="text-muted">climb</span>
            </span>
          ) : null}
          {duration ? (
            <span>
              ≈ {duration}
              {trail.hikeGainM === null ? <span className="text-muted"> · distance only</span> : null}
            </span>
          ) : null}
          {trail.difficulty !== "unknown" ? (
            <span>
              {difficultyLabel(trail.difficulty)}
              {qualifier ? <span className="text-muted"> · {qualifier}</span> : null}
            </span>
          ) : null}
        </p>
        <p className="mt-1.5 text-xs text-muted">
          Saved <time dateTime={saved.savedAt}>{formatRelativeAge(saved.savedAt)}</time>
        </p>
      </div>
      <RemoveForm trailId={trail.id} trailName={trail.name} />
    </li>
  );
}

function UnavailableRow({ saved }: { saved: SavedTrailRef }) {
  return (
    <li className="flex items-start justify-between gap-2 py-4 pl-4 pr-2 sm:gap-4 sm:px-5">
      <div>
        <p className="font-semibold text-muted">No longer available</p>
        <p className="mt-0.5 text-sm text-muted">
          This trail was removed from the map data or hidden after review. Saved{" "}
          <time dateTime={saved.savedAt}>{formatRelativeAge(saved.savedAt)}</time>.
        </p>
      </div>
      <RemoveForm trailId={saved.trailId} trailName="this unavailable trail" />
    </li>
  );
}

export default async function SavedTrailsPage() {
  const user = await requireUser("/saved");
  const saved = await listSavedTrails(user);
  const summaries = await getTrailSummariesByIds(saved.map((s) => s.trailId));
  const byId = new Map(summaries.map((t) => [t.id.toLowerCase(), t]));

  return (
    <Container className="max-w-3xl py-8 sm:py-10">
      <UnitsSync />
      <PageHeader
        title="Saved trails"
        description={saved.length ? `${saved.length} ${saved.length === 1 ? "trail" : "trails"}, newest first.` : undefined}
        actions={
          saved.length ? (
            <ButtonLink href="/explore" variant="secondary">
              Explore trails
            </ButtonLink>
          ) : null
        }
      />
      {saved.length === 0 ? (
        <EmptyState
          title="Save trails you like and find them here"
          action={
            <ButtonLink href="/explore" size="lg">
              Explore trails
            </ButtonLink>
          }
        >
          <span className="inline-flex items-center gap-1.5">
            Tap <Bookmark aria-hidden className="size-4" /> Save on any trail page.
          </span>
        </EmptyState>
      ) : (
        <ul className="divide-y divide-sand-200 overflow-hidden rounded-[var(--radius-card)] border border-sand-200 bg-surface">
          {saved.map((s) => {
            const trail = byId.get(s.trailId.toLowerCase());
            return trail ? <SavedTrailRow key={s.trailId} saved={s} trail={trail} /> : <UnavailableRow key={s.trailId} saved={s} />;
          })}
        </ul>
      )}
    </Container>
  );
}
