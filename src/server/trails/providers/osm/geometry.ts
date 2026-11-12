import "server-only";
import type { RouteType } from "@/domain/catalog";
import { haversineM, lineLengthM } from "@/domain/geo";
import type { Line } from "@/server/trails/types";

/**
 * Pure geometry helpers for assembling OSM ways into trails.
 *
 * Connectivity is decided on exact shared vertices. Two OSM ways are
 * connected when they share a node, and a shared node has identical
 * coordinates in both ways, so coordinates rounded to OSM's storage
 * precision (1e-7°) identify nodes. We key on coordinates rather than node
 * ids because Overpass `out geom` gives node ids for standalone ways but NOT
 * for the member ways of a relation; coordinates work for both.
 *
 * Gaps are never bridged in the geometry: a route whose members do not touch
 * keeps separate lines (no connecting segment is ever invented). Tiny
 * dead-end gaps (unjoined nodes, a very common OSM mapping error) are only
 * tolerated when deciding what belongs together: they do not split a named
 * trail into several trails (groupByConnectivity) and do not turn a linear
 * trail into a "network" (assembleRoute).
 *
 * Complexity: everything here is linear in the number of vertices (hash maps
 * keyed by vertex, union-find), except sorting candidate gap pairs. The gap
 * search uses a spatial grid (nearbyPairs), never an all-pairs scan, so a
 * dense urban tile with tens of thousands of ways parses in well under a
 * second (see tests/unit/trails/osm-perf.test.ts).
 */

/** Ends of a single chain closer than this make it a loop. */
export const LOOP_CLOSURE_TOLERANCE_M = 50;

/**
 * Dead ends of two lines closer than this count as connected when grouping
 * ways and classifying the route type (the lines themselves stay separate).
 * Real example: OSM relation 6011996 "Table Rock Trail" has two members
 * whose ends are 4 m apart but not joined. Kept small so that real
 * disconnections (an unmapped road walk, a 70 m gap) still read as separate.
 */
export const GAP_JOIN_TOLERANCE_M = 20;

const COORD_DECIMALS = 7;

export const isValidLngLat = (lng: unknown, lat: unknown): boolean =>
  typeof lng === "number" &&
  typeof lat === "number" &&
  Number.isFinite(lng) &&
  Number.isFinite(lat) &&
  lng >= -180 &&
  lng <= 180 &&
  lat >= -90 &&
  lat <= 90;

/** Identity of a vertex: its coordinates at OSM precision. */
export const coordKey = (p: readonly [number, number]) => `${p[0].toFixed(COORD_DECIMALS)},${p[1].toFixed(COORD_DECIMALS)}`;

/** A line without consecutive duplicate vertices, with the vertex keys computed once. */
interface KeyedLine {
  coords: Line;
  keys: string[];
}

function dedupeKeyed(line: readonly (readonly [number, number])[]): KeyedLine | null {
  const coords: Line = [];
  const keys: string[] = [];
  for (const p of line) {
    const k = coordKey(p);
    if (k === keys[keys.length - 1]) continue;
    coords.push([p[0], p[1]]);
    keys.push(k);
  }
  return coords.length >= 2 ? { coords, keys } : null;
}

/** Drop consecutive duplicate vertices. Returns null when fewer than two distinct vertices remain. */
export function dedupeConsecutive(line: Line): Line | null {
  return dedupeKeyed(line)?.coords ?? null;
}

export const totalLengthM = (lines: readonly Line[]) => lines.reduce((sum, l) => sum + lineLengthM(l), 0);

const distanceM = (a: readonly [number, number], b: readonly [number, number]) =>
  haversineM({ lng: a[0], lat: a[1] }, { lng: b[0], lat: b[1] });

/** Route type from exact chains: one chain → loop/linear by end distance; several → network. */
export function classifyRouteType(chains: readonly Line[]): RouteType {
  if (chains.length === 0) return "unknown";
  if (chains.length > 1) return "network";
  const line = chains[0];
  return distanceM(line[0], line[line.length - 1]) <= LOOP_CLOSURE_TOLERANCE_M ? "loop" : "linear";
}

