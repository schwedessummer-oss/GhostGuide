import Link from "next/link";
import { ArrowRight, Clock, Mountain, Route } from "lucide-react";
import { formatDistance, formatDuration, formatElevation } from "@/domain/geo";
import { formatMoney } from "@/lib/format";
import { routeTypeLabel } from "@/domain/recommendation";
import type { Closure, Trail } from "@/domain/types";
import { worstClosure } from "@/server/discover/browse";
import { ClosureBadge, DemoBadge, DifficultyBadge } from "./badges";
import { humanize } from "./format";

export type TrailCardData = Pick<
  Trail,
  | "slug"
  | "name"
  | "summary"
  | "isDemo"
  | "status"
  | "distanceKm"
  | "elevationGainM"
  | "difficulty"
  | "estimatedDurationMin"
  | "terrain"
  | "routeType"
  | "basePriceCents"
  | "currency"
> & { activeClosures: Pick<Closure, "severity">[] };

export function TrailCard({ trail, headingLevel = 3, index }: { trail: TrailCardData; headingLevel?: 2 | 3; index?: number }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const severity = trail.status === "closed" ? "closed" : worstClosure(trail.activeClosures);
  return (
    <article className="group relative flex h-full flex-col rounded-[var(--radius-card)] border border-sand-200 bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-shadow hover:shadow-md focus-within:shadow-md">
      <div aria-hidden className="h-2 rounded-t-[var(--radius-card)] bg-gradient-to-r from-forest-700 via-forest-500 to-[#c9a96b]" />
      <div className="flex flex-1 flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          {index !== undefined ? (
            <span className="inline-flex size-7 items-center justify-center rounded-full bg-forest-800 text-sm font-bold text-white" aria-hidden>
              {index}
            </span>
          ) : null}
          <DifficultyBadge difficulty={trail.difficulty} />
          {trail.isDemo ? <DemoBadge /> : null}
          <ClosureBadge severity={severity} />
        </div>
        <div>
          <H className="text-xl font-bold text-ink">
            <Link
              href={`/trails/${trail.slug}`}
              className="after:absolute after:inset-0 after:rounded-[var(--radius-card)] after:content-[''] hover:text-forest-700 focus-visible:outline-none group-focus-within:underline"
            >
              {trail.name}
            </Link>
          </H>
          <p className="mt-1.5 line-clamp-2 text-[0.95rem] text-muted">{trail.summary}</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div>
            <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
              <Route aria-hidden className="size-3.5" /> Distance
            </dt>
            <dd className="mt-0.5 font-semibold">
              {formatDistance(trail.distanceKm * 1000)} <span className="text-xs font-normal text-muted">({formatDistance(trail.distanceKm * 1000, "metric")})</span>
            </dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
              <Mountain aria-hidden className="size-3.5" /> Elevation gain
            </dt>
            <dd className="mt-0.5 font-semibold">
              {formatElevation(trail.elevationGainM)} <span className="text-xs font-normal text-muted">({formatElevation(trail.elevationGainM, "metric")})</span>
            </dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
              <Clock aria-hidden className="size-3.5" /> Duration
            </dt>
            <dd className="mt-0.5 font-semibold">
              {formatDuration(trail.estimatedDurationMin)} <span className="font-normal text-muted">est.</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Route</dt>
            <dd className="mt-0.5 font-semibold">{routeTypeLabel(trail.routeType)}</dd>
          </div>
        </dl>
        <ul className="flex flex-wrap gap-1.5" aria-label="Terrain">
          {trail.terrain.map((t) => (
            <li key={t} className="rounded-full bg-sand-100 px-2.5 py-0.5 text-xs font-medium text-ink">
              {humanize(t)}
            </li>
          ))}
        </ul>
        <div className="mt-auto flex items-end justify-between gap-3 border-t border-sand-200 pt-4">
          <p className="text-sm text-muted">
            from <span className="text-lg font-bold text-ink">{formatMoney(trail.basePriceCents, trail.currency)}</span> / person
          </p>
          <span aria-hidden className="inline-flex items-center gap-1 text-sm font-semibold text-forest-700">
            Details <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>
      </div>
    </article>
  );
}
