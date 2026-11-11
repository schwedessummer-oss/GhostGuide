import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TrailsOverviewSvg, hitRadius, type OverviewRoute } from "@/components/discover/trails-overview-svg";

/** Seeded trailheads as projected into the 720×480 overview (viewBox units). */
const SEEDED = [
  [356, 119],
  [300, 200],
  [207, 270],
  [139, 238],
  [245, 335],
  [329, 301],
] as const;

describe("trails overview (no map tiles)", () => {
  it("gives each marker the largest touch target that does not overlap a neighbour", () => {
    const mobile = { min: 24, max: 44 };
    const radii = SEEDED.map((_, i) => hitRadius(i, SEEDED, mobile));
    // Isolated markers get the full 44 units (about 44 px across at the phone's ~0.5 scale).
    expect(radii[0]).toBe(44);
    radii.forEach((r) => expect(r).toBeGreaterThanOrEqual(24));
    for (let i = 0; i < SEEDED.length; i++) {
      for (let j = i + 1; j < SEEDED.length; j++) {
        const d = Math.hypot(SEEDED[i][0] - SEEDED[j][0], SEEDED[i][1] - SEEDED[j][1]);
        expect(radii[i] + radii[j], `${i}/${j}`).toBeLessThanOrEqual(d);
      }
    }
  });

  it("renders hit targets, enlarges markers on small screens and hides the tiny name labels there", () => {
    const route = (n: number, lat: number, lng: number): OverviewRoute => ({
      slug: `t${n}`,
      name: `Trail ${n}`,
      number: n,
      coordinates: [
        [lng, lat],
        [lng + 0.01, lat + 0.01],
      ],
      trailhead: { lat, lng },
      closed: false,
    });
    const html = renderToStaticMarkup(createElement(TrailsOverviewSvg, { routes: [route(1, 47.5, -121.7), route(2, 47.52, -121.66)], label: "Overview" }));
    expect(html.match(/data-hit-target=""/g)).toHaveLength(2);
    expect(html).toMatch(/--gg-hit-r:\d+px/);
    expect(html).toContain("max-sm:[r:20px]");
    expect(html).toMatch(/class="max-sm:hidden"[^>]*>Trail 1</);
    expect(html.match(/<a /g)).toHaveLength(2);
  });
});
