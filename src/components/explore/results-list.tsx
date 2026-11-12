"use client";

import Link from "next/link";
import clsx from "clsx";
import { Clock, MapPinOff, RotateCw, Route, SearchX, TrendingUp, ZoomIn } from "lucide-react";
import type { CoverageDto, TrailSummaryDto } from "@/domain/catalog";
import { MAP_ATTRIBUTION } from "@/config/public";
import type { Units } from "@/lib/units";
import { FeatureIcons, Spinner, TrailDifficulty } from "./bits";
import { climbText, durationText, englishName, formatAgo, hikeDistanceText, placeLine } from "./format";

export type SearchStatus = "idle" | "loading" | "ready" | "error";

/** Hike numbers in one line: distance + route form · climb · moving time. */
export function TrailStats({ trail, units, className }: { trail: TrailSummaryDto; units: Units; className?: string }) {
  const climb = climbText(trail, units);
  const time = durationText(trail);
  return (
    <p className={clsx("flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.95rem] text-ink", className)}>
      <span className="inline-flex items-center gap-1.5">
        <Route aria-hidden className="size-4 text-muted" />
        <span className="sr-only">Distance: </span>
        {hikeDistanceText(trail, units)}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <TrendingUp aria-hidden className="size-4 text-muted" />
        <span className="sr-only">Climb: </span>
        {climb ?? <span className="text-muted">Climb unknown</span>}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Clock aria-hidden className="size-4 text-muted" />
        <span className="sr-only">Estimated moving time: </span>
        {time ?? <span className="text-muted">Time unknown</span>}
      </span>
    </p>
  );
}

function ResultItem({
  trail,
  units,
  selected,
  onHover,
}: {
  trail: TrailSummaryDto;
  units: Units;
  selected: boolean;
  onHover: (id: string | null) => void;
}) {
  const en = englishName(trail);
  const place = placeLine(trail);
  return (
    <li data-trail-id={trail.id}>
      <Link
        href={trail.path}
        onMouseEnter={() => onHover(trail.id)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(trail.id)}
        onBlur={() => onHover(null)}
        aria-current={selected ? "true" : undefined}
        className={clsx(
          "group block px-4 py-3.5 transition-colors focus-visible:-outline-offset-2 sm:px-5",
          selected ? "bg-forest-50 shadow-[inset_4px_0_0_var(--color-forest-700)]" : "hover:bg-canvas",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base leading-snug font-semibold text-ink group-hover:underline group-hover:underline-offset-2">{trail.name}</h3>
            {en ? <p className="text-sm text-muted">{en}</p> : null}
            {place ? <p className="text-sm text-muted">{place}</p> : null}
          </div>
          <TrailDifficulty difficulty={trail.difficulty} source={trail.difficultySource} className="mt-0.5" />
        </div>
        <div className="mt-2 flex items-end justify-between gap-3">
          <TrailStats trail={trail} units={units} />
          <FeatureIcons features={trail.features} className="shrink-0" />
        </div>
      </Link>
    </li>
  );
}

export function SkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <ul aria-hidden className="divide-y divide-sand-200">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="px-4 py-4 sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 space-y-2">
              <div className="h-4 w-3/5 rounded bg-sand-200 motion-safe:animate-pulse" />
              <div className="h-3 w-2/5 rounded bg-sand-100 motion-safe:animate-pulse" />
            </div>
            <div className="h-5 w-16 rounded-full bg-sand-100 motion-safe:animate-pulse" />
          </div>
          <div className="mt-3 h-3.5 w-4/5 rounded bg-sand-100 motion-safe:animate-pulse" />
        </li>
      ))}
    </ul>
  );
}

