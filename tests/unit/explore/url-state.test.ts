import { describe, expect, it } from "vitest";
import { trailSearchQuerySchema } from "@/domain/catalog";
import {
  EMPTY_FILTERS,
  cleanQuery,
  clearedFilters,
  countActiveFilters,
  explorePath,
  filtersEqual,
  parseExploreParams,
  parseFilters,
  searchApiQuery,
  serializeExploreParams,
  type ExploreFilters,
} from "@/components/explore/url-state";

const FULL: ExploreFilters = {
  difficulty: ["easy", "hard"],
  routeType: ["loop", "linear"],
  features: ["waterfall", "peak"],
  activity: "hiking",
  minDistanceKm: 2,
  maxDistanceKm: 8.047,
  maxGainM: 609.6,
  maxDurationMin: 240,
  dogFriendly: true,
  familyFriendly: true,
  parking: true,
  toilets: true,
  camping: true,
  fee: "free",
  permit: "not_required",
  sort: "length",
};

describe("explore URL state", () => {
  it("parses an empty URL to defaults", () => {
    expect(parseExploreParams(new URLSearchParams(""))).toEqual({ q: "", bbox: null, filters: EMPTY_FILTERS });
  });

  it("round-trips every filter through the canonical query string", () => {
    const state = { q: "trails near Denver", bbox: [-82.8, 35, -82.6, 35.1] as [number, number, number, number], filters: FULL };
    const qs = serializeExploreParams(state);
    expect(parseExploreParams(new URLSearchParams(qs))).toEqual(state);
    // canonical: serializing again yields the same string
    expect(serializeExploreParams(parseExploreParams(new URLSearchParams(qs)))).toBe(qs);
  });

  it("writes keys in a stable order and omits defaults", () => {
    const qs = serializeExploreParams({ q: "", bbox: null, filters: { ...EMPTY_FILTERS, toilets: true, difficulty: ["hard", "easy"] } });
    expect(qs).toBe("difficulty=easy%2Chard&toilets=1");
    expect(explorePath({ q: "", bbox: null, filters: EMPTY_FILTERS })).toBe("/explore");
  });

  it("accepts Next.js searchParams objects with repeated keys", () => {
    const f = parseFilters({ difficulty: ["easy", "moderate,expert"], features: "lake", dogFriendly: "true", fee: "paid" });
    expect(f.difficulty).toEqual(["easy", "moderate", "expert"]);
    expect(f.features).toEqual(["lake"]);
    expect(f.dogFriendly).toBe(true);
    expect(f.fee).toBe("paid");
  });

  it("drops unknown, malformed and out-of-range values instead of failing", () => {
    const s = parseExploreParams(
      new URLSearchParams("bbox=1,2,3&difficulty=easy,unknown,bogus&routeType=unknown&maxGainM=-5&maxDurationMin=abc&activity=flying&sort=random&fee=maybe&minDistanceKm=9&maxDistanceKm=3"),
    );
    expect(s.bbox).toBeNull();
    expect(s.filters.difficulty).toEqual(["easy"]);
    expect(s.filters.routeType).toEqual([]);
    expect(s.filters.maxGainM).toBeNull();
    expect(s.filters.maxDurationMin).toBeNull();
    expect(s.filters.activity).toBeNull();
    expect(s.filters.sort).toBe("relevance");
    expect(s.filters.fee).toBeNull();
    // min above max: the minimum is dropped, the maximum kept
    expect(s.filters.minDistanceKm).toBeNull();
    expect(s.filters.maxDistanceKm).toBe(3);
  });

  it("cleans the search text", () => {
    expect(cleanQuery("  trails   near\tDenver ")).toBe("trails near Denver");
    expect(cleanQuery("x".repeat(300))).toHaveLength(120);
    expect(cleanQuery(undefined)).toBe("");
  });
});

describe("search API query", () => {
  it("is accepted by trailSearchQuerySchema with the same meaning", () => {
    const qs = searchApiQuery([-82.8, 35, -82.6, 35.1], FULL);
    const parsed = trailSearchQuerySchema.parse(Object.fromEntries(new URLSearchParams(qs)));
    expect(parsed.bbox).toEqual([-82.8, 35, -82.6, 35.1]);
    expect(parsed.difficulty).toEqual(["easy", "hard"]);
    expect(parsed.routeType).toEqual(["loop", "linear"]);
    expect(parsed.features).toEqual(["waterfall", "peak"]);
    expect(parsed.activity).toBe("hiking");
    expect(parsed.minDistanceKm).toBe(2);
    expect(parsed.maxDistanceKm).toBe(8.047);
    expect(parsed.maxGainM).toBe(609.6);
    expect(parsed.maxDurationMin).toBe(240);
    expect(parsed.dogFriendly && parsed.familyFriendly && parsed.parking && parsed.toilets && parsed.camping).toBe(true);
    expect(parsed.fee).toBe("free");
    expect(parsed.permit).toBe("not_required");
    expect(parsed.sort).toBe("length");
    expect(parsed.q).toBeUndefined();
  });

  it("never sends the place text as a trail-name filter", () => {
    const qs = searchApiQuery([-1, -1, 1, 1], EMPTY_FILTERS);
    expect(qs).toBe("bbox=-1%2C-1%2C1%2C1");
  });
});

describe("filter helpers", () => {
  it("counts each active choice once and ignores sort", () => {
    expect(countActiveFilters(EMPTY_FILTERS)).toBe(0);
    expect(countActiveFilters({ ...EMPTY_FILTERS, sort: "name" })).toBe(0);
    expect(countActiveFilters({ ...EMPTY_FILTERS, difficulty: ["easy", "hard"], parking: true, maxGainM: 500 })).toBe(4);
    expect(countActiveFilters(FULL)).toBe(18);
  });

  it("clears choices but keeps the sort", () => {
    expect(clearedFilters(FULL)).toEqual({ ...EMPTY_FILTERS, sort: "length" });
  });

  it("compares filters by meaning", () => {
    expect(filtersEqual({ ...EMPTY_FILTERS, difficulty: ["hard", "easy"] }, { ...EMPTY_FILTERS, difficulty: ["easy", "hard"] })).toBe(true);
    expect(filtersEqual(EMPTY_FILTERS, { ...EMPTY_FILTERS, parking: true })).toBe(false);
  });
});
