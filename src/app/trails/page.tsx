import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { List, Map as MapIcon } from "lucide-react";
import clsx from "clsx";
import { Alert, ButtonLink, Container, EmptyState, PageHeader, SimulatedBadge } from "@/components/ui";
import { TrailCard } from "@/components/discover/trail-card";
import { TrailFiltersPanel } from "@/components/discover/trail-filters";
import { TrailsOverviewMap, type OverviewMapTrail } from "@/components/map/trails-overview-map";
import { ClosureBadge } from "@/components/discover/badges";
import { distanceBoth } from "@/components/discover/format";
import { getLaunchRegion, listTrails } from "@/server/catalog/trails";
import { describeFilters, filterTrails, filtersToQuery, parseTrailFilters, worstClosure } from "@/server/discover/browse";
import { showDemoFixtures } from "@/config/env";
import { TERRAIN_OPTIONS } from "@/domain/types";

export const metadata: Metadata = {
  title: "Find a trail",
  description: "Browse self-guided hikes by difficulty, distance, elevation gain, terrain, accessibility and dog policy.",
};

export default async function TrailsPage({ searchParams }: PageProps<"/trails">) {
  // The fictional demo region is a development fixture; real trails live on Explore.
  if (!showDemoFixtures()) redirect("/explore");
  const filters = parseTrailFilters(await searchParams);
  const region = await getLaunchRegion();
  const all = await listTrails(region.id);
  const trails = filterTrails(all, filters);
  const terrains = TERRAIN_OPTIONS.filter((t) => all.some((tr) => tr.terrain.includes(t)));
  const applied = describeFilters(filters);
  const isMap = filters.view === "map";

  const numbered = trails.map((t, i) => ({ trail: t, number: i + 1, closed: t.status === "closed" || worstClosure(t.activeClosures) === "closed" }));
  const mapTrails: OverviewMapTrail[] = numbered
    .filter(({ trail }) => trail.geometry && trail.geometry.coordinates.length >= 2)
    .map(({ trail, number, closed }) => ({
      slug: trail.slug,
      name: trail.name,
      number,
      summary: trail.summary,
      coordinates: trail.geometry!.coordinates.map((c) => [c[0], c[1]] as [number, number]),
      trailhead: { lat: trail.trailheadLat, lng: trail.trailheadLng },
      closed,
    }));

  const viewLink = (view: "list" | "map", label: string, Icon: typeof List) => {
    const active = filters.view === view;
    return (
      <Link
        href={`/trails${filtersToQuery(filters, { view })}`}
        aria-current={active ? "page" : undefined}
        className={clsx(
          "inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg px-4 font-semibold sm:flex-none",
          active ? "bg-forest-700 text-white" : "text-forest-800 hover:bg-forest-50",
        )}
      >
        <Icon aria-hidden className="size-4" />
        {label}
      </Link>
    );
  };

  return (
    <Container className="py-10">
      <PageHeader
        eyebrow={/demo/i.test(region.name) ? `${region.name} · fictional` : `${region.name} · demo region (fictional)`}
        title="Find a trail"
        description={
          <>
            Every trail in this demo region is <strong>fictional</strong> and not for navigation. Durations are catalog estimates; get a personal
            estimate by <Link className="font-semibold text-forest-800 underline" href="/plan">planning your hike</Link>.
          </>
        }
        actions={<ButtonLink href="/plan">Plan my hike</ButtonLink>}
      />
      {region.isDemo ? (
        <Alert tone="amber" className="mb-6" title="Demonstration region">
          Ghost Ridge and its trails, facts and stories are invented to show how Ghost Guide works. <SimulatedBadge label="Demo data" />
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <TrailFiltersPanel filters={filters} terrains={terrains} />
        <section aria-labelledby="results-heading" className="min-w-0">
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 id="results-heading" className="text-xl font-bold">
                {trails.length} {trails.length === 1 ? "trail" : "trails"}
                {applied.length ? (trails.length === 1 ? " matches your filters" : " match your filters") : ""}
              </h2>
              {applied.length ? <p className="text-sm text-muted">{applied.join(" · ")}</p> : null}
            </div>
            <nav aria-label="Results view" className="flex gap-1 rounded-xl border border-sand-200 bg-surface p-1">
              {viewLink("list", "List", List)}
              {viewLink("map", "Map", MapIcon)}
            </nav>
          </div>

          {trails.length === 0 ? (
            <EmptyState
              title="No trails match these filters"
              action={
                <ButtonLink href={isMap ? "/trails?view=map" : "/trails"} variant="secondary">
                  Clear filters
                </ButtonLink>
              }
            >
              Try removing a filter. We only list trails in our catalog; we never generate routes.
            </EmptyState>
          ) : isMap ? (
            <div className="space-y-6">
              <figure>
                <TrailsOverviewMap trails={mapTrails} label={`Map of ${mapTrails.length} fictional trail routes in ${region.name}`} />
                <figcaption className="mt-2 text-sm text-muted">
                  Demonstration routes drawn on a real basemap: the trails are fictional and not for navigation. Dashed routes are closed.
                </figcaption>
              </figure>
              <div>
                <h3 className="mb-3 text-lg font-bold">Trails on the map</h3>
                <ol className="divide-y divide-sand-200 rounded-[var(--radius-card)] border border-sand-200 bg-surface">
                  {numbered.map(({ trail, number }) => (
                    <li key={trail.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-4">
                      <span aria-hidden className="inline-flex size-7 items-center justify-center rounded-full bg-forest-800 text-sm font-bold text-white">
                        {number}
                      </span>
                      <Link href={`/trails/${trail.slug}`} className="inline-flex min-h-11 items-center font-semibold text-forest-800 underline-offset-2 hover:underline">
                        <span className="sr-only">{number}. </span>
                        {trail.name}
                      </Link>
                      <span className="text-sm text-muted">
                        {distanceBoth(trail.distanceKm)} · trailhead: {trail.trailheadName ?? "unnamed"}
                      </span>
                      <ClosureBadge severity={trail.status === "closed" ? "closed" : worstClosure(trail.activeClosures)} />
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          ) : (
            <ul className="grid gap-5 sm:grid-cols-2">
              {trails.map((t) => (
                <li key={t.id}>
                  <TrailCard trail={t} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Container>
  );
}
