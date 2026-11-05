import { expect } from "vitest";
import { offsetMeters, lineLengthM, type Position } from "@/domain/geo";
import type { SessionUser } from "@/server/auth";
import { ForbiddenError, type ActionResult } from "@/server/admin/common";
import { createTrail } from "@/server/admin/trails";

/** A gently curving route of `km` kilometres with ~100 m vertex spacing (and elevation). */
export function makeRoute(start: { lat: number; lng: number }, km: number, stepM = 100): Position[] {
  const steps = Math.round((km * 1000) / stepM);
  const coords: Position[] = [[start.lng, start.lat, 300]];
  let p = start;
  for (let i = 1; i <= steps; i++) {
    const heading = (30 + 25 * Math.sin(i / 6)) * (Math.PI / 180);
    p = offsetMeters(p, stepM * Math.sin(heading), stepM * Math.cos(heading));
    coords.push([Math.round(p.lng * 1e6) / 1e6, Math.round(p.lat * 1e6) / 1e6, 300 + Math.round(40 * Math.sin(i / 4) * 10) / 10]);
  }
  return coords;
}

export const routeKm = (coords: Position[]) => Math.round((lineLengthM(coords) / 1000) * 100) / 100;

export const enc = (s: string) => new TextEncoder().encode(s);

export function geojsonFeature(coords: Position[]) {
  return JSON.stringify({ type: "Feature", properties: { name: "Test route" }, geometry: { type: "LineString", coordinates: coords } });
}

export function gpxDoc(coords: Position[], kind: "trk" | "rte" = "trk") {
  const pt = kind === "trk" ? "trkpt" : "rtept";
  const pts = coords.map((c) => `<${pt} lat="${c[1]}" lon="${c[0]}">${c[2] !== undefined ? `<ele>${c[2]}</ele>` : ""}</${pt}>`).join("\n");
  const body = kind === "trk" ? `<trk><name>Test</name><trkseg>${pts}</trkseg></trk>` : `<rte><name>Test</name>${pts}</rte>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;
}

let counter = 0;
/** A new draft trail whose declared distance matches `coords`. */
export async function draftTrailFor(admin: SessionUser, coords: Position[], name = "Admin Test Trail") {
  counter++;
  const r = await createTrail(admin, {
    name: `${name} ${counter} ${Date.now() % 100000}`,
    summary: "Integration test trail",
    description: "",
    distanceKm: routeKm(coords),
    elevationGainM: 100,
    difficulty: "easy",
    routeType: "point_to_point",
    estimatedDurationMin: 60,
    trailheadName: "Test trailhead",
    trailheadLat: coords[0][1],
    trailheadLng: coords[0][0],
    basePriceCents: 1500,
    dailyCapacity: 10,
    isDemo: true,
  });
  if (!r.ok || !r.data) throw new Error(`createTrail failed: ${r.ok ? "no data" : r.error}`);
  return r.data.id;
}

export function expectOk<D>(r: ActionResult<D>): asserts r is { ok: true; message: string; warnings?: string[]; data?: D } {
  if (!r.ok) throw new Error(`Expected ok, got error: ${r.error}`);
}

export async function expectForbidden(p: Promise<unknown>) {
  await expect(p).rejects.toBeInstanceOf(ForbiddenError);
}
