import type { RouteType } from "@/domain/catalog";
import { VIEW_H, VIEW_W, buildElevationChart, type Tick } from "./elevation";
import { formatAltitude, formatTrailDistance } from "./format";
import { Measure } from "./measure";

function cleanSource(source: string | null): string | null {
  if (!source) return null;
  return source.replace(/\s*\((?:estimate|estimated)\)\s*$/i, "").trim() || null;
}

function XTicks({ ticks }: { ticks: Tick[] }) {
  return (
    <div className="relative h-5 text-[0.7rem] tabular-nums text-muted" aria-hidden>
      {ticks.map((t, i) => (
        <span
          key={t.label}
          className="absolute top-0.5 whitespace-nowrap"
          style={{ left: `${t.pct}%`, transform: i === 0 ? "none" : t.pct > 92 ? "translateX(-100%)" : "translateX(-50%)" }}
        >
          {t.label}
        </span>
      ))}
    </div>
  );
}

function YTicks({ ticks }: { ticks: Tick[] }) {
  return (
    <>
      {ticks.map((t) => (
        <span
          key={t.label}
          aria-hidden
          className={`absolute left-1.5 whitespace-nowrap rounded bg-surface/80 px-1 text-[0.7rem] tabular-nums leading-4 text-muted ${t.pct < 12 ? "" : "-translate-y-full"}`}
          style={{ top: `${t.pct}%` }}
        >
          {t.label}
        </span>
      ))}
    </>
  );
}

/**
 * Server-rendered elevation profile: area + line from the stored DEM
 * profile, gridlines with distance and elevation labels in both unit
 * systems (CSS shows the chosen one), highest/lowest point markers and an
 * honest caption. Text alternative: the figure's accessible summary.
 */
export function ElevationProfile({
  profile,
  elevationSource,
  routeType,
  maxElevationM,
  minElevationM,
}: {
  profile: [number, number][] | null;
  elevationSource: string | null;
  routeType: RouteType;
  maxElevationM: number | null;
  minElevationM: number | null;
}) {
  const chart = buildElevationChart(profile);
  if (!chart) {
    return <p className="rounded-xl bg-sand-100 px-4 py-3 text-muted">Elevation data isn&apos;t available for this trail.</p>;
  }
  const source = cleanSource(elevationSource);
  const high = maxElevationM ?? chart.high.elevationM;
  const low = minElevationM ?? chart.low.elevationM;
  const summary = (u: "imperial" | "metric") =>
    `Elevation profile${routeType === "linear" ? ", one way from the trailhead" : ""}: starts at ${formatAltitude(chart.start.elevationM, u)}, ` +
    `highest point ${formatAltitude(chart.high.elevationM, u)} after ${formatTrailDistance(chart.high.distanceM, u)}, ` +
    `lowest ${formatAltitude(chart.low.elevationM, u)}, ends at ${formatAltitude(chart.end.elevationM, u)} after ${formatTrailDistance(chart.totalM, u)}.`;

  return (
    <figure className="m-0">
      <dl className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div className="flex gap-1.5">
          <dt className="text-muted">Highest</dt>
          <dd className="font-semibold tabular-nums text-ink">
            <Measure value={high} kind="altitude" />
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted">Lowest</dt>
          <dd className="font-semibold tabular-nums text-ink">
            <Measure value={low} kind="altitude" />
          </dd>
        </div>
        {routeType === "linear" ? <div className="text-muted">One way from the trailhead</div> : null}
      </dl>
      <div role="img" aria-label={summary("imperial")} className="[[data-units=metric]_&]:hidden">
        <Plot chart={chart} units="imperial" />
      </div>
      <div role="img" aria-label={summary("metric")} className="hidden [[data-units=metric]_&]:block">
        <Plot chart={chart} units="metric" />
      </div>
      <figcaption className="mt-2 text-xs text-muted">
        Estimated from terrain data{source ? ` (${source})` : ""}. Real climbs can differ, especially on short, steep sections.
      </figcaption>
    </figure>
  );
}

function Plot({ chart, units }: { chart: NonNullable<ReturnType<typeof buildElevationChart>>; units: "imperial" | "metric" }) {
  const yTicks = chart.yTicks[units];
  return (
    <div>
      <div className="relative h-44 overflow-hidden rounded-xl bg-forest-50/60 sm:h-52">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 size-full"
          aria-hidden
          focusable="false"
        >
          {yTicks.map((t) => (
            <line
              key={t.label}
              x1={0}
              x2={VIEW_W}
              y1={(t.pct / 100) * VIEW_H}
              y2={(t.pct / 100) * VIEW_H}
              stroke="#c7dccd"
              strokeWidth={1}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <path d={chart.areaPath} fill="#c7dccd" fillOpacity={0.75} />
          <path
            d={chart.linePath}
            fill="none"
            stroke="#1f4630"
            strokeWidth={2.25}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <YTicks ticks={yTicks} />
        <span
          aria-hidden
          className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-forest-800 shadow"
          style={{ left: `${chart.high.xPct}%`, top: `${chart.high.yPct}%` }}
        />
      </div>
      <XTicks ticks={chart.xTicks[units]} />
    </div>
  );
}
