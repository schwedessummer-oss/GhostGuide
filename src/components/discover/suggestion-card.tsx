import Link from "next/link";
import clsx from "clsx";
import { Bot, Check, Clock, Droplets, Flag, Footprints, Gauge, MapPin, RotateCcw, Sparkles, TriangleAlert } from "lucide-react";
import { Badge, SimulatedBadge } from "@/components/ui";
import { formatDuration } from "@/domain/geo";
import { routeTypeLabel } from "@/domain/recommendation";
import { addMinutesToClock } from "@/lib/time";
import { formatMoney } from "@/lib/format";
import type { AiText } from "@/integrations/ai/types";
import type { PlanSuggestion } from "@/server/discover/plan";
import { saveTripAction } from "@/app/plan/actions";
import { DemoBadge, DifficultyBadge } from "./badges";
import { distanceBoth, elevationBoth } from "./format";
import { SaveTripButton } from "./save-trip-button";

function ScoreMeter({ score }: { score: number }) {
  return (
    <div className="min-w-32">
      <p className="text-right">
        <span className="text-3xl font-bold text-forest-800">{score}</span>
        <span className="text-muted"> / 100</span>
      </p>
      <div aria-hidden className="mt-1 h-2 w-full overflow-hidden rounded-full bg-sand-200">
        <div className="h-full rounded-full bg-forest-600" style={{ width: `${Math.max(2, score)}%` }} />
      </div>
      <p className="mt-1 text-right text-xs text-muted">match score</p>
    </div>
  );
}

