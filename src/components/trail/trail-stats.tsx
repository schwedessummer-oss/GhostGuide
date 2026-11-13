import type { TrailDetailDto } from "@/domain/catalog";
import {
  DISTANCE_ONLY_TIME,
  FLAT_PACE_KMH,
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

/** 4.5 km/h → "2.8 mph". */
const FLAT_PACE_MPH = (FLAT_PACE_KMH / 1.609344).toFixed(1);

/**
 * Key numbers for the hike as usually walked (hikeDistanceM / hikeGainM /
 * hikeDurationMin: out-and-back for linear routes), the route form, and the
 * difficulty with where it comes from.
 *
 * Without elevation data (elevationGainM null) the moving time is distance
 * at a flat-ground pace with no time for climbing (estimate.ts), and an
 * estimated difficulty rests on distance alone: both labels say so, and
 * nothing claims the climb was counted.
 */
export function TrailStats({ trail, aside }: { trail: TrailDetailDto; aside?: React.ReactNode }) {
  const duration = formatDurationEstimate(trail.hikeDurationMin);
  const climbKnown = trail.elevationGainM !== null;
  const qualifier = difficultyQualifier(trail.difficultySource, trail.sacScale, climbKnown);
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
          sub={duration && !climbKnown ? `moving time ${DISTANCE_ONLY_TIME}` : "moving time, estimated"}
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
              <p>{difficultyExplanation(trail.difficulty, trail.difficultySource, trail.sacScale, climbKnown)}</p>
              {climbKnown ? (
                <p>
                  Moving time assumes an average hiking pace with extra time for climbing, without long breaks. Your own pace, the weather
                  and the trail surface change it.
                </p>
              ) : (
                <p>
                  There is no elevation data for this trail, so moving time is based on distance only, at a flat-ground pace (
                  <Dual imperial={`${FLAT_PACE_MPH} mph`} metric={`${FLAT_PACE_KMH} km/h`} />
                  ), with no extra time for climbing. On a hilly trail it takes longer. Long breaks are not included; your own pace, the
                  weather and the trail surface change it.
                </p>
              )}
            </div>
          </details>
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
    </div>
  );
}
