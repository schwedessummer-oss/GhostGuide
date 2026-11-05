import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";
import { Button, Checkbox, Select } from "@/components/ui";
import { ACCESSIBILITY_FEATURES } from "@/domain/types";
import { DIFFICULTIES, activeFilterCount, featureLabel, type TrailFilters } from "@/server/discover/browse";
import { humanize } from "./format";

const DISTANCE_OPTIONS = [3, 5, 8, 12];
const GAIN_OPTIONS = [500, 1000, 2000, 3000];

/** GET form: works without JavaScript; filters live in the URL. */
function FilterForm({ filters, terrains, idPrefix }: { filters: TrailFilters; terrains: string[]; idPrefix: string }) {
  const id = (s: string) => `${idPrefix}${s}`;
  return (
    <form method="get" action="/trails" className="space-y-6" aria-label="Filter trails">
      {filters.view === "map" ? <input type="hidden" name="view" value="map" /> : null}
      <fieldset>
        <legend className="mb-1 font-semibold">Difficulty</legend>
        <div className="grid grid-cols-2 gap-x-2">
          {DIFFICULTIES.map((d) => (
            <Checkbox key={d} name="difficulty" value={d} label={humanize(d)} defaultChecked={filters.difficulty.includes(d)} />
          ))}
        </div>
      </fieldset>
      <div className="space-y-1.5">
        <label htmlFor={id("maxMi")} className="block font-semibold">
          Maximum distance
        </label>
        <Select id={id("maxMi")} name="maxMi" defaultValue={filters.maxMi ? String(filters.maxMi) : ""}>
          <option value="">Any distance</option>
          {DISTANCE_OPTIONS.map((mi) => (
            <option key={mi} value={mi}>
              Up to {mi} mi ({Math.round(mi * 1.609344)} km)
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <label htmlFor={id("maxGainFt")} className="block font-semibold">
          Maximum elevation gain
        </label>
        <Select id={id("maxGainFt")} name="maxGainFt" defaultValue={filters.maxGainFt ? String(filters.maxGainFt) : ""}>
          <option value="">Any elevation gain</option>
          {GAIN_OPTIONS.map((ft) => (
            <option key={ft} value={ft}>
              Up to {ft.toLocaleString("en-US")} ft ({Math.round(ft * 0.3048)} m)
            </option>
          ))}
        </Select>
      </div>
      <fieldset>
        <legend className="mb-1 font-semibold">Terrain</legend>
        <p className="mb-1 text-sm text-muted">Shows trails with any selected terrain.</p>
        <div className="grid grid-cols-2 gap-x-2">
          {terrains.map((t) => (
            <Checkbox key={t} name="terrain" value={t} label={humanize(t)} defaultChecked={filters.terrain.includes(t)} />
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-1 font-semibold">Accessibility features</legend>
        <p className="mb-1 text-sm text-muted">Shows trails with every selected feature recorded. Always verify on site.</p>
        {ACCESSIBILITY_FEATURES.map((f) => (
          <Checkbox key={f} name="access" value={f} label={featureLabel(f)} defaultChecked={filters.access.includes(f)} />
        ))}
      </fieldset>
      <fieldset>
        <legend className="mb-1 font-semibold">Dogs</legend>
        <Checkbox name="dogs" value="yes" label="Dogs allowed" defaultChecked={filters.dogs} />
      </fieldset>
      <div className="flex flex-wrap gap-3">
        <Button type="submit">Apply filters</Button>
        <Link href={filters.view === "map" ? "/trails?view=map" : "/trails"} className="inline-flex min-h-11 items-center rounded-xl px-3 font-semibold text-forest-800 underline-offset-2 hover:underline">
          Clear all
        </Link>
      </div>
    </form>
  );
}

export function TrailFiltersPanel({ filters, terrains }: { filters: TrailFilters; terrains: string[] }) {
  const count = activeFilterCount(filters);
  return (
    <>
      {/* Mobile: collapsible, no JavaScript required */}
      <details className="rounded-[var(--radius-card)] border border-sand-200 bg-surface lg:hidden" open={count > 0 ? true : undefined}>
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-4 font-semibold [&::-webkit-details-marker]:hidden">
          <span className="inline-flex items-center gap-2">
            <SlidersHorizontal aria-hidden className="size-5" /> Filters
          </span>
          <span className="text-sm font-medium text-muted">{count ? `${count} active` : "None applied"}</span>
        </summary>
        <div className="border-t border-sand-200 p-4">
          <FilterForm filters={filters} terrains={terrains} idPrefix="m-" />
        </div>
      </details>
      {/* Desktop sidebar */}
      <aside className="hidden lg:block" aria-label="Trail filters">
        <div className="sticky top-4 rounded-[var(--radius-card)] border border-sand-200 bg-surface p-5">
          <h2 className="mb-4 flex items-center gap-2 text-lg font-bold">
            <SlidersHorizontal aria-hidden className="size-5" /> Filters
          </h2>
          <FilterForm filters={filters} terrains={terrains} idPrefix="d-" />
        </div>
      </aside>
    </>
  );
}
