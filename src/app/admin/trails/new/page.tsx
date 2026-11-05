import Link from "next/link";
import type { Metadata } from "next";
import { Card } from "@/components/ui";
import { AdminHeader } from "@/components/admin/admin-ui";
import { ActionForm } from "@/components/admin/action-form";
import { CheckField, SelectField, TextAreaField, TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { getLaunchRegion } from "@/server/catalog/trails";
import { isDemoMode } from "@/config/env";
import { DIFFICULTIES, ROUTE_TYPES } from "@/server/admin/trail-fields";
import { createTrailAction } from "../actions";

export const metadata: Metadata = { title: "New trail" };

export default async function NewTrailPage() {
  await requirePermission("trails.manage", "/admin/trails/new");
  const region = await getLaunchRegion();
  return (
    <>
      <p className="mb-3">
        <Link href="/admin/trails" className="inline-flex min-h-11 items-center font-semibold text-forest-800 hover:underline">
          ← All trails
        </Link>
      </p>
      <AdminHeader
        title="New draft trail"
        description={
          <>
            Creates an unpublished draft in <strong>{region.name}</strong>. After saving, record each fact&apos;s provenance, link sources and upload a
            route file. Never enter routes, access or safety facts that are not backed by a source.
          </>
        }
      />
      <Card>
        <ActionForm action={createTrailAction} submitLabel="Create draft" pendingLabel="Creating…">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField id="t-name" name="name" label="Name" required minLength={3} maxLength={120} className="sm:col-span-2" />
            <TextAreaField id="t-summary" name="summary" label="Summary" maxLength={400} className="sm:col-span-2" hint="One or two sentences shown on trail cards." />
            <TextAreaField id="t-desc" name="description" label="Description" maxLength={8000} className="sm:col-span-2" />
            <TextField id="t-dist" name="distanceKm" label="Distance (km)" type="number" step="0.01" min="0.1" required hint="Route uploads must match within 10%." />
            <TextField id="t-gain" name="elevationGainM" label="Elevation gain (m)" type="number" step="1" min="0" required />
            <SelectField id="t-diff" name="difficulty" label="Difficulty" options={DIFFICULTIES} required />
            <SelectField id="t-type" name="routeType" label="Route type" options={ROUTE_TYPES} required />
            <TextField id="t-dur" name="estimatedDurationMin" label="Estimated duration (minutes)" type="number" min="1" required hint="An estimate, not a guarantee." />
            <TextField id="t-thname" name="trailheadName" label="Trailhead name" maxLength={200} />
            <TextField id="t-lat" name="trailheadLat" label="Trailhead latitude" type="number" step="any" min="-90" max="90" required defaultValue={region.centerLat} />
            <TextField id="t-lng" name="trailheadLng" label="Trailhead longitude" type="number" step="any" min="-180" max="180" required defaultValue={region.centerLng} />
            <TextField id="t-price" name="basePrice" label="Base price per person (USD)" type="number" step="0.01" min="0" required defaultValue="25.00" />
            <TextField id="t-cap" name="dailyCapacity" label="Daily capacity (hikers)" type="number" min="0" required defaultValue="20" />
            <CheckField
              id="t-demo"
              name="isDemo"
              defaultChecked={isDemoMode() || region.isDemo}
              className="sm:col-span-2"
              label="Demonstration (fictional) trail — always labeled as demo content to customers"
            />
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
