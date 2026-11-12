import { describe, expect, it } from "vitest";
import { lineLengthM } from "@/domain/geo";
import {
  GAP_JOIN_TOLERANCE_M,
  LOOP_CLOSURE_TOLERANCE_M,
  UnionFind,
  assembleChains,
  assembleRoute,
  classifyRouteType,
  coordKey,
  dedupeConsecutive,
  groupByConnectivity,
  isValidLngLat,
  nearbyPairs,
  totalLengthM,
} from "@/server/trails/providers/osm/geometry";
import type { Line } from "@/server/trails/types";
import { lngLat, straight, type Xy } from "../../fixtures/osm/synthetic";

/** Polyline in metre offsets → [lng, lat] line. */
const L = (...points: Xy[]): Line => points.map(lngLat);
/** Straight line a→b with intermediate vertices. */
const S = (a: Xy, b: Xy, n = 3): Line => straight(a, b, n).map(lngLat);
const rev = (l: Line): Line => [...l].reverse();
const ends = (l: Line) => [coordKey(l[0]), coordKey(l[l.length - 1])];
const key = (xy: Xy) => coordKey(lngLat(xy));

/** Every input vertex is used (as a set) and no vertex is invented. */
function expectSameVertices(chains: Line[], input: Line[]) {
  const inKeys = new Set(input.flat().map(coordKey));
  const outKeys = new Set(chains.flat().map(coordKey));
  expect(outKeys).toEqual(inKeys);
}

describe("osm geometry: basics", () => {
  it("validates coordinates", () => {
    expect(isValidLngLat(-82.7, 35)).toBe(true);
    expect(isValidLngLat(180, -90)).toBe(true);
    expect(isValidLngLat(181, 0)).toBe(false);
    expect(isValidLngLat(0, 91)).toBe(false);
    expect(isValidLngLat(Number.NaN, 0)).toBe(false);
    expect(isValidLngLat("1", 0)).toBe(false);
    expect(isValidLngLat(undefined, undefined)).toBe(false);
  });

  it("keys coordinates at OSM precision (1e-7°)", () => {
    expect(coordKey([-82.72, 35.05])).toBe("-82.7200000,35.0500000");
    expect(coordKey([-82.72000001, 35.05])).toBe(coordKey([-82.72, 35.05]));
    expect(coordKey([-82.7200001, 35.05])).not.toBe(coordKey([-82.72, 35.05]));
  });

  it("drops consecutive duplicate vertices and degenerate lines", () => {
    expect(dedupeConsecutive(L([0, 0], [0, 0], [10, 0], [10, 0], [20, 0]))).toEqual(L([0, 0], [10, 0], [20, 0]));
    expect(dedupeConsecutive(L([0, 0], [0, 0]))).toBeNull();
    expect(dedupeConsecutive([])).toBeNull();
  });

  it("sums line lengths", () => {
    expect(totalLengthM([S([0, 0], [1000, 0]), S([0, 100], [0, 600])])).toBeCloseTo(1500, -1);
    expect(totalLengthM([])).toBe(0);
  });

  it("union-find merges sets", () => {
    const uf = new UnionFind(5);
    uf.union(0, 1);
    uf.union(3, 4);
    uf.union(1, 4);
    expect(uf.find(0)).toBe(uf.find(3));
    expect(uf.find(2)).not.toBe(uf.find(0));
  });
});

describe("osm geometry: route type", () => {
  it("unknown without lines, network with several", () => {
    expect(classifyRouteType([])).toBe("unknown");
    expect(classifyRouteType([S([0, 0], [500, 0]), S([0, 100], [500, 100])])).toBe("network");
  });

  it("loop when the ends of a single chain are within 50 m", () => {
    expect(LOOP_CLOSURE_TOLERANCE_M).toBe(50);
    expect(classifyRouteType([L([0, 0], [500, 0], [500, 500], [0, 0])])).toBe("loop");
    expect(classifyRouteType([L([0, 0], [500, 0], [500, 500], [0, 40])])).toBe("loop");
    expect(classifyRouteType([L([0, 0], [500, 0], [500, 500], [0, 60])])).toBe("linear");
  });
});

