import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/config/env";
import { withSystem } from "@/server/db";
import { can, type Permission, type StaffRole } from "./rbac";
import { signSession, verifySession } from "./tokens";
import { hashPassword, verifyPassword } from "./password";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export { can } from "./rbac";
export type { Permission, StaffRole } from "./rbac";

export const DEMO_SESSION_COOKIE = "gg_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 7;

export interface SessionUser {
  id: string;
  email: string;
  roles: StaffRole[];
  isStaff: boolean;
}

async function readIdentity(): Promise<{ id: string; email: string } | null> {
  const e = env();
  if (e.AUTH_PROVIDER === "demo") {
    const token = (await cookies()).get(DEMO_SESSION_COOKIE)?.value;
    const payload = verifySession(e.AUTH_SECRET, token);
    return payload ? { id: payload.sub, email: payload.email } : null;
  }
  const supabase = await createSupabaseServerClient();
  // getClaims verifies the JWT signature (per Supabase SSR guidance); never
  // trust getSession() for authorization.
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;
  return { id: String(claims.sub), email: String(claims.email ?? "") };
}

/** The signed-in user (memoized per request), or null. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const identity = await readIdentity();
  if (!identity) return null;
  const rows = await withSystem(
    (tx) => tx<{ role: StaffRole }[]>`select role from public.staff_roles where user_id = ${identity.id}`,
  );
  const roles = rows.map((r) => r.role);
  return { ...identity, roles, isStaff: roles.length > 0 };
});

/** For pages / server actions: redirect to login when signed out. */
export async function requireUser(nextPath?: string): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect(`/login${nextPath ? `?next=${encodeURIComponent(nextPath)}` : ""}`);
  return user;
}

/** For admin pages / actions: require a staff permission. */
export async function requirePermission(permission: Permission, nextPath?: string): Promise<SessionUser> {
  const user = await requireUser(nextPath);
  if (!can(user.roles, permission)) redirect("/forbidden");
  return user;
}

/** For route handlers: returns the user or null (respond 401 yourself). */
export async function getApiUser(): Promise<SessionUser | null> {
  return getCurrentUser();
}

export function jsonError(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

// ---------------------------------------------------------------------------
// Sign in / sign up / sign out
// ---------------------------------------------------------------------------

export type AuthResult = { ok: true } | { ok: false; error: string };

async function setDemoSession(id: string, email: string) {
  const e = env();
  const token = signSession(e.AUTH_SECRET, { sub: id, email, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC });
  (await cookies()).set(DEMO_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: e.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SEC,
  });
}

export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  const normalized = email.trim().toLowerCase();
  if (env().AUTH_PROVIDER === "demo") {
    const [row] = await withSystem(
      (tx) => tx<{ id: string; encryptedPassword: string | null }[]>`
        select id, encrypted_password from auth.users where lower(email) = ${normalized}`,
    );
    // Verify even when the user is missing to keep timing uniform.
    const ok = await verifyPassword(password, row?.encryptedPassword ?? "scrypt$AAAA$AAAA");
    if (!row || !ok) return { ok: false, error: "Email or password is incorrect." };
    await setDemoSession(row.id, normalized);
    return { ok: true };
  }
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email: normalized, password });
  if (error) return { ok: false, error: "Email or password is incorrect." };
  return { ok: true };
}

export async function signUpWithPassword(email: string, password: string, fullName: string): Promise<AuthResult> {
  const normalized = email.trim().toLowerCase();
  if (password.length < 10) return { ok: false, error: "Use at least 10 characters for your password." };
  if (env().AUTH_PROVIDER === "demo") {
    const hash = await hashPassword(password);
    const created = await withSystem(async (tx) => {
      const existing = await tx`select 1 from auth.users where lower(email) = ${normalized}`;
      if (existing.length) return null;
      const [u] = await tx<{ id: string }[]>`
        insert into auth.users (email, encrypted_password, raw_user_meta_data)
        values (${normalized}, ${hash}, ${tx.json({ full_name: fullName })})
        returning id`;
      await tx`update public.profiles set full_name = ${fullName} where id = ${u.id}`;
      return u;
    });
    if (!created) return { ok: false, error: "An account with that email already exists." };
    await setDemoSession(created.id, normalized);
    return { ok: true };
  }
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signUp({
    email: normalized,
    password,
    options: { data: { full_name: fullName }, emailRedirectTo: `${env().NEXT_PUBLIC_APP_URL}/trips` },
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function signOut() {
  if (env().AUTH_PROVIDER === "demo") {
    (await cookies()).delete(DEMO_SESSION_COOKIE);
    return;
  }
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
}
