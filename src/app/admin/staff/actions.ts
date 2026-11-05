"use server";

import type { FormState } from "@/server/admin/common";
import { grantStaffRole, revokeStaffRole } from "@/server/admin/staff";
import { checked, runAction, str } from "../_lib/action";

export async function grantRoleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("staff.manage", "/admin/staff", (user) => grantStaffRole(user, { email: str(fd, "email"), role: str(fd, "role") }));
}

export async function revokeRoleAction(userId: string, role: string, _prev: FormState, fd: FormData): Promise<FormState> {
  if (!checked(fd, "confirm")) return { ok: false, error: "Tick the confirmation box to revoke this role." };
  return runAction("staff.manage", "/admin/staff", (user) => revokeStaffRole(user, userId, role));
}