describe("osm geometry: assembleChains", () => {
  it("returns nothing for no or degenerate input", () => {
    expect(assembleChains([])).toEqual([]);
    expect(assembleChains([L([0, 0]), L([5, 5], [5, 5])])).toEqual([]);
  });

  it("keeps a single segment as is", () => {
    const a = S([0, 0], [800, 0]);
    expect(assembleChains([a])).toEqual([a]);
  });

  it("joins end-to-start segments into one chain", () => {
    const a = S([0, 0], [400, 0]);
    const b = S([400, 0], [800, 0]);
    const chains = assembleChains([a, b]);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toHaveLength(a.length + b.length - 1);
    expect(ends(chains[0])).toEqual([key([0, 0]), key([800, 0])]);
  });

  it("reverses segments whose direction disagrees (end-to-end and start-to-start)", () => {
    const a = S([0, 0], [400, 0]);
    const b = rev(S([400, 0], [800, 0])); // end-to-end with a
    const c = S([800, 0], [800, 400]);
    const chains = assembleChains([a, b, c]);
    expect(chains).toHaveLength(1);
    expect(ends(chains[0])).toEqual([key([0, 0]), key([800, 400])]);
    expect(lineLengthM(chains[0])).toBeCloseTo(totalLengthM([a, b, c]), 6);
  });

  it("merges ways listed in reverse order", () => {
    const a = S([0, 0], [400, 0]);
    const b = S([400, 0], [800, 0]);
    const c = S([800, 0], [1200, 0]);
    const chains = assembleChains([c, b, a]);
    expect(chains).toHaveLength(1);
    expect(new Set(ends(chains[0]))).toEqual(new Set([key([0, 0]), key([1200, 0])]));
    expectSameVertices(chains, [a, b, c]);
  });

  it("merges scrambled, partly reversed members where a greedy merge would start in the middle", () => {
    const parts = [S([400, 0], [800, 0]), rev(S([1200, 0], [1600, 0])), rev(S([0, 0], [400, 0])), S([800, 0], [1200, 0])];
    const chains = assembleChains(parts);
    expect(chains).toHaveLength(1);
    expect(new Set(ends(chains[0]))).toEqual(new Set([key([0, 0]), key([1600, 0])]));
    expect(lineLengthM(chains[0])).toBeCloseTo(totalLengthM(parts), 6);
    expect(classifyRouteType(chains)).toBe("linear");
  });

  it("closes a loop of three ways into one chain that starts at the first way's start", () => {
    const a = S([0, 0], [600, 0]);
    const b = rev(S([600, 600], [600, 0]));
    const c = S([600, 600], [0, 0]);
    const chains = assembleChains([a, b, c]);
    expect(chains).toHaveLength(1);
    expect(ends(chains[0])).toEqual([key([0, 0]), key([0, 0])]);
    expect(classifyRouteType(chains)).toBe("loop");
  });

  it("treats a single closed way as a loop", () => {
    const closed = L([0, 0], [300, 0], [300, 300], [0, 300], [0, 0]);
    const chains = assembleChains([closed]);
    expect(chains).toEqual([closed]);
    expect(classifyRouteType(chains)).toBe("loop");
  });

  it("assembles a lollipop (stem + loop) as one chain from the stem end", () => {
    const stem = S([0, 0], [500, 0]);
    const loopA = S([500, 0], [800, 300]);
    const loopB = S([800, 300], [500, 0]);
    for (const order of [
      [stem, loopA, loopB],
      [loopA, loopB, stem],
      [loopB, stem, loopA],
    ]) {
      const chains = assembleChains(order);
      expect(chains).toHaveLength(1);
      expect(new Set(ends(chains[0]))).toEqual(new Set([key([0, 0]), key([500, 0])]));
      expect(classifyRouteType(chains)).toBe("linear");
    }
  });

  it("splits at a T-junction on an interior vertex: network", () => {
    const main = L([0, 0], [250, 0], [500, 0], [750, 0], [1000, 0]);
    const spur = S([500, 0], [500, 600]); // starts at main's interior vertex
    const chains = assembleChains([main, spur]);
    expect(chains).toHaveLength(2);
    expect(classifyRouteType(chains)).toBe("network");
    expect(totalLengthM(chains)).toBeCloseTo(totalLengthM([main, spur]), 6);
    expectSameVertices(chains, [main, spur]);
  });

  it("an excursion/alternative branch makes a network; the first chain starts at the first odd vertex", () => {
    const m1 = S([0, 0], [500, 0]);
    const m2 = S([500, 0], [1000, 0]);
    const excursion = S([500, 0], [500, 400]);
    const chains = assembleChains([m1, m2, excursion]);
    expect(chains).toHaveLength(2);
    expect(coordKey(chains[0][0])).toBe(key([0, 0]));
    expect(totalLengthM(chains)).toBeCloseTo(totalLengthM([m1, m2, excursion]), 6);
  });

  it("an X crossing at a shared vertex needs two chains; a crossing without a shared vertex is disconnected", () => {
    const h = L([-500, 0], [0, 0], [500, 0]);
    const v = L([0, -500], [0, 0], [0, 500]);
    expect(assembleChains([h, v])).toHaveLength(2);
    const bridge = L([0, -500], [0, 500]); // passes over (0,0) without a node there
    const chains = assembleChains([h, bridge]);
    expect(chains).toHaveLength(2);
  });

  it("does not bridge gaps: segments 5 m apart stay separate", () => {
    const a = S([0, 0], [500, 0]);
    const b = S([505, 0], [1000, 0]);
    const chains = assembleChains([a, b]);
    expect(chains).toHaveLength(2);
    expect(classifyRouteType(chains)).toBe("network");
  });

  it("a figure eight (two loops through one node) is one closed chain", () => {
    const loop1 = [S([0, 0], [300, 300]), S([300, 300], [0, 600]), S([0, 600], [0, 0])];
    const loop2 = [S([0, 0], [-300, -300]), S([-300, -300], [0, -600]), S([0, -600], [0, 0])];
    const chains = assembleChains([...loop1, ...loop2]);
    expect(chains).toHaveLength(1);
    expect(classifyRouteType(chains)).toBe("loop");
    expect(lineLengthM(chains[0])).toBeCloseTo(totalLengthM([...loop1, ...loop2]), 6);
  });

  it("a theta (three paths between two junctions) can be walked as one chain (documented behaviour)", () => {
    const p1 = S([0, 0], [1000, 0]);
    const p2 = L([0, 0], [500, 300], [1000, 0]);
    const p3 = L([0, 0], [500, -300], [1000, 0]);
    const chains = assembleChains([p1, p2, p3]);
    expect(chains).toHaveLength(1);
    expect(classifyRouteType(chains)).toBe("linear");
  });

  it("a way that loops back onto itself (6-shape) is split at the repeated vertex", () => {
    const six = L([0, 0], [500, 0], [800, 300], [500, 600], [200, 300], [500, 0]);
    const chains = assembleChains([six]);
    expect(chains).toHaveLength(1);
    expect(totalLengthM(chains)).toBeCloseTo(lineLengthM(six), 6);
  });

  it("keeps separate components in input order", () => {
    const a = S([0, 0], [500, 0]);
    const b = S([0, 1000], [500, 1000]);
    const chains = assembleChains([b, a]);
    expect(chains).toHaveLength(2);
    expect(coordKey(chains[0][0])).toBe(key([0, 1000]));
  });

  it("is deterministic", () => {
    const parts = [S([0, 0], [500, 0]), S([500, 0], [1000, 0]), S([500, 0], [500, 400]), S([1000, 0], [1000, 500])];
    expect(assembleChains(parts)).toEqual(assembleChains(parts));
  });

  it("a 4-way junction needs two chains; minimum count for 2k odd vertices is k", () => {
    // Star with 4 arms → 4 odd leaves (+ centre with even degree 4) → 2 chains.
    const arms = [S([0, 0], [500, 0]), S([0, 0], [-500, 0]), S([0, 0], [0, 500]), S([0, 0], [0, -500])];
    expect(assembleChains(arms)).toHaveLength(2);
    // Star with 6 arms → 6 odd leaves → 3 chains.
    const six = [...arms, S([0, 0], [400, 400]), S([0, 0], [-400, -400])];
    const chains = assembleChains(six);
    expect(chains).toHaveLength(3);
    expect(totalLengthM(chains)).toBeCloseTo(totalLengthM(six), 6);
  });
});

