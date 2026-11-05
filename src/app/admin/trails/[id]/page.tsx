import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Alert, Badge, Card } from "@/components/ui";
import { Section, When } from "@/components/admin/admin-ui";
import { ActionForm } from "@/components/admin/action-form";
import { CheckField, CheckGroup, SelectField, TextAreaField, TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { getAdminTrail, getPublishReadiness, getTrailFactsView, type AdminTrail } from "@/server/admin/trails";
import { FACT_FIELDS, FACT_FIELD_KEYS, FACT_KINDS, type FactField, type FactFieldDef } from "@/server/admin/trail-fields";
import { formatDate } from "@/lib/format";
import { setTrailStatusAction, updateBasicsAction, updateFactAction } from "../actions";

export const metadata: Metadata = { title: "Trail facts" };

const KIND_LABEL: Record<string, string> = { verified: "Verified", estimate: "Estimate", operator_note: "Operator note", demo: "Demo data" };
const KIND_TONE: Record<string, "forest" | "blue" | "neutral" | "amber"> = { verified: "forest", estimate: "blue", operator_note: "neutral", demo: "amber" };

function currentValue(field: FactField, t: AdminTrail): string {
  switch (field) {
    case "distance_km":
      return `${t.distanceKm} km`;
    case "elevation_gain_m":
      return `${t.elevationGainM} m`;
    case "max_elevation_m":
      return t.maxElevationM === null ? "Unknown" : `${t.maxElevationM} m`;
    case "difficulty":
      return t.difficulty;
    case "route_type":
      return t.routeType.replace(/_/g, " ");
    case "terrain":
      return t.terrain.join(", ") || "None recorded";
    case "estimated_duration_min":
      return `${t.estimatedDurationMin} min`;
    case "accessibility_features":
      return t.accessibilityFeatures.map((a) => a.replace(/_/g, " ")).join(", ") || "None recorded";
    case "dogs_allowed":
      return t.dogsAllowed === null ? "Unknown" : t.dogsAllowed ? "Yes" : "No";
    case "permit_required":
      return t.permitRequired ? "Yes" : "No";
    case "trailhead_location":
      return `${t.trailheadLat.toFixed(5)}, ${t.trailheadLng.toFixed(5)}`;
    case "parking_info":
      return t.parkingInfo ?? "—";
  }
}

function ValueInput({ field, t }: { field: FactField; t: AdminTrail }): ReactNode {
  const def = FACT_FIELDS[field] as FactFieldDef;
  const id = `fact-${field}-value`;
  switch (def.type) {
    case "number":
      return <TextField id={id} name="value" label={def.label} type="number" step="0.01" min="0.01" required defaultValue={t.distanceKm} hint={def.hint} />;
    case "int": {
      const v = field === "elevation_gain_m" ? t.elevationGainM : field === "max_elevation_m" ? (t.maxElevationM ?? "") : t.estimatedDurationMin;
      return <TextField id={id} name="value" label={def.label} type="number" step="1" required={field !== "max_elevation_m"} defaultValue={v} hint={def.hint} />;
    }
    case "enum":
      return <SelectField id={id} name="value" label={def.label} options={def.options ?? []} defaultValue={field === "difficulty" ? t.difficulty : t.routeType} />;
    case "multi":
      return <CheckGroup idPrefix={id} legend={def.label} name="values" options={def.options ?? []} selected={field === "terrain" ? t.terrain : t.accessibilityFeatures} />;
    case "tristate":
      return (
        <SelectField
          id={id}
          name="value"
          label={def.label}
          options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }, { value: "unknown", label: "Unknown" }]}
          defaultValue={t.dogsAllowed === null ? "unknown" : t.dogsAllowed ? "yes" : "no"}
        />
      );
    case "boolean":
      return <SelectField id={id} name="value" label={def.label} options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]} defaultValue={t.permitRequired ? "yes" : "no"} />;
    case "text":
      return <TextAreaField id={id} name="value" label={def.label} maxLength={1000} defaultValue={t.parkingInfo ?? ""} />;
    case "location":
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField id={`${id}-lat`} name="lat" label="Latitude" type="number" step="any" min="-90" max="90" required defaultValue={t.trailheadLat} />
          <TextField id={`${id}-lng`} name="lng" label="Longitude" type="number" step="any" min="-180" max="180" required defaultValue={t.trailheadLng} />
        </div>
      );
  }
}

