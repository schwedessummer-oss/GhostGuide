import { describe, expect, it } from "vitest";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { CoverageDto, TrailSearchResponse, TrailSummaryDto } from "@/domain/catalog";
import { ListFooter, ResultsList, TrailStats, type ResultsListProps } from "@/components/explore/results-list";
import { FiltersDialog } from "@/components/explore/filters-dialog";
import { TrailDifficulty } from "@/components/explore/bits";
import { climbKnown, difficultyEstimateNote, resultsHeading } from "@/components/explore/format";
import { EMPTY_FILTERS } from "@/components/explore/url-state";
import { trailRoutePreviewUrl } from "@/components/explore/types";

/*
 * Explore UI honesty: never "no trails here" when part of the area did not
 * load (#21), no filter choices that can never match (#13), and estimates
 * that say when they rest on distance alone (#6/#7).
 */
const render = (el: ReactElement) => renderToStaticMarkup(h(AppRouterContext.Provider, { value: {} as never }, el));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").trim();

const coverage = (state: CoverageDto["state"], extra: Partial<CoverageDto> = {}): CoverageDto => ({
  layer: "outdoor",
  state,
  tilesTotal: 4,
  tilesReady: state === "partial" ? 1 : 4,
  tilesLoading: 0,
  tilesFailed: state === "partial" ? 3 : 0,
  oldestSyncAt: "2026-11-10T00:00:00.000Z",
  message: state === "partial" ? "Some of this area could not be loaded right now; showing what is available." : "Loaded.",
  ...extra,
});

const TRAIL: TrailSummaryDto = {
  id: "0ae15977-bbbe-467f-94f3-74534a4da5db",
  path: "/trail/us/south-carolina/table-rock-trail",
  name: "Table Rock Trail",
  nameEn: null,
  countryCode: "us",
  regionName: "South Carolina",
  nearestPlace: null,
  centroid: { lng: -82.708, lat: 35.043 },
  trailhead: { lng: -82.6996, lat: 35.0317 },
  distanceM: 5483,
  routeType: "linear",
  elevationGainM: 609,
  estimatedDurationMin: 104,
  hikeDistanceM: 10966,
  hikeGainM: 695,
  hikeDurationMin: 186,
  difficulty: "hard",
  difficultySource: "estimated",
  features: [],
  dogPolicy: "unknown",
  feeRequired: null,
  permitRequired: null,
  hasParking: true,
  hasToilets: false,
  hasCamping: false,
  familyFriendly: false,
  provider: "osm",
  sourceName: "OpenStreetMap",
  lastSyncedAt: "2026-11-10T00:00:00.000Z",
};
const NO_CLIMB: TrailSummaryDto = { ...TRAIL, elevationGainM: null, hikeGainM: null, difficulty: "expert", hikeDurationMin: 300 };

function list(props: Partial<ResultsListProps>) {
  const noop = () => {};
  return render(
    h(ResultsList, {
      status: "ready",
      error: null,
      trails: [],
      coverage: coverage("ready"),
      units: "imperial",
      selectedId: null,
      filtersActive: false,
      onHover: noop,
      onRetry: noop,
      onClearFilters: noop,
      intro: null,
      ...props,
    }),
  );
}

const results = (state: CoverageDto["state"], trails: TrailSummaryDto[] = []): Pick<TrailSearchResponse, "trails" | "total" | "coverage"> => ({
  trails,
  total: trails.length,
  coverage: coverage(state),
});

