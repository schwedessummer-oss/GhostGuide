import type { Metadata } from "next";
import { Card } from "@/components/ui";
import { AdminHeader, Section, When } from "@/components/admin/admin-ui";
import { ActionForm } from "@/components/admin/action-form";
import { CheckField, SelectField, TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS, STAFF_ROLES } from "@/server/auth/rbac";
import { listStaff } from "@/server/admin/staff";
import { grantRoleAction, revokeRoleAction } from "./actions";

export const metadata: Metadata = { title: "Staff roles" };

export default async function StaffPage() {
  const user = await requirePermission("staff.manage", "/admin/staff");
  const staff = await listStaff(user);
  const adminCount = staff.filter((s) => s.roles.some((r) => r.role === "admin")).length;
  const roleCaps = Object.fromEntries(STAFF_ROLES.map((r) => [r, Object.entries(PERMISSIONS).filter(([, roles]) => (roles as readonly string[]).includes(r)).map(([p]) => p)]));

  return (
    <>
      <AdminHeader title="Staff roles" description="Grant or revoke staff roles by email. Changes are audited. The last remaining admin role cannot be removed." />
      <Section id="grant" title="Grant a role">
        <Card>
          <ActionForm action={grantRoleAction} submitLabel="Grant role" inline>
            <TextField id="sr-email" name="email" type="email" label="User email" required autoComplete="off" className="sm:min-w-72" hint="The person must already have an account." />
            <SelectField id="sr-role" name="role" label="Role" options={STAFF_ROLES} defaultValue="support" />
          </ActionForm>
        </Card>
      </Section>
      <Section id="staff" title={`Staff (${staff.length})`}>
        <ul className="space-y-3">
          {staff.map((m) => (
            <li key={m.userId}>
              <Card className="p-4 sm:p-5">
                <p className="font-semibold">
                  {m.fullName ?? m.email ?? m.userId}
                  {m.userId === user.id ? <span className="ml-2 text-sm font-normal text-muted">(you)</span> : null}
                </p>
                <p className="text-sm text-muted">{m.email}</p>
                <ul className="mt-3 space-y-2">
                  {m.roles.map((r) => {
                    const lastAdmin = r.role === "admin" && adminCount <= 1;
                    return (
                      <li key={r.role} className="flex flex-col gap-2 rounded-xl border border-sand-200 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <span>
                          <span className="font-semibold">{r.role.replace("_", " ")}</span>
                          <span className="block text-xs text-muted">
                            granted <When at={r.grantedAt} />
                            {r.grantedByEmail ? ` by ${r.grantedByEmail}` : ""}
                          </span>
                        </span>
                        {lastAdmin ? (
                          <span className="text-sm text-muted">Last admin — cannot be revoked</span>
                        ) : (
                          <details>
                            <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold text-red-ink">Revoke</summary>
                            <ActionForm action={revokeRoleAction.bind(null, m.userId, r.role)} submitLabel={`Revoke ${r.role.replace("_", " ")}`} variant="danger" compact className="mt-2">
                              <CheckField id={`rv-${m.userId}-${r.role}`} name="confirm" required label={m.userId === user.id ? "Remove this role from my own account." : "Remove this role."} />
                            </ActionForm>
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </li>
          ))}
        </ul>
      </Section>
      <Section id="matrix" title="What each role can do">
        <dl className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {STAFF_ROLES.map((r) => (
            <div key={r} className="rounded-xl border border-sand-200 bg-surface p-4">
              <dt className="font-semibold">{r.replace("_", " ")}</dt>
              <dd className="mt-1 text-sm text-muted">{roleCaps[r].join(", ")}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
}