describe("osm geometry: assembleRoute (route type with tiny dead-end gaps)", () => {
  it("exact chains: same result as assembleChains + classifyRouteType", () => {
    const parts = [S([0, 0], [500, 0]), S([500, 0], [1000, 0])];
    expect(assembleRoute(parts)).toEqual({ lines: assembleChains(parts), routeType: "linear" });
    expect(assembleRoute([])).toEqual({ lines: [], routeType: "unknown" });
  });

  it("a 4 m gap between dead ends is still one linear route; the gap is not drawn", () => {
    expect(GAP_JOIN_TOLERANCE_M).toBe(20);
    const a = S([0, 0], [1000, 0]);
    const b = S([1004, 0], [2000, 0]);
    const r = assembleRoute([b, a]);
    expect(r.routeType).toBe("linear");
    expect(r.lines).toHaveLength(2);
    expect(totalLengthM(r.lines)).toBeCloseTo(totalLengthM([a, b]), 6);
    // Ordered and oriented along the route: line 0 ends next to where line 1 starts.
    const gap = totalLengthM([[r.lines[0][r.lines[0].length - 1], r.lines[1][0]]]);
    expect(gap).toBeLessThan(5);
  });

  it("links several gaps, reversing chains as needed, and detects a gappy loop", () => {
    const parts = [S([0, 0], [600, 0]), rev(S([610, 0], [610, 600])), S([600, 610], [0, 610]), S([0, 600], [0, 10])];
    const r = assembleRoute(parts);
    expect(r.lines).toHaveLength(4);
    expect(r.routeType).toBe("loop");
  });

  it("gaps above the tolerance stay a network", () => {
    const r = assembleRoute([S([0, 0], [1000, 0]), S([1070, 0], [2000, 0])]);
    expect(r.routeType).toBe("network");
    expect(assembleRoute([S([0, 0], [1000, 0]), S([1010, 0], [2000, 0])], 5).routeType).toBe("network");
    expect(assembleRoute([S([0, 0], [1000, 0]), S([1010, 0], [2000, 0])], 0).routeType).toBe("network");
  });

  it("a branch point stays a network even when another line ends 8 m from it", () => {
    // Main line through (500,0) with a branch; a separate line starts 8 m from that junction.
    // Junction vertices are never treated as dead ends, so nothing is linked there.
    const main = L([0, 0], [500, 0], [1000, 0]);
    const other = L([500, 0], [500, -400]); // makes (500,0) a junction
    const spur = S([508, 0], [508, 500]);
    expect(assembleRoute([main, other, spur]).routeType).toBe("network");
  });

  it("does not join a real branch even when its dead end is near another dead end of the same network", () => {
    // Y shape (true network) plus nothing else: no gaps → network.
    const y = [S([0, 0], [500, 0]), S([500, 0], [1000, 300]), S([500, 0], [1000, -300])];
    expect(assembleRoute(y).routeType).toBe("network");
  });
});

