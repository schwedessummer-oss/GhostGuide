/**
 * Role-based access control for staff. Customers have no staff role.
 * Pure module (no I/O) so it can be imported anywhere, including tests.
 */
export const STAFF_ROLES = ["admin", "operator", "content_editor", "support"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const PERMISSIONS = {
  "admin.access": ["admin", "operator", "content_editor", "support"],
  "customers.view": ["admin", "operator", "support"],
  "jobs.manage": ["admin", "operator"],
  "integrations.view": ["admin", "operator"],
  "flags.manage": ["admin"],
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
