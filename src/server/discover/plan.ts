import "server-only";
import { getLaunchRegion, type Region } from "@/server/catalog/trails";
import { localDateInZone } from "@/lib/time";
import { buildItinerary } from "@/domain/itinerary";
import { LATEST_FINISH_LABEL, recommendTrails, type ExclusionCode, type RankedTrail } from "@/domain/recommendation";
import type { Itinerary, TripPreferences } from "@/domain/types";
import { getLatestFinishTable, loadCandidates, type PlanTrail } from "./catalog";

/**
 * Plan a hike: run the deterministic recommendation over the region's
 * catalog for the planned date and build an itinerary for each suggestion.
 * Read-only and public (no user needed); nothing is written.
 */
export interface PlanSuggestion {
  rank: number;
  trail: PlanTrail;
  result: RankedTrail;
  itinerary: Itinerary;
  permits: { name: string; officialUrl: string; leadTimeDays: number | null }[];
  /** POI ids that are trailheads (shown as the start, not as a separate stop). */
  trailheadPoiIds: string[];
}

export interface PlanExclusion {
  trail: PlanTrail;
  reasons: string[];
  codes: ExclusionCode[];
}

export interface PlanResult {
  region: Pick<Region, "id" | "slug" | "name" | "timezone" | "isDemo">;
  today: string;
  latestFinishTime: string;
  latestFinishLabel: string;
  paceFactor: number;
  suggestions: PlanSuggestion[];
  excluded: PlanExclusion[];
  noMatch: boolean;
  relaxSuggestions: string[];
  focus: { slug: string; status: "ranked" | "excluded" | "unknown" } | null;
}

export async function planTrip(prefs: TripPreferences, opts: { now?: Date; focusSlug?: string } = {}): Promise<PlanResult> {
  const now = opts.now ?? new Date();
  const region = await getLaunchRegion();
  const today = localDateInZone(now, region.timezone);
  const [bundle, latestFinishByMonth] = await Promise.all([
    loadCandidates({ regionId: region.id }, prefs.plannedDate, region.timezone),
    getLatestFinishTable(region.slug),
  ]);
  const rec = recommendTrails(prefs, bundle.candidates, { today, regionTimezone: region.timezone, latestFinishByMonth });

  const suggestions: PlanSuggestion[] = rec.ranked.map((r, i) => {
    const trail = bundle.trails.get(r.trailId)!;
    const permits = bundle.permitsByTrail.get(r.trailId) ?? [];
    return {
      rank: i + 1,
      trail,
      result: r,
      permits,
      trailheadPoiIds: (bundle.pois.get(r.trailId) ?? []).filter((p) => p.kind === "trailhead").map((p) => p.id),
      itinerary: buildItinerary(trail, bundle.pois.get(r.trailId) ?? [], prefs, now, {
        latestFinishTime: rec.latestFinishTime,
        extraNotes: permits.map((p) => `Permit: ${p.name}${p.leadTimeDays !== null ? ` (allow about ${p.leadTimeDays} days)` : ""}.`),
      }),
    };
  });
  const excluded: PlanExclusion[] = rec.excluded.map((e) => ({ trail: bundle.trails.get(e.trailId)!, reasons: e.reasons, codes: e.codes }));

  let focus: PlanResult["focus"] = null;
  if (opts.focusSlug) {
    const status = suggestions.some((s) => s.trail.slug === opts.focusSlug)
      ? "ranked"
      : excluded.some((e) => e.trail.slug === opts.focusSlug)
        ? "excluded"
        : "unknown";
    focus = { slug: opts.focusSlug, status };
  }

  return {
    region: { id: region.id, slug: region.slug, name: region.name, timezone: region.timezone, isDemo: region.isDemo },
    today,
    latestFinishTime: rec.latestFinishTime,
    latestFinishLabel: LATEST_FINISH_LABEL,
    paceFactor: rec.paceFactor,
    suggestions,
    excluded,
    noMatch: rec.noMatch,
    relaxSuggestions: rec.relaxSuggestions,
    focus,
  };
}
