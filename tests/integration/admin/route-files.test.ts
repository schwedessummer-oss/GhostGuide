import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { closeDb, sql } from "@/server/db";
import { activateRouteFile, uploadRouteFile } from "@/server/admin/route-files";
import { getPublishReadiness, setTrailStatus } from "@/server/admin/trails";
import { linkSource } from "@/server/admin/sources";
import { demoUser } from "../../helpers/db";
import { draftTrailFor, enc, expectOk, geojsonFeature, gpxDoc, makeRoute } from "./helpers";

afterAll(closeDb);

const START = { lat: 47.52, lng: -121.7 };

async function trailRow(id: string) {
  const [t] = await sql()<{ geometry: { type: string; coordinates: number[][] } | null; geometryChecksum: string | null; geometryValidatedAt: Date | null; geometryValidatedBy: string | null; status: string }[]>`
    select geometry, geometry_checksum, geometry_validated_at, geometry_validated_by, status from public.trails where id = ${id}`;
  return t;
}

describe("route file upload, validation and activation", () => {
  it("activates a valid GeoJSON Feature and updates geometry + checksum", async () => {
    const admin = await demoUser("admin");
    const coords = makeRoute(START, 2.4);
    const trailId = await draftTrailFor(admin, coords);
    expect((await trailRow(trailId)).geometry).toBeNull();

    const up = await uploadRouteFile(admin, trailId, { filename: "route.geojson", bytes: enc(geojsonFeature(coords)) });
    expectOk(up);
    expect(up.data?.status).toBe("valid");
    const [rf] = await sql()<{ validationStatus: string; storagePath: string; isActive: boolean }[]>`
      select validation_status, storage_path, is_active from public.route_files where id = ${up.data!.routeFileId}`;
    expect(rf.validationStatus).toBe("valid");
    expect(rf.storagePath).toMatch(new RegExp(`^routes/${trailId}/[0-9a-f]{64}\\.geojson$`));
    expect(rf.isActive).toBe(false);

    const act = await activateRouteFile(admin, up.data!.routeFileId);
    expectOk(act);
    const t = await trailRow(trailId);
    expect(t.geometry?.type).toBe("LineString");
    expect(t.geometry?.coordinates).toHaveLength(coords.length);
    const expected = createHash("sha256").update(JSON.stringify({ type: "LineString", coordinates: coords })).digest("hex");
    expect(t.geometryChecksum).toBe(expected);
    expect(t.geometryValidatedAt).toBeInstanceOf(Date);
    expect(t.geometryValidatedBy).toBe(admin.id);
    const [active] = await sql()<{ isActive: boolean }[]>`select is_active from public.route_files where id = ${up.data!.routeFileId}`;
    expect(active.isActive).toBe(true);
  });

  it("activates a valid GPX track and deactivates the previously active file", async () => {
    const operator = await demoUser("operator");
    const coords = makeRoute(START, 3.1);
    const trailId = await draftTrailFor(operator, coords);
    const first = await uploadRouteFile(operator, trailId, { filename: "first.geojson", bytes: enc(JSON.stringify({ type: "LineString", coordinates: coords })) });
    expectOk(first);
    expectOk(await activateRouteFile(operator, first.data!.routeFileId));

    // GPX of the same line with slightly different elevation -> different file + checksum
    const gpxCoords = coords.map((c) => [c[0], c[1], (c[2] ?? 0) + 1] as [number, number, number]);
    const up = await uploadRouteFile(operator, trailId, { filename: "track.gpx", bytes: enc(gpxDoc(gpxCoords, "trk")) });
    expectOk(up);
    expect(up.data?.status).toBe("valid");
    const act = await activateRouteFile(operator, up.data!.routeFileId);
    expectOk(act);
    const t = await trailRow(trailId);
    expect(t.geometry?.coordinates[0]).toEqual(gpxCoords[0]);
    expect(t.geometryChecksum).toBe(createHash("sha256").update(JSON.stringify({ type: "LineString", coordinates: gpxCoords })).digest("hex"));
    const files = await sql()<{ id: string; isActive: boolean }[]>`select id, is_active from public.route_files where trail_id = ${trailId}`;
    expect(files.filter((f) => f.isActive).map((f) => f.id)).toEqual([up.data!.routeFileId]);
  });

  it("GPX route points (rte) are accepted too", async () => {
    const admin = await demoUser("admin");
    const coords = makeRoute(START, 1.5);
    const trailId = await draftTrailFor(admin, coords);
    const up = await uploadRouteFile(admin, trailId, { filename: "route.gpx", bytes: enc(gpxDoc(coords, "rte")) });
    expectOk(up);
    expect(up.data?.status).toBe("valid");
  });

  it("rejects an invalid file with errors, and it can never be activated", async () => {
    const admin = await demoUser("admin");
    const coords = makeRoute(START, 2.0);
    const trailId = await draftTrailFor(admin, coords);

    // declared distance mismatch (> 10%): upload only half the route
    const half = coords.slice(0, Math.floor(coords.length / 2));
    const up = await uploadRouteFile(admin, trailId, { filename: "half.geojson", bytes: enc(geojsonFeature(half)) });
    expectOk(up);
    expect(up.data?.status).toBe("invalid");
    expect(up.data?.errors.join(" ")).toMatch(/differs from declared/);
    const [rf] = await sql()<{ validationStatus: string; validationErrors: string[] }[]>`
      select validation_status, validation_errors from public.route_files where id = ${up.data!.routeFileId}`;
    expect(rf.validationStatus).toBe("invalid");
    expect(rf.validationErrors.length).toBeGreaterThan(0);

    const act = await activateRouteFile(admin, up.data!.routeFileId);
    expect(act.ok).toBe(false);
    expect((await trailRow(trailId)).geometry).toBeNull();

    // a vertex gap > max
    const gappy = [...coords.slice(0, 5), ...coords.slice(15)];
    const gap = await uploadRouteFile(admin, trailId, { filename: "gap.geojson", bytes: enc(geojsonFeature(gappy)) });
    expectOk(gap);
    expect(gap.data?.status).toBe("invalid");

    // malicious GPX with an entity declaration
    const evil = `<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><gpx><trk><trkseg><trkpt lat="1" lon="1"/><trkpt lat="1.001" lon="1"/></trkseg></trk></gpx>`;
    const bad = await uploadRouteFile(admin, trailId, { filename: "evil.gpx", bytes: enc(evil) });
    expectOk(bad);
    expect(bad.data?.status).toBe("invalid");
    expect((await activateRouteFile(admin, bad.data!.routeFileId)).ok).toBe(false);

    // wrong extension and oversized files are refused outright
    expect((await uploadRouteFile(admin, trailId, { filename: "route.kml", bytes: enc("<kml/>") })).ok).toBe(false);
    expect((await uploadRouteFile(admin, trailId, { filename: "big.geojson", bytes: new Uint8Array(2 * 1024 * 1024 + 1) })).ok).toBe(false);
  });

  it("publishing refuses a trail without validated geometry, then succeeds once ready", async () => {
    const admin = await demoUser("admin");
    const coords = makeRoute(START, 2.2);
    const trailId = await draftTrailFor(admin, coords);
    const r1 = await setTrailStatus(admin, trailId, "published");
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toMatch(/validated route/);
    expect((await trailRow(trailId)).status).toBe("draft");

    const up = await uploadRouteFile(admin, trailId, { filename: "r.geojson", bytes: enc(geojsonFeature(coords)) });
    expectOk(up);
    expectOk(await activateRouteFile(admin, up.data!.routeFileId));
    // still needs a linked source
    const r2 = await setTrailStatus(admin, trailId, "published");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/source/);

    const [src] = await sql()<{ id: string }[]>`select id from public.sources order by created_at limit 1`;
    expectOk(await linkSource(admin, trailId, src.id, true));
    expect((await getPublishReadiness(admin, trailId)).ready).toBe(true);
    expectOk(await setTrailStatus(admin, trailId, "published"));
    const t = await trailRow(trailId);
    expect(t.status).toBe("published");
    const [demo] = await sql()<{ isDemo: boolean }[]>`select is_demo from public.trails where id = ${trailId}`;
    expect(demo.isDemo).toBe(true);
  });
});
