import "server-only";
import type { Bbox, CatalogLayer } from "@/domain/catalog";
import {
  ROUTE_RELATION_VALUES,
  TRAIL_WAY_CANDIDATES,
  TRAIL_WAY_EXCLUSIONS,
  poiRulesForLayer,
  type OsmElementType,
  type TagCondition,
} from "./tags";

/**
 * Overpass QL builder for one catalog tile.
 *
 * Output (JSON, in this order):
 *   outdoor
 *     1. route relations (route=hiking|foot) with `out geom`: tags plus the
 *        full geometry of every member way (not clipped to the tile, so a
 *        route that crosses tiles is complete and identical in each tile);
 *     2. the tags (only) of those routes' member ways, so route attributes
 *        (sac_scale, surface, ...) can be aggregated from the ways;
 *     3. named trail ways that are NOT members of those routes, `out geom`
 *        (node ids + coordinates);
 *     4. outdoor POIs: nodes with coordinates, ways/relations with a centre.
 *   services
 *     4. service POIs only.
 *
 * Efficiency: exact key lookups everywhere (regexes only on values, never on
 * keys), one bbox filter per statement, `qt` output order (no sorting; the
 * parser does not depend on order), tags-only output where geometry is not
 * needed.
 */

export interface OverpassQueryOptions {
  /** Server-side query timeout, seconds (default 90). */
  timeoutSec?: number;
  /** Server-side memory limit, bytes (default 256 MiB). */
  maxSizeBytes?: number;
  /**
   * Route relations with more members than this are not fetched as
   * relations (default 1000). Long-distance routes (national trails with
   * thousands of ways) would otherwise put megabytes of geometry far outside
   * the tile into every tile along them; their named ways still come back
   * as trail ways (step 3), as sections within the tile.
   */
  maxRouteMembers?: number;
}

export const DEFAULT_OVERPASS_TIMEOUT_SEC = 90;
export const DEFAULT_OVERPASS_MAXSIZE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_ROUTE_MEMBERS = 1000;

/** Format a coordinate without exponent notation or float noise (max 7 decimals, OSM precision). */
function coord(n: number): string {
  return n.toFixed(7).replace(/\.?0+$/, "");
}

/** Overpass bbox filter "(south,west,north,east)" from our [west,south,east,north]. */
export function overpassBbox(bbox: Bbox): string {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new RangeError("bbox must be four finite numbers [west, south, east, north]");
  }
  const [w, s, e, n] = bbox;
  if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) {
    throw new RangeError("bbox out of range or empty (antimeridian-crossing boxes are not supported)");
  }
  return `(${coord(s)},${coord(w)},${coord(n)},${coord(e)})`;
}

/** Escape a literal for use inside an Overpass double-quoted string. */
const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Escape regex metacharacters of a literal value. */
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Exact-match alternation regex for a value set: ^(a|b)$. */
const exactAlternation = (values: readonly string[]) => `^(${values.map(reEscape).join("|")})$`;

/** Render one tag condition as an Overpass filter. */
export function renderCondition(c: TagCondition): string {
  const k = quote(c.key);
  switch (c.op) {
    case "exists":
      return `[${k}]`;
    case "in":
      return c.values.length === 1 ? `[${k}=${quote(c.values[0])}]` : `[${k}~${quote(exactAlternation(c.values))}]`;
    case "not_in":
      return c.values.length === 1 ? `[${k}!=${quote(c.values[0])}]` : `[${k}!~${quote(exactAlternation(c.values))}]`;
    case "list_has":
      // Semicolon-separated list containing one of the values.
      return `[${k}~${quote(`(^|;) *(${c.values.map(reEscape).join("|")}) *(;|$)`)}]`;
  }
}

const renderConditions = (conditions: readonly TagCondition[]) => conditions.map(renderCondition).join("");

const QL_TYPE: Record<OsmElementType, string> = { node: "node", way: "way", relation: "rel" };

function typeSelectors(types: readonly OsmElementType[]): string[] {
  const unique = [...new Set(types)];
  return unique.length === 3 ? ["nwr"] : unique.map((t) => QL_TYPE[t]);
}

function positiveInt(value: number | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw new RangeError(`${name} must be an integer between 1 and ${max}`);
  return value;
}

export function buildOverpassQuery(layer: CatalogLayer, bbox: Bbox, opts: OverpassQueryOptions = {}): string {
  const timeout = positiveInt(opts.timeoutSec, DEFAULT_OVERPASS_TIMEOUT_SEC, 3600, "timeoutSec");
  const maxsize = positiveInt(opts.maxSizeBytes, DEFAULT_OVERPASS_MAXSIZE_BYTES, 4 * 1024 ** 3, "maxSizeBytes");
  const maxMembers = positiveInt(opts.maxRouteMembers, DEFAULT_MAX_ROUTE_MEMBERS, 1_000_000, "maxRouteMembers");
  if (layer !== "outdoor" && layer !== "services") throw new RangeError(`Unknown catalog layer: ${String(layer)}`);
  const b = overpassBbox(bbox);

  const lines: string[] = [`[out:json][timeout:${timeout}][maxsize:${maxsize}];`];

  if (layer === "outdoor") {
    // 1. Named hiking/walking route relations (bounded size) with member geometry.
    lines.push(
      "(",
      ...ROUTE_RELATION_VALUES.map((v) => `  rel["route"=${quote(v)}]["name"]${b};`),
      `)->.routes_all;`,
      `rel.routes_all(if:count_members() <= ${maxMembers})->.routes;`,
      `.routes out geom qt;`,
      // 2. Tags of their member ways (attributes live on ways more often than on routes).
      `way(r.routes)->.route_ways;`,
      `.route_ways out tags qt;`,
    );
    // 3. Named trail ways, minus exclusions and minus route members.
    lines.push(
      "(",
      ...TRAIL_WAY_CANDIDATES.map((rule) => `  way${renderConditions(rule)}${b};`),
      `)->.candidates;`,
      "(",
      ...TRAIL_WAY_EXCLUSIONS.map((rule) => `  way.candidates${renderConditions(rule)};`),
      `  .route_ways;`,
      `)->.excluded;`,
      `(way.candidates; - .excluded;)->.trails;`,
      `.trails out geom qt;`,
    );
  }

  // 4. POIs for the layer.
  const poiStatements = poiRulesForLayer(layer).flatMap((rule) =>
    typeSelectors(rule.types).map((t) => `  ${t}${renderConditions(rule.conditions)}${b};`),
  );
  lines.push(
    "(",
    ...[...new Set(poiStatements)],
    `)->.pois;`,
    // Nodes carry coordinates; ways/relations only need tags + centre (no member lists).
    `node.pois->.poi_nodes;`,
    `.poi_nodes out qt;`,
    `(way.pois; rel.pois;)->.poi_areas;`,
    `.poi_areas out tags center qt;`,
  );

  return lines.join("\n");
}
