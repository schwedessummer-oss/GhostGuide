"use client";

import { useEffect, useRef, useState } from "react";
import { Clock, ExternalLink, Globe, Phone, RefreshCw } from "lucide-react";
import type { NearbyGroupDto, NearbyResponse, PoiDto } from "@/domain/catalog";
import { Button } from "@/components/ui";
import { poiDisplayName, safeWebsiteUrl, telHref, websiteLabel } from "./format";
import { Measure } from "./measure";

/** Polls while the area is still loading: 6 tries, 6 s → 30 s apart (~1.5 min in total). */
const POLL_DELAYS_MS = [6_000, 10_000, 15_000, 20_000, 25_000, 30_000];
const TRAILHEAD_GROUPS = new Set<NearbyGroupDto["category"]>(["parking", "toilets"]);

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; data: NearbyResponse; polling: boolean; gaveUp: boolean };

/**
 * At the trailhead (parking, restrooms within 1 km) and nearby services
 * (gas, food, lodging, supplies, medical within 15 km), from
 * GET /api/trails/:id/nearby. While OpenStreetMap data for the area is still
 * loading it shows what is stored and polls a few times. Distances are
 * straight lines from the trailhead (the API says so in its notes).
 */
export function NearbyPanel({ trailId }: { trailId: string }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const pollIndex = useRef(0);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      try {
        const res = await fetch(`/api/trails/${trailId}/nearby`, { signal: ctrl.signal, headers: { Accept: "application/json" } });
        if (!res.ok) {
          setLoad({
            status: "error",
            message:
              res.status === 429 ? "Too many requests right now. Try again in a minute." : "Nearby places couldn't be loaded right now.",
          });
          return;
        }
        const data = (await res.json()) as NearbyResponse;
        const loading = data.coverage.state === "loading";
        const canPoll = loading && pollIndex.current < POLL_DELAYS_MS.length;
        setLoad({ status: "ok", data, polling: canPoll, gaveUp: loading && !canPoll });
        if (canPoll) timer = setTimeout(run, POLL_DELAYS_MS[pollIndex.current++]);
      } catch (err) {
        if ((err as { name?: string })?.name !== "AbortError")
          setLoad({ status: "error", message: "Nearby places couldn't be loaded right now." });
      }
    };
    run();
    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [trailId, attempt]);

  const retry = () => {
    pollIndex.current = 0;
    setLoad({ status: "loading" });
    setAttempt((a) => a + 1);
  };

  if (load.status === "loading") {
    return (
      <div aria-busy="true">
        <p role="status" aria-live="polite" className="text-sm text-muted">
          Looking up places near the trailhead…
        </p>
        <div aria-hidden className="mt-3 grid gap-3 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-28 rounded-xl bg-sand-200/70 motion-safe:animate-pulse" />
          ))}
        </div>
      </div>
    );
  }
  if (load.status === "error") {
    return (
      <div className="rounded-xl border border-sand-200 bg-surface p-4" role="status" aria-live="polite">
        <p className="font-semibold text-ink">{load.message}</p>
        <Button variant="secondary" onClick={retry} className="mt-3">
          <RefreshCw aria-hidden className="size-4" /> Try again
        </Button>
      </div>
    );
  }

  return <NearbyView data={load.data} polling={load.polling} gaveUp={load.gaveUp} onRetry={retry} />;
}

/** The services text when no service is listed: a "none mapped" claim only once the whole area was checked. */
export function emptyServicesText(state: NearbyResponse["coverage"]["state"], radiusM: number): string {
  const km = Math.round(radiusM / 1000);
  switch (state) {
    case "ready":
      return `No gas, food, lodging or medical care is mapped within ${km} km.`;
    case "loading":
      return "Gas, food, lodging and medical care will appear here once the area has loaded.";
    case "partial":
      return (
        `None is mapped in the part of this area that loaded, but the rest within ${km} km couldn't be checked right now, ` +
        "so there may be gas, food, lodging or medical care nearby that isn't shown."
      );
    case "too_large":
      return `Gas, food, lodging and medical care within ${km} km couldn't all be checked, so there may be places nearby that aren't shown.`;
    default:
      return `Gas, food, lodging and medical care within ${km} km couldn't be checked right now, so there may be places nearby that aren't shown.`;
  }
}

/**
 * The loaded nearby places (exported for tests). Only coverage "ready" lets
 * the panel say nothing is mapped; after a failed, partial or too-large load
 * it says what couldn't be checked and offers to check again.
 */
