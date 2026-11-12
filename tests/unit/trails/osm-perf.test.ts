/**
 * Performance guard for the Overpass parser on a dense urban tile.
 *
 * A 0.25° tile over a city can return tens of thousands of named ways. The
 * parser must stay (near-)linear in the number of ways and vertices: any
 * all-pairs pass over the ways of a tile, or over the chains of one big
 * trail, would make tile ingestion take minutes. The synthetic tile below
 * combines the patterns that would expose that:
 *
 *   - a 100 × 100 grid of named footways (19 800 ways, 200 names): every
 *     name group is one long chain crossing 99 junctions of other names;
 *   - one park mesh of 1 200 ways sharing a single name (one huge group with
 *     hundreds of odd-degree junctions → many chains);
 *   - one "dotted" trail of 400 pieces with 8 m gaps (the dead-end gap search);
 *   - sidewalks the parser must reject, and 3 000 POI nodes.
 *
 * The time budget is generous (CI machines are slow) but an O(n²) pass over
 * 20k ways or a cubic gap search would blow through it by orders of magnitude.
 */
import { describe, expect, it } from "vitest";
import { totalLengthM } from "@/server/trails/providers/osm/geometry";
import { parseOverpassResponse } from "@/server/trails/providers/osm/parse";
import { node, response, way, type Xy } from "../../fixtures/osm/synthetic";

const SPACING_M = 80;
const GRID = 100;

function denseUrbanTile(): { elements: unknown[]; wayCount: number } {
  const elements: unknown[] = [];
  let id = 1;
  let wayCount = 0;
  const addWay = (tags: Record<string, string>, points: Xy[]) => {
    elements.push(way(id++, tags, points));
    wayCount++;
  };

  // 1. Grid: each row/column is one named footway made of 99 block-long ways
  //    (3 vertices each). Rows and columns share the intersection vertices.
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c + 1 < GRID; c++) {
      const y = r * SPACING_M;
      addWay({ highway: "footway", name: `Row Walk ${r}` }, [
        [c * SPACING_M, y],
        [c * SPACING_M + SPACING_M / 2, y],
        [(c + 1) * SPACING_M, y],
      ]);
      const x = r * SPACING_M;
      addWay({ highway: "path", name: `Column Path ${r}` }, [
        [x, c * SPACING_M],
        [x, c * SPACING_M + SPACING_M / 2],
        [x, (c + 1) * SPACING_M],
      ]);
    }
  }

  // 2. Park mesh: a 20 × 31 lattice of ways that all share one name.
  const parkOrigin: Xy = [GRID * SPACING_M + 500, 0];
  const cell = 30;
  for (let r = 0; r < 20; r++) {
    for (let c = 0; c < 30; c++) {
      const x0 = parkOrigin[0] + c * cell;
      const y0 = parkOrigin[1] + r * cell;
      addWay({ highway: "footway", name: "Park Path" }, [
        [x0, y0],
        [x0 + cell, y0],
      ]);
      addWay({ highway: "footway", name: "Park Path" }, [
        [x0, y0],
        [x0, y0 + cell],
      ]);
    }
  }

  // 3. A dotted trail: 400 pieces, 60 m long, separated by 8 m unjoined gaps.
  const dottedY = GRID * SPACING_M + 500;
  for (let i = 0; i < 400; i++) {
    const x0 = i * 68;
    addWay({ highway: "path", name: "Dotted Trail" }, [
      [x0, dottedY],
      [x0 + 30, dottedY + 5],
      [x0 + 60, dottedY],
    ]);
  }

  // 4. Sidewalks (rejected by the parser's own rules) and POIs.
  for (let i = 0; i < 2000; i++) {
    addWay({ highway: "footway", footway: "sidewalk", name: `Row Walk ${i % GRID}` }, [
      [i * 4, -50],
      [i * 4 + 3, -50],
    ]);
  }
  for (let i = 0; i < 3000; i++) {
    elements.push(node(1_000_000 + i, { amenity: "parking" }, [(i % 100) * 70 + 10, Math.floor(i / 100) * 70 + 10]));
  }
  return { elements, wayCount };
}

describe("osm parse: performance on a dense urban tile", () => {
  it("parses > 20 000 ways in well under 2 s and still groups them correctly", () => {
    const { elements, wayCount } = denseUrbanTile();
    expect(wayCount).toBeGreaterThan(20_000);
    const json = response(elements);

    parseOverpassResponse("outdoor", json); // warm-up (JIT), not timed
    const started = performance.now();
    const r = parseOverpassResponse("outdoor", json);
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(2000);

    // Correctness at scale: one trail per row/column name, one park network, one dotted trail.
    const names = new Map(r.trails.map((t) => [t.name, t]));
    expect(r.trails).toHaveLength(2 * GRID + 2);
    const row = names.get("Row Walk 7")!;
    expect(row.routeType).toBe("linear");
    expect(row.lines).toHaveLength(1);
    expect(totalLengthM(row.lines)).toBeCloseTo((GRID - 1) * SPACING_M, -1);
    expect(names.get("Park Path")!.routeType).toBe("network");
    const dotted = names.get("Dotted Trail")!;
    expect(dotted.lines).toHaveLength(400); // gaps are never drawn
    expect(dotted.routeType).toBe("linear"); // but 8 m dead-end gaps do not make a network
    expect(r.pois).toHaveLength(3000);
  });
});
