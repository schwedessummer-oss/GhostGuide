"use client";

import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw, Sunrise, Sunset, TriangleAlert } from "lucide-react";
import type { TrailConditionsDto, WeatherAlertDto } from "@/domain/catalog";
import { Button } from "@/components/ui";
import {
  DISTANCE_ONLY_TIME,
  dayOf,
  formatClock,
  formatClockWithDay,
  formatDayLabel,
  formatDurationEstimate,
  formatHour,
  formatRelativeAge,
  formatZonedMoment,
  localDateKey,
  zoneAbbreviation,
} from "./format";
import { Measure } from "./measure";
import { weatherSymbol } from "./weather";
import { WeatherIcon } from "./weather-icon";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; data: TrailConditionsDto };

function errorMessage(status: number): string {
  if (status === 404) return "Conditions aren't available for this trail.";
  if (status === 429) return "Too many requests right now. Try again in a minute.";
  return "Weather is unavailable right now.";
}

/**
 * Trail conditions (client): forecast at the trailhead (MET Norway),
 * official alerts (NWS, US only), sunrise/sunset and daylight planning,
 * from GET /api/trails/:id/conditions. Loaded in the browser so the trail
 * page itself can be cached. Every value comes from the response; missing
 * values are shown as missing, never estimated here.
 *
 * When the response's planning.durationBasis is "distance_only" (no
 * elevation data: distance at a flat pace, climb not counted), the planning
 * explanation says so next to the duration. It comes from the live response,
 * not the cached page, so the label always matches the time it describes.
 */