describe("osm geometry: assembleRoute ordering and scale", () => {
  it("orders a gappy route along the walk; the first chain keeps its direction", () => {
    // Pieces listed out of order, one reversed, with 6 m gaps between them.
    const a = S([0, 0], [500, 0]);
    const b = S([506, 0], [1000, 0]);
    const c = S([1006, 0], [1500, 0]);
    const r = assembleRoute([b, rev(c), a]);
    expect(r.routeType).toBe("linear");
    // b (the first input chain) keeps its west→east direction, so the walk is a, b, c.
    expect(r.lines.map(ends)).toEqual([
      [key([0, 0]), key([500, 0])],
      [key([506, 0]), key([1000, 0])],
      [key([1006, 0]), key([1500, 0])],
    ]);
    expect(totalLengthM(r.lines)).toBeCloseTo(totalLengthM([a, b, c]), 6);
  });

  it("returns the same lines and type whatever the input order", () => {
    const parts = [S([0, 0], [500, 0]), S([506, 0], [1000, 0]), S([1006, 0], [1500, 0]), S([3000, 0], [3500, 0])];
    const sig = (r: ReturnType<typeof assembleRoute>) => ({
      routeType: r.routeType,
      lengthM: Math.round(totalLengthM(r.lines)),
      vertices: new Set(r.lines.flat().map(coordKey)),
    });
    const base = sig(assembleRoute(parts));
    expect(base.routeType).toBe("network"); // the far piece is not linked
    expect(sig(assembleRoute([...parts].reverse()))).toEqual(base);
    expect(sig(assembleRoute([parts[2], parts[0], rev(parts[3]), rev(parts[1])]))).toEqual(base);
  });

  it("a network lists its parts path by path, without losing or inventing vertices", () => {
    const parts = [S([0, 0], [500, 0]), S([505, 0], [1000, 0]), S([0, 2000], [500, 2000]), S([505, 2000], [1000, 2000])];
    const r = assembleRoute(parts);
    expect(r.routeType).toBe("network");
    expect(r.lines).toHaveLength(4);
    expect(new Set(r.lines.flat().map(coordKey))).toEqual(new Set(parts.flat().map(coordKey)));
    // Each linked pair is adjacent and continuous across its gap.
    for (const i of [0, 2]) {
      const end = r.lines[i][r.lines[i].length - 1];
      expect(totalLengthM([[end, r.lines[i + 1][0]]])).toBeLessThan(10);
    }
  });

  it("links hundreds of small gaps quickly (no cubic search)", () => {
    const pieces: Line[] = [];
    for (let i = 0; i < 1000; i++) pieces.push(S([i * 58, 0], [i * 58 + 50, 0], 1)); // 8 m gaps
    const started = performance.now();
    const r = assembleRoute([...pieces].reverse());
    expect(performance.now() - started).toBeLessThan(1000);
    expect(r.routeType).toBe("linear");
    expect(r.lines).toHaveLength(1000);
    expect(totalLengthM(r.lines)).toBeCloseTo(50_000, -2);
  });
});