export function SuggestionCard({
  suggestion,
  explanation,
  query,
  signedIn,
  highlighted,
  saveError,
}: {
  suggestion: PlanSuggestion;
  explanation: AiText;
  query: string;
  signedIn: boolean;
  highlighted: boolean;
  saveError?: string | null;
}) {
  const { trail, result, itinerary, rank } = suggestion;
  const headingId = `trail-${trail.id}-heading`;
  const start = itinerary.startTime;
  return (
    <article
      id={`trail-${trail.id}`}
      aria-labelledby={headingId}
      className={clsx(
        "scroll-mt-6 rounded-[var(--radius-card)] border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
        highlighted ? "border-forest-600 ring-2 ring-forest-200" : "border-sand-200",
      )}
    >
      <header className="flex flex-col gap-4 border-b border-sand-200 p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="forest">#{rank} suggestion</Badge>
            <DifficultyBadge difficulty={trail.difficulty} />
            {trail.isDemo ? <DemoBadge /> : null}
            {highlighted ? <Badge tone="blue">The trail you asked about</Badge> : null}
          </div>
          <h2 id={headingId} className="mt-2 text-2xl font-bold">
            <Link href={`/trails/${trail.slug}`} className="hover:text-forest-700 hover:underline">
              {trail.name}
            </Link>
          </h2>
          <p className="mt-1 text-muted">{trail.summary}</p>
        </div>
        <ScoreMeter score={result.score} />
      </header>

      <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-6">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl bg-sand-100 p-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Distance</dt>
              <dd className="mt-0.5 font-semibold">{distanceBoth(trail.distanceKm)}</dd>
            </div>
            <div className="rounded-xl bg-sand-100 p-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Elevation gain</dt>
              <dd className="mt-0.5 font-semibold">{elevationBoth(trail.elevationGainM)}</dd>
            </div>
            <div className="rounded-xl bg-sand-100 p-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Your time (est.)</dt>
              <dd className="mt-0.5 font-semibold">{formatDuration(result.estimatedDurationMin)}</dd>
            </div>
            <div className="rounded-xl bg-sand-100 p-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Route</dt>
              <dd className="mt-0.5 font-semibold">{routeTypeLabel(trail.routeType)}</dd>
            </div>
          </dl>

          {result.reasons.length ? (
            <div>
              <h3 className="mb-2 font-bold">Why it fits</h3>
              <ul className="space-y-1.5">
                {result.reasons.map((r) => (
                  <li key={r} className="flex items-start gap-2">
                    <Check aria-hidden className="mt-1 size-4 shrink-0 text-forest-600" />
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {result.warnings.length ? (
            <div>
              <h3 className="mb-2 font-bold">Notes to review</h3>
              <ul className="space-y-1.5">
                {result.warnings.map((w) => (
                  <li key={w} className="flex items-start gap-2 text-[0.95rem]">
                    <TriangleAlert aria-hidden className="mt-1 size-4 shrink-0 text-amber-ink" />
                    <span>
                      <span className="sr-only">Note: </span>
                      {w}
                    </span>
                  </li>
                ))}
              </ul>
              {suggestion.permits.length ? (
                <ul className="mt-2 space-y-1">
                  {suggestion.permits.map((p) => (
                    <li key={p.name}>
                      <a href={p.officialUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-semibold text-forest-800 underline">
                        Official page: {p.name}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <details className="rounded-xl border border-sand-200">
            <summary className="flex min-h-11 cursor-pointer items-center px-4 font-semibold">How the score of {result.score} was calculated</summary>
            <div className="overflow-x-auto px-4 pb-4">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Score breakdown for {trail.name}</caption>
                <thead>
                  <tr className="border-b border-sand-200 text-muted">
                    <th scope="col" className="py-2 pr-3 font-semibold">Factor</th>
                    <th scope="col" className="py-2 pr-3 font-semibold">Points</th>
                    <th scope="col" className="py-2 font-semibold">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {result.breakdown.map((f) => (
                    <tr key={f.factor} className="border-b border-sand-100 align-top">
                      <th scope="row" className="py-2 pr-3 font-semibold">{f.factor}</th>
                      <td className="whitespace-nowrap py-2 pr-3">{f.max > 0 ? `${f.points} of ${f.max}` : f.points === 0 ? "0" : `${f.points}`}</td>
                      <td className="py-2 text-muted">{f.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted">Scores come from fixed, published rules (no AI). Ties are ordered by trail name.</p>
            </div>
          </details>
        </div>

        <div className="space-y-6">
          <section aria-labelledby={`${headingId}-itinerary`} className="rounded-xl bg-forest-50 p-4">
            <h3 id={`${headingId}-itinerary`} className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-bold">
              <Footprints aria-hidden className="size-5 text-forest-700" /> Suggested itinerary
              <span className="text-sm font-normal text-muted">(all times est.)</span>
            </h3>
            <ol className="relative space-y-3 border-l-2 border-forest-200 pl-5">
              <li>
                <span aria-hidden className="absolute -left-[7px] mt-1.5 size-3 rounded-full bg-forest-800" />
                <p className="font-semibold">
                  <MapPin aria-hidden className="mr-1 inline size-4" />
                  {start} · Start at {trail.trailheadName ?? "the trailhead"}
                </p>
              </li>
              {itinerary.stops
                .filter((s) => !suggestion.trailheadPoiIds.includes(s.poiId))
                .map((s) => (
                  <li key={s.poiId}>
                    <span aria-hidden className="absolute -left-[6px] mt-1.5 size-2.5 rounded-full border-2 border-forest-700 bg-white" />
                    <p>
                      <span className="font-semibold">≈ {addMinutesToClock(start, s.etaOffsetMin)}</span> · {s.name}
                    </p>
                  </li>
                ))}
              {itinerary.turnaroundBy ? (
                <li>
                  <span aria-hidden className="absolute -left-[7px] mt-1.5 size-3 rounded-full bg-amber-ink" />
                  <p className="font-semibold text-amber-ink">
                    <RotateCcw aria-hidden className="mr-1 inline size-4" />
                    Turn around by {itinerary.turnaroundBy}, even if you haven&apos;t reached the far end
                  </p>
                </li>
              ) : null}
              <li>
                <span aria-hidden className="absolute -left-[7px] mt-1.5 size-3 rounded-full bg-forest-800" />
                <p className="font-semibold">
                  <Flag aria-hidden className="mr-1 inline size-4" />≈ {itinerary.estimatedFinishTime} · Finish (about {formatDuration(itinerary.estimatedDurationMin)})
                </p>
              </li>
            </ol>
            <ul className="mt-4 space-y-1 text-sm">
              <li className="flex items-center gap-2">
                <Droplets aria-hidden className="size-4 text-blue-ink" /> Drink reminder every {itinerary.reminders.hydrationEveryMin} min
              </li>
              <li className="flex items-center gap-2">
                <Gauge aria-hidden className="size-4 text-forest-700" /> Pace check every {itinerary.reminders.paceCheckEveryMin} min
              </li>
              <li className="flex items-center gap-2">
                <Clock aria-hidden className="size-4 text-muted" /> Pace factor ×{itinerary.paceFactor.toFixed(2)} applied to the catalog estimate
              </li>
            </ul>
            <p className="mt-2 text-xs text-muted">Reminders are general prompts, not medical advice.</p>
            <details className="mt-3">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">Planning notes ({itinerary.notes.length})</summary>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                {itinerary.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </details>
          </section>

          <section aria-labelledby={`${headingId}-ai`} className="rounded-xl border border-sand-200 p-4">
            <h3 id={`${headingId}-ai`} className="mb-2 flex flex-wrap items-center gap-2 text-sm font-bold">
              {explanation.simulated ? (
                <>
                  <Sparkles aria-hidden className="size-4 text-amber-ink" /> Simulated AI (template)
                  <SimulatedBadge />
                </>
              ) : (
                <>
                  <Bot aria-hidden className="size-4 text-forest-700" /> AI-generated explanation of the checks above
                </>
              )}
            </h3>
            <p className="text-[0.95rem]">{explanation.text}</p>
            <p className="mt-2 text-xs text-muted">
              {explanation.simulated
                ? "Built from the score breakdown by a fixed template; no AI model was used."
                : "Written by an AI model from the computed checks only. It can be wrong; the checks and notes above are what count."}
            </p>
          </section>

          <form action={saveTripAction} className="space-y-2">
            <input type="hidden" name="q" value={query} />
            <input type="hidden" name="trailId" value={trail.id} />
            {saveError ? (
              <p role="alert" className="rounded-xl bg-red-bg p-3 text-sm font-semibold text-red-ink">
                {saveError}
              </p>
            ) : null}
            <SaveTripButton signedIn={signedIn} trailName={trail.name} />
            <p className="text-sm text-muted">
              {signedIn
                ? "Saves this plan to My trips. You can book it from there"
                : "You'll come straight back to these results after signing in"}
              {` · from ${formatMoney(trail.basePriceCents, trail.currency)} per person.`}
            </p>
          </form>
        </div>
      </div>
    </article>
  );
}