export function ConditionsPanel({ trailId }: { trailId: string }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/trails/${trailId}/conditions`, { signal: ctrl.signal, headers: { Accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) return setLoad({ status: "error", message: errorMessage(res.status) });
        setLoad({ status: "ok", data: (await res.json()) as TrailConditionsDto });
      })
      .catch((err) => {
        if ((err as { name?: string })?.name !== "AbortError") setLoad({ status: "error", message: errorMessage(0) });
      });
    return () => ctrl.abort();
  }, [trailId, attempt]);

  const retry = () => {
    setLoad({ status: "loading" });
    setAttempt((a) => a + 1);
  };

  return (
    <div aria-busy={load.status === "loading"}>
      <p role="status" aria-live="polite" className="sr-only">
        {load.status === "loading" ? "Loading trail conditions…" : load.status === "error" ? load.message : "Trail conditions loaded."}
      </p>
      {load.status === "loading" ? <ConditionsSkeleton /> : null}
      {load.status === "error" ? (
        <div className="rounded-xl border border-sand-200 bg-surface p-4">
          <p className="font-semibold text-ink">{load.message}</p>
          <p className="mt-1 text-sm text-muted">
            Check a local forecast before you go. Daylight times will show here once conditions load.
          </p>
          <Button variant="secondary" onClick={retry} className="mt-3">
            <RefreshCw aria-hidden className="size-4" /> Try again
          </Button>
        </div>
      ) : null}
      {load.status === "ok" ? <Conditions data={load.data} onRetry={retry} /> : null}
    </div>
  );
}

function ConditionsSkeleton() {
  const bar = "rounded-lg bg-sand-200/70 motion-safe:animate-pulse";
  return (
    <div aria-hidden className="space-y-4">
      <div className="flex items-center gap-4">
        <div className={`size-14 ${bar}`} />
        <div className="flex-1 space-y-2">
          <div className={`h-6 w-32 ${bar}`} />
          <div className={`h-4 w-48 ${bar}`} />
        </div>
      </div>
      <div className="flex gap-2 overflow-hidden">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className={`h-24 w-16 shrink-0 ${bar}`} />
        ))}
      </div>
      <div className={`h-28 ${bar}`} />
    </div>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{children}</h3>;
}

/** The loaded conditions (exported for tests). */
export function Conditions({ data, onRetry }: { data: TrailConditionsDto; onRetry: () => void }) {
  const tz = data.timezone;
  const zone = zoneAbbreviation(tz, new Date(data.generatedAt));
  const today = data.sun[0]?.date ?? data.daily[0]?.date ?? null;
  const forecastOk = data.forecastStatus === "ok";

  return (
    <div className="space-y-7">
      {forecastOk ? (
        <>
          <Current data={data} />
          {data.highlights.length ? (
            <ul className="space-y-1.5">
              {data.highlights.map((h) => (
                <li key={h} className="flex gap-2 text-[0.95rem] text-ink">
                  <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-forest-600" />
                  {h}
                </li>
              ))}
            </ul>
          ) : null}
          {data.hourly.length ? (
            <section>
              <SubHeading>Next hours ({zone})</SubHeading>
              <ol
                className="relative -mx-1 flex snap-x gap-1.5 overflow-x-auto px-1 pb-2 [scrollbar-width:thin]"
                aria-label="Hourly forecast"
                tabIndex={0}
              >
                {data.hourly.slice(0, 12).map((h, i) => (
                  <li
                    key={h.time}
                    className="relative flex w-[4.25rem] shrink-0 snap-start flex-col items-center gap-1 rounded-xl bg-sand-100 px-1 py-2.5 text-center"
                  >
                    <span className="text-xs font-semibold text-muted">{i === 0 ? "Now" : formatHour(h.time, tz)}</span>
                    <WeatherIcon symbol={h.symbol} className="size-6" />
                    <span className="text-sm font-bold tabular-nums text-ink">
                      <Measure value={h.temperatureC} kind="temperature" />
                    </span>
                    <span className="text-[0.7rem] tabular-nums text-blue-ink">
                      <Precipitation mm={h.precipitationMm} none={<>—<span className="sr-only">no precipitation</span></>} />
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          {data.daily.length ? (
            <section>
              <SubHeading>Next 7 days</SubHeading>
              <ol className="divide-y divide-sand-200 rounded-xl border border-sand-200 bg-surface sm:grid sm:grid-cols-7 sm:divide-x sm:divide-y-0">
                {data.daily.slice(0, 7).map((d) => (
                  <li key={d.date} className="flex items-center gap-3 px-3 py-2 sm:flex-col sm:gap-1 sm:px-1 sm:py-3 sm:text-center">
                    <span className="w-12 text-sm font-semibold text-ink sm:w-auto">{formatDayLabel(d.date, today)}</span>
                    <WeatherIcon symbol={d.symbol} className="size-5" />
                    <span className="ml-auto text-sm tabular-nums sm:ml-0">
                      <span className="font-bold text-ink">
                        <Measure value={d.maxC} kind="temperature" />
                      </span>
                      <span className="text-muted">
                        {" / "}
                        <Measure value={d.minC} kind="temperature" />
                      </span>
                    </span>
                    <span className="w-16 text-right text-xs tabular-nums text-blue-ink sm:w-auto sm:text-center">
                      <Precipitation mm={d.precipitationMm} none={<>Dry<span className="sr-only"> (no precipitation forecast)</span></>} />
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </>
      ) : (
        <div className="rounded-xl border border-sand-200 bg-surface p-4">
          <p className="font-semibold text-ink">Weather is unavailable right now</p>
          <p className="mt-1 text-sm text-muted">The forecast provider didn&apos;t answer. Check a local forecast before you go.</p>
          <Button variant="secondary" onClick={onRetry} className="mt-3">
            <RefreshCw aria-hidden className="size-4" /> Try again
          </Button>
        </div>
      )}

      <Alerts data={data} />
      <Daylight data={data} zone={zone} />

      <p className="text-xs text-muted">
        {data.forecastUpdatedAt ? <>Forecast issued {formatRelativeAge(data.forecastUpdatedAt)}. </> : null}
        {data.attribution.map((a, i) => (
          <span key={a.name}>
            {i > 0 ? " · " : ""}
            {a.url ? (
              <a href={a.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-ink">
                {a.name}
              </a>
            ) : (
              a.name
            )}
            {a.license ? ` (${a.license})` : ""}
          </span>
        ))}
      </p>
    </div>
  );
}

/**
 * A forecast precipitation amount: the amount when above zero, `none` when
 * the forecast says zero, and "Unknown" when the forecast has no amount
 * (null is never shown as dry).
 */
function Precipitation({ mm, none }: { mm: number | null; none: React.ReactNode }) {
  if (typeof mm !== "number" || !Number.isFinite(mm) || mm < 0) {
    return (
      <span className="text-muted">
        Unknown<span className="sr-only"> precipitation</span>
      </span>
    );
  }
  if (mm === 0) return <span className="text-muted">{none}</span>;
  return <Measure value={mm} kind="precipitation" />;
}

function Current({ data }: { data: TrailConditionsDto }) {
  const c = data.current;
  if (!c) return <p className="text-muted">Current conditions aren&apos;t in this forecast.</p>;
  const sym = weatherSymbol(c.symbol);
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
      <div className="flex items-center gap-3">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-sand-100">
          <WeatherIcon symbol={c.symbol} className="size-8" labelled={false} />
        </span>
        <div>
          <p className="text-3xl font-bold leading-none tabular-nums text-ink">
            <Measure value={c.temperatureC} kind="temperature" fallback="—" />
          </p>
          <p className="mt-1 text-sm text-muted">{sym ? sym.label : "Now"} at the trailhead</p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted">Wind</dt>
        <dd className="font-semibold tabular-nums text-ink">
          <Measure value={c.windSpeedMs} kind="wind" fallback="No data" />
          {typeof c.windGustMs === "number" ? (
            <span className="font-normal text-muted">
              {" "}
              (gusts <Measure value={c.windGustMs} kind="wind" />)
            </span>
          ) : null}
        </dd>
        <dt className="text-muted">Precip. next hour</dt>
        <dd className="font-semibold tabular-nums text-ink">
          <Measure value={c.precipitationMm} kind="precipitation" fallback="No data" />
          {typeof c.precipitationProbability === "number" ? (
            <span className="font-normal text-muted"> ({Math.round(c.precipitationProbability)}% chance)</span>
          ) : null}
        </dd>
      </dl>
    </div>
  );
}

const SEVERITY_TONE: Record<string, string> = {
  extreme: "border-red-ink/40 bg-red-bg text-red-ink",
  severe: "border-red-ink/30 bg-red-bg text-red-ink",
  moderate: "border-[#f1d9b0] bg-amber-bg text-amber-ink",
};

function Alerts({ data }: { data: TrailConditionsDto }) {
  const tz = data.timezone;
  const now = new Date(data.generatedAt);
  return (
    <section>
      <SubHeading>Official alerts</SubHeading>
      {data.alertsStatus === "not_supported" ? (
        <p className="text-sm text-muted">Official weather alerts aren&apos;t available for this region in Ghost Guide.</p>
      ) : data.alertsStatus === "unavailable" ? (
        <p className="text-sm text-muted">Couldn&apos;t load alerts right now.</p>
      ) : data.alerts.length === 0 ? (
        <p className="text-sm text-muted">No active official weather alerts for this location.</p>
      ) : (
        <ul className="space-y-3">
          {data.alerts.map((a) => (
            <AlertItem key={a.id} alert={a} tz={tz} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * "From 10:00 AM EST today until Thu, Nov 13, 8:00 PM EST": each end names
 * its day unless it is today in the trail's zone (so a multi-day warning never
 * reads as ending tonight), with the zone name in force at that moment.
 */
export function alertWindowText(a: Pick<WeatherAlertDto, "onset" | "ends">, tz: string | null, now: Date): string | null {
  const from = a.onset ? formatZonedMoment(a.onset, tz, now) : null;
  const until = a.ends ? formatZonedMoment(a.ends, tz, now) : null;
  if (from && until) return `From ${from} until ${until}`;
  if (from) return `From ${from}`;
  if (until) return `Until ${until}`;
  return null;
}

function AlertItem({ alert: a, tz, now }: { alert: WeatherAlertDto; tz: string | null; now: Date }) {
  const tone = SEVERITY_TONE[a.severity.toLowerCase()] ?? "border-[#c9daf8] bg-blue-bg text-blue-ink";
  const when = alertWindowText(a, tz, now);
  return (
    <li className={`rounded-xl border p-4 ${tone}`}>
      <p className="flex items-start gap-2 font-semibold">
        <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0" />
        <span>
          {a.event}
          <span className="ml-2 rounded-full border border-current/30 px-2 py-0.5 text-xs font-semibold">{a.severity}</span>
        </span>
      </p>
      {a.headline ? <p className="mt-1.5 text-[0.95rem]">{a.headline}</p> : null}
      {when ? <p className="mt-1 text-sm opacity-90">{when}</p> : null}
      {a.description || a.instruction ? (
        <details className="mt-2 text-sm">
          <summary className="min-h-11 cursor-pointer py-2 font-semibold underline underline-offset-2">Full alert text</summary>
          {a.description ? <p className="whitespace-pre-line">{a.description}</p> : null}
          {a.instruction ? <p className="mt-2 whitespace-pre-line font-semibold">{a.instruction}</p> : null}
        </details>
      ) : null}
      <p className="mt-2 text-xs">
        Source: {a.source}
        {a.url ? (
          <>
            {" · "}
            <a
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-semibold underline underline-offset-2"
            >
              Official alert <ExternalLink aria-hidden className="size-3" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </>
        ) : null}
      </p>
    </li>
  );
}

/**
 * How to show the latest recommended start. The server gives today's when it
 * is still ahead, else TOMORROW's (never a time already past), so the day is
 * named whenever it is not today in the trail's zone (the zone the server
 * used: UTC when unknown), and a start before that day's sunrise (a hike
 * longer than the daylight) is flagged next to the value.
 */
export function latestStartView(data: Pick<TrailConditionsDto, "timezone" | "sun" | "planning" | "generatedAt">): {
  text: string;
  tooLateToday: boolean;
  beforeSunrise: boolean;
} | null {
  const iso = data.planning.latestRecommendedStart;
  if (!iso || Number.isNaN(new Date(iso).getTime())) return null;
  const tz = data.timezone;
  const today = data.sun[0]?.date ?? localDateKey(data.generatedAt, tz);
  const day = dayOf(iso, tz, today);
  const startDate = localDateKey(iso, tz);
  const sunThatDay = data.sun.find((s) => s.date === startDate) ?? null;
  const sunrise = sunThatDay && sunThatDay.polar === null && sunThatDay.sunrise ? new Date(sunThatDay.sunrise).getTime() : null;
  return {
    text: formatClockWithDay(iso, tz, today),
    tooLateToday: day === "tomorrow" || day === "other",
    beforeSunrise: sunrise !== null && new Date(iso).getTime() < sunrise,
  };
}

function Daylight({ data, zone }: { data: TrailConditionsDto; zone: string }) {
  const tz = data.timezone;
  const sun = data.sun[0] ?? null;
  const p = data.planning;
  const today = sun?.date ?? localDateKey(data.generatedAt, tz);
  const latest = latestStartView(data);
  const finishAfterSunset =
    p.finishIfStartNow && sun?.sunset ? new Date(p.finishIfStartNow).getTime() > new Date(sun.sunset).getTime() : false;
  const duration = formatDurationEstimate(p.outAndBackDurationMin ?? p.estimatedDurationMin);

  return (
    <section>
      <SubHeading>Daylight today ({zone})</SubHeading>
      {sun?.polar === "day" ? (
        <p className="text-sm text-ink">The sun doesn&apos;t set here today.</p>
      ) : sun?.polar === "night" ? (
        <p className="text-sm text-ink">The sun doesn&apos;t rise here today.</p>
      ) : sun ? (
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <p className="flex items-center gap-2">
            <Sunrise aria-hidden className="size-5 text-amber-ink" />
            <span className="text-muted">Sunrise</span>
            <span className="font-semibold tabular-nums text-ink">{sun.sunrise ? formatClock(sun.sunrise, tz) : "—"}</span>
          </p>
          <p className="flex items-center gap-2">
            <Sunset aria-hidden className="size-5 text-amber-ink" />
            <span className="text-muted">Sunset</span>
            <span className="font-semibold tabular-nums text-ink">{sun.sunset ? formatClock(sun.sunset, tz) : "—"}</span>
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted">Sunrise and sunset aren&apos;t available.</p>
      )}

      <dl className="mt-4 divide-y divide-sand-200 rounded-xl bg-sand-100 sm:grid sm:grid-cols-3 sm:gap-2 sm:divide-y-0 sm:bg-transparent">
        <PlanStat label="Latest recommended start">
          {latest ? (
            <>
              {latest.text}
              {latest.tooLateToday ? <span className="block text-xs font-normal text-amber-ink">Too late to start today</span> : null}
              {latest.beforeSunrise ? (
                <span className="block text-xs font-normal text-amber-ink">Before sunrise: part of the hike would be in the dark</span>
              ) : null}
            </>
          ) : (
            <span className="text-base font-normal text-muted">Not available</span>
          )}
        </PlanStat>
        <PlanStat label="Finish if you start now">
          {p.finishIfStartNow ? (
            <>
              <span className={finishAfterSunset ? "text-amber-ink" : undefined}>≈ {formatClockWithDay(p.finishIfStartNow, tz, today)}</span>
              {finishAfterSunset ? <span className="block text-xs font-normal text-amber-ink">After sunset</span> : null}
            </>
          ) : (
            <span className="text-base font-normal text-muted">Not available</span>
          )}
        </PlanStat>
        <PlanStat label="Daylight left">
          {p.daylightRemainingMin === null ? (
            <span className="text-base font-normal text-muted">Not available</span>
          ) : p.daylightRemainingMin <= 0 ? (
            "The sun has set"
          ) : (
            formatDurationEstimate(p.daylightRemainingMin, 1)
          )}
        </PlanStat>
      </dl>
      {duration || p.notes.length ? (
        <details className="mt-2 text-sm text-muted">
          <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-forest-800 underline decoration-forest-200 underline-offset-4 hover:decoration-forest-700 sm:min-h-8">
            How these times are worked out
          </summary>
          <ul className="mt-1 space-y-1 text-xs">
            {duration ? (
              <li>
                Based on ≈ {duration} moving time{data.planning.durationBasis === "distance_only" ? ` ${DISTANCE_ONLY_TIME}` : ""}.
              </li>
            ) : null}
            {p.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function PlanStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-2.5 sm:block sm:rounded-xl sm:bg-sand-100">
      <dt className="text-sm text-muted sm:text-xs sm:font-semibold">{label}</dt>
      <dd className="text-right text-base font-bold tabular-nums text-ink sm:mt-0.5 sm:text-left sm:text-lg">{children}</dd>
    </div>
  );
}