describe("osm geometry: nearbyPairs", () => {
  it("finds every pair within the tolerance, sorted by distance", () => {
    const pts = [lngLat([0, 0]), lngLat([10, 0]), lngLat([25, 0]), lngLat([1000, 0]), lngLat([1003, 4])];
    const pairs = nearbyPairs(pts, 20);
    expect(pairs.map(([i, j]) => [i, j])).toEqual([
      [3, 4], // 5 m
      [0, 1], // 10 m
      [1, 2], // 15 m
    ]);
    expect(pairs[0][2]).toBeCloseTo(5, 1);
    for (const [i, j] of pairs) expect(i).toBeLessThan(j);
  });

  it("matches a brute-force search on random points, including near cell borders", () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pts = Array.from({ length: 400 }, () => lngLat([rand() * 600, rand() * 600]));
    const brute: string[] = [];
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) if (totalLengthM([[pts[i], pts[j]]]) <= 20) brute.push(`${i},${j}`);
    expect(new Set(nearbyPairs(pts, 20).map(([i, j]) => `${i},${j}`))).toEqual(new Set(brute));
    expect(brute.length).toBeGreaterThan(10);
  });

  it("does not miss east-west neighbours at high latitude (shorter longitude degrees)", () => {
    const north: [number, number][] = [
      [15.0, 78.2],
      [15.0004, 78.2], // ≈ 9 m east at 78.2° N
      [15.0, 10.0], // far south, sets nothing
    ];
    expect(nearbyPairs(north, 20).map(([i, j]) => [i, j])).toEqual([[0, 1]]);
    expect(nearbyPairs([[0, 89.9999], [120, 89.9999]], 30).map(([i, j]) => [i, j])).toEqual([[0, 1]]); // ≈ 19 m apart near the pole
  });

  it("applies the accept filter and handles degenerate input", () => {
    const pts = [lngLat([0, 0]), lngLat([5, 0]), lngLat([10, 0])];
    expect(nearbyPairs(pts, 20, (i, j) => !(i === 0 && j === 1)).map(([i, j]) => [i, j])).toEqual([
      [1, 2],
      [0, 2],
    ]);
    expect(nearbyPairs(pts, 0)).toEqual([]);
    expect(nearbyPairs(pts, Number.NaN)).toEqual([]);
    expect(nearbyPairs([pts[0]], 20)).toEqual([]);
    expect(nearbyPairs([], 20)).toEqual([]);
  });

  it("gives up (reports nothing) on pathological input instead of exploding", () => {
    // 2 100 distinct points within about a metre: ~2.2 million candidate pairs.
    const pts = Array.from({ length: 2100 }, (_, i) => lngLat([(i % 50) * 0.02, Math.floor(i / 50) * 0.02]));
    expect(nearbyPairs(pts, 20)).toEqual([]);
  });
});

