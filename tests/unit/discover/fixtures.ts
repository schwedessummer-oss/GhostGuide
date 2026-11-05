import type { CandidateTrail, CandidateTrailInfo, RecommendationContext } from "@/domain/recommendation";
import { DEFAULT_LATEST_FINISH_BY_MONTH } from "@/domain/recommendation";
import type { TripPreferences } from "@/domain/types";

export function trailInfo(overrides: Partial<CandidateTrailInfo> = {}): CandidateTrailInfo {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "base-trail",
    name: "Base Trail",
    status: "published",
    isDemo: true,
    distanceKm: 5,
    elevationGainM: 200,
    difficulty: "moderate",
    terrain: ["forest", "river"],
    routeType: "loop",
    estimatedDurationMin: 100,
    accessibilityFeatures: [],
    dogsAllowed: true,
    permitRequired: false,
    dailyCapacity: 20,
    geometryValidatedAt: new Date("2026-10-01T00:00:00Z"),
    hasGeometry: true,
    ...overrides,
  };
}

export function candidate(overrides: Partial<CandidateTrailInfo> = {}, extra: Partial<CandidateTrail> = {}): CandidateTrail {
  return { trail: trailInfo(overrides), closures: [], permits: [], poiCount: 3, stopCount: 2, ...extra };
}

export function prefs(overrides: Partial<TripPreferences> = {}): TripPreferences {
  return {
    experience: "some",
    fitness: "moderate",
    preferredTerrain: ["forest"],
    pace: "steady",
    availableHours: 6,
    plannedDate: "2026-11-14",
    startTime: "08:00",
    accessibilityNeeds: [],
    partySize: 2,
    equipment: [],
    bringingDog: false,
    ...overrides,
  };
}

export const ctx: RecommendationContext = {
  today: "2026-11-05",
  regionTimezone: "America/Los_Angeles",
  latestFinishByMonth: DEFAULT_LATEST_FINISH_BY_MONTH,
};
