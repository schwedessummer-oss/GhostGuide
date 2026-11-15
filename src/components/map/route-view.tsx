import type { Position } from "@/domain/geo";

/**
 * Vector route view: draws validated route geometry and POIs with their
 * trigger radii. No basemap tiles (no tile-licensing constraints). Pure
 * render; safe on server/client.
 */
export interface RouteViewPoi {
  id: string;
  name: string;
  lat: number;
  lng: number;
  triggerRadiusM?: number;
}

export interface RouteViewProps {
  coordinates: Position[];
  pois?: RouteViewPoi[];
  label: string;
  className?: string;
  height?: number;
}

const W = 600;

export function RouteView({ coordinates, pois = [], label, className, height = 360 }: RouteViewProps) {
  if (coordinates.length < 2) return null;
  const lats = coordinates.map((c) => c[1]);
  const lngs = coordinates.map((c) => c[0]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const midLat = (minLat + maxLat) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const spanX = Math.max((maxLng - minLng) * kx, 1e-6);
  const spanY = Math.max(maxLat - minLat, 1e-6);
  const H = height;
  const pad = 24;
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  const project = (lat: number, lng: number) => [offX + (lng - minLng) * kx * scale, H - (offY + (lat - minLat) * scale)] as const;
  // metres per degree latitude ≈ 111_320
  const metresToPx = (m: number) => (m / 111_320) * scale;

  const path = coordinates.map((c, i) => `${i ? "L" : "M"}${project(c[1], c[0]).map((n) => n.toFixed(1)).join(" ")}`).join(" ");
  const [sx, sy] = project(coordinates[0][1], coordinates[0][0]);
  const last = coordinates[coordinates.length - 1];
  const [ex, ey] = project(last[1], last[0]);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
      className={className ?? "h-auto w-full rounded-xl border border-sand-200 bg-[#f4f1e8]"}
      preserveAspectRatio="xMidYMid meet"
    >
      <title>{label}</title>
      <defs>
        <pattern id="gg-grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#e4ddcd" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="url(#gg-grid)" />
      <path d={path} fill="none" stroke="#ffffff" strokeWidth="9" strokeLinejoin="round" strokeLinecap="round" />
      <path d={path} fill="none" stroke="#2a5a3e" strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" />
      {pois.map((p) => {
        const [x, y] = project(p.lat, p.lng);
        const r = p.triggerRadiusM ? Math.max(4, metresToPx(p.triggerRadiusM)) : 0;
        return (
          <g key={p.id}>
            {r ? <circle cx={x} cy={y} r={r} fill="#2a5a3e" fillOpacity="0.08" stroke="#2a5a3e" strokeOpacity="0.3" strokeDasharray="3 3" /> : null}
            <circle cx={x} cy={y} r="7" fill="#ffffff" stroke="#173524" strokeWidth="2.5" />
          </g>
        );
      })}
      <g aria-hidden>
        <circle cx={sx} cy={sy} r="9" fill="#173524" />
        <text x={sx} y={sy + 4} textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff">
          S
        </text>
        {Math.hypot(ex - sx, ey - sy) > 12 ? (
          <>
            <circle cx={ex} cy={ey} r="9" fill="#8a4b08" />
            <text x={ex} y={ey + 4} textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff">
              F
            </text>
          </>
        ) : null}
      </g>
    </svg>
  );
}
