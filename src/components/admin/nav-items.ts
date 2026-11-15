import type { Permission } from "@/server/auth/rbac";

/** Admin sidebar sections. Only sections the viewer's roles allow are shown. */
export interface AdminNavItem {
  href: string;
  label: string;
  icon: AdminIcon;
  permission: Permission;
}

export type AdminIcon = "overview" | "customers" | "support" | "jobs" | "flags" | "staff" | "audit";

export const ADMIN_NAV: { group: string; items: AdminNavItem[] }[] = [
  {
    group: "Operations",
    items: [
      { href: "/admin", label: "Overview", icon: "overview", permission: "admin.access" },
      { href: "/admin/customers", label: "Customers", icon: "customers", permission: "customers.view" },
      { href: "/admin/support", label: "Support", icon: "support", permission: "support.manage" },
    ],
  },
  {
    group: "System",
    items: [
      { href: "/admin/jobs", label: "Jobs & integrations", icon: "jobs", permission: "jobs.manage" },
      { href: "/admin/flags", label: "Feature flags", icon: "flags", permission: "flags.manage" },
      { href: "/admin/staff", label: "Staff roles", icon: "staff", permission: "staff.manage" },
      { href: "/admin/audit", label: "Audit log", icon: "audit", permission: "audit.view" },
    ],
  },
];
