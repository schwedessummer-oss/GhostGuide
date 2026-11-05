import type { Metadata } from "next";
import { requirePermission } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import { isDemoMode } from "@/config/env";
import { AdminNav } from "@/components/admin/admin-nav";
import { ADMIN_NAV } from "@/components/admin/nav-items";
import { SimulatedBadge } from "@/components/ui";

export const metadata: Metadata = {
  title: { default: "Admin", template: "%s · Admin · Ghost Guide" },
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const user = await requirePermission("admin.access", "/admin");
  const groups = ADMIN_NAV.map((g) => ({
    group: g.group,
    items: g.items.filter((i) => can(user.roles, i.permission)).map(({ href, label, icon }) => ({ href, label, icon })),
  })).filter((g) => g.items.length);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:grid lg:grid-cols-[15rem_1fr] lg:gap-8 lg:py-8">
      <aside className="mb-6 lg:mb-0">
        <div className="mb-4 hidden rounded-xl bg-forest-900 p-4 text-white lg:block">
          <p className="text-sm font-semibold uppercase tracking-wide text-forest-200">Ghost Guide admin</p>
          <p className="mt-1 truncate text-sm" title={user.email}>
            {user.email}
          </p>
          <p className="mt-0.5 text-xs text-forest-200">Roles: {user.roles.join(", ").replace(/_/g, " ")}</p>
          {isDemoMode() ? (
            <p className="mt-2">
              <SimulatedBadge label="Demo mode" />
            </p>
          ) : null}
        </div>
        <div className="lg:sticky lg:top-4">
          <AdminNav groups={groups} />
        </div>
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
