/**
 * Role-based access control for staff. Customers have no staff role.
 * Pure module (no I/O) so it can be imported anywhere, including tests.
 */
export const STAFF_ROLES = ["admin", "operator", "safety", "content_editor", "support"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const PERMISSIONS = {
  "admin.access": ["admin", "operator", "safety", "content_editor", "support"],
  "trails.manage": ["admin", "operator", "content_editor"],
  "content.approve": ["admin", "content_editor"],
  "closures.manage": ["admin", "operator", "content_editor"],
  "customers.view": ["admin", "operator", "support"],
  "bookings.view": ["admin", "operator", "support"],
  "bookings.cancel": ["admin", "operator"],
  "bookings.refund": ["admin", "operator"],
  "gear.manage": ["admin", "operator"],
  "fulfillment.manage": ["admin", "operator"],
  "trips.monitor": ["admin", "operator", "safety"],
  /** precise location + emergency contact details */
  "safety.sensitive": ["admin", "safety"],
  "notifications.view": ["admin", "safety"],
  "jobs.manage": ["admin", "operator"],
  "integrations.view": ["admin", "operator"],
  /** Trail-catalog data: ingestion status, retries, moderation (hide a trail). */
  "catalog.manage": ["admin", "operator"],
  "pricing.manage": ["admin"],
  "inventory.manage": ["admin", "operator"],
  "flags.manage": ["admin"],
  "marketing.draft": ["admin", "operator", "content_editor"],
  "marketing.approve": ["admin", "operator"],
  "permits.manage": ["admin", "operator", "content_editor"],
  "support.manage": ["admin", "operator", "support"],
  "audit.view": ["admin"],
  "staff.manage": ["admin"],
} as const satisfies Record<string, readonly StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(roles: readonly string[] | undefined, permission: Permission): boolean {
  if (!roles?.length) return false;
  const allowed = PERMISSIONS[permission] as readonly string[];
  return roles.some((r) => allowed.includes(r));
}
