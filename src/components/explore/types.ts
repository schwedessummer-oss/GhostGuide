import type { GeocodeResultDto, TrailDetailDto, TrailSearchResponse } from "@/domain/catalog";
import type { Units } from "@/lib/units";
import type { ExploreUrlState } from "./url-state";

/** Result of looking up the text typed in the search box. */
export interface PlaceSearchState {
  query: string;
  status: "searching" | "ok" | "no_results" | "unavailable" | "near_me";
  results: GeocodeResultDto[];
  chosenId: string | null;
  /** Shown for "unavailable" (e.g. rate limited). */
  message?: string;
}

/** What the server rendered: hydrated as the client's starting state. */
export interface ExploreInitial {
  /** Canonical URL state (bbox resolved from q when the server geocoded it). */
  state: ExploreUrlState;
  results: TrailSearchResponse | null;
  searchError: string | null;
  place: PlaceSearchState | null;
  units: Units;
}

export type SearchStatus = "idle" | "loading" | "ready" | "error";

/**
 * GET /api/trails/:id/geometry: the route line for Explore's map preview,
 * simplified for display (a few metres at most; the trail page has the full
 * route). Distances and climbs are never computed from it.
 */
export interface TrailRoutePreviewDto {
  id: string;
  geometry: TrailDetailDto["geometry"];
  /** True when vertices were dropped for display. */
  simplified: boolean;
}

/** Where Explore fetches a trail's preview line. */
export const trailRoutePreviewUrl = (id: string) => `/api/trails/${encodeURIComponent(id)}/geometry`;