export default async function TrailFactsPage({ params }: PageProps<"/admin/trails/[id]">) {
  const { id } = await params;
  const user = await requirePermission("trails.manage", `/admin/trails/${id}`);
  const trail = await getAdminTrail(user, id);
  if (!trail) notFound();
  const [facts, readiness] = await Promise.all([getTrailFactsView(user, trail.id), getPublishReadiness(user, trail.id)]);
  const sourceOptions = facts.allSources.map((s) => ({ value: s.id, label: s.label }));
  const closedNow = facts.activeClosures.some((c) => c.severity === "closed");

  return (
    <>
      <Section id="publishing" title="Publishing" description="Publishing makes the trail visible and bookable. It requires a validated route and at least one linked source.">
        <Card>
          {trail.status === "published" ? (
            <div className="space-y-3">
              <p>
                <strong>Published.</strong> {closedNow ? "A full closure is active, so it cannot be recommended or booked right now." : "Customers can find and book it."}
              </p>
              <ActionForm action={setTrailStatusAction.bind(null, trail.id, "draft")} submitLabel="Unpublish" variant="secondary">
                <CheckField id="unpub-confirm" name="confirm" required label="I understand customers will no longer see or book this trail. Existing bookings are not cancelled." />
              </ActionForm>
            </div>
          ) : (
            <div className="space-y-3">
              {readiness.ready ? (
                <Alert tone="forest" title="Ready to publish">
                  Route validated and sources linked.
                </Alert>
              ) : (
                <Alert tone="amber" title="Not ready to publish">
                  <ul className="list-disc pl-5">
                    {readiness.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </Alert>
              )}
              <ActionForm action={setTrailStatusAction.bind(null, trail.id, "published")} submitLabel="Publish trail" pendingLabel="Publishing…" disabled={!readiness.ready} />
            </div>
          )}
          {trail.status !== "archived" ? (
            <details className="mt-4 rounded-xl border border-sand-200 p-3">
              <summary className="min-h-11 cursor-pointer content-center font-semibold">Archive this trail</summary>
              <ActionForm action={setTrailStatusAction.bind(null, trail.id, "archived")} submitLabel="Archive" variant="danger" className="mt-2">
                <CheckField id="archive-confirm" name="confirm" required label="Archive: hide it everywhere, including admin pickers." />
              </ActionForm>
            </details>
          ) : null}
          <p className="mt-3 text-sm text-muted">
            Route validated: <When at={trail.geometryValidatedAt} /> · Facts last verified: {trail.factsVerifiedAt ? formatDate(trail.factsVerifiedAt) : "never"}
          </p>
        </Card>
      </Section>

      <Section id="basics" title="Basics" description="Descriptive text and operational settings (not facts with provenance).">
        <Card>
          <ActionForm action={updateBasicsAction.bind(null, trail.id)} submitLabel="Save basics">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField id="b-name" name="name" label="Name" required minLength={3} maxLength={120} defaultValue={trail.name} className="sm:col-span-2" />
              <TextAreaField id="b-summary" name="summary" label="Summary" maxLength={400} defaultValue={trail.summary} className="sm:col-span-2" />
              <TextAreaField id="b-desc" name="description" label="Description" maxLength={8000} defaultValue={trail.description} className="sm:col-span-2" />
              <TextField id="b-th" name="trailheadName" label="Trailhead name" maxLength={200} defaultValue={trail.trailheadName ?? ""} />
              <TextField id="b-cap" name="dailyCapacity" label="Default daily capacity" type="number" min="0" required defaultValue={trail.dailyCapacity} hint="Per-day overrides live in Availability." />
            </div>
          </ActionForm>
        </Card>
      </Section>

      <Section
        id="facts"
        title="Facts and provenance"
        description="Each fact is saved together with where it came from. Use “Verified” only with a source and a verification date; label estimates as estimates."
      >
        {facts.allSources.length === 0 ? <Alert tone="amber">Create a source first (Sources tab) so facts can cite it.</Alert> : null}
        <ul className="space-y-3">
          {FACT_FIELD_KEYS.map((field) => {
            const def = FACT_FIELDS[field] as FactFieldDef;
            const prov = facts.provenance.find((p) => p.field === field);
            return (
              <li key={field}>
                <details className="group rounded-xl border border-sand-200 bg-surface">
                  <summary className="flex min-h-12 cursor-pointer list-none flex-col gap-1 p-4 sm:flex-row sm:items-center sm:justify-between [&::-webkit-details-marker]:hidden">
                    <span>
                      <span className="font-semibold">{def.label}:</span> {currentValue(field, trail)}
                    </span>
                    <span className="flex flex-wrap items-center gap-2 text-sm text-muted">
                      {prov ? (
                        <>
                          <Badge tone={KIND_TONE[prov.kind]}>{KIND_LABEL[prov.kind]}</Badge>
                          <span>{prov.sourceLabel ?? "No source"}</span>
                          <span>{prov.verifiedAt ? `verified ${formatDate(prov.verifiedAt)}` : "no verification date"}</span>
                        </>
                      ) : (
                        <Badge tone="red">No provenance</Badge>
                      )}
                      <span className="font-semibold text-forest-800 group-open:hidden">Edit</span>
                    </span>
                  </summary>
                  <div className="border-t border-sand-200 p-4">
                    {prov?.note ? <p className="mb-3 text-sm text-muted">Note: {prov.note}</p> : null}
                    <ActionForm action={updateFactAction.bind(null, trail.id, field)} submitLabel={`Save ${def.label.toLowerCase()}`}>
                      <ValueInput field={field} t={trail} />
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <SelectField
                          id={`fact-${field}-kind`}
                          name="kind"
                          label="Provenance"
                          options={FACT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
                          defaultValue={prov?.kind ?? (trail.isDemo ? "demo" : "estimate")}
                        />
                        <SelectField id={`fact-${field}-source`} name="sourceId" label="Source" options={sourceOptions} placeholder="No source" defaultValue={prov?.sourceId ?? ""} />
                        <TextField
                          id={`fact-${field}-verified`}
                          name="verifiedAt"
                          label="Verified on"
                          type="date"
                          defaultValue={prov?.verifiedAt ? new Date(prov.verifiedAt).toISOString().slice(0, 10) : ""}
                        />
                      </div>
                      <TextField id={`fact-${field}-note`} name="note" label="Note (optional)" maxLength={500} defaultValue={prov?.note ?? ""} />
                    </ActionForm>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      </Section>
    </>
  );
}