export function NearbyView({
  data,
  polling,
  gaveUp,
  onRetry,
}: {
  data: NearbyResponse;
  polling: boolean;
  gaveUp: boolean;
  onRetry: () => void;
}) {
  const atTrailhead = data.groups.filter((g) => TRAILHEAD_GROUPS.has(g.category));
  const services = data.groups.filter((g) => !TRAILHEAD_GROUPS.has(g.category));
  const state = data.coverage.state;
  const canRetry = gaveUp || state === "failed" || state === "partial";

  return (
    <div className="space-y-6">
      <div role="status" aria-live="polite">
        {state === "loading" ? (
          <p className="flex items-start gap-2 rounded-xl bg-sand-100 px-3 py-2.5 text-sm text-ink">
            {polling ? <RefreshCw aria-hidden className="mt-0.5 size-4 shrink-0 text-forest-700 motion-safe:animate-spin" /> : null}
            <span>
              {gaveUp
                ? "Nearby places for this area are still loading from OpenStreetMap. Check back in a few minutes."
                : data.coverage.message}
            </span>
          </p>
        ) : state === "failed" || state === "partial" ? (
          <p className="rounded-xl bg-amber-bg px-3 py-2.5 text-sm text-amber-ink">{data.coverage.message}</p>
        ) : state === "too_large" ? (
          // (coverage.message says "zoom in", which means nothing on a trail page.)
          <p className="rounded-xl bg-amber-bg px-3 py-2.5 text-sm text-amber-ink">
            The area around this trailhead is too large to load at once, so nearby services may be missing.
          </p>
        ) : null}
        {canRetry ? (
          <Button variant="ghost" onClick={onRetry} className="mt-2">
            <RefreshCw aria-hidden className="size-4" /> Check again
          </Button>
        ) : null}
      </div>

      <div>
        <h3 className="mb-2 text-base font-bold text-ink">At the trailhead</h3>
        {atTrailhead.length ? (
          <GroupGrid groups={atTrailhead} />
        ) : (
          <p className="text-sm text-muted">No parking or restrooms are mapped within 1 km of the trailhead.</p>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-base font-bold text-ink">Nearby services</h3>
        {services.length ? <GroupGrid groups={services} /> : <p className="text-sm text-muted">{emptyServicesText(state, data.radiusM)}</p>}
      </div>

      {data.notes.length ? (
        <ul className="space-y-1 text-xs text-muted">
          {data.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {data.attribution.length ? (
        <p className="text-xs text-muted">
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
      ) : null}
    </div>
  );
}

function GroupGrid({ groups }: { groups: NearbyGroupDto[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {groups.map((g) => (
        <li key={g.category} className="rounded-xl border border-sand-200 bg-surface p-3.5">
          <p className="text-sm font-semibold text-muted">{g.label}</p>
          <ul className="mt-1.5 divide-y divide-sand-200">
            {g.items.slice(0, 3).map((p) => (
              <PlaceRow key={p.id} poi={p} />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function PlaceRow({ poi }: { poi: PoiDto }) {
  const website = safeWebsiteUrl(poi.website);
  const tel = telHref(poi.phone);
  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className={poi.name ? "font-medium text-ink" : "text-muted"}>{poiDisplayName(poi)}</span>
        <span className="shrink-0 text-sm tabular-nums text-muted">
          {poi.distanceM === null ? null : poi.distanceM < 25 ? (
            "at the trailhead"
          ) : (
            <>
              <Measure value={poi.distanceM} kind="distance" />
              <span className="sr-only"> away in a straight line</span>
            </>
          )}
        </span>
      </div>
      {poi.openingHours ? (
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
          <Clock aria-hidden className="size-3.5 shrink-0" />
          <span>
            <span className="sr-only">Mapped opening hours: </span>
            {poi.openingHours}
          </span>
        </p>
      ) : null}
      {website || tel ? (
        <p className="mt-0.5 flex flex-wrap gap-x-4 text-sm">
          {website ? (
            <a
              href={website}
              target="_blank"
              rel="nofollow noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-1.5 font-medium text-forest-800 underline underline-offset-2 sm:min-h-8"
            >
              <Globe aria-hidden className="size-3.5" /> {websiteLabel(website)}
              <ExternalLink aria-hidden className="size-3" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : null}
          {tel ? (
            <a
              href={tel}
              className="inline-flex min-h-11 items-center gap-1.5 font-medium text-forest-800 underline underline-offset-2 sm:min-h-8"
            >
              <Phone aria-hidden className="size-3.5" /> {poi.phone}
            </a>
          ) : null}
        </p>
      ) : null}
    </li>
  );
}
