import "server-only";
import type { CatalogLayer } from "@/domain/catalog";
import type { Line, NormalizedPoi, NormalizedTrail, ProviderAreaResult } from "@/server/trails/types";
import {
  GAP_JOIN_TOLERANCE_M,
  assembleRoute,
  dedupeConsecutive,
  groupByConnectivity,
  isValidLngLat,
  totalLengthM,
  type AssembledRoute,
} from "./geometry";
import {
  TRAIL_PROVENANCE_KEYS,
  POI_PROVENANCE_KEYS,
  accessFromTags,
  aggregateActivities,
  aggregateDogPolicy,
  aggregateFee,
  aggregatePermit,
  aggregateSurfaces,
  aggregateWheelchair,
  classifyPoi,
  cleanName,
  consensus,
  descriptionFromTags,
  highestSacScale,
  isRouteRelation,
  isTrailWayCandidate,
  nameKey,
  namesFromTags,
  openingHoursFromTags,
  operatorFromTags,
  parseElevationM,
  phoneFromTags,
  pickConsensusTags,
  pickTags,
  seasonalityFromTags,
  websiteFromTags,
  worstTrailVisibility,
  type OsmElementType,
  type OsmTags,
} from "./tags";

/**
 * Overpass JSON → normalized trails and POIs.
 *
 * Trails come from two sources:
 *  - route relations (route=hiking|foot): providerId "relation/<id>"; member
 *    ways merged into chains in member order;
 *  - named trail ways that are not members of any route relation in the
 *    response: ways with the same normalized name that share a vertex (or
 *    whose dead ends are ≤ 20 m apart: an unjoined node does not split a
 *    trail) form one trail, providerId "waygroup/<smallest way id>" (stable
 *    across refreshes as long as that way exists; source link points at it).
 *    Way groups only see the ways of one tile: a standalone named trail that
 *    crosses a tile edge comes back from each tile as that tile's part.
 *    Route relations do not have this problem (their full geometry is
 *    fetched in every tile they touch).
 *
 * Trails shorter than 400 m in total (configurable) are dropped. Everything
 * is linear in the size of the response (hash maps, union-find, a spatial
 * grid for gaps): no pass compares all ways of a tile with each other.
 *
 * Route type (geometry.assembleRoute): one chain whose ends are ≤ 50 m apart
 * → "loop"; one open chain → "linear"; several chains (branches,
 * alternatives, excursions that cannot be walked as one continuous line, or
 * gaps over 20 m) → "network". Chains separated only by a tiny dead-end gap
 * (unjoined nodes) still count as one chain; their lines stay separate. The
 * roundtrip tag never overrides the geometry.
 *
 * Defensive: malformed elements (bad ids, coordinates, tags, geometry) are
 * skipped individually; only a response without an `elements` array is an
 * error (OverpassResponseError), because silently treating it as "no data"
 * would wipe a tile.
 */

export const OSM_SOURCE_NAME = "OpenStreetMap contributors";
export const OSM_SOURCE_LICENSE = "ODbL 1.0";
export const OSM_WEB_BASE = "https://www.openstreetmap.org";
export const DEFAULT_MIN_TRAIL_LENGTH_M = 400;

export class OverpassResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverpassResponseError";
  }
}

export interface ParseOverpassOptions {
  /** Trails shorter than this (total mapped length) are dropped. Default 400 m. */
  minTrailLengthM?: number;
}

// ---------------------------------------------------------------------------
// Raw element validation
// ---------------------------------------------------------------------------

interface RawNode {
  id: number;
  tags: OsmTags;
  lng: number;
  lat: number;
}

interface RawWay {
  id: number;
  /** null when the element came without tags. */
  tags: OsmTags | null;
  /** Geometry (split at missing vertices), when output with `out geom`. */
  segments: Line[] | null;
  /** Centre, when output with `out center`. */
  center: [number, number] | null;
}

interface RawMember {
  type: OsmElementType;
  ref: number;
  role: string;
  segments: Line[] | null;
}

interface RawRelation {
  id: number;
  tags: OsmTags | null;
  members: RawMember[];
  center: [number, number] | null;
}

type Dict = Record<string, unknown>;
const isRecord = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
const parseId = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);
const isElementType = (v: unknown): v is OsmElementType => v === "node" || v === "way" || v === "relation";

