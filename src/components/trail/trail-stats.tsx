import type { TrailDetailDto } from "@/domain/catalog";
import {
  difficultyExplanation,
  difficultyLabel,
  difficultyQualifier,
  formatDurationEstimate,
  hikeFormLabel,
  routeFormNote,
} from "./format";
import { Dual, Measure } from "./measure";

const DIFFICULTY_DOT: Record<string, string> = {
  easy: "bg-forest-500",
  moderate: "bg-[#c98a1b]",
  hard: "bg-[#b4461f]",
  expert: "bg-red-ink",
  unknown: "bg-sand-300",
};

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub: React.ReactNode }) {
  return (
    <div className="min-w-0 sm:px-6 sm:first:pl-0">
      <dt className="sr-only">{label}</dt>
      <dd className="text-xl font-bold leading-tight tabular-nums text-ink sm:text-2xl">{value}</dd>
      <dd className="mt-0.5 text-sm text-muted">{sub}</dd>
    </div>
  );
}

/**
 * Key numbers for the hike as usually walked (hikeDistanceM / hikeGainM /
 * hikeDurationMin: out-and-back for linear routes), the route form, and the
 * difficulty with where it comes from.
 */
export function TrailStats({ trail, aside }: { trail: TrailDetailDto; aside?: React.ReactNode }) {
  const duration = formatDurationEstimate(trail.hikeDurationMin);
  const qualifier = difficultyQualifier(trail.difficultySource, trail.sacScale);
  const note = (u: "imperial" | "metric") => routeFormNote(trail.routeType, trail.distanceM, u);
  const imperialNote = note("imperial");
  const metricNote = note("metric");

  return (
    <div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:flex sm:gap-0 sm:divide-x sm:divide-sand-200">
        <Stat label="Hike distance" value={<Measure value={trail.hikeDistanceM} kind="distance" />} sub={hikeFormLabel(trail.routeType)} />
        <Stat
          label="Total climb"
          value={
            <Measure
              value={trail.hikeGainM}
              kind="climb"
              fallback={<span className="text-base font-semibold text-muted">Not available</span>}
            />
          }
          sub="total climb"
        />
        <Stat
          label="Moving time"
          value={duration ? `≈ ${duration}` : <span className="text-base font-semibold text-muted">Not available</span>}
          sub="moving time, estimated"
        />
        <Stat
          label="Difficulty"
          value={
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className={`size-2.5 rounded-full ${DIFFICULTY_DOT[trail.difficulty] ?? DIFFICULTY_DOT.unknown}`} />
              {difficultyLabel(trail.difficulty)}
            </span>
          }
          sub={qualifier ?? "difficulty"}
        />
      </dl>
      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1 text-sm text-muted">
          {imperialNote && metricNote ? (
            <p>
              <Dual imperial={imperialNote} metric={metricNote} />
            </p>
          ) : null}
          <details className="group">
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 font-medium text-forest-800 underline decoration-forest-200 underline-offset-4 hover:decoration-forest-700 [&::-webkit-details-marker]:hidden sm:min-h-8">
              How difficulty and time are estimated
            </summary>
            <div className="mt-1 max-w-prose space-y-1.5 rounded-xl bg-sand-100 px-4 py-3 text-ink">
              <p>{difficultyExplanation(trail.difficulty, trail.difficultySource, trail.sacScale)}</p>
              <p>
                Moving time assumes an average hiking pace with extra time for climbing, without long breaks. Your own pace, the weather and
                the trail surface change it.
              </p>
            </div>
          </details>
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
    </div>
  );
}
