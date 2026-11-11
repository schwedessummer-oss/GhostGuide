import type { CSSProperties } from "react";
import type { Position } from "@/domain/geo";

/**
 * Offline overview of every route in the region (no basemap tiles), using
 * the same equirectangular projection as RouteView. Each trailhead carries a
 * number and a name; the page always renders a text list alternative with
 * the same numbers. Routes are links (keyboard focusable).
 *
 * Small screens: the 720-unit-wide drawing is shown at about half size, so
 * markers and numbers are enlarged with CSS (`max-sm:`), the name labels are
 * hidden (they would be unreadably small and collide; the numbered list
 * below names every trail), and each marker gets an invisible hit circle so
 * the touch target is large without overlapping its neighbours.
 */
export interface OverviewRoute {
  slug: string;
  name: string;
  number: number;
  coordinates: Position[];
  trailhead: { lat: number; lng: number };
  closed: boolean;
}

const W = 720;
const H = 480;
const PAD = 36;
// Distinguishable stroke colors; meaning is carried by the numbered labels, not color.
const COLORS = ["#2a5a3e", "#8a4b08", "#1e4f9c", "#6b3fa0", "#a3241a", "#0f6b6b", "#5c5f1e"];
/** Invisible hit-circle radius (viewBox units): desktop ≈ 1:1, small screens ≈ 1:2 (44 units ≈ 22 px ⇒ 44 px target). */
const HIT_R = { desktop: { min: 16, max: 26 }, mobile: { min: 24, max: 44 } };

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Largest hit radius that keeps neighbouring markers' targets from overlapping. */
export function hitRadius(index: number, points: readonly (readonly [number, number])[], bounds: { min: number; max: number }): number {
  const [x, y] = points[index];
  const nearest = Math.min(Infinity, ...points.filter((_, j) => j !== index).map(([px, py]) => Math.hypot(px - x, py - y)));
  return Math.round(clamp(nearest / 2 - 1, bounds.min, bounds.max));
}

export function TrailsOverviewSvg({ routes, label }: { routes: OverviewRoute[]; label: string }) {
  const all = routes.flatMap((r) => r.coordinates);
  if (all.length < 2) return null;
  const lats = all.map((c) => c[1]);
  const lngs = all.map((c) => c[0]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = Math.max((maxLng - minLng) * kx, 1e-6);
  const spanY = Math.max(maxLat - minLat, 1e-6);
  const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  const project = (lat: number, lng: number) => [offX + (lng - minLng) * kx * scale, H - (offY + (lat - minLat) * scale)] as const;
  const pathFor = (coords: Position[]) => coords.map((c, i) => `${i ? "L" : "M"}${project(c[1], c[0]).map((n) => n.toFixed(1)).join(" ")}`).join(" ");
  // Scale bar: 1 km
  const kmPx = (1000 / 111_320) * scale;
  const markers = routes.map((r) => project(r.trailhead.lat, r.trailhead.lng));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={label} className="h-auto w-full rounded-xl border border-sand-200 bg-[#f4f1e8]">
      <title>{label}</title>
      <defs>
        <pattern id="gg-overview-grid" width="48" height="48" patternUnits="userSpaceOnUse">
          <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#e4ddcd" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="url(#gg-overview-grid)" />
      {routes.map((r, i) => {
        const color = COLORS[i % COLORS.length];
        const d = pathFor(r.coordinates);
        const [tx, ty] = markers[i];
        const anchorRight = tx > W * 0.62;
        const hitStyle = { "--gg-hit-r": `${hitRadius(i, markers, HIT_R.mobile)}px` } as CSSProperties;
        return (
          <a
            key={r.slug}
            href={`/trails/${r.slug}`}
            aria-label={`${r.number}. ${r.name}${r.closed ? " (closed)" : ""}: open trail details`}
            className="group"
          >
            <title>{`${r.number}. ${r.name}`}</title>
            <path d={d} fill="none" stroke="#ffffff" strokeWidth="7" strokeLinejoin="round" strokeLinecap="round" />
            <path
              d={d}
              fill="none"
              stroke={color}
              strokeWidth="4"
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={r.closed ? "6 5" : undefined}
            />
            {/* Invisible touch target around the marker (enlarged on small screens). */}
            <circle
              data-hit-target=""
              cx={tx}
              cy={ty}
              r={hitRadius(i, markers, HIT_R.desktop)}
              fill="transparent"
              style={hitStyle}
              className="max-sm:[r:var(--gg-hit-r)]"
            />
            <circle
              cx={tx}
              cy={ty}
              r="12"
              fill={color}
              stroke="#fff"
              strokeWidth="2.5"
              className="max-sm:[r:20px] group-focus-visible:[stroke:#1d2420] group-focus-visible:[stroke-width:4px]"
            />
            <text
              x={tx}
              y={ty}
              dominantBaseline="central"
              textAnchor="middle"
              fontSize="13"
              fontWeight="700"
              fill="#fff"
              className="max-sm:text-[22px]"
              aria-hidden
            >
              {r.number}
            </text>
            <text
              x={anchorRight ? tx - 17 : tx + 17}
              y={ty}
              dominantBaseline="central"
              textAnchor={anchorRight ? "end" : "start"}
              fontSize="13"
              fontWeight="600"
              fill="#1d2420"
              stroke="#f4f1e8"
              strokeWidth="4"
              paintOrder="stroke"
              className="max-sm:hidden"
              aria-hidden
            >
              {r.name}
            </text>
          </a>
        );
      })}
      <g aria-hidden>
        <line x1={PAD} y1={H - 18} x2={PAD + kmPx} y2={H - 18} stroke="#1d2420" strokeWidth="2" />
        <line x1={PAD} y1={H - 23} x2={PAD} y2={H - 13} stroke="#1d2420" strokeWidth="2" />
        <line x1={PAD + kmPx} y1={H - 23} x2={PAD + kmPx} y2={H - 13} stroke="#1d2420" strokeWidth="2" />
        <text x={PAD + kmPx + 6} y={H - 14} fontSize="11" fill="#545b55" className="max-sm:text-[20px]">
          1 km
        </text>
        <text x={W - PAD} y={22} textAnchor="end" fontSize="11" fill="#545b55" className="max-sm:text-[20px]">
          N ↑ · schematic, not for navigation
        </text>
      </g>
    </svg>
  );
}
