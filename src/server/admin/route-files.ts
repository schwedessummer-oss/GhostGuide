import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import { projectOntoLine, validateLineString, type LineStringGeometry } from "@/domain/geo";
import { storage } from "@/integrations/storage";
import type { JsonValue } from "@/server/db";
import { assertCan, auditInStaffTx, fail, guarded, isUuid, ok, staffTx, type ActionResult } from "./common";
import { MAX_ROUTE_FILE_BYTES } from "./gpx";
import { detectRouteFormat, parseRouteFile, type RouteFormat } from "./route-parse";

/**
 * Route files: upload (store raw bytes + validation result), then explicitly
 * ACTIVATE a valid file to make it the trail's geometry. Invalid files can
 * never be activated; activation re-reads and re-validates the stored bytes.
 */
export const ROUTE_DISTANCE_TOLERANCE = 0.1;
export const ROUTE_MAX_VERTEX_GAP_M = 500;
export const POI_OFF_ROUTE_WARN_M = 75;

export interface RouteFileRow {
  id: string;
  trailId: string;
  storagePath: string;
  format: RouteFormat;
  checksum: string;
  validationStatus: "pending" | "valid" | "invalid";
  validationErrors: string[];
  isActive: boolean;
  uploadedBy: string | null;
  uploaderEmail: string | null;
  uploadedAt: Date;
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** Checksum of a geometry as stored on trails.geometry_checksum. */
export function geometryChecksum(geometry: LineStringGeometry): string {
  return sha256(JSON.stringify({ type: "LineString", coordinates: geometry.coordinates }));
}

export function validateRouteGeometry(bytes: Uint8Array, format: RouteFormat, declaredDistanceKm: number) {
  const parsed = parseRouteFile(bytes, format);
  if (!parsed.ok) return { valid: false as const, errors: parsed.errors, warnings: [] as string[], geometry: null, lengthM: 0 };
  const v = validateLineString(parsed.geometry, {
    declaredDistanceKm,
    maxVertexGapM: ROUTE_MAX_VERTEX_GAP_M,
    distanceTolerance: ROUTE_DISTANCE_TOLERANCE,
  });
  const geometry: LineStringGeometry = { type: "LineString", coordinates: parsed.geometry.coordinates };
  return {
    valid: v.valid,
    errors: v.errors,
    warnings: [...parsed.notes, ...v.warnings],
    geometry: v.valid ? geometry : null,
    lengthM: v.lengthM,
  };
}

const uploadSchema = z.object({
  filename: z.string().trim().min(1, "Choose a file.").max(200),
  size: z.number().int().min(1, "The file is empty.").max(MAX_ROUTE_FILE_BYTES, "The file is larger than 2 MB."),
});

export async function uploadRouteFile(
  user: SessionUser,
  trailId: string,
  file: { filename: string; bytes: Uint8Array },
): Promise<ActionResult<{ routeFileId: string; status: "valid" | "invalid"; errors: string[] }>> {
  assertCan(user, "trails.manage");
  if (!isUuid(trailId)) return fail("Trail not found.");
  const meta = uploadSchema.safeParse({ filename: file.filename, size: file.bytes.byteLength });
  if (!meta.success) return fail(meta.error.issues[0].message);
  const format = detectRouteFormat(meta.data.filename);
  if (!format) return fail("Upload a .geojson, .json or .gpx file.");

  return guarded(async () => {
    const [trail] = await staffTx(user, (tx) => tx<{ id: string; distanceKm: number }[]>`select id, distance_km from public.trails where id = ${trailId}`);
    if (!trail) return fail("Trail not found.");
    const checksum = sha256(file.bytes);
    const result = validateRouteGeometry(file.bytes, format, trail.distanceKm);
    const storagePath = `routes/${trail.id}/${checksum}.${format === "gpx" ? "gpx" : "geojson"}`;
    await storage().put(storagePath, file.bytes, format === "gpx" ? "application/gpx+xml" : "application/geo+json");

    return staffTx(user, async (tx) => {
      const [existing] = await tx<{ id: string; validationStatus: "valid" | "invalid"; validationErrors: string[] }[]>`
        select id, validation_status, validation_errors from public.route_files where trail_id = ${trail.id} and checksum = ${checksum}
        order by uploaded_at desc limit 1`;
      if (existing) {
        return ok(`This exact file was already uploaded (${existing.validationStatus}).`, {
          data: { routeFileId: existing.id, status: existing.validationStatus, errors: existing.validationErrors },
        });
      }
      const status = result.valid ? "valid" : "invalid";
      const [row] = await tx<{ id: string }[]>`
        insert into public.route_files (trail_id, storage_path, format, checksum, validation_status, validation_errors, uploaded_by)
        values (${trail.id}, ${storagePath}, ${format}, ${checksum}, ${status}, ${tx.json(result.errors)}, ${user.id})
        returning id`;
      await auditInStaffTx(tx, user, "route_file.uploaded", "trail", trail.id, { routeFileId: row.id, format, checksum, status, errorCount: result.errors.length });
      const lengthKm = (result.lengthM / 1000).toFixed(2);
      return result.valid
        ? ok(`Valid route (${lengthKm} km). Review it, then activate it to use it as the trail geometry.`, {
            warnings: result.warnings,
            data: { routeFileId: row.id, status, errors: [] },
          })
        : ok(`Uploaded, but the route is INVALID and cannot be activated: ${result.errors.join(" ")}`, {
            warnings: result.warnings,
            data: { routeFileId: row.id, status, errors: result.errors },
          });
    });
  }, "admin.route_upload");
}

export async function listRouteFiles(user: SessionUser, trailId: string): Promise<RouteFileRow[]> {
  assertCan(user, "trails.manage");
  if (!isUuid(trailId)) return [];
  return staffTx(user, (tx) => tx<RouteFileRow[]>`
    select rf.id, rf.trail_id, rf.storage_path, rf.format, rf.checksum, rf.validation_status, rf.validation_errors, rf.is_active,
           rf.uploaded_by, p.email as uploader_email, rf.uploaded_at
    from public.route_files rf left join public.profiles p on p.id = rf.uploaded_by
    where rf.trail_id = ${trailId} order by rf.uploaded_at desc`);
}

export async function activateRouteFile(user: SessionUser, routeFileId: string): Promise<ActionResult<{ checksum: string }>> {
  assertCan(user, "trails.manage");
  if (!isUuid(routeFileId)) return fail("Route file not found.");
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [rf] = await tx<{ id: string; trailId: string; storagePath: string; format: RouteFormat; checksum: string; validationStatus: string }[]>`
        select id, trail_id, storage_path, format, checksum, validation_status from public.route_files where id = ${routeFileId}`;
      if (!rf) return fail("Route file not found.");
      if (rf.validationStatus !== "valid") return fail("Invalid route files can never be activated. Upload a corrected file.");
      const [trail] = await tx<{ id: string; distanceKm: number }[]>`select id, distance_km from public.trails where id = ${rf.trailId} for update`;
      if (!trail) return fail("Trail not found.");

      const stored = await storage().get(rf.storagePath);
      if (!stored) return fail("The stored route file is missing. Upload it again.");
      if (sha256(stored.data) !== rf.checksum) return fail("The stored route file does not match its checksum. Upload it again.");
      const v = validateRouteGeometry(stored.data, rf.format, trail.distanceKm);
      if (!v.valid || !v.geometry) {
        await tx`update public.route_files set validation_status = 'invalid', validation_errors = ${tx.json(v.errors)} where id = ${rf.id}`;
        await auditInStaffTx(tx, user, "route_file.revalidation_failed", "trail", trail.id, { routeFileId: rf.id });
        return fail(`The file no longer validates against this trail and was marked invalid: ${v.errors.join(" ")}`);
      }
      const checksum = geometryChecksum(v.geometry);
      await tx`
        update public.trails set geometry = ${tx.json(v.geometry as unknown as JsonValue)}, geometry_checksum = ${checksum},
          geometry_validated_at = now(), geometry_validated_by = ${user.id}
        where id = ${trail.id}`;
      await tx`update public.route_files set is_active = (id = ${rf.id}) where trail_id = ${trail.id}`;
      await auditInStaffTx(tx, user, "route_file.activated", "trail", trail.id, { routeFileId: rf.id, geometryChecksum: checksum, lengthM: Math.round(v.lengthM) });

      const pois = await tx<{ name: string; lat: number; lng: number }[]>`select name, lat, lng from public.trail_pois where trail_id = ${trail.id}`;
      const warnings = pois
        .map((p) => ({ name: p.name, d: projectOntoLine({ lat: p.lat, lng: p.lng }, v.geometry!.coordinates).distanceFromRouteM }))
        .filter((p) => p.d > POI_OFF_ROUTE_WARN_M)
        .map((p) => `POI "${p.name}" is ${Math.round(p.d)} m from the new route.`);
      return ok(`Route activated (${(v.lengthM / 1000).toFixed(2)} km). Geometry, checksum and validation stamp updated.`, {
        warnings: [...v.warnings, ...warnings],
        data: { checksum },
      });
    }),
  );
}
