import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, Card } from "@/components/ui";
import { RouteView } from "@/components/map/route-view";
import { Section, StatusBadge, When } from "@/components/admin/admin-ui";
import { DataTable } from "@/components/admin/data-table";
import { ActionForm } from "@/components/admin/action-form";
import { RouteUploadForm } from "@/components/admin/route-upload-form";
import { requirePermission } from "@/server/auth";
import { getAdminTrail } from "@/server/admin/trails";
import { listRouteFiles, ROUTE_DISTANCE_TOLERANCE, ROUTE_MAX_VERTEX_GAP_M, type RouteFileRow } from "@/server/admin/route-files";
import { listPois } from "@/server/admin/pois";
import { lineLengthM } from "@/domain/geo";
import { sp } from "@/server/admin/common";
import { activateRouteAction } from "../../actions";

export const metadata: Metadata = { title: "Route geometry" };

const UPLOAD_ERRORS: Record<string, string> = {
  too_large: "The file is larger than 2 MB.",
  no_file: "Choose a .geojson or .gpx file.",
  unreadable: "The upload could not be read.",
  invalid_request: "The upload was refused. Check the file type and try again.",
};

export default async function TrailGeometryPage({ params, searchParams }: PageProps<"/admin/trails/[id]/geometry">) {
  const { id } = await params;
  const q = await searchParams;
  const user = await requirePermission("trails.manage", `/admin/trails/${id}/geometry`);
  const trail = await getAdminTrail(user, id);
  if (!trail) notFound();
  const [files, pois] = await Promise.all([listRouteFiles(user, trail.id), listPois(user, trail.id)]);
  const upload = sp(q.upload);
  const lengthKm = trail.geometry ? lineLengthM(trail.geometry.coordinates) / 1000 : null;

  return (
    <>
      {upload === "error" ? <Alert tone="red" live="polite" title={UPLOAD_ERRORS[sp(q.reason) ?? ""] ?? "Upload failed."} className="mb-4" /> : null}
      {upload === "valid" || upload === "invalid" ? (
        <Alert tone={upload === "valid" ? "forest" : "red"} live="polite" className="mb-4" title={upload === "valid" ? "Uploaded: the route is valid. Activate it below." : "Uploaded, but the route is invalid. See the errors below."} />
      ) : null}

      <Section id="current" title="Active geometry" description="The geometry customers' maps, downloads and GPS triggers use. Changing it updates the checksum that trip downloads verify.">
        {trail.geometry ? (
          <Card>
            <RouteView
              coordinates={trail.geometry.coordinates}
              pois={pois.map((p) => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng, triggerRadiusM: p.triggerRadiusM }))}
              label={`Route of ${trail.name} with ${pois.length} points of interest`}
              height={320}
            />
            <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="font-semibold">Length</dt>
                <dd>
                  {lengthKm?.toFixed(2)} km (declared {trail.distanceKm} km)
                </dd>
              </div>
              <div>
                <dt className="font-semibold">Validated</dt>
                <dd>
                  <When at={trail.geometryValidatedAt} />
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="font-semibold">Checksum (SHA-256)</dt>
                <dd className="truncate font-mono text-xs" title={trail.geometryChecksum ?? ""}>
                  {trail.geometryChecksum ?? "—"}
                </dd>
              </div>
            </dl>
            {trail.isDemo ? <p className="mt-2 text-sm text-amber-ink">Synthetic demonstration geometry — not for navigation.</p> : null}
          </Card>
        ) : (
          <Alert tone="amber" title="No active route">
            Upload a route file and activate it. The trail cannot be published without a validated route.
          </Alert>
        )}
      </Section>

      <Section
        id="upload"
        title="Upload a route file"
        description={`Checked against the declared distance (±${Math.round(ROUTE_DISTANCE_TOLERANCE * 100)}%), coordinate ranges and a maximum gap of ${ROUTE_MAX_VERTEX_GAP_M} m between points. Uploading never changes the live route; activation does.`}
      >
        <Card>
          <RouteUploadForm trailId={trail.id} />
        </Card>
      </Section>

      <Section id="files" title="Uploaded files" description="Only valid files can be activated. Invalid files are kept for the record.">
        <DataTable<RouteFileRow>
          caption="Route files, newest first"
          captionHidden
          rows={files}
          rowKey={(f) => f.id}
          empty="No route files uploaded yet."
          columns={[
            {
              header: "File",
              cell: (f) => (
                <span>
                  <span className="font-semibold uppercase">{f.format}</span> <span className="font-mono text-xs">{f.checksum.slice(0, 12)}…</span>
                  {f.isActive ? (
                    <span className="ml-2">
                      <StatusBadge status="active" label="Active" />
                    </span>
                  ) : null}
                </span>
              ),
            },
            { header: "Validation", cell: (f) => <StatusBadge status={f.validationStatus} /> },
            {
              header: "Errors",
              cell: (f) =>
                f.validationErrors.length ? (
                  <ul className="list-disc pl-4 text-red-ink">
                    {f.validationErrors.slice(0, 5).map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                    {f.validationErrors.length > 5 ? <li>…and {f.validationErrors.length - 5} more</li> : null}
                  </ul>
                ) : (
                  "—"
                ),
            },
            { header: "Uploaded", cell: (f) => <span>{f.uploaderEmail ?? "Staff"} · <When at={f.uploadedAt} /></span> },
            {
              header: "Action",
              hideLabelOnMobile: true,
              cell: (f) =>
                f.validationStatus === "valid" && !f.isActive ? (
                  <ActionForm action={activateRouteAction.bind(null, trail.id, f.id)} submitLabel="Activate" pendingLabel="Activating…" compact />
                ) : f.isActive ? (
                  <span className="text-sm text-muted">In use</span>
                ) : (
                  <span className="text-sm text-muted">Cannot be activated</span>
                ),
            },
          ]}
        />
      </Section>
    </>
  );
}
