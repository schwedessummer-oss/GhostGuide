import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import { withUser, type JsonValue } from "@/server/db";
import { getRegionById } from "@/server/catalog/trails";
import { log } from "@/server/log";
import { localDateInZone } from "@/lib/time";
import { buildItinerary } from "@/domain/itinerary";
import { recommendTrails } from "@/domain/recommendation";
import { getLatestFinishTable, getVisibleTrailRegionId, loadCandidates, partialClosuresOn } from "./catalog";
import { permitNotes } from "./plan";
import { parseTripPreferences, validatePlanTiming } from "./preferences";
import { summarizeItineraryText } from "./ai";

export type SaveTripErrorCode = "invalid" | "not_found" | "excluded" | "date";

export class SaveTripError extends Error {
  constructor(
    readonly code: SaveTripErrorCode,
    message: string,
    readonly reasons: string[] = [],
  ) {
    super(message);
    this.name = "SaveTripError";
  }
}

export interface SavedTrip {
  tripId: string;
  score: number;
}

/**
 * Save a personalized trip for `user`.
 *
 * Never trusts client-side scores: the preferences are re-validated (unknown
 * keys such as a tampered "score" are stripped), the deterministic
 * recommendation is re-run server-side for this trail, and a trail that is
 * excluded for these preferences is refused. The row is inserted with the
 * user's own RLS-scoped connection (status defaults to 'saved').
 */
export async function saveTrip(user: SessionUser, prefsInput: unknown, trailId: string, opts: { now?: Date } = {}): Promise<SavedTrip> {
  const now = opts.now ?? new Date();
  const parsed = parseTripPreferences(prefsInput);
  if (!parsed.ok) throw new SaveTripError("invalid", `Invalid trip preferences: ${parsed.error}`);
  const prefs = parsed.prefs;
  if (!z.uuid().safeParse(trailId).success) throw new SaveTripError("not_found", "Trail not found.");

  const regionId = await getVisibleTrailRegionId(trailId);
  const region = regionId ? await getRegionById(regionId) : null;
  if (!region) throw new SaveTripError("not_found", "Trail not found.");
  const timing = validatePlanTiming(prefs, now, region.timezone);
  if (timing.date || timing.start) throw new SaveTripError("date", timing.date ?? timing.start ?? "Invalid date.");

  const regional = await loadCandidates({ trailId }, prefs.plannedDate, region.timezone);
  const trail = regional.trails.get(trailId);
  if (!trail) throw new SaveTripError("not_found", "Trail not found.");
  const latestFinishByMonth = await getLatestFinishTable(region.slug);
  const rec = recommendTrails(prefs, regional.candidates, {
    today: localDateInZone(now, region.timezone),
    regionTimezone: region.timezone,
    latestFinishByMonth,
  });
  const ranked = rec.ranked.find((r) => r.trailId === trailId);
  if (!ranked) {
    const reasons = rec.excluded.find((e) => e.trailId === trailId)?.reasons ?? ["This trail does not meet your plan's constraints."];
    throw new SaveTripError("excluded", "This trail doesn't fit your plan, so it can't be saved.", reasons);
  }

  const permits = regional.permitsByTrail.get(trailId) ?? [];
  // Same itinerary as the results page, including partial closures on the planned date.
  const partialClosures = partialClosuresOn(regional, trailId, prefs.plannedDate, region.timezone);
  const itinerary = buildItinerary(trail, regional.pois.get(trailId) ?? [], prefs, now, {
    latestFinishTime: rec.latestFinishTime,
    partialClosures,
    extraNotes: permitNotes(permits),
  });

  const trailheadIds = new Set((regional.pois.get(trailId) ?? []).filter((p) => p.kind === "trailhead").map((p) => p.id));
  const ai = await summarizeItineraryText(user, {
    trailId,
    trailName: trail.name,
    isDemo: trail.isDemo,
    plannedDate: itinerary.plannedDate,
    startTime: itinerary.startTime,
    estimatedFinishTime: itinerary.estimatedFinishTime,
    estimatedDurationMin: itinerary.estimatedDurationMin,
    turnaroundBy: itinerary.turnaroundBy,
    stops: itinerary.stops
      .filter((s) => !trailheadIds.has(s.poiId))
      .map((s) => ({ name: s.name, etaOffsetMin: s.etaOffsetMin })),
    reminders: itinerary.reminders,
    partialClosures,
  });

  const recommendation = {
    version: 1,
    trailId,
    score: ranked.score,
    breakdown: ranked.breakdown,
    reasons: ranked.reasons,
    warnings: ranked.warnings,
    estimatedDurationMin: ranked.estimatedDurationMin,
    estimatedFinishTime: ranked.estimatedFinishTime,
    paceFactor: ranked.paceFactor,
    latestFinishEstimate: rec.latestFinishTime,
    evaluatedAt: now.toISOString(),
  };

  const [row] = await withUser(
    user,
    (tx) => tx<{ id: string }[]>`
      insert into public.trips (user_id, region_id, trail_id, planned_date, start_time, party_size,
                                preferences, recommendation, itinerary, ai_summary, ai_provider, ai_generated_at)
      values (${user.id}, ${trail.regionId}, ${trailId}, ${prefs.plannedDate}::date, ${prefs.startTime}::time, ${prefs.partySize},
              ${tx.json(JSON.parse(JSON.stringify(prefs)) as JsonValue)}, ${tx.json(recommendation as unknown as JsonValue)},
              ${tx.json(itinerary as unknown as JsonValue)}, ${ai.text},
              ${ai.model ? `${ai.provider}:${ai.model}` : ai.provider}, ${now}::timestamptz)
      returning id`,
  );
  log.info("discover.trip_saved", { tripId: row.id, trailId, score: ranked.score });
  return { tripId: row.id, score: ranked.score };
}