describe("osm geometry: groupByConnectivity", () => {
  it("groups items sharing any vertex (endpoints or interior)", () => {
    const items: Line[][] = [
      [S([0, 0], [500, 0])],
      [S([500, 0], [1000, 0])], // shares an endpoint with 0
      [L([250, -200], [250, 0], [250, 200])], // crosses item 0 at its interior vertex (250, 0)
      [S([0, 5000], [500, 5000])], // far away
      [L([750, 300], [750, 0])], // ends at an interior vertex of item 1
    ];
    const groups = groupByConnectivity(items);
    // S([0, 0], [500, 0]) has vertices every 125 m, so (250, 0) is shared with item 2.
    expect(groups).toEqual([[0, 1, 2, 4], [3]]);
  });

  it("returns singleton groups for disconnected items and handles empty input", () => {
    expect(groupByConnectivity([])).toEqual([]);
    expect(groupByConnectivity([[S([0, 0], [10, 0])], [S([0, 50], [10, 50])]])).toEqual([[0], [1]]);
  });

  it("with a gap tolerance, joins items whose dead ends are close (unjoined nodes)", () => {
    const items: Line[][] = [
      [S([0, 0], [500, 0])],
      [S([504, 0], [1000, 0])], // 4 m gap to item 0
      [S([1030, 0], [1500, 0])], // 30 m gap to item 1: a real disconnection
      [S([0, 300], [500, 300]), S([505, 300], [900, 300])], // one item, two segments: nothing to join
    ];
    expect(groupByConnectivity(items)).toEqual([[0], [1], [2], [3]]);
    expect(groupByConnectivity(items, 20)).toEqual([[0, 1], [2], [3]]);
  });

  it("never joins at a junction: only dead ends (vertices no other line touches) count", () => {
    const items: Line[][] = [
      [L([0, 0], [500, 0], [1000, 0])],
      [S([500, 0], [500, 500])], // T-junction at (500, 0): connected exactly
      [S([500, -8], [500, -500])], // starts 8 m from the junction vertex, which is not a dead end
    ];
    expect(groupByConnectivity(items, 20)).toEqual([[0, 1], [2]]);
  });
});
