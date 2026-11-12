/**
 * Display helpers for catalog trails on Explore (pure, isomorphic).
 * Never invent values: unknowns are reported as unknown.
 */
import type { CoverageDto, Difficulty, DifficultySource, RouteType, TrailFeature, TrailSummaryDto } from "@/domain/catalog";
import { approxDuration, formatClimb, formatLength, type Units } from "@/lib/units";

export type Tone = "neutral" | "forest" | "amber" | "red" | "blue";

export const DIFFICULTY_META: Record<Difficulty, { label: string; tone: Tone; color: string }> = {
  easy: { label: "Easy", tone: "forest", color: "#35704d" },
  moderate: { label: "Moderate", tone: "blue", color: "#1e4f9c" },
  hard: { label: "Hard", tone: "amber", color: "#a8590c" },
  expert: { label: "Expert", tone: "red", color: "#a3241a" },
  unknown: { label: "Difficulty unknown", tone: "neutral", color: "#6b716c" },
};

export function difficultyText(d: Difficulty, source: DifficultySource | null): { label: string; estimated: boolean } {
  return { label: DIFFICULTY_META[d]?.label ?? DIFFICULTY_META.unknown.label, estimated: d !== "unknown" && source === "estimated" };
}

export const ROUTE_FORM_LABEL: Record<RouteType, string> = {
  loop: "Loop",
  linear: "Out & back",
  network: "Network",
  unknown: "Route form unknown",
};

export const FEATURE_LABEL: Record<TrailFeature, string> = {
  waterfall: "Waterfall",
  lake: "Lake",
  viewpoint: "Viewpoint",
  peak: "Peak",
  cave: "Cave",
  spring: "Spring",
  shelter: "Shelter",
  picnic_site: "Picnic area",
};

/** Display priority: the features people choose hikes for come first. */
const FEATURE_ORDER: TrailFeature[] = ["waterfall", "lake", "viewpoint", "peak", "cave", "spring", "shelter", "picnic_site"];

export function topFeatures(features: readonly TrailFeature[], n = 3): TrailFeature[] {
  const set = new Set(features);
  return FEATURE_ORDER.filter((f) => set.has(f)).slice(0, n);
}

/** "6.8 mi out & back", "3.1 mi loop", "4.2 mi of paths (network)", "2.0 mi". */
export function hikeDistanceText(t: Pick<TrailSummaryDto, "hikeDistanceM" | "routeType">, units: Units): string {
  const d = formatLength(t.hikeDistanceM, units);
  switch (t.routeType) {
    case "linear":
      return `${d} out & back`;
    case "loop":
      return `${d} loop`;
    case "network":
      return `${d} of paths (network)`;
    default:
      return d;
  }
}

export function climbText(t: Pick<TrailSummaryDto, "hikeGainM">, units: Units): string | null {
  return t.hikeGainM === null ? null : formatClimb(t.hikeGainM, units);
}

export function durationText(t: Pick<TrailSummaryDto, "hikeDurationMin">): string | null {
  return t.hikeDurationMin === null ? null : approxDuration(t.hikeDurationMin);
}

/** "Pickens · South Carolina" (whatever parts are known, without repeats). */
export function placeLine(t: Pick<TrailSummaryDto, "nearestPlace" | "regionName">): string | null {
  const parts = [t.nearestPlace, t.regionName].map((p) => p?.trim()).filter((p): p is string => Boolean(p));
  const unique = parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
  return unique.length ? unique.join(" · ") : null;
}

/** The English name when it differs from the local name. */
export function englishName(t: Pick<TrailSummaryDto, "name" | "nameEn">): string | null {
  const en = t.nameEn?.trim();
  return en && en.toLowerCase() !== t.name.trim().toLowerCase() ? en : null;
}

/** "today", "yesterday", "3 days ago", "2 weeks ago", "4 months ago". */
export function formatAgo(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const days = Math.floor(Math.max(0, now.getTime() - t) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 730) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

export type CoverageTone = "info" | "warn" | "error";

/**
 * Short status for the map pill. `message` (from the API) is the full,
 * honest explanation; `short` fits a phone screen. Null when there is
 * nothing to say (ready).
 */
export function coverageSummary(c: CoverageDto): { short: string; tone: CoverageTone; progress: string | null } | null {
  const progress = c.tilesTotal > 1 ? `${c.tilesReady} of ${c.tilesTotal} areas ready` : null;
  switch (c.state) {
    case "ready":
      return null;
    case "loading":
      return { short: c.tilesReady > 0 ? "Loading more trails…" : "Loading trails…", tone: "info", progress };
    case "too_large":
      return { short: "Zoom in to load trails here", tone: "info", progress: null };
    case "partial":
      return { short: "Part of this area couldn’t be loaded", tone: "warn", progress };
    case "failed":
      return { short: "Trails couldn’t be loaded here", tone: "error", progress: null };
    default:
      return null;
  }
}

/** "14 trails", "1 trail", "Showing 100 of 312 trails". */
export function resultCountText(shown: number, total: number): string {
  const noun = (n: number) => (n === 1 ? "trail" : "trails");
  if (total > shown) return `Showing ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${noun(total)}`;
  return `${shown.toLocaleString("en-US")} ${noun(shown)}`;
}
