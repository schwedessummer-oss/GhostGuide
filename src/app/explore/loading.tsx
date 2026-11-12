import { SkeletonRows } from "@/components/explore/results-list";

/** Shown while the server searches (place lookup + first results). Same frame as the page, so nothing jumps. */
export default function ExploreLoading() {
  return (
    <div data-app-fullscreen className="relative min-h-0 flex-1 overflow-hidden bg-sand-100 lg:grid lg:grid-cols-[400px_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)]">
      <div className="absolute inset-x-0 top-0 z-30 space-y-2 p-3 lg:static lg:col-start-1 lg:row-start-1 lg:space-y-3 lg:border-r lg:border-b lg:border-sand-200 lg:bg-surface lg:p-4">
        <div className="h-[3.25rem] rounded-2xl bg-surface shadow-[0_2px_10px_rgba(15,35,24,0.16)] ring-1 ring-sand-200 lg:shadow-none" />
        <div className="flex gap-2">
          <div className="h-11 w-28 rounded-full bg-surface ring-1 ring-sand-200" />
          <div className="h-11 w-28 rounded-full bg-surface ring-1 ring-sand-200" />
        </div>
      </div>
      <section
        aria-busy="true"
        aria-label="Loading trails"
        className="absolute inset-x-0 bottom-0 z-20 flex h-48 flex-col rounded-t-2xl bg-surface shadow-[0_-6px_24px_rgba(15,35,24,0.14)] lg:static lg:col-start-1 lg:row-start-2 lg:h-auto lg:rounded-none lg:border-r lg:border-sand-200 lg:shadow-none"
      >
        <div className="border-b border-sand-200 px-4 pt-6 pb-3 sm:px-5 lg:pt-4">
          <p role="status" className="text-lg font-bold text-ink">
            Searching…
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <SkeletonRows />
        </div>
      </section>
      <div aria-hidden className="absolute inset-0 z-0 bg-[#eae6dc] lg:static lg:col-start-2 lg:row-span-2 lg:row-start-1" />
    </div>
  );
}
