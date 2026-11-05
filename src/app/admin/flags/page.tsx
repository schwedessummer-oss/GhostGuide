import type { Metadata } from "next";
import { Card } from "@/components/ui";
import { AdminHeader, StatusBadge, When } from "@/components/admin/admin-ui";
import { ActionForm } from "@/components/admin/action-form";
import { requirePermission } from "@/server/auth";
import { listFlags } from "@/server/admin/feature-flags";
import { setFlagAction } from "./actions";

export const metadata: Metadata = { title: "Feature flags" };

export default async function FlagsPage() {
  const user = await requirePermission("flags.manage", "/admin/flags");
  const flags = await listFlags(user);
  return (
    <>
      <AdminHeader title="Feature flags" description="Turn features on or off without a deploy. Changes apply to new requests immediately and are recorded in the audit log." />
      <ul className="space-y-3">
        {flags.map((f) => (
          <li key={f.key}>
            <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
              <div>
                <p className="flex flex-wrap items-center gap-2">
                  <code className="font-semibold">{f.key}</code>
                  <StatusBadge status={f.enabled ? "active" : "retired"} label={f.enabled ? "On" : "Off"} />
                  {!f.known ? <span className="text-xs text-muted">(not read by this version of the app)</span> : null}
                </p>
                <p className="text-sm text-muted">{f.description}</p>
                <p className="text-xs text-muted">
                  Last changed <When at={f.updatedAt} />
                  {f.updatedByEmail ? ` by ${f.updatedByEmail}` : ""}
                </p>
              </div>
              <ActionForm action={setFlagAction.bind(null, f.key, !f.enabled)} submitLabel={f.enabled ? "Turn off" : "Turn on"} variant={f.enabled ? "secondary" : "primary"} compact />
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
