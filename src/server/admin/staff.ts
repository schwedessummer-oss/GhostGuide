import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import { STAFF_ROLES, type StaffRole } from "@/server/auth/rbac";
import { assertCan, auditInStaffTx, fail, guarded, isUuid, ok, staffTx, type ActionResult } from "./common";

/**
 * Staff role management (staff.manage = admin). Writes go through RLS
 * (staff_roles_admin_write). The last remaining admin role can never be
 * removed: checked here under a lock on all admin rows, and by a database
 * trigger as a safety net.
 */
export interface StaffMember {
  userId: string;
  email: string | null;
  fullName: string | null;
  roles: { role: StaffRole; grantedAt: Date; grantedByEmail: string | null }[];
}

export async function listStaff(user: SessionUser): Promise<StaffMember[]> {
  assertCan(user, "staff.manage");
  const rows = await staffTx(user, (tx) => tx<{ userId: string; email: string | null; fullName: string | null; role: StaffRole; grantedAt: Date; grantedByEmail: string | null }[]>`
    select sr.user_id, p.email, p.full_name, sr.role, sr.granted_at, gp.email as granted_by_email
    from public.staff_roles sr left join public.profiles p on p.id = sr.user_id left join public.profiles gp on gp.id = sr.granted_by
    order by p.email, sr.role`);
  const map = new Map<string, StaffMember>();
  for (const r of rows) {
    const m = map.get(r.userId) ?? { userId: r.userId, email: r.email, fullName: r.fullName, roles: [] };
    m.roles.push({ role: r.role, grantedAt: r.grantedAt, grantedByEmail: r.grantedByEmail });
    map.set(r.userId, m);
  }
  return [...map.values()];
}

const grantSchema = z.object({ email: z.email("Enter the user's email address.").transform((v) => v.trim().toLowerCase()), role: z.enum(STAFF_ROLES) });

export async function grantStaffRole(user: SessionUser, input: { email?: unknown; role?: unknown }): Promise<ActionResult> {
  assertCan(user, "staff.manage");
  const p = grantSchema.safeParse({ email: typeof input.email === "string" ? input.email.trim() : input.email, role: input.role });
  if (!p.success) return fail(p.error.issues[0].message);
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [target] = await tx<{ id: string }[]>`select id from public.profiles where lower(email) = ${p.data.email}`;
      if (!target) return fail("No account with that email. The person must sign up first.");
      const rows = await tx`
        insert into public.staff_roles (user_id, role, granted_by) values (${target.id}, ${p.data.role}, ${user.id})
        on conflict (user_id, role) do nothing returning user_id`;
      if (!rows.length) return ok(`That user already has the ${p.data.role} role.`);
      await auditInStaffTx(tx, user, "staff.role_granted", "user", target.id, { role: p.data.role });
      return ok(`Granted ${p.data.role.replace("_", " ")}. It applies on their next request.`);
    }),
  );
}

export async function revokeStaffRole(user: SessionUser, targetUserId: string, role: unknown): Promise<ActionResult> {
  assertCan(user, "staff.manage");
  if (!isUuid(targetUserId)) return fail("User not found.");
  const r = z.enum(STAFF_ROLES).safeParse(role);
  if (!r.success) return fail("Unknown role.");
  return guarded(() =>
    staffTx(user, async (tx) => {
      if (r.data === "admin") {
        // Serialize concurrent admin removals: lock every admin row first.
        const admins = await tx<{ userId: string }[]>`select user_id from public.staff_roles where role = 'admin' for update`;
        if (admins.some((a) => a.userId === targetUserId) && admins.length <= 1) {
          return fail("You cannot remove the last remaining admin role. Grant admin to someone else first.");
        }
      }
      const rows = await tx`delete from public.staff_roles where user_id = ${targetUserId} and role = ${r.data} returning user_id`;
      if (!rows.length) return fail("That user does not have this role.");
      await auditInStaffTx(tx, user, "staff.role_revoked", "user", targetUserId, { role: r.data, self: targetUserId === user.id });
      return ok(`Revoked ${r.data.replace("_", " ")}.${targetUserId === user.id ? " You removed one of your own roles." : ""}`);
    }),
  );
}
