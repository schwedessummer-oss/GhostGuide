"use client";

import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import Link from "next/link";
import clsx from "clsx";
import { ArrowRight, ChevronDown, List, LocateFixed, Map as MapIcon, RotateCw, Search, SlidersHorizontal, X } from "lucide-react";
import type { Bbox, GeocodeResponse, GeocodeResultDto, TrailDetailDto, TrailSearchResponse, TrailSummaryDto } from "@/domain/catalog";
import type { Units } from "@/lib/units";
import { UnitsToggle } from "@/components/site/units-toggle";
import { ExploreMap, type ExploreMapHandle, type MapViewChange } from "./explore-map";
import { FiltersDialog } from "./filters-dialog";
import { ListFooter, ResultsList, TrailStats } from "./results-list";
import { FeatureIcons, Spinner, TrailDifficulty } from "./bits";
import { climbKnown, coverageSummary, englishName, hikeDistanceText, placeLine, resultsHeading } from "./format";
import { NEAR_ME_RADIUS_KM, bboxAroundPoint, bboxForPlace, bboxWithin } from "./geometry";
import { useNearMe } from "./use-near-me";
import { createAreaClaims } from "./area-claims";
import { trailRoutePreviewUrl, type ExploreInitial, type PlaceSearchState, type SearchStatus, type TrailRoutePreviewDto } from "./types";
import {
  cleanQuery,
  clearedFilters,
  countActiveFilters,
  filterEntries,
  parseExploreParams,
  searchApiQuery,
  serializeExploreParams,
  type ExploreFilters,
  type ExploreUrlState,
  type Sort,
} from "./url-state";

/** Poll a loading area this often, for at most this long. */
const POLL_INTERVAL_MS = 4_000;
const POLL_MAX_MS = 120_000;
/** Below this zoom an area is too big to search (the API would answer "too_large"). */
const MIN_SEARCH_ZOOM = 7;
/** Phone bottom-sheet peek height (rem) — the map keeps this much clear at the bottom. */
const PEEK_REM = 12;
const ROUTE_CACHE_SIZE = 30;
const EMPTY_TRAILS: TrailSummaryDto[] = [];

const SUGGESTIONS = ["Table Rock State Park", "Boulder, Colorado", "Lake District, England"];

const SORT_LABEL: Record<Sort, string> = {
  relevance: "Best match",
  length: "Shortest first",
  gain: "Least climb first",
  name: "Name (A–Z)",
};

type Sheet = "peek" | "half" | "full";
type RouteState = { id: string; status: "loading" | "ready" | "error"; geometry: TrailDetailDto["geometry"] | null };

const DESKTOP_QUERY = "(min-width: 1024px)";
function useIsDesktop() {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(DESKTOP_QUERY);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}

/** A search failure with a message written for people (network errors keep a generic one). */
class SearchFailure extends Error {}

/** Wall-clock time for poll budgets (kept out of render; see react-hooks/purity). */
const clock = () => Date.now();
const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const humanizeKind = (k: string) => k.replace(/_/g, " ");

const chipButton =
  "pointer-events-auto inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-sand-200 bg-surface px-4 text-[0.95rem] font-semibold text-forest-900 shadow-[0_1px_3px_rgba(15,35,24,0.12)] hover:bg-forest-50 disabled:opacity-60 lg:shadow-none";