function Notice({ icon, title, children, action }: { icon: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="px-5 py-8 text-center">
      <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full bg-sand-100 text-forest-800">{icon}</div>
      <p className="font-semibold text-ink">{title}</p>
      {children ? <div className="mx-auto mt-1.5 max-w-sm text-[0.95rem] text-muted">{children}</div> : null}
      {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

const secondaryButton =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-forest-200 bg-surface px-4 font-semibold text-forest-800 hover:bg-forest-50";

export interface ResultsListProps {
  status: SearchStatus;
  error: string | null;
  trails: TrailSummaryDto[];
  coverage: CoverageDto | null;
  units: Units;
  selectedId: string | null;
  filtersActive: boolean;
  onHover: (id: string | null) => void;
  onRetry: () => void;
  onClearFilters: () => void;
  /** Rendered when nothing has been searched yet. */
  intro: React.ReactNode;
}

/** The trail list and its loading, empty and error states (the text alternative to the map). */
export function ResultsList({ status, error, trails, coverage, units, selectedId, filtersActive, onHover, onRetry, onClearFilters, intro }: ResultsListProps) {
  if (status === "idle") return <>{intro}</>;
  if (status === "loading") return <SkeletonRows />;
  if (status === "error") {
    return (
      <Notice
        icon={<SearchX aria-hidden className="size-5" />}
        title="Trail search is unavailable right now"
        action={
          <button type="button" onClick={onRetry} className={secondaryButton}>
            <RotateCw aria-hidden className="size-4" /> Try again
          </button>
        }
      >
        {error ?? "We couldn’t reach the trail catalog."} Nothing is shown rather than old or made-up results.
      </Notice>
    );
  }
  if (!trails.length) {
    if (coverage?.state === "loading") {
      return (
        <div>
          <p className="flex items-center gap-2 px-5 pt-4 text-sm text-muted">
            <Spinner /> Loading trails for this area from OpenStreetMap. The first load can take a minute.
          </p>
          <SkeletonRows count={3} />
        </div>
      );
    }
    if (coverage?.state === "too_large") {
      return (
        <Notice icon={<ZoomIn aria-hidden className="size-5" />} title="Zoom in to load trails here">
          This area is too big to load at once. Zoom in on the map, then choose “Search this area”, or search for a town or park.
        </Notice>
      );
    }
    if (coverage?.state === "failed") {
      return (
        <Notice
          icon={<MapPinOff aria-hidden className="size-5" />}
          title="Trails for this area couldn’t be loaded"
          action={
            <button type="button" onClick={onRetry} className={secondaryButton}>
              <RotateCw aria-hidden className="size-4" /> Try again
            </button>
          }
        >
          {coverage.message}
        </Notice>
      );
    }
    return (
      <Notice
        icon={<MapPinOff aria-hidden className="size-5" />}
        title="No mapped trails in this area yet"
        action={
          filtersActive ? (
            <button type="button" onClick={onClearFilters} className={secondaryButton}>
              Clear filters
            </button>
          ) : null
        }
      >
        <ul className="mt-1 space-y-1 text-left sm:text-center">
          <li>Zoom out or move the map, then search this area.</li>
          {filtersActive ? <li>Clear some filters: many trails have no fee, dog or facility data yet.</li> : null}
          <li>Try a nearby town, park or mountain by name.</li>
        </ul>
      </Notice>
    );
  }

  return (
    <ul className="divide-y divide-sand-200">
      {trails.map((t) => (
        <ResultItem key={t.id} trail={t} units={units} selected={t.id === selectedId} onHover={onHover} />
      ))}
    </ul>
  );
}

/** Source attribution and freshness under the list. */
export function ListFooter({ coverage, capped }: { coverage: CoverageDto | null; capped: boolean }) {
  const updated = formatAgo(coverage?.oldestSyncAt ?? null);
  return (
    <div className="space-y-1.5 border-t border-sand-200 px-4 py-4 text-xs text-muted sm:px-5">
      {capped ? <p className="text-sm font-medium text-ink">Zoom in to see more trails in this area.</p> : null}
      <p>
        Trail data{" "}
        <a href={MAP_ATTRIBUTION.osm.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-ink">
          {MAP_ATTRIBUTION.osm.label}
        </a>
        {updated ? ` · updated ${updated}` : ""}
      </p>
      <p>Times are moving-time estimates. Distances and climbs come from mapped routes and elevation data; check conditions before you go.</p>
    </div>
  );
}