// ---------------------------------------------------------------------------
// Near pairs (spatial grid)
// ---------------------------------------------------------------------------

/**
 * Metres per degree used to size grid cells: slightly LESS than the true
 * 111 195 m per degree of latitude on the haversine sphere, so that a cell
 * is always at least `toleranceM` wide.
 */
const GRID_M_PER_DEG = 110_000;

/**
 * Distance checks allowed in one nearbyPairs call. Real data never comes
 * close (dead ends are distinct vertices, rarely within 20 m of each other);
 * beyond this the input is pathological and no pairs are reported, which is
 * the conservative outcome (nothing is joined).
 */
const MAX_PAIR_CHECKS = 2_000_000;

/**
 * Pairs of points at most `toleranceM` apart (haversine), as
 * [i, j, distanceM] with i < j, sorted by distance, then i, then j.
 * `accept(i, j)` can exclude pairs before their distance is computed.
 *
 * Uses a uniform grid with cells at least `toleranceM` wide, so only the
 * 3 × 3 neighbouring cells of each point are searched: expected linear time.
 * Longitude cells are sized for the highest |latitude| in the input (where a
 * degree of longitude is shortest), so no pair is missed. Pairs across the
 * antimeridian are not found (tiles never cross it).
 */
export function nearbyPairs(
  points: readonly (readonly [number, number])[],
  toleranceM: number,
  accept: (i: number, j: number) => boolean = () => true,
): [number, number, number][] {
  if (!(toleranceM > 0) || points.length < 2) return [];
  let maxAbsLat = 0;
  for (const p of points) maxAbsLat = Math.max(maxAbsLat, Math.abs(p[1]));
  const cellLat = toleranceM / GRID_M_PER_DEG;
  const cos = Math.cos((maxAbsLat * Math.PI) / 180);
  const cellLng = cos > 1e-9 ? Math.min(360, toleranceM / (GRID_M_PER_DEG * cos)) : 360;

  const cellOf = points.map((p) => [Math.floor(p[0] / cellLng), Math.floor(p[1] / cellLat)] as const);
  const cells = new Map<string, number[]>();
  cellOf.forEach(([cx, cy], i) => {
    const k = `${cx}:${cy}`;
    const bucket = cells.get(k);
    if (bucket) bucket.push(i);
    else cells.set(k, [i]);
  });

  const out: [number, number, number][] = [];
  let checks = 0;
  for (let i = 0; i < points.length; i++) {
    const [cx, cy] = cellOf[i];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = cells.get(`${cx + dx}:${cy + dy}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          if (++checks > MAX_PAIR_CHECKS) return [];
          if (!accept(i, j)) continue;
          const d = distanceM(points[i], points[j]);
          if (d <= toleranceM) out.push([i, j, d]);
        }
      }
    }
  }
  return out.sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);
}

// ---------------------------------------------------------------------------
// Route assembly (chains + small-gap linking + route type)
// ---------------------------------------------------------------------------

export interface AssembledRoute {
  /** Polylines ordered and oriented along the route; exact input vertices only. */
  lines: Line[];
  routeType: RouteType;
}

interface ChainEnd {
  chain: number;
  atStart: boolean;
  p: [number, number];
}

/**
 * Assemble segments into chains (assembleChains) and classify the route.
 *
 * Chains are then linked across small gaps: two chain ends are linked when
 * both are DEAD ENDS (vertices no other line touches — never a junction),
 * they belong to different chains, and they are at most `gapToleranceM`
 * apart; closest pairs first, never closing a cycle (Kruskal-style, with a
 * union-find). Each set of linked chains is a path. A route whose chains
 * link into one path is "loop" (path ends ≤ 50 m apart) or "linear";
 * otherwise it is a "network". Lines are returned path by path (paths
 * ordered by their first chain), each in walking order and orientation, the
 * path's first chain keeping its own direction; the gaps are not drawn.
 */
export function assembleRoute(segments: readonly Line[], gapToleranceM = GAP_JOIN_TOLERANCE_M): AssembledRoute {
  const { chains, degree } = buildChains(segments);
  if (chains.length <= 1 || !(gapToleranceM > 0)) return { lines: chains, routeType: classifyRouteType(chains) };

  // Dead ends are exactly the degree-1 vertices of the chain graph.
  const ends: ChainEnd[] = [];
  const endAt: [number, number][] = chains.map(() => [-1, -1]); // [start end index, finish end index]
  chains.forEach((c, i) => {
    for (const atStart of [true, false]) {
      const p = atStart ? c[0] : c[c.length - 1];
      if (degree(coordKey(p)) !== 1) continue;
      endAt[i][atStart ? 0 : 1] = ends.length;
      ends.push({ chain: i, atStart, p });
    }
  });

  const pairs = nearbyPairs(
    ends.map((e) => e.p),
    gapToleranceM,
    (a, b) => ends[a].chain !== ends[b].chain,
  );
  const uf = new UnionFind(chains.length);
  const partner = new Map<number, number>(); // end index → end index it is linked to
  for (const [a, b] of pairs) {
    if (partner.has(a) || partner.has(b)) continue;
    if (uf.find(ends[a].chain) === uf.find(ends[b].chain)) continue;
    uf.union(ends[a].chain, ends[b].chain);
    partner.set(a, b);
    partner.set(b, a);
  }
  const linkedTo = (chain: number, atStart: boolean): ChainEnd | null => {
    const idx = endAt[chain][atStart ? 0 : 1];
    const p = idx >= 0 ? partner.get(idx) : undefined;
    return p === undefined ? null : ends[p];
  };

  const groups = new Map<number, number[]>(); // insertion order = by smallest chain index
  for (let i = 0; i < chains.length; i++) {
    const root = uf.find(i);
    const g = groups.get(root);
    if (g) g.push(i);
    else groups.set(root, [i]);
  }

  const paths: Line[][] = [];
  for (const group of groups.values()) {
    // Acyclic by construction: start at a chain with an unlinked end and walk.
    let chain = group.find((c) => linkedTo(c, true) === null || linkedTo(c, false) === null) ?? group[0];
    let forward = linkedTo(chain, true) === null; // enter through the unlinked end
    const path: Line[] = [];
    const forwardOf = new Map<number, boolean>();
    while (path.length < group.length) {
      forwardOf.set(chain, forward);
      path.push(forward ? chains[chain] : [...chains[chain]].reverse());
      const next = linkedTo(chain, !forward); // leave through the other end
      if (!next) break;
      chain = next.chain;
      forward = next.atStart;
    }
    // Deterministic orientation: the group's first chain keeps its direction.
    paths.push(forwardOf.get(group[0]) === false ? path.reverse().map((l) => [...l].reverse()) : path);
  }

  if (paths.length > 1) return { lines: paths.flat(), routeType: "network" };
  const path = paths[0];
  const last = path[path.length - 1];
  return { lines: path, routeType: distanceM(path[0][0], last[last.length - 1]) <= LOOP_CLOSURE_TOLERANCE_M ? "loop" : "linear" };
}

// ---------------------------------------------------------------------------
// Union-find (grouping ways by shared vertices)
// ---------------------------------------------------------------------------

export class UnionFind {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = new Array<number>(size).fill(0);
  }

  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root];
    // Path compression.
    while (this.parent[i] !== root) {
      const next = this.parent[i];
      this.parent[i] = root;
      i = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else {
      this.parent[rb] = ra;
      this.rank[ra]++;
    }
  }
}

/**
 * Group items (e.g. the ways of one name) that share at least one vertex
 * (any vertex, not only endpoints: same-named ways often meet at a
 * T-junction in the middle of one of them).
 *
 * With `gapToleranceM` > 0, items are also grouped when a DEAD END of one
 * (a line end that no other line of the input touches) lies within that
 * distance of a dead end of another: an unjoined node does not split one
 * trail into two.
 *
 * Returns groups of item indexes, each sorted ascending, groups ordered by
 * their smallest index. Linear in the number of vertices.
 */
export function groupByConnectivity(items: readonly (readonly Line[])[], gapToleranceM = 0): number[][] {
  const uf = new UnionFind(items.length);
  const owner = new Map<string, number>();
  const occurrences = new Map<string, number>();
  items.forEach((segments, i) => {
    for (const seg of segments) {
      for (const p of seg) {
        const k = coordKey(p);
        occurrences.set(k, (occurrences.get(k) ?? 0) + 1);
        const j = owner.get(k);
        if (j === undefined) owner.set(k, i);
        else uf.union(i, j);
      }
    }
  });

  if (gapToleranceM > 0) {
    const ends: { item: number; p: readonly [number, number] }[] = [];
    items.forEach((segments, i) => {
      for (const seg of segments) {
        if (seg.length === 0) continue;
        for (const p of [seg[0], seg[seg.length - 1]]) if (occurrences.get(coordKey(p)) === 1) ends.push({ item: i, p });
      }
    });
    const pairs = nearbyPairs(
      ends.map((e) => e.p),
      gapToleranceM,
      (a, b) => ends[a].item !== ends[b].item,
    );
    for (const [a, b] of pairs) uf.union(ends[a].item, ends[b].item);
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < items.length; i++) {
    const root = uf.find(i);
    const g = groups.get(root);
    if (g) g.push(i);
    else groups.set(root, [i]);
  }
  return [...groups.values()].sort((a, b) => a[0] - b[0]);
}

// ---------------------------------------------------------------------------
// Chain assembly
// ---------------------------------------------------------------------------

interface Edge {
  a: string;
  b: string;
  coords: Line;
  virtual: boolean;
}

/**
 * Merge segments (OSM ways, in a meaningful order such as relation member
 * order) into the fewest continuous polylines, reversing segments as needed.
 *
 * Method: build a graph whose vertices are segment endpoints plus every
 * vertex shared by two or more segments (so T-junctions and crossings
 * split segments), then decompose each connected component into the
 * minimum number of trails. A component with 0 or 2 odd-degree vertices is
 * exactly ONE chain (an Euler circuit/path — this is what "the ways form one
 * chain" means even when a naive greedy merge would get stuck); with 2k odd
 * vertices it needs k chains. We pair odd vertices with virtual edges, walk
 * an Euler circuit (Hierholzer), and cut it at the virtual edges.
 *
 * Every input vertex appears in the output and no coordinates are added, so
 * total length is preserved. Deterministic for a given input order; the first
 * chain starts at the first segment's start (circuits) or at the first odd
 * vertex encountered (paths). Linear in the number of vertices.
 */
export function assembleChains(segments: readonly Line[]): Line[] {
  return buildChains(segments).chains;
}

/** Chains plus the degree of every graph vertex (by coordKey; 0 when not a vertex). */
function buildChains(segments: readonly Line[]): { chains: Line[]; degree: (key: string) => number } {
  const segs = segments.map(dedupeKeyed).filter((s): s is KeyedLine => s !== null);
  if (segs.length === 0) return { chains: [], degree: () => 0 };

  // 1. Graph vertices: endpoints, and any vertex seen more than once.
  const occurrences = new Map<string, number>();
  for (const s of segs) for (const k of s.keys) occurrences.set(k, (occurrences.get(k) ?? 0) + 1);

  // 2. Split segments at graph vertices into edges.
  const edges: Edge[] = [];
  for (const { coords, keys } of segs) {
    let start = 0;
    for (let i = 1; i < coords.length; i++) {
      if (i !== coords.length - 1 && (occurrences.get(keys[i]) ?? 0) <= 1) continue;
      edges.push({ a: keys[start], b: keys[i], coords: coords.slice(start, i + 1), virtual: false });
      start = i;
    }
  }

  // 3. Connected components over edges (vertex → incident real edges; a
  //    self-loop is listed twice, so list length = vertex degree).
  const incident = new Map<string, number[]>();
  const addIncident = (v: string, e: number) => {
    const list = incident.get(v);
    if (list) list.push(e);
    else incident.set(v, [e]);
  };
  edges.forEach((e, i) => {
    addIncident(e.a, i);
    addIncident(e.b, i);
  });
  const uf = new UnionFind(edges.length);
  for (const list of incident.values()) for (let i = 1; i < list.length; i++) uf.union(list[0], list[i]);
  const components = new Map<number, number[]>();
  edges.forEach((_, i) => {
    const r = uf.find(i);
    const c = components.get(r);
    if (c) c.push(i);
    else components.set(r, [i]);
  });

  const chains: Line[] = [];
  for (const compEdges of [...components.values()].sort((x, y) => x[0] - y[0])) {
    for (const chain of decomposeComponent(compEdges.map((i) => edges[i]))) chains.push(chain);
  }
  return { chains, degree: (key) => incident.get(key)?.length ?? 0 };
}

/** Minimum trail decomposition of one connected component (see assembleChains). */
function decomposeComponent(realEdges: readonly Edge[]): Line[] {
  const edges: Edge[] = [...realEdges];
  const degree = new Map<string, number>();
  const order: string[] = []; // vertices in first-appearance order (deterministic pairing)
  for (const e of edges) {
    for (const v of [e.a, e.b]) {
      if (!degree.has(v)) order.push(v);
      degree.set(v, (degree.get(v) ?? 0) + 1);
    }
  }
  const odd = order.filter((v) => (degree.get(v) ?? 0) % 2 === 1);
  for (let i = 0; i + 1 < odd.length; i += 2) edges.push({ a: odd[i], b: odd[i + 1], coords: [], virtual: true });

  // Adjacency: per vertex, incident edge indexes in input order (virtual edges last).
  const adj = new Map<string, number[]>();
  edges.forEach((e, i) => {
    for (const v of e.a === e.b ? [e.a] : [e.a, e.b]) {
      const list = adj.get(v);
      if (list) list.push(i);
      else adj.set(v, [i]);
    }
  });
  const used = new Array<boolean>(edges.length).fill(false);
  const cursor = new Map<string, number>();

  // Hierholzer (iterative). Each stack entry: vertex reached and the edge used to reach it.
  const start = odd.length > 0 ? odd[0] : edges[0].a;
  const stack: { v: string; edge: number; forward: boolean }[] = [{ v: start, edge: -1, forward: true }];
  const circuit: { edge: number; forward: boolean }[] = [];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const list = adj.get(top.v) ?? [];
    let i = cursor.get(top.v) ?? 0;
    while (i < list.length && used[list[i]]) i++;
    cursor.set(top.v, i);
    if (i < list.length) {
      const ei = list[i];
      used[ei] = true;
      const e = edges[ei];
      const forward = e.a === top.v;
      stack.push({ v: forward ? e.b : e.a, edge: ei, forward });
    } else {
      stack.pop();
      if (top.edge >= 0) circuit.push({ edge: top.edge, forward: top.forward });
    }
  }
  circuit.reverse(); // now in walking order, a closed walk from `start` back to `start`

  // With odd vertices, rotate the closed walk so it begins right after the
  // virtual edge that enters `start`: every run between virtual edges is then
  // one real chain, and the first chain starts at the first odd vertex.
  // (`start` has exactly one virtual edge; if the walk leaves `start` through
  // it, walk the circuit backwards instead.)
  let steps = circuit;
  if (odd.length > 0) {
    const endsAtStart = (s: { edge: number; forward: boolean }) =>
      edges[s.edge].virtual && (s.forward ? edges[s.edge].b : edges[s.edge].a) === start;
    if (!steps.some(endsAtStart)) steps = [...steps].reverse().map((s) => ({ edge: s.edge, forward: !s.forward }));
    const pivot = steps.findIndex(endsAtStart);
    steps = [...steps.slice(pivot + 1), ...steps.slice(0, pivot + 1)];
  }

  const chains: Line[] = [];
  let current: Line = [];
  const flush = () => {
    if (current.length >= 2) chains.push(current);
    current = [];
  };
  for (const s of steps) {
    const e = edges[s.edge];
    if (e.virtual) {
      flush();
      continue;
    }
    const coords = s.forward ? e.coords : [...e.coords].reverse();
    // Consecutive edges share their joint vertex; keep it once.
    for (let i = current.length > 0 ? 1 : 0; i < coords.length; i++) current.push(coords[i]);
  }
  flush();
  return chains;
}
