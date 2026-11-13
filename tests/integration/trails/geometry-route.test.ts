/**
 * GET /api/trails/:id/geometry (finding #34): Explore's map preview gets a
 * display-simplified route line instead of the whole trail detail.
 *
 * Trail rows live around lng 160–170, lat -40 (no other test file uses this area).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const limiter = vi.hoisted(() => ({ forceLimited: false }));
vi.mock("@/server/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/rate-limit")>();
  return {
    ...actual,
    checkRateLimit: vi.fn(async (key: string, limit: number, windowSec: number) => {
      if (limiter.forceLimited) return { allowed: false, remaining: 0, resetAt: new Date(Date.now() + 42_000) };
      return actual.checkRateLimit(key, limit, windowSec);
    }),
  };
});

import { closeDb, withSystem, type JsonValue } from "@/server/db";
import { checkRateLimit } from "@/server/rate-limit";
import type { TrailRoutePreviewDto } from "@/components/explore/types";
import { trailRoutePreviewUrl } from "@/components/explore/types";
import { GET } from "@/app/api/trails/[id]/geometry/route";

afterAll(closeDb);
beforeEach(() => {
  limiter.forceLimited = false;
  vi.mocked(checkRateLimit).mockClear();
});

const newIp = () => `203.0.113.${Math.floor(Math.random() * 250) + 1}-${randomUUID().slice(0, 6)}`;
const get = (id: string, ip = newIp()) => GET(new Request(`http://localhost${trailRoutePreviewUrl(id)}`, { headers: { "x-real-ip": ip } }), { params: Promise.resolve({ id }) });

let areaSeq = 0;
async function insertTrail(lines: [number, number][][], opts: { hidden?: boolean } = {}) {
  const geojson = JSON.stringify({ type: "MultiLineString", coordinates: lines });
  const [row] = await withSystem(
    (tx) => tx<{ id: string }[]>`
      with g as (select st_setsrid(st_geomfromgeojson(${geojson}), 4326) as geom)
      insert into public.catalog_trails (provider, provider_id, name, slug, country_code, region_slug, centroid, trailhead,
        trailhead_source, geom, distance_m, route_type, difficulty, source_name, source_license, hidden, tags)
      select 'osm', ${`way/${randomUUID()}`}, 'Preview Trail', ${`preview-${randomUUID().slice(0, 8)}`}, 'nz', 'canterbury',
             st_centroid(g.geom)::geography, st_startpoint(st_geometryn(g.geom, 1))::geography, 'route_start',
             g.geom, greatest(1, round(st_length(g.geom::geography)))::int, 'linear', 'easy', 'OpenStreetMap', 'ODbL 1.0', ${opts.hidden ?? false},
             ${tx.json({} as JsonValue)}
        from g
      returning id`,
  );
  return row.id;
}

/** A dense, gently wiggling line: `n` vertices over ~`km` km eastwards (≈0.5 m of wiggle). */
function denseLine(n: number, km: number): [number, number][] {
  const lng0 = 160 + areaSeq++ * 0.5;
  const lat0 = -40;
  const dLng = km / 85.4 / (n - 1); // ~85.4 km per degree of longitude at 40° S
  return Array.from({ length: n }, (_, i) => [lng0 + i * dLng, lat0 + (i % 2 ? 0.000005 : 0) + Math.sin(i / 40) * 0.01] as [number, number]);
}

const vertices = (g: TrailRoutePreviewDto["geometry"]) => g.coordinates.reduce((s, l) => s + l.length, 0);

describe("GET /api/trails/:id/geometry", () => {
  it("returns a display-simplified MultiLineString that keeps the route's ends, with the public cache header", async () => {
    const line = denseLine(3_000, 20);
    const id = await insertTrail([line]);
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=60");
    const body = (await res.json()) as TrailRoutePreviewDto;
    expect(body.id).toBe(id);
    expect(body.simplified).toBe(true);
    expect(body.geometry.type).toBe("MultiLineString");
    expect(body.geometry.coordinates).toHaveLength(1);
    const n = vertices(body.geometry);
    expect(n).toBeGreaterThan(10);
    expect(n).toBeLessThan(line.length / 3);
    const [first, last] = [body.geometry.coordinates[0][0], body.geometry.coordinates[0].at(-1)!];
    expect(first[0]).toBeCloseTo(line[0][0], 4);
    expect(first[1]).toBeCloseTo(line[0][1], 4);
    expect(last[0]).toBeCloseTo(line.at(-1)![0], 4);
    expect(last[1]).toBeCloseTo(line.at(-1)![1], 4);
    // Much smaller than the full detail would carry.
    expect(JSON.stringify(body).length).toBeLessThan(JSON.stringify(line).length / 3);
  });

  it("stays within a few metres of the stored route", async () => {
    const line = denseLine(1_500, 8);
    const id = await insertTrail([line]);
    const body = (await (await get(id)).json()) as TrailRoutePreviewDto;
    const [{ maxM }] = await withSystem(
      (tx) => tx<{ maxM: number }[]>`
        select st_hausdorffdistance(t.geom::geography::geometry, st_setsrid(st_geomfromgeojson(${JSON.stringify(body.geometry)}), 4326)) * 111320 as max_m
          from public.catalog_trails t where t.id = ${id}::uuid`,
    );
    expect(maxM).toBeLessThanOrEqual(25);
  });

  it("short lines are sent as stored; multi-part routes keep their parts", async () => {
    const lng = 160 + areaSeq++ * 0.5;
    const parts: [number, number][][] = [
      [[lng, -40], [lng + 0.01, -40.005], [lng + 0.02, -40.004]],
      [[lng + 0.05, -40], [lng + 0.06, -40.01]],
    ];
    const id = await insertTrail(parts);
    const body = (await (await get(id)).json()) as TrailRoutePreviewDto;
    expect(body.simplified).toBe(false);
    expect(body.geometry.coordinates).toEqual(parts);
  });

  it("404 (not cached) for non-UUIDs, unknown and hidden trails alike", async () => {
    const hidden = await insertTrail([denseLine(5, 1)], { hidden: true });
    for (const id of ["not-a-uuid", randomUUID(), hidden]) {
      const res = await get(id);
      expect(res.status, id).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Trail not found" });
    }
  });

  it("rate limits per client IP (120/min) with Retry-After", async () => {
    const id = await insertTrail([denseLine(5, 1)]);
    const ip = newIp();
    await get(id, ip);
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith(`trails:geometry:ip:${ip}`, 120, 60);
    limiter.forceLimited = true;
    const res = await get(id, ip);
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });
});
