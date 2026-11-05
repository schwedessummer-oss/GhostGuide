import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, Card } from "@/components/ui";
import { RouteView } from "@/components/map/route-view";
import { Section, StatusBadge } from "@/components/admin/admin-ui";
import { ActionForm } from "@/components/admin/action-form";
import { CheckField, SelectField, TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { getAdminTrail } from "@/server/admin/trails";
import { listPois, POI_KINDS, type PoiRow } from "@/server/admin/pois";
import { POI_OFF_ROUTE_WARN_M } from "@/server/admin/route-files";
import { createPoiAction, deletePoiAction, updatePoiAction } from "../../actions";

export const metadata: Metadata = { title: "Trail POIs" };

function PoiFields({ idPrefix, p, defaults }: { idPrefix: string; p?: PoiRow; defaults?: { lat: number; lng: number } }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <TextField id={`${idPrefix}-name`} name="name" label="Name" required minLength={2} maxLength={120} defaultValue={p?.name ?? ""} className="sm:col-span-2" />
      <SelectField id={`${idPrefix}-kind`} name="kind" label="Kind" options={POI_KINDS} defaultValue={p?.kind ?? "viewpoint"} />
      <TextField id={`${idPrefix}-lat`} name="lat" label="Latitude" type="number" step="any" min="-90" max="90" required defaultValue={p?.lat ?? defaults?.lat} />
      <TextField id={`${idPrefix}-lng`} name="lng" label="Longitude" type="number" step="any" min="-180" max="180" required defaultValue={p?.lng ?? defaults?.lng} />
      <TextField id={`${idPrefix}-radius`} name="triggerRadiusM" label="Trigger radius (m)" type="number" min="10" max="500" step="1" required defaultValue={p?.triggerRadiusM ?? 40} hint="10–500 m" />
      <TextField id={`${idPrefix}-seq`} name="seq" label="Order" type="number" min="1" max="999" defaultValue={p?.seq ?? ""} hint={p ? undefined : "Leave empty to add at the end."} />
    </div>
  );
}

export default async function TrailPoisPage({ params }: PageProps<"/admin/trails/[id]/pois">) {
  const { id } = await params;
  const user = await requirePermission("trails.manage", `/admin/trails/${id}/pois`);
  const trail = await getAdminTrail(user, id);
  if (!trail) notFound();
  const pois = await listPois(user, trail.id);
  const offRoute = pois.filter((p) => p.distanceFromRouteM !== null && p.distanceFromRouteM > POI_OFF_ROUTE_WARN_M);

  return (
    <>
      {trail.geometry ? (
        <Card className="mb-6">
          <RouteView
            coordinates={trail.geometry.coordinates}
            pois={pois.map((p) => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng, triggerRadiusM: p.triggerRadiusM }))}
            label={`${trail.name}: route with ${pois.length} points of interest and their trigger radii`}
            height={300}
          />
        </Card>
      ) : (
        <Alert tone="amber" className="mb-6">
          No validated route yet, so POI positions cannot be checked against it.
        </Alert>
      )}
      {offRoute.length ? (
        <Alert tone="amber" title={`${offRoute.length} POI(s) are more than ${POI_OFF_ROUTE_WARN_M} m from the route`} className="mb-6">
          Hikers may never trigger them: {offRoute.map((p) => `${p.name} (${Math.round(p.distanceFromRouteM!)} m)`).join(", ")}.
        </Alert>
      ) : null}

      <Section id="list" title="Points of interest" description="Narration is triggered when a hiker comes within the trigger radius (when location is available — not guaranteed in the background).">
        {pois.length ? (
          <ul className="space-y-3">
            {pois.map((p) => {
              const far = p.distanceFromRouteM !== null && p.distanceFromRouteM > POI_OFF_ROUTE_WARN_M;
              return (
                <li key={p.id}>
                  <details className="rounded-xl border border-sand-200 bg-surface">
                    <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center gap-2 p-4 [&::-webkit-details-marker]:hidden">
                      <span className="font-semibold">
                        {p.seq}. {p.name}
                      </span>
                      <StatusBadge status="neutral" label={p.kind} />
                      <span className="text-sm text-muted">radius {p.triggerRadiusM} m</span>
                      <span className={far ? "text-sm font-semibold text-amber-ink" : "text-sm text-muted"}>
                        {p.distanceFromRouteM === null ? "route unknown" : `${Math.round(p.distanceFromRouteM)} m from route${far ? " — check position" : ""}`}
                      </span>
                      <span className="text-sm text-muted">{p.narrationCount} approved narration(s)</span>
                    </summary>
                    <div className="space-y-4 border-t border-sand-200 p-4">
                      <ActionForm action={updatePoiAction.bind(null, trail.id, p.id)} submitLabel="Save POI">
                        <PoiFields idPrefix={`poi-${p.id}`} p={p} />
                      </ActionForm>
                      <ActionForm action={deletePoiAction.bind(null, trail.id, p.id)} submitLabel="Delete POI" variant="danger" compact>
                        <CheckField id={`poi-${p.id}-del`} name="confirm" required label="Delete this POI. Its narration stays but is no longer location-triggered." />
                      </ActionForm>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-muted">No POIs yet.</p>
        )}
      </Section>

      <Section id="new" title="Add a POI">
        <Card>
          <ActionForm action={createPoiAction.bind(null, trail.id)} submitLabel="Add POI">
            <PoiFields idPrefix="poi-new" defaults={{ lat: trail.trailheadLat, lng: trail.trailheadLng }} />
          </ActionForm>
        </Card>
      </Section>
    </>
  );
}
