"use server";

import { redirect } from "next/navigation";
import type { FormState } from "@/server/admin/common";
import { createTrail, setTrailStatus, updateTrailBasics, updateTrailFact } from "@/server/admin/trails";
import { activateRouteFile } from "@/server/admin/route-files";
import { createSource, deleteSource, linkSource, updateSource } from "@/server/admin/sources";
import { createClosure, deleteClosure, endClosure, updateClosure } from "@/server/admin/closures";
import { createPoi, deletePoi, updatePoi } from "@/server/admin/pois";
import { createPermitRequirement, deletePermitRequirement, updatePermitRequirement } from "@/server/admin/permits";
import { checked, runAction, str, strs } from "../_lib/action";

const P = "/admin/trails";

export async function createTrailAction(_prev: FormState<{ id: string }>, fd: FormData): Promise<FormState<{ id: string }>> {
  const r = await runAction("trails.manage", `${P}/new`, (user) =>
    createTrail(user, {
      name: str(fd, "name"),
      summary: str(fd, "summary"),
      description: str(fd, "description"),
      distanceKm: str(fd, "distanceKm"),
      elevationGainM: str(fd, "elevationGainM"),
      difficulty: str(fd, "difficulty") as never,
      routeType: str(fd, "routeType") as never,
      estimatedDurationMin: str(fd, "estimatedDurationMin"),
      trailheadName: str(fd, "trailheadName"),
      trailheadLat: str(fd, "trailheadLat"),
      trailheadLng: str(fd, "trailheadLng"),
      basePriceCents: String(Math.round(Number(str(fd, "basePrice") || "NaN") * 100)),
      dailyCapacity: str(fd, "dailyCapacity"),
      isDemo: checked(fd, "isDemo"),
    }),
  );
  if (r.ok && r.data) redirect(`${P}/${r.data.id}`);
  return r;
}

export async function updateBasicsAction(trailId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("trails.manage", `${P}/${trailId}`, (user) =>
    updateTrailBasics(user, trailId, {
      name: str(fd, "name"),
      summary: str(fd, "summary"),
      description: str(fd, "description"),
      trailheadName: str(fd, "trailheadName"),
      dailyCapacity: str(fd, "dailyCapacity"),
    }),
  );
}

export async function updateFactAction(trailId: string, field: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("trails.manage", `${P}/${trailId}`, (user) =>
    updateTrailFact(user, trailId, {
      field,
      value: str(fd, "value"),
      values: strs(fd, "values"),
      lat: str(fd, "lat"),
      lng: str(fd, "lng"),
      kind: str(fd, "kind"),
      sourceId: str(fd, "sourceId"),
      verifiedAt: str(fd, "verifiedAt"),
      note: str(fd, "note"),
    }),
  );
}

export async function setTrailStatusAction(trailId: string, target: "published" | "draft" | "archived", _prev: FormState, fd: FormData): Promise<FormState> {
  if (target !== "published" && fd.get("confirm") !== "on") return { ok: false, error: "Tick the confirmation box first." };
  return runAction("trails.manage", `${P}/${trailId}`, (user) => setTrailStatus(user, trailId, target));
}

export async function activateRouteAction(trailId: string, routeFileId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  void fd;
  return runAction("trails.manage", `${P}/${trailId}/geometry`, (user) => activateRouteFile(user, routeFileId));
}

function sourceInput(fd: FormData) {
  return {
    label: str(fd, "label"),
    url: str(fd, "url"),
    publisher: str(fd, "publisher"),
    sourceType: str(fd, "sourceType") as never,
    retrievedAt: str(fd, "retrievedAt"),
    notes: str(fd, "notes"),
  };
}

export async function createSourceAction(trailId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("trails.manage", `${P}/${trailId}/sources`, (user) => createSource(user, sourceInput(fd), trailId));
}

