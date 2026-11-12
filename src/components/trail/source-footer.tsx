import { ExternalLink } from "lucide-react";
import type { TrailDetailDto } from "@/domain/catalog";
import { formatRelativeAge, osmFeatureFromUrl } from "./format";

const link = "font-medium text-forest-800 underline underline-offset-2 hover:text-forest-900";

/**
 * Source, licence and freshness for the trail page, plus how to correct the
 * data at its source (OpenStreetMap edits flow back on the next refresh).
 */
export function SourceFooter({ trail, now = new Date() }: { trail: TrailDetailDto; now?: Date }) {
  const osm = osmFeatureFromUrl(trail.sourceUrl);
  const elevation = trail.attribution.find((a) => a.name.startsWith("Elevation:"));
  const isOsm = trail.provider === "osm";
  const synced = formatRelativeAge(trail.lastSyncedAt, now);

  return (
    <div className="space-y-3 text-sm text-muted">
      <p>
        {isOsm ? (
          <>
            Trail data ©{" "}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className={link}>
              OpenStreetMap contributors
            </a>{" "}
            ({trail.sourceLicense})
          </>
        ) : (
          <>
            Trail data: {trail.sourceName} ({trail.sourceLicense})
          </>
        )}
        {" · "}
        <time dateTime={trail.lastSyncedAt}>last updated in Ghost Guide {synced}</time>
        {trail.sourceUpdatedAt ? (
          <>
            {" · "}
            <time dateTime={trail.sourceUpdatedAt}>source last edited {formatRelativeAge(trail.sourceUpdatedAt, now)}</time>
          </>
        ) : null}
        {trail.sourceUrl ? (
          <>
            {" · "}
            <a href={trail.sourceUrl} target="_blank" rel="noopener noreferrer" className={link}>
              {isOsm ? "View/edit on OpenStreetMap" : `View on ${trail.sourceName}`}
            </a>
          </>
        ) : null}
      </p>
      {elevation ? (
        <p>
          {elevation.url ? (
            <a href={elevation.url} target="_blank" rel="noopener noreferrer" className={link}>
              {elevation.name}
            </a>
          ) : (
            elevation.name
          )}
          . Elevation, climb, moving time and estimated difficulty are calculated by Ghost Guide.
        </p>
      ) : null}
      {osm ? (
        <div className="rounded-xl border border-sand-200 bg-surface px-4 py-3">
          <p className="font-semibold text-ink">Data looks wrong?</p>
          <p className="mt-1">
            This trail comes from OpenStreetMap, the map anyone can edit. Fix it at the source and the correction reaches Ghost Guide on the
            next refresh of this area.{" "}
            <a href={osm.url} target="_blank" rel="noopener noreferrer" className={`${link} inline-flex items-center gap-1`}>
              Open this {osm.type} on OpenStreetMap <ExternalLink aria-hidden className="size-3.5" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </p>
        </div>
      ) : null}
    </div>
  );
}