function parseTags(v: unknown): OsmTags | null {
  if (!isRecord(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (k.length > 0 && k.length <= 255 && typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function parsePoint(v: unknown): [number, number] | null {
  if (!isRecord(v)) return null;
  return isValidLngLat(v.lon, v.lat) ? [v.lon as number, v.lat as number] : null;
}

/**
 * Overpass `geometry`: [{lat, lon}, ...]. Missing/invalid vertices (null when
 * output is clipped, or garbage) split the line: we never draw a straight
 * line across a vertex we do not have.
 */
function parseGeometry(v: unknown): Line[] | null {
  if (!Array.isArray(v)) return null;
  const segments: Line[] = [];
  let current: Line = [];
  const flush = () => {
    const cleaned = dedupeConsecutive(current);
    if (cleaned) segments.push(cleaned);
    current = [];
  };
  for (const p of v) {
    const pt = parsePoint(p);
    if (pt) current.push(pt);
    else flush();
  }
  flush();
  return segments.length > 0 ? segments : null;
}

function mergeTags(a: OsmTags | null, b: OsmTags | null): OsmTags | null {
  if (!a) return b;
  if (!b) return a;
  return { ...a, ...b };
}

interface Collected {
  nodes: Map<number, RawNode>;
  ways: Map<number, RawWay>;
  relations: Map<number, RawRelation>;
}

/**
 * Validate and index elements. The same element may appear more than once
 * (e.g. tags-only as a route member, and again with a centre as a POI):
 * occurrences are merged.
 */
function collectElements(elements: readonly unknown[]): Collected {
  const nodes = new Map<number, RawNode>();
  const ways = new Map<number, RawWay>();
  const relations = new Map<number, RawRelation>();
  for (const el of elements) {
    if (!isRecord(el)) continue;
    const id = parseId(el.id);
    if (id === null) continue;
    const tags = parseTags(el.tags);
    const center = parsePoint(el.center);
    if (el.type === "node") {
      const pt = parsePoint(el);
      if (!pt || !tags) continue;
      const prev = nodes.get(id);
      nodes.set(id, { id, lng: pt[0], lat: pt[1], tags: mergeTags(prev?.tags ?? null, tags) ?? tags });
    } else if (el.type === "way") {
      const segments = parseGeometry(el.geometry);
      const prev = ways.get(id);
      ways.set(id, {
        id,
        tags: mergeTags(prev?.tags ?? null, tags),
        segments: prev?.segments ?? segments,
        center: prev?.center ?? center,
      });
    } else if (el.type === "relation") {
      const members: RawMember[] = [];
      if (Array.isArray(el.members)) {
        for (const m of el.members) {
          if (!isRecord(m) || !isElementType(m.type)) continue;
          const ref = parseId(m.ref);
          if (ref === null) continue;
          members.push({
            type: m.type,
            ref,
            role: typeof m.role === "string" ? m.role : "",
            segments: m.type === "way" ? parseGeometry(m.geometry) : null,
          });
        }
      }
      const prev = relations.get(id);
      relations.set(id, {
        id,
        tags: mergeTags(prev?.tags ?? null, tags),
        members: prev && prev.members.length > 0 ? prev.members : members,
        center: prev?.center ?? center,
      });
    }
  }
  return { nodes, ways, relations };
}

function parseTimestamp(v: unknown): Date | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Overpass reports some failures as HTTP 200 with a `remark` (the elements
 * are then incomplete). Returns the remark when it signals such a failure.
 */
export function overpassRuntimeError(json: unknown): string | null {
  if (!isRecord(json) || typeof json.remark !== "string") return null;
  const remark = json.remark.trim();
  return /runtime error|timed out|out of memory/i.test(remark) ? remark.slice(0, 500) : null;
}

// ---------------------------------------------------------------------------
// Trails
// ---------------------------------------------------------------------------

interface MemberInfo {
  tags: OsmTags;
  /** Mapped length (m), used to rank surfaces. */
  weight: number;
}

interface TrailDraft {
  providerId: string;
  sourceUrl: string;
  name: string;
  nameEn: string | null;
  /** The route relation's own tags (null for way groups). */
  primary: OsmTags | null;
  members: MemberInfo[];
  route: AssembledRoute;
  provenance: Record<string, string>;
}

/** All non-null and equal → that value; otherwise null. */
function unanimous(values: readonly (string | null)[]): string | null {
  if (values.length === 0 || values.some((v) => v === null)) return null;
  return new Set(values).size === 1 ? values[0] : null;
}

function finishTrail(d: TrailDraft, dataTimestamp: Date | null): NormalizedTrail {
  const memberTags = d.members.map((m) => m.tags);
  const all = d.primary ? [d.primary, ...memberTags] : memberTags;
  /**
   * Route-level text (description, website, operator, seasonality): a route
   * relation's own tags only — its member ways are sections, and one
   * section's description is not the route's. Ways of a name group ARE the
   * trail, so the value they agree on is used.
   */
  const text = (pick: (t: OsmTags) => string | null) => (d.primary ? pick(d.primary) : consensus(null, memberTags.map(pick)));
  /**
   * access is usually mapped on ways: a route's own tag wins, else the value
   * EVERY member way states; for a name group, the value its ways agree on.
   */
  const access = d.primary
    ? (accessFromTags(d.primary) ?? unanimous(memberTags.map(accessFromTags)))
    : consensus(null, memberTags.map(accessFromTags));
  return {
    provider: "osm",
    providerId: d.providerId,
    name: d.name,
    nameEn: d.nameEn,
    lines: d.route.lines,
    routeType: d.route.routeType,
    sacScale: highestSacScale(all),
    trailVisibility: worstTrailVisibility(all),
    surfaces: aggregateSurfaces([...(d.primary ? [{ tags: d.primary, weight: 0 }] : []), ...d.members]),
    activities: aggregateActivities(d.primary, memberTags),
    description: text(descriptionFromTags),
    dogPolicy: aggregateDogPolicy(d.primary, memberTags),
    wheelchair: aggregateWheelchair(d.primary, memberTags),
    feeRequired: aggregateFee(d.primary, memberTags),
    permitRequired: aggregatePermit(d.primary, memberTags),
    access,
    seasonality: text(seasonalityFromTags),
    operator: text(operatorFromTags),
    website: text(websiteFromTags),
    tags: d.provenance,
    sourceName: OSM_SOURCE_NAME,
    sourceUrl: d.sourceUrl,
    sourceLicense: OSM_SOURCE_LICENSE,
    // OSM snapshot time of the response (per-element edit times would need
    // `out meta`, which also carries contributor user names: not fetched).
    sourceUpdatedAt: dataTimestamp,
  };
}

function relationDraft(rel: RawRelation, ways: ReadonlyMap<number, RawWay>): TrailDraft | null {
  const tags = rel.tags;
  if (!tags) return null;
  const { name, nameEn } = namesFromTags(tags);
  if (!name) return null;
  const seen = new Set<number>();
  const segments: Line[] = [];
  const members: MemberInfo[] = [];
  for (const m of rel.members) {
    // Non-way members (guidepost nodes, sub-relations) carry no trail geometry.
    // A way listed twice (e.g. walked out and back) is the same physical trail.
    if (m.type !== "way" || seen.has(m.ref)) continue;
    seen.add(m.ref);
    if (m.segments) segments.push(...m.segments);
    const way = ways.get(m.ref);
    if (way?.tags) members.push({ tags: way.tags, weight: m.segments ? totalLengthM(m.segments) : 0 });
  }
  const route = assembleRoute(segments);
  if (route.lines.length === 0) return null;
  return {
    providerId: `relation/${rel.id}`,
    sourceUrl: `${OSM_WEB_BASE}/relation/${rel.id}`,
    name,
    nameEn,
    primary: tags,
    members,
    route,
    provenance: pickTags(tags, TRAIL_PROVENANCE_KEYS),
  };
}

function wayGroupDraft(group: readonly RawWay[]): TrailDraft | null {
  // `group` is sorted by id; the smallest id names and identifies the trail.
  const rep = group[0];
  const repTags = rep.tags;
  const name = repTags ? cleanName(repTags.name) : null;
  if (!repTags || !name) return null;
  const memberTags = group.map((w) => w.tags ?? {});
  const en = consensus(
    null,
    memberTags.map((t) => cleanName(t["name:en"])),
  );
  const route = assembleRoute(group.flatMap((w) => w.segments ?? []));
  if (route.lines.length === 0) return null;
  return {
    providerId: `waygroup/${rep.id}`,
    sourceUrl: `${OSM_WEB_BASE}/way/${rep.id}`,
    name,
    nameEn: en && nameKey(en) !== nameKey(name) ? en : null,
    primary: null,
    members: group.map((w) => ({ tags: w.tags ?? {}, weight: w.segments ? totalLengthM(w.segments) : 0 })),
    route,
    provenance: pickConsensusTags(memberTags, TRAIL_PROVENANCE_KEYS),
  };
}

function buildTrails(collected: Collected, dataTimestamp: Date | null, minLengthM: number): NormalizedTrail[] {
  const { ways, relations } = collected;
  const routes = [...relations.values()].filter((r) => r.tags !== null && isRouteRelation(r.tags)).sort((a, b) => a.id - b.id);

  // Ways that belong to a route relation in this response are represented by
  // that route and must not be emitted again as a way group.
  const routeMemberWays = new Set<number>();
  for (const r of routes) for (const m of r.members) if (m.type === "way") routeMemberWays.add(m.ref);

  const drafts: TrailDraft[] = [];
  for (const r of routes) {
    const d = relationDraft(r, ways);
    if (d) drafts.push(d);
  }

  // Named candidate ways grouped by normalized name, then by connectivity.
  const byName = new Map<string, RawWay[]>();
  const candidates = [...ways.values()]
    .filter((w) => w.segments !== null && w.tags !== null && !routeMemberWays.has(w.id) && isTrailWayCandidate(w.tags))
    .sort((a, b) => a.id - b.id);
  for (const w of candidates) {
    const key = nameKey(cleanName(w.tags?.name) ?? "");
    const list = byName.get(key);
    if (list) list.push(w);
    else byName.set(key, [w]);
  }
  for (const group of byName.values()) {
    for (const component of groupByConnectivity(group.map((w) => w.segments ?? []), GAP_JOIN_TOLERANCE_M)) {
      const d = wayGroupDraft(component.map((i) => group[i]));
      if (d) drafts.push(d);
    }
  }

  return drafts
    .map((d) => finishTrail(d, dataTimestamp))
    .filter((t) => totalLengthM(t.lines) >= minLengthM)
    .sort(compareProviderIds);
}

// ---------------------------------------------------------------------------
// POIs
// ---------------------------------------------------------------------------

const TYPE_ORDER: Record<string, number> = { node: 0, way: 1, relation: 2, waygroup: 3 };

/** Order by element type, then numeric id (deterministic output). */
function compareProviderIds(a: { providerId: string }, b: { providerId: string }): number {
  const [ta, ia] = a.providerId.split("/");
  const [tb, ib] = b.providerId.split("/");
  return (TYPE_ORDER[ta] ?? 9) - (TYPE_ORDER[tb] ?? 9) || Number(ia) - Number(ib);
}

/** Centre of the bounding box of some lines (what Overpass `out center` reports). */
function bboxCenter(segments: readonly Line[]): [number, number] | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const s of segments)
    for (const [lng, lat] of s) {
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
  return Number.isFinite(minLng) ? [(minLng + maxLng) / 2, (minLat + maxLat) / 2] : null;
}

function makePoi(layer: CatalogLayer, type: OsmElementType, id: number, tags: OsmTags, at: [number, number]): NormalizedPoi | null {
  const category = classifyPoi(layer, type, tags);
  if (!category) return null;
  const { name, nameEn } = namesFromTags(tags);
  return {
    provider: "osm",
    providerId: `${type}/${id}`,
    layer,
    category,
    name,
    nameEn,
    lng: at[0],
    lat: at[1],
    elevationM: parseElevationM(tags.ele),
    tags: pickTags(tags, POI_PROVENANCE_KEYS),
    openingHours: openingHoursFromTags(tags),
    phone: phoneFromTags(tags),
    website: websiteFromTags(tags),
    sourceName: OSM_SOURCE_NAME,
    sourceUrl: `${OSM_WEB_BASE}/${type}/${id}`,
    sourceLicense: OSM_SOURCE_LICENSE,
  };
}

function buildPois(layer: CatalogLayer, collected: Collected): NormalizedPoi[] {
  const out: NormalizedPoi[] = [];
  for (const n of collected.nodes.values()) {
    const poi = makePoi(layer, "node", n.id, n.tags, [n.lng, n.lat]);
    if (poi) out.push(poi);
  }
  for (const w of collected.ways.values()) {
    const at = w.center ?? (w.segments ? bboxCenter(w.segments) : null);
    const poi = w.tags && at ? makePoi(layer, "way", w.id, w.tags, at) : null;
    if (poi) out.push(poi);
  }
  for (const r of collected.relations.values()) {
    const poi = r.tags && r.center ? makePoi(layer, "relation", r.id, r.tags, r.center) : null;
    if (poi) out.push(poi);
  }
  return out.sort(compareProviderIds);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseOverpassResponse(layer: CatalogLayer, json: unknown, opts: ParseOverpassOptions = {}): ProviderAreaResult {
  const minLengthM = opts.minTrailLengthM ?? DEFAULT_MIN_TRAIL_LENGTH_M;
  if (!Number.isFinite(minLengthM) || minLengthM < 0) throw new RangeError("minTrailLengthM must be a finite number >= 0");
  if (!isRecord(json) || !Array.isArray(json.elements)) {
    throw new OverpassResponseError("Overpass response is not an object with an elements array");
  }
  const dataTimestamp = isRecord(json.osm3s) ? parseTimestamp(json.osm3s.timestamp_osm_base) : null;
  const collected = collectElements(json.elements);
  return {
    // The services layer never carries trails, whatever the response contains.
    trails: layer === "outdoor" ? buildTrails(collected, dataTimestamp, minLengthM) : [],
    pois: buildPois(layer, collected),
    dataTimestamp,
  };
}