export async function updateSourceAction(trailId: string, sourceId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("trails.manage", `${P}/${trailId}/sources`, (user) => updateSource(user, sourceId, sourceInput(fd)));
}

export async function deleteSourceAction(trailId: string, sourceId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  if (fd.get("confirm") !== "on") return { ok: false, error: "Tick the confirmation box to delete this source." };
  return runAction("trails.manage", `${P}/${trailId}/sources`, (user) => deleteSource(user, sourceId));
}

export async function linkSourceAction(trailId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("trails.manage", `${P}/${trailId}/sources`, (user) => linkSource(user, trailId, str(fd, "sourceId"), true));
}

export async function unlinkSourceAction(trailId: string, sourceId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  void fd;
  return runAction("trails.manage", `${P}/${trailId}/sources`, (user) => linkSource(user, trailId, sourceId, false));
}

function closureInput(fd: FormData) {
  return { severity: str(fd, "severity") as never, reason: str(fd, "reason"), sourceId: str(fd, "sourceId"), startsAt: str(fd, "startsAt"), endsAt: str(fd, "endsAt") };
}

export async function createClosureAction(trailId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("closures.manage", `${P}/${trailId}/closures`, (user) => createClosure(user, trailId, closureInput(fd)));
}

export async function updateClosureAction(trailId: string, closureId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("closures.manage", `${P}/${trailId}/closures`, (user) => updateClosure(user, closureId, closureInput(fd)));
}

export async function endClosureAction(trailId: string, closureId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  void fd;
  return runAction("closures.manage", `${P}/${trailId}/closures`, (user) => endClosure(user, closureId));
}

export async function deleteClosureAction(trailId: string, closureId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  if (fd.get("confirm") !== "on") return { ok: false, error: "Tick the confirmation box to delete this closure." };
  return runAction("closures.manage", `${P}/${trailId}/closures`, (user) => deleteClosure(user, closureId));
}

function poiInput(fd: FormData) {
  return { name: str(fd, "name"), kind: str(fd, "kind") as never, lat: str(fd, "lat"), lng: str(fd, "lng"), triggerRadiusM: str(fd, "triggerRadiusM"), seq: str(fd, "seq") };
}

export async function createPoiAction(trailId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("trails.manage", `${P}/${trailId}/pois`, (user) => createPoi(user, trailId, poiInput(fd)));
}

export async function updatePoiAction(trailId: string, poiId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("trails.manage", `${P}/${trailId}/pois`, (user) => updatePoi(user, poiId, poiInput(fd)));
}

export async function deletePoiAction(trailId: string, poiId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  if (fd.get("confirm") !== "on") return { ok: false, error: "Tick the confirmation box to delete this POI." };
  return runAction("trails.manage", `${P}/${trailId}/pois`, (user) => deletePoi(user, poiId));
}

function permitInput(fd: FormData) {
  return {
    name: str(fd, "name"),
    authority: str(fd, "authority"),
    officialUrl: str(fd, "officialUrl"),
    requirementSummary: str(fd, "requirementSummary"),
    howToObtain: str(fd, "howToObtain"),
    leadTimeDays: str(fd, "leadTimeDays"),
    sourceId: str(fd, "sourceId"),
    verifiedAt: str(fd, "verifiedAt"),
  };
}

export async function createPermitRequirementAction(trailId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("permits.manage", `${P}/${trailId}/permits`, (user) => createPermitRequirement(user, trailId, permitInput(fd)));
}

export async function updatePermitRequirementAction(trailId: string, requirementId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("permits.manage", `${P}/${trailId}/permits`, (user) => updatePermitRequirement(user, requirementId, permitInput(fd)));
}

export async function deletePermitRequirementAction(trailId: string, requirementId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  if (fd.get("confirm") !== "on") return { ok: false, error: "Tick the confirmation box to delete this requirement." };
  return runAction("permits.manage", `${P}/${trailId}/permits`, (user) => deletePermitRequirement(user, requirementId));
}