describe("part of the area failed to load (#21)", () => {
  it("the heading never says 'No trails found'", () => {
    expect(resultsHeading("ready", results("partial"))).toBe("Some of this area couldn’t be loaded");
    expect(resultsHeading("ready", results("ready"))).toBe("No trails found");
    expect(resultsHeading("ready", results("loading"))).toBe("Loading trails…");
    expect(resultsHeading("ready", results("failed"))).toBe("Trails unavailable");
    expect(resultsHeading("ready", results("too_large"))).toBe("Zoom in to see trails");
    expect(resultsHeading("ready", results("partial", [TRAIL]))).toBe("1 trail");
    expect(resultsHeading("loading", results("partial"))).toBe("Searching…");
    expect(resultsHeading("idle", null)).toBe("Explore trails");
  });

  it("the empty list explains the failure and offers Try again (and Clear filters when filtering)", () => {
    const t = text(list({ coverage: coverage("partial") }));
    expect(t).toContain("Part of this area couldn’t be loaded");
    expect(t).toContain("Some of this area could not be loaded right now");
    expect(t).toContain("No trails were found in the parts that did load.");
    expect(t).toContain("Try again");
    expect(t).not.toContain("No mapped trails in this area yet");
    expect(t).not.toContain("Clear filters");
    const filtered = text(list({ coverage: coverage("partial"), filtersActive: true }));
    expect(filtered).toContain("No trails matched your filters in the parts that did load.");
    expect(filtered).toContain("Clear filters");
  });

  it("with results, the footer says some trails may be missing", () => {
    expect(text(render(h(ListFooter, { coverage: coverage("partial"), capped: false })))).toContain("Part of this area couldn’t be loaded, so some trails may be missing.");
    expect(text(render(h(ListFooter, { coverage: coverage("ready"), capped: false })))).not.toContain("may be missing");
  });
});

describe("filters (#13)", () => {
  const dialog = () => text(render(h(FiltersDialog, { open: false, filters: EMPTY_FILTERS, units: "imperial", onApply: () => {}, onClose: () => {} })));

  it("offers no choice that no trail can match", () => {
    const t = dialog();
    expect(t).not.toContain("Not required");
    expect(t).not.toContain("running");
    expect(t).toContain("Required");
    for (const a of ["Hiking", "Walking", "Biking", "Horse riding"]) expect(t).toContain(a);
  });

  it("says that activity and permit filters only include trails whose data says so", () => {
    const t = dialog();
    expect(t).toContain("Only trails whose mapped data lists the activity.");
    expect(t).toContain("shows only trails whose mapped data says a permit is needed");
  });

  it("an empty filtered list blames the filters, not the area", () => {
    const t = text(list({ filtersActive: true }));
    expect(t).toContain("No trails here match your filters");
    expect(t).not.toContain("No mapped trails in this area yet");
    expect(t).toContain("permit, activity");
    expect(text(list({}))).toContain("No mapped trails in this area yet");
  });
});

describe("estimates without climb data (#6/#7)", () => {
  it("knows when the climb is unknown", () => {
    expect(climbKnown(TRAIL)).toBe(true);
    expect(climbKnown(NO_CLIMB)).toBe(false);
  });

  it("the moving time says it is based on distance only", () => {
    const flat = text(render(h(TrailStats, { trail: NO_CLIMB, units: "imperial" })));
    expect(flat).toContain("Climb unknown");
    expect(flat).toContain("≈ 5 h");
    expect(flat).toContain("distance only");
    expect(flat).toContain("no time for climbing is included");
    expect(text(render(h(TrailStats, { trail: TRAIL, units: "imperial" })))).not.toContain("distance only");
    // No time at all: nothing to qualify.
    expect(text(render(h(TrailStats, { trail: { ...NO_CLIMB, hikeDurationMin: null }, units: "imperial" })))).not.toContain("distance only");
  });

  it("an estimated difficulty says it comes from distance only, never 'distance and climb'", () => {
    const html = render(h(TrailDifficulty, { difficulty: "expert", source: "estimated", climbKnown: false }));
    expect(text(html)).toContain("Expert · estimated from distance only");
    expect(html).not.toContain("distance and climb");
    expect(difficultyEstimateNote("expert", "estimated", false)).toMatch(/^Estimated from distance only/);
    expect(difficultyEstimateNote("hard", "estimated", true)).toBe("Estimated from distance and climb; no official rating is mapped.");
    expect(difficultyEstimateNote("hard", "osm_sac_scale", false)).toBeNull();
    expect(difficultyEstimateNote("unknown", "estimated", false)).toBeNull();
    expect(text(render(h(TrailDifficulty, { difficulty: "hard", source: "estimated" })))).toBe("Hard · estimated");
  });
});

describe("route preview (#34)", () => {
  it("Explore asks for the simplified line, not the whole trail detail", () => {
    expect(trailRoutePreviewUrl("0ae15977-bbbe-467f-94f3-74534a4da5db")).toBe("/api/trails/0ae15977-bbbe-467f-94f3-74534a4da5db/geometry");
  });
});