export function ExploreApp({ initial }: { initial: ExploreInitial }) {
  const isDesktop = useIsDesktop();
  const [query, setQuery] = useState(initial.state.q);
  /** The place text that produced the current area ("" for map / near-me searches). */
  const [areaQuery, setAreaQuery] = useState(initial.state.q);
  const [area, setArea] = useState<Bbox | null>(initial.state.bbox);
  const [filters, setFilters] = useState<ExploreFilters>(initial.state.filters);
  const [results, setResults] = useState<TrailSearchResponse | null>(initial.results);
  const [status, setStatus] = useState<SearchStatus>(initial.results ? "ready" : initial.searchError ? "error" : "idle");
  const [error, setError] = useState<string | null>(initial.searchError);
  const [place, setPlace] = useState<PlaceSearchState | null>(initial.place);
  const [placesOpen, setPlacesOpen] = useState(false);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [view, setView] = useState<{ moved: boolean; zoom: number | null; bbox: Bbox | null }>({ moved: false, zoom: null, bbox: null });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Trails sharing the tapped spot (e.g. one trailhead for several trails), to choose from. */
  const [group, setGroup] = useState<string[] | null>(null);
  const [route, setRoute] = useState<RouteState | null>(null);
  const [sheet, setSheet] = useState<Sheet>(initial.results || initial.searchError ? "peek" : "half");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filtersKey, setFiltersKey] = useState(0);
  const [units, setUnits] = useState<Units>(initial.units);
  const [topHeight, setTopHeight] = useState(0);

  const mapHandle = useRef<ExploreMapHandle | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const searchSeq = useRef(0);
  const pollTimer = useRef<number | undefined>(undefined);
  const pollStarted = useRef(0);
  /** Area choices (place lookup, Near me, map view, back/forward): the newest wins (see area-claims.ts). */
  const [areaClaims] = useState(createAreaClaims);
  /** The filters as of the last render, for area changes that complete later (a slow place lookup). */
  const filtersRef = useRef(filters);
  const routeAbort = useRef<AbortController | null>(null);
  const routeCache = useRef(new Map<string, TrailDetailDto["geometry"]>());
  const lastUrl = useRef(serializeExploreParams(initial.state));
  const topRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const trails = results?.trails ?? EMPTY_TRAILS;
  const coverage = results?.coverage ?? null;
  const activeFilters = countActiveFilters(filters);
  const selected = selectedId ? (trails.find((t) => t.id === selectedId) ?? null) : null;
  const groupTrails = group ? trails.filter((t) => group.includes(t.id)) : [];

  // ---------------------------------------------------------------------------
  // URL (pushState keeps back/forward working without a server round trip)
  // ---------------------------------------------------------------------------
  function writeUrl(state: ExploreUrlState, mode: "push" | "replace") {
    const qs = serializeExploreParams(state);
    if (qs === lastUrl.current) return;
    lastUrl.current = qs;
    window.history[mode === "push" ? "pushState" : "replaceState"](null, "", qs ? `/explore?${qs}` : "/explore");
  }

  // ---------------------------------------------------------------------------
  // Trail search (same query as the URL) + polling while an area loads
  // ---------------------------------------------------------------------------
  async function runSearch(bbox: Bbox, f: ExploreFilters, mode: "new" | "poll" | "refresh") {
    window.clearTimeout(pollTimer.current);
    searchAbort.current?.abort();
    const ctrl = new AbortController();
    searchAbort.current = ctrl;
    const seq = ++searchSeq.current;
    if (mode !== "poll") {
      pollStarted.current = clock();
      setPollTimedOut(false);
    }
    if (mode === "new") {
      setStatus("loading");
      setError(null);
    }
    try {
      const res = await fetch(`/api/trails/search?${searchApiQuery(bbox, f)}`, { signal: ctrl.signal, headers: { accept: "application/json" } });
      if (!res.ok) {
        throw new SearchFailure(
          res.status === 429
            ? "You’ve searched a lot in a short time. Wait a minute, then try again."
            : res.status === 400
              ? "This search couldn’t be read. Try clearing the filters."
              : "We couldn’t reach the trail catalog.",
        );
      }
      const data = (await res.json()) as TrailSearchResponse;
      if (seq !== searchSeq.current) return;
      setResults(data);
      setStatus("ready");
      setError(null);
      setSelectedId((cur) => (cur && data.trails.some((t) => t.id === cur) ? cur : null));
      setGroup((g) => (g ? g.filter((id) => data.trails.some((t) => t.id === id)) : g));
      if (data.coverage.state === "loading") {
        if (clock() - pollStarted.current < POLL_MAX_MS) {
          pollTimer.current = window.setTimeout(() => void runSearch(bbox, f, "poll"), POLL_INTERVAL_MS);
        } else {
          setPollTimedOut(true);
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted || seq !== searchSeq.current) return;
      if (mode === "poll") {
        // Keep what is shown; offer "Check again".
        setPollTimedOut(true);
        return;
      }
      setStatus("error");
      setError(err instanceof SearchFailure ? err.message : "We couldn’t reach the trail catalog. Check your connection and try again.");
    }
  }

  function stopSearch() {
    window.clearTimeout(pollTimer.current);
    searchAbort.current?.abort();
    searchSeq.current += 1;
  }

  // ---------------------------------------------------------------------------
  // Selection: highlight, preview card and the route line
  // ---------------------------------------------------------------------------
  function select(id: string | null) {
    setSelectedId(id);
    setGroup(null);
    routeAbort.current?.abort();
    if (!id) {
      setRoute(null);
      return;
    }
    if (!isDesktop) setSheet("peek");
    window.requestAnimationFrame(() => {
      listRef.current?.querySelector(`[data-trail-id="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    });
    const cached = routeCache.current.get(id);
    if (cached) {
      setRoute({ id, status: "ready", geometry: cached });
      return;
    }
    setRoute({ id, status: "loading", geometry: null });
    const ctrl = new AbortController();
    routeAbort.current = ctrl;
    // Only the line (display-simplified), not the whole trail detail.
    fetch(trailRoutePreviewUrl(id), { signal: ctrl.signal, headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const preview = (await res.json()) as TrailRoutePreviewDto;
        const cache = routeCache.current;
        cache.set(id, preview.geometry);
        if (cache.size > ROUTE_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
        setRoute({ id, status: "ready", geometry: preview.geometry });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setRoute({ id, status: "error", geometry: null });
      });
  }

  function selectGroup(ids: string[]) {
    select(null);
    setGroup(ids);
    if (!isDesktop) setSheet("peek");
  }

  // ---------------------------------------------------------------------------
  // Areas: a chosen place, near me, or the current map view
  // ---------------------------------------------------------------------------
  function goToArea(bbox: Bbox, q: string, mode: "push" | "replace", f: ExploreFilters = filtersRef.current) {
    setArea(bbox);
    setAreaQuery(q);
    setView((v) => ({ ...v, moved: false }));
    select(null);
    mapHandle.current?.fitBbox(bbox, true);
    writeUrl({ q, bbox, filters: f }, mode);
    if (!isDesktop) setSheet("peek");
    void runSearch(bbox, f, "new");
  }

  function choosePlace(result: GeocodeResultDto, q: string, mode: "push" | "replace" = "push") {
    claimArea();
    setPlace((p) => (p ? { ...p, chosenId: result.id } : p));
    setPlacesOpen(false);
    goToArea(bboxForPlace(result), q, mode);
  }

  const nearMe = useNearMe((point) => {
    setQuery("");
    setPlace(null);
    goToArea(bboxAroundPoint(point, NEAR_ME_RADIUS_KM), "", "push");
  });

  /**
   * A new area choice: a place lookup or location request still in flight can
   * no longer move the map (it is aborted, and its "Looking up…" cleared).
   */
  function claimArea() {
    nearMe.reset();
    setPlace((p) => (p?.status === "searching" ? null : p));
    return areaClaims.claim();
  }

  async function searchPlace(text: string, mode: "push" | "replace" = "push") {
    const q = cleanQuery(text);
    const claim = claimArea();
    setPlacesOpen(false);
    if (q.length < 2) {
      setPlace({ query: q, status: "no_results", results: [], chosenId: null, message: "Type at least two letters of a place name." });
      return;
    }
    setPlace({ query: q, status: "searching", results: [], chosenId: null });
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { signal: claim.signal, headers: { accept: "application/json" } });
      if (!claim.isCurrent()) return;
      if (res.status === 429) {
        setPlace({ query: q, status: "unavailable", results: [], chosenId: null, message: "Too many place searches in a short time. Wait a minute, then try again." });
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as GeocodeResponse;
      // The person chose another area meanwhile (searched the map, Near me, Back…): that choice stands.
      if (!claim.isCurrent()) return;
      if (data.nearMe) {
        setPlace(null);
        nearMe.locate();
        return;
      }
      if (data.status === "unavailable") {
        setPlace({ query: q, status: "unavailable", results: [], chosenId: null });
        return;
      }
      if (!data.results.length) {
        setPlace({ query: q, status: "no_results", results: [], chosenId: null });
        return;
      }
      const first = data.results[0];
      setPlace({ query: q, status: "ok", results: data.results, chosenId: first.id });
      goToArea(bboxForPlace(first), q, mode);
    } catch {
      if (claim.isCurrent()) setPlace({ query: q, status: "unavailable", results: [], chosenId: null });
    }
  }

  function locateMe() {
    claimArea();
    nearMe.locate();
  }

  function searchThisArea() {
    const bbox = mapHandle.current?.getBbox();
    if (!bbox) return;
    claimArea();
    setQuery("");
    setPlace(null);
    setArea(bbox);
    setAreaQuery("");
    setView((v) => ({ ...v, moved: false }));
    select(null);
    writeUrl({ q: "", bbox, filters }, "push");
    void runSearch(bbox, filters, "new");
  }

  function applyFilters(f: ExploreFilters) {
    setFilters(f);
    setFiltersOpen(false);
    writeUrl({ q: areaQuery, bbox: area, filters: f }, "push");
    if (area) void runSearch(area, f, "new");
  }

  function retry() {
    if (area) void runSearch(area, filters, status === "error" ? "new" : "refresh");
  }

  function onUserMove(change: MapViewChange) {
    setView({ moved: true, zoom: change.zoom, bbox: change.bbox });
  }

  // ---------------------------------------------------------------------------
  // Effects: canonical URL + resume polling, back/forward, overlay size
  // ---------------------------------------------------------------------------
  const resumeInitial = useEffectEvent(() => {
    const qs = serializeExploreParams(initial.state);
    lastUrl.current = qs;
    if (window.location.search.replace(/^\?/, "") !== qs) {
      // Not synchronously: on the first page load this effect runs before the App Router's own mount
      // effect (React runs a child's effects before its parent's), and it is that effect which makes
      // history.replaceState keep the router's state on the entry (__NA and its tree) and update the
      // router's URL. Replaced now, the entry would be left with no router state, and Next.js ignores
      // a popstate to such an entry: Back from a trail page would change the URL but not the page
      // (next/dist/client/components/app-router.js, handlePopState). A microtask runs after the whole
      // effect flush, so the router is listening by then.
      queueMicrotask(() => {
        if (lastUrl.current === qs) window.history.replaceState(null, "", qs ? `/explore?${qs}` : "/explore");
      });
    }
    const bbox = initial.state.bbox;
    if (bbox && initial.results?.coverage.state === "loading") {
      pollStarted.current = clock();
      pollTimer.current = window.setTimeout(() => void runSearch(bbox, initial.state.filters, "poll"), POLL_INTERVAL_MS);
    }
  });
  const stopOnUnmount = useEffectEvent(() => {
    stopSearch();
    areaClaims.release();
    routeAbort.current?.abort();
  });
  useEffect(() => {
    resumeInitial();
    return () => stopOnUnmount();
  }, []);

  const onPopState = useEffectEvent(() => {
    const s = parseExploreParams(new URLSearchParams(window.location.search));
    const qs = serializeExploreParams(s);
    if (qs === lastUrl.current) return;
    lastUrl.current = qs;
    setQuery(s.q);
    setFilters(s.filters);
    setFiltersKey((k) => k + 1);
    if (s.bbox) {
      claimArea();
      const bbox = s.bbox;
      setArea(bbox);
      setAreaQuery(s.q);
      setView((v) => ({ ...v, moved: false }));
      setPlace((p) => (p && p.query === s.q ? p : null));
      select(null);
      mapHandle.current?.fitBbox(bbox, true);
      void runSearch(bbox, s.filters, "new");
    } else if (s.q) {
      void searchPlace(s.q, "replace");
    } else {
      claimArea();
      stopSearch();
      select(null);
      setArea(null);
      setAreaQuery("");
      setResults(null);
      setPlace(null);
      setStatus("idle");
    }
  });
  useEffect(() => {
    const handler = () => onPopState();
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  // Esc closes the preview card (unless a dialog is open; it handles Esc itself).
  const onEscape = useEffectEvent((e: KeyboardEvent) => {
    if (e.key !== "Escape" || filtersOpen || (!selectedId && !group)) return;
    select(null);
  });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onEscape(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  useEffect(() => {
    const el = topRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setTopHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const peekPx = PEEK_REM * 16;
  const getPadding = () =>
    isDesktop ? { top: 72, bottom: 56, left: 56, right: 56 } : { top: topHeight + 16, bottom: peekPx + 16, left: 24, right: 24 };

  const capped = results ? results.total > results.trails.length : false;
  const viewOutsideArea = view.bbox ? !area || !bboxWithin(view.bbox, area) || capped : false;
  const showAreaPill = view.moved && viewOutsideArea;
  const zoomedOut = view.zoom !== null && view.zoom < MIN_SEARCH_ZOOM;
  const summary = coverage ? coverageSummary(coverage) : null;
  const chosenPlace = place?.status === "ok" ? (place.results.find((r) => r.id === place.chosenId) ?? place.results[0]) : null;

  const heading = resultsHeading(status, results);
  const areaLabel = status === "idle" ? null : chosenPlace ? `near ${chosenPlace.label}` : area ? "in this map area" : null;

  const sheetStyle = {
    "--sheet-h": sheet === "peek" ? `${PEEK_REM}rem` : sheet === "half" ? "55%" : `calc(100% - ${topHeight + 8}px)`,
    "--pill-top": `${topHeight + 8}px`,
  } as CSSProperties;

  const placeMessage: { busy: boolean; text: string; source: "near_me" | "place"; retry: boolean; dismiss: boolean } | null = nearMe.message
    ? { busy: nearMe.status === "locating", text: nearMe.message, source: "near_me", retry: false, dismiss: nearMe.status !== "locating" }
    : !place
      ? null
      : place.status === "searching"
        ? { busy: true, text: `Looking up “${place.query}”…`, source: "place", retry: false, dismiss: false }
        : place.status === "no_results"
          ? {
              busy: false,
              text: place.message ?? `We couldn’t find “${place.query}”. Try a town, park or mountain name, or check the spelling.`,
              source: "place",
              retry: false,
              dismiss: true,
            }
          : place.status === "unavailable"
            ? {
                busy: false,
                text: place.message ?? "Place search is unavailable right now. Try again, or move the map and choose “Search this area”.",
                source: "place",
                retry: true,
                dismiss: true,
              }
            : place.status === "near_me"
              ? { busy: false, text: "To find trails near you, tap “Near me”. Your location is used once and never stored.", source: "place", retry: false, dismiss: true }
              : null;

  return (
    <div
      data-app-fullscreen
      style={sheetStyle}
      className="relative min-h-0 flex-1 overflow-hidden bg-sand-100 lg:grid lg:grid-cols-[400px_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)]"
    >
      <h1 className="sr-only">Explore trails</h1>

      {/* Search, filters and place messages: floating over the map on phones, top of the side panel on desktop. */}
      <div
        ref={topRef}
        className="pointer-events-none absolute inset-x-0 top-0 z-30 space-y-2 p-3 lg:pointer-events-auto lg:static lg:col-start-1 lg:row-start-1 lg:space-y-3 lg:border-r lg:border-b lg:border-sand-200 lg:bg-surface lg:p-4"
      >
        <form
          role="search"
          action="/explore"
          method="get"
          onSubmit={(e) => {
            e.preventDefault();
            void searchPlace(query);
          }}
          className="pointer-events-auto flex items-center gap-1 rounded-2xl bg-surface p-1 pl-3 shadow-[0_2px_10px_rgba(15,35,24,0.16)] ring-1 ring-sand-200 focus-within:ring-2 focus-within:ring-forest-600 lg:shadow-none"
        >
          <Search aria-hidden className="size-5 shrink-0 text-muted" />
          <label htmlFor="explore-q" className="sr-only">
            Search for a place
          </label>
          <input
            id="explore-q"
            name="q"
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            maxLength={120}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Town, park or mountain"
            className="min-h-11 min-w-0 flex-1 bg-transparent px-1 text-base text-ink placeholder:text-muted/80 focus:outline-none focus-visible:outline-none"
          />
          {filterEntries(filters).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <button type="submit" className="inline-flex min-h-11 items-center rounded-xl bg-forest-700 px-4 font-semibold text-white hover:bg-forest-800">
            Search
          </button>
        </form>

        <div className="flex gap-2 overflow-x-auto [scrollbar-width:none]">
          <button type="button" onClick={locateMe} disabled={nearMe.status === "locating"} className={chipButton}>
            {nearMe.status === "locating" ? <Spinner /> : <LocateFixed aria-hidden className="size-4" />}
            Near me
          </button>
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => {
              setFiltersKey((k) => k + 1);
              setFiltersOpen(true);
            }}
            className={chipButton}
          >
            <SlidersHorizontal aria-hidden className="size-4" />
            Filters
            {activeFilters ? (
              <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-forest-700 px-1.5 text-xs font-bold text-white">
                {activeFilters}
                <span className="sr-only"> active</span>
              </span>
            ) : null}
          </button>
          {activeFilters ? (
            <button type="button" onClick={() => applyFilters(clearedFilters(filters))} className={clsx(chipButton, "font-medium text-muted")}>
              <X aria-hidden className="size-4" />
              Clear<span className="sr-only"> filters</span>
            </button>
          ) : null}
        </div>

        <div role="status" aria-live="polite" className="space-y-2 empty:hidden">
          {placeMessage ? (
            <div className="pointer-events-auto flex items-start gap-2 rounded-xl bg-surface px-3 py-2.5 text-sm text-ink shadow-[0_1px_4px_rgba(15,35,24,0.14)] ring-1 ring-sand-200 lg:shadow-none">
              {placeMessage.busy ? <Spinner className="mt-0.5" /> : null}
              <p className="flex-1">{placeMessage.text}</p>
              {placeMessage.retry && place ? (
                <button type="button" onClick={() => void searchPlace(place.query)} className="-my-1.5 inline-flex min-h-9 items-center gap-1 rounded-lg px-2 font-semibold text-forest-800 hover:bg-forest-50">
                  <RotateCw aria-hidden className="size-3.5" /> Retry
                </button>
              ) : null}
              {placeMessage.dismiss ? (
                <button type="button" onClick={() => (placeMessage.source === "near_me" ? nearMe.reset() : setPlace(null))} className="-my-1.5 -mr-1.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg hover:bg-sand-100">
                  <X aria-hidden className="size-4" />
                  <span className="sr-only">Dismiss</span>
                </button>
              ) : null}
            </div>
          ) : null}
          {chosenPlace && place && place.results.length > 1 ? (
            <div className="pointer-events-auto rounded-xl bg-surface text-sm shadow-[0_1px_4px_rgba(15,35,24,0.14)] ring-1 ring-sand-200 lg:shadow-none">
              <div className="flex items-center gap-2 py-1 pr-1 pl-3">
                <p className="min-w-0 flex-1 truncate">
                  <span className="text-muted">Showing </span>
                  <span className="font-semibold text-ink">{chosenPlace.label}</span>
                </p>
                <button
                  type="button"
                  aria-expanded={placesOpen}
                  aria-controls="explore-places"
                  onClick={() => setPlacesOpen((o) => !o)}
                  className="inline-flex min-h-10 shrink-0 items-center gap-1 rounded-lg px-2 font-semibold text-forest-800 hover:bg-forest-50"
                >
                  {place.results.length - 1 === 1 ? "1 other place" : `${place.results.length - 1} other places`}
                  <ChevronDown aria-hidden className={clsx("size-4 transition-transform", placesOpen && "rotate-180")} />
                </button>
              </div>
              {placesOpen ? (
                <ul id="explore-places" className="max-h-56 overflow-y-auto border-t border-sand-200 py-1">
                  {place.results
                    .filter((r) => r.id !== chosenPlace.id)
                    .map((r) => (
                      <li key={r.id}>
                        <button type="button" onClick={() => choosePlace(r, place.query)} className="flex min-h-11 w-full flex-col justify-center px-3 py-1.5 text-left hover:bg-forest-50">
                          <span className="font-medium text-ink">{r.label}</span>
                          <span className="text-xs text-muted capitalize">{humanizeKind(r.kind)}</span>
                        </button>
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* Results: bottom sheet on phones, side panel on desktop. */}
      <section
        aria-labelledby="explore-results-heading"
        className="absolute inset-x-0 bottom-0 z-20 flex h-[var(--sheet-h)] flex-col rounded-t-2xl bg-surface shadow-[0_-6px_24px_rgba(15,35,24,0.14)] motion-safe:transition-[height] motion-safe:duration-300 motion-safe:ease-out lg:static lg:col-start-1 lg:row-start-2 lg:h-auto lg:min-h-0 lg:rounded-none lg:border-r lg:border-sand-200 lg:shadow-none"
      >
        <button
          type="button"
          onClick={() => setSheet((s) => (s === "peek" ? "half" : s === "half" ? "full" : "peek"))}
          aria-expanded={sheet !== "peek"}
          aria-controls="explore-list"
          className="flex h-6 w-full shrink-0 items-center justify-center rounded-t-2xl lg:hidden"
        >
          <span aria-hidden className="h-1.5 w-10 rounded-full bg-sand-300" />
          <span className="sr-only">{sheet === "full" ? "Show the map" : "Show more of the list"}</span>
        </button>
        <div className="shrink-0 border-b border-sand-200 px-4 pb-2.5 sm:px-5 lg:pt-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 id="explore-results-heading" aria-live="polite" className="truncate text-lg font-bold text-ink">
                {heading}
              </h2>
              {areaLabel ? <p className="truncate text-sm text-muted">{areaLabel}</p> : null}
              {/* The map's status pill, for screen readers (the visual pill sits on the map). */}
              <p className="sr-only" aria-live="polite">
                {status === "ready" && coverage && coverage.state !== "ready"
                  ? pollTimedOut && coverage.state === "loading"
                    ? "Still loading this area. Use Check again on the map, or try again in a minute."
                    : coverage.message
                  : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSheet((s) => (s === "full" ? "peek" : "full"))}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-forest-200 px-3 font-semibold text-forest-800 hover:bg-forest-50 lg:hidden"
            >
              {sheet === "full" ? <MapIcon aria-hidden className="size-4" /> : <List aria-hidden className="size-4" />}
              {sheet === "full" ? "Map" : "List"}
            </button>
          </div>
          <div className={clsx("mt-2 items-center justify-between gap-2", status === "idle" ? "hidden" : sheet === "peek" ? "hidden lg:flex" : "flex")}>
            <label htmlFor="explore-sort" className="sr-only">
              Sort trails
            </label>
            <select
              id="explore-sort"
              value={filters.sort}
              onChange={(e) => applyFilters({ ...filters, sort: e.target.value as Sort })}
              className="min-h-9 rounded-lg border border-sand-200 bg-surface py-1 pr-8 pl-2.5 text-sm font-medium text-ink"
            >
              {(Object.keys(SORT_LABEL) as Sort[]).map((s) => (
                <option key={s} value={s}>
                  Sort: {SORT_LABEL[s]}
                </option>
              ))}
            </select>
            <UnitsToggle value={units} onChange={setUnits} size="sm" />
          </div>
        </div>
        <div
          id="explore-list"
          ref={listRef}
          className={clsx("min-h-0 flex-1 overscroll-contain", sheet === "peek" && !isDesktop ? "overflow-hidden" : "overflow-y-auto")}
        >
          <ResultsList
            status={status}
            error={error}
            trails={trails}
            coverage={coverage}
            units={units}
            selectedId={selectedId}
            filtersActive={activeFilters > 0}
            onHover={(id) => mapHandle.current?.setHovered(id)}
            onRetry={retry}
            onClearFilters={() => applyFilters(clearedFilters(filters))}
            intro={
              <div className="px-5 py-5">
                <p className="font-semibold text-ink">Find a trail anywhere</p>
                <p className="mt-1 text-[0.95rem] text-muted">
                  Search for a town, park or mountain, or use Near me. Trails come from OpenStreetMap and load the first time an area is searched.
                </p>
                <p className="mt-4 text-sm font-medium text-muted">Try</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        setQuery(s);
                        void searchPlace(s);
                      }}
                      className="inline-flex min-h-11 items-center rounded-full border border-sand-300 px-4 text-[0.95rem] font-medium text-forest-900 hover:border-forest-500 hover:bg-forest-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            }
          />
          {status === "ready" && trails.length ? <ListFooter coverage={coverage} capped={capped} /> : null}
        </div>
      </section>

      {/* The map. */}
      {/* maplibre-gl.css sets .maplibregl-map { position: relative }, which (depending on stylesheet order) defeats
          MapView's absolute inset-0 canvas container and collapses it to 0 px; keep it absolutely positioned. */}
      <div className="absolute inset-0 z-0 lg:static lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:min-h-0 [&_.maplibregl-map]:absolute! [&_.maplibregl-map]:inset-0!">
        <ExploreMap
          ariaLabel="Map of trails. The list has the same trails."
          initialBbox={initial.state.bbox}
          trails={trails}
          selectedId={selectedId}
          selectedRoute={route?.id === selectedId && route?.status === "ready" ? route.geometry : null}
          onSelect={select}
          onSelectGroup={selectGroup}
          onUserMove={onUserMove}
          getPadding={getPadding}
          handleRef={mapHandle}
        >
          <div className="pointer-events-none absolute inset-x-3 top-[var(--pill-top)] z-10 flex flex-col items-center gap-2 lg:top-4">
            {summary && status === "ready" ? (
              <div
                className={clsx(
                  "pointer-events-auto flex max-w-full items-center gap-2 rounded-full py-1.5 pr-1.5 pl-3 text-sm font-medium shadow-[0_2px_8px_rgba(15,35,24,0.18)] ring-1 lg:max-w-xl",
                  summary.tone === "error" ? "bg-red-bg text-red-ink ring-[#f5c6c1]" : summary.tone === "warn" ? "bg-amber-bg text-amber-ink ring-[#f1d9b0]" : "bg-surface text-ink ring-sand-200",
                )}
              >
                {coverage?.state === "loading" && !pollTimedOut ? <Spinner className="text-forest-700" /> : null}
                <span className="min-w-0">
                  <span className="lg:hidden">{pollTimedOut && coverage?.state === "loading" ? "Still loading this area" : summary.short}</span>
                  <span className="hidden lg:inline">{pollTimedOut && coverage?.state === "loading" ? "Still loading this area. Check again in a minute." : coverage?.message}</span>
                  {summary.progress && coverage?.state === "loading" ? <span className="text-muted"> · {summary.progress}</span> : null}
                </span>
                {(coverage?.state === "loading" && pollTimedOut) || coverage?.state === "partial" || coverage?.state === "failed" ? (
                  <button type="button" onClick={retry} className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full bg-surface px-3 font-semibold text-forest-800 ring-1 ring-sand-200 hover:bg-forest-50">
                    <RotateCw aria-hidden className="size-3.5" /> {coverage?.state === "loading" ? "Check again" : "Retry"}
                  </button>
                ) : (
                  <span className="w-1.5" />
                )}
              </div>
            ) : null}
            {showAreaPill ? (
              zoomedOut ? (
                <p className="rounded-full bg-surface/95 px-4 py-2 text-sm font-medium text-muted shadow-[0_2px_8px_rgba(15,35,24,0.18)]">Zoom in to search this area</p>
              ) : (
                <button
                  type="button"
                  onClick={searchThisArea}
                  className="pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-full bg-forest-800 px-5 font-semibold text-white shadow-[0_3px_12px_rgba(15,35,24,0.3)] hover:bg-forest-900"
                >
                  <Search aria-hidden className="size-4" /> Search this area
                </button>
              )
            ) : null}
          </div>

          {groupTrails.length > 1 && (isDesktop || sheet === "peek") ? (
            <TrailGroupPreview
              trails={groupTrails}
              units={units}
              onChoose={select}
              onHover={(id) => mapHandle.current?.setHovered(id)}
              onClose={() => setGroup(null)}
              className="absolute inset-x-3 bottom-[calc(var(--sheet-h)+0.75rem)] z-10 lg:right-auto lg:bottom-6 lg:left-6 lg:w-[22rem]"
            />
          ) : null}
          {selected && (isDesktop || sheet === "peek") ? (
            <TrailPreview
              trail={selected}
              units={units}
              routeStatus={route?.id === selected.id ? route.status : "loading"}
              onClose={() => select(null)}
              className="absolute inset-x-3 bottom-[calc(var(--sheet-h)+0.75rem)] z-10 lg:right-auto lg:bottom-6 lg:left-6 lg:w-[22rem]"
            />
          ) : null}
        </ExploreMap>
      </div>

      <FiltersDialog
        key={`${filtersKey}-${units}`}
        open={filtersOpen}
        filters={filters}
        units={units}
        onApply={applyFilters}
        onClose={() => setFiltersOpen(false)}
      />
    </div>
  );
}

function TrailGroupPreview({
  trails,
  units,
  onChoose,
  onHover,
  onClose,
  className,
}: {
  trails: TrailSummaryDto[];
  units: Units;
  onChoose: (id: string) => void;
  onHover: (id: string | null) => void;
  onClose: () => void;
  className?: string;
}) {
  return (
    <section aria-label={`${trails.length} trails start here`} className={clsx("rounded-2xl bg-surface pt-3 shadow-[0_6px_24px_rgba(15,35,24,0.22)] ring-1 ring-sand-200", className)}>
      <div className="flex items-center justify-between gap-3 px-4">
        <h3 className="font-bold text-ink">{trails.length} trails start here</h3>
        <button type="button" onClick={onClose} className="-mr-1.5 inline-flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-sand-100">
          <X aria-hidden className="size-5" />
          <span className="sr-only">Close</span>
        </button>
      </div>
      <ul className="max-h-60 divide-y divide-sand-200 overflow-y-auto border-t border-sand-200">
        {trails.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onChoose(t.id)}
              onMouseEnter={() => onHover(t.id)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(t.id)}
              onBlur={() => onHover(null)}
              className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-2 text-left hover:bg-forest-50"
            >
              <span className="min-w-0">
                <span className="block truncate font-semibold text-ink">{t.name}</span>
                <span className="block text-sm text-muted">{hikeDistanceText(t, units)}</span>
              </span>
              <TrailDifficulty difficulty={t.difficulty} source={t.difficultySource} climbKnown={climbKnown(t)} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TrailPreview({
  trail,
  units,
  routeStatus,
  onClose,
  className,
}: {
  trail: TrailSummaryDto;
  units: Units;
  routeStatus: RouteState["status"];
  onClose: () => void;
  className?: string;
}) {
  const en = englishName(trail);
  const place = placeLine(trail);
  return (
    <article aria-label={`Selected trail: ${trail.name}`} className={clsx("rounded-2xl bg-surface p-4 shadow-[0_6px_24px_rgba(15,35,24,0.22)] ring-1 ring-sand-200", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg leading-snug font-bold text-ink">{trail.name}</h3>
          {en ? <p className="text-sm text-muted">{en}</p> : null}
          {place ? <p className="text-sm text-muted">{place}</p> : null}
        </div>
        <button type="button" onClick={onClose} className="-mt-1.5 -mr-1.5 inline-flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-sand-100">
          <X aria-hidden className="size-5" />
          <span className="sr-only">Close preview</span>
        </button>
      </div>
      <TrailStats trail={trail} units={units} className="mt-2" />
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <TrailDifficulty difficulty={trail.difficulty} source={trail.difficultySource} climbKnown={climbKnown(trail)} />
          <FeatureIcons features={trail.features} />
        </div>
        <Link href={trail.path} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl bg-forest-700 px-4 font-semibold text-white hover:bg-forest-800">
          View trail <ArrowRight aria-hidden className="size-4" />
        </Link>
      </div>
      {routeStatus === "error" ? <p className="mt-2 text-xs text-muted">The route line couldn’t be loaded. The trail page has the full route.</p> : null}
    </article>
  );
}
