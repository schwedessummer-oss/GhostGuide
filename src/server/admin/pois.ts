import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import type { Poi } from "@/domain/types";
import { projectOntoLine, type LineStringGeometry } from "@/domain/geo";
import type { Tx } from "@/server/db";
import { assertCan, auditInStaffTx, fail, guarded, isUuid, ok, requiredText, staffTx, zodFail, type ActionResult } from "./common";
import { POI_OFF_ROUTE_WARN_M } from "./route-files";

export const POI_KINDS = ["history", "ecology", "safety", "viewpoint", "water", "junction", "trailhead"] as const;

export interface PoiRow extends Poi {
  /** distance from the active route geometry (m), null when the trail has no geometry */
  distanceFromRouteM: number | null;
  narrationCount: number;
}

function distanceFrom(geometry: LineStringGeometry | null, lat: number, lng: number): number | null {
  if (!geometry || geometry.coordinates.length < 2) return null;
  return projectOntoLine({ lat, lng }, geometry.coordinates).distanceFromRouteM;
}

async function trailGeometry(tx: Tx, trailId: string): Promise<{ exists: boolean; geometry: LineStringGeometry | null }> {
  const [t] = await tx<{ geometry: LineStringGeometry | null }[]>`select geometry from public.trails where id = ${trailId}`;
  return { exists: !!t, geometry: t?.geometry ?? null };
}

export async function listPois(user: SessionUser, trailId: string): Promise<PoiRow[]> {
  assertCan(user, "trails.manage");
  if (!isUuid(trailId)) return [];
  return staffTx(user, async (tx) => {
    const { geometry } = await trailGeometry(tx, trailId);
    const rows = await tx<(Poi & { narrationCount: number })[]>`
      select p.id, p.trail_id, p.seq, p.name, p.kind, p.lat, p.lng, p.trigger_radius_m,
             (select count(*)::int from public.narrations n where n.poi_id = p.id and n.status = 'approved') as narration_count
      from public.trail_pois p where p.trail_id = ${trailId} order by p.seq`;
    return rows.map((r) => ({ ...r, distanceFromRouteM: distanceFrom(geometry, r.lat, r.lng) }));
  });
}

const poiSchema = z.object({
  name: requiredText(2, 120, "Name"),
  kind: z.enum(POI_KINDS),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  triggerRadiusM: z.coerce.number().int("Use whole metres").min(10, "Trigger radius must be 10–500 m").max(500, "Trigger radius must be 10–500 m"),
  seq: z.union([z.coerce.number().int().min(1).max(999), z.literal("")]).optional(),
});
export type PoiInput = z.input<typeof poiSchema>;

function offRouteWarnings(d: number | null): string[] {
  if (d === null) return ["The trail has no validated route yet, so the POI position could not be checked."];
  if (d > POI_OFF_ROUTE_WARN_M) return [`This POI is ${Math.round(d)} m from the route (more than ${POI_OFF_ROUTE_WARN_M} m). Hikers may never trigger it; check the coordinates.`];
  return [];
}

export async function createPoi(user: SessionUser, trailId: string, input: PoiInput): Promise<ActionResult<{ id: string }>> {
  assertCan(user, "trails.manage");
  if (!isUuid(trailId)) return fail("Trail not found.");
  const p = poiSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const d = p.data;
  return guarded(() =>
    staffTx(user, async (tx) => {
      const g = await trailGeometry(tx, trailId);
      if (!g.exists) return fail("Trail not found.");
      const [{ next }] = await tx<{ next: number }[]>`select coalesce(max(seq), 0) + 1 as next from public.trail_pois where trail_id = ${trailId}`;
      const seq = typeof d.seq === "number" ? d.seq : next;
      const [row] = await tx<{ id: string }[]>`
        insert into public.trail_pois (trail_id, seq, name, kind, lat, lng, trigger_radius_m)
        values (${trailId}, ${seq}, ${d.name}, ${d.kind}, ${d.lat}, ${d.lng}, ${d.triggerRadiusM}) returning id`;
      await auditInStaffTx(tx, user, "poi.created", "trail", trailId, { poiId: row.id, name: d.name, kind: d.kind, seq });
      const dist = distanceFrom(g.geometry, d.lat, d.lng);
      return ok(`POI "${d.name}" added.`, { warnings: offRouteWarnings(dist), data: { id: row.id } });
    }),
  );
}

export async function updatePoi(user: SessionUser, poiId: string, input: PoiInput): Promise<ActionResult> {
  assertCan(user, "trails.manage");
  if (!isUuid(poiId)) return fail("POI not found.");
  const p = poiSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const d = p.data;
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [cur] = await tx<{ trailId: string; seq: number }[]>`select trail_id, seq from public.trail_pois where id = ${poiId} for update`;
      if (!cur) return fail("POI not found.");
      const seq = typeof d.seq === "number" ? d.seq : cur.seq;
      await tx`
        update public.trail_pois set name = ${d.name}, kind = ${d.kind}, lat = ${d.lat}, lng = ${d.lng},
          trigger_radius_m = ${d.triggerRadiusM}, seq = ${seq}
        where id = ${poiId}`;
      await auditInStaffTx(tx, user, "poi.updated", "trail", cur.trailId, { poiId, name: d.name, kind: d.kind, seq });
      const g = await trailGeometry(tx, cur.trailId);
      return ok(`POI "${d.name}" saved.`, { warnings: offRouteWarnings(distanceFrom(g.geometry, d.lat, d.lng)) });
    }),
  );
}

export async function deletePoi(user: SessionUser, poiId: string): Promise<ActionResult> {
  assertCan(user, "trails.manage");
  if (!isUuid(poiId)) return fail("POI not found.");
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [p] = await tx<{ trailId: string; name: string }[]>`delete from public.trail_pois where id = ${poiId} returning trail_id, name`;
      if (!p) return fail("POI not found.");
      await auditInStaffTx(tx, user, "poi.deleted", "trail", p.trailId, { poiId, name: p.name });
      return ok(`POI "${p.name}" deleted. Its narration (if any) is no longer location-triggered.`);
    }),
  );
}
