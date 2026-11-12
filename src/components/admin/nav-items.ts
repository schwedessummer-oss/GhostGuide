import type { Permission } from "@/server/auth/rbac";

/** Admin sidebar sections. Only sections the viewer's roles allow are shown. */
export interface AdminNavItem {
  href: string;
  label: string;
  icon: AdminIcon;
  permission: Permission;
}

export type AdminIcon =
  | "overview"
  | "trails"
  | "content"
  | "customers"
  | "bookings"
  | "availability"
  | "pricing"
  | "fulfillment"
  | "gear"
  | "safety"
  | "notifications"
  | "permits"
  | "marketing"
  | "support"
  | "jobs"
  | "flags"
  | "staff"
  | "audit";

export const ADMIN_NAV: { group: string; items: AdminNavItem[] }[] = [
  {
    group: "Operations",
    items: [
      { href: "/admin", label: "Overview", icon: "overview", permission: "admin.access" },
      { href: "/admin/safety", label: "Safety monitor", icon: "safety", permission: "trips.monitor" },
      { href: "/admin/notifications", label: "Notifications", icon: "notifications", permission: "notifications.view" },
      { href: "/admin/bookings", label: "Bookings", icon: "bookings", permission: "bookings.view" },
      { href: "/admin/fulfillment", label: "Fulfillment", icon: "fulfillment", permission: "fulfillment.manage" },
      { href: "/admin/gear", label: "Gear lockers", icon: "gear", permission: "gear.manage" },
      { href: "/admin/availability", label: "Availability", icon: "availability", permission: "inventory.manage" },
      { href: "/admin/customers", label: "Customers", icon: "customers", permission: "customers.view" },
      { href: "/admin/support", label: "Support", icon: "support", permission: "support.manage" },
    ],
  },
  {
    group: "Catalog",
    items: [
      { href: "/admin/trails", label: "Trails", icon: "trails", permission: "trails.manage" },
      { href: "/admin/content", label: "Narration review", icon: "content", permission: "trails.manage" },
      { href: "/admin/permits", label: "Permits", icon: "permits", permission: "permits.manage" },
      { href: "/admin/pricing", label: "Pricing", icon: "pricing", permission: "pricing.manage" },
      { href: "/admin/marketing", label: "Marketing drafts", icon: "marketing", permission: "marketing.draft" },
    ],
  },
  {
    group: "System",
    items: [
      { href: "/admin/jobs", label: "Jobs & integrations", icon: "jobs", permission: "jobs.manage" },
      { href: "/admin/data", label: "Trail data", icon: "trails", permission: "integrations.view" },
      { href: "/admin/flags", label: "Feature flags", icon: "flags", permission: "flags.manage" },
      { href: "/admin/staff", label: "Staff roles", icon: "staff", permission: "staff.manage" },
      { href: "/admin/audit", label: "Audit log", icon: "audit", permission: "audit.view" },
    ],
  },
];
