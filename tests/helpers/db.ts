/**
 * Integration-test helpers. Tests call server use-case functions directly
 * with an explicit SessionUser (no cookies / Next runtime needed).
 */
import { randomUUID } from "node:crypto";
import { sql, withSystem } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import type { StaffRole } from "@/server/auth/rbac";

export const DEMO_EMAILS = {
  hiker: "hiker@demo.ghostguide.test",
  hiker2: "hiker2@demo.ghostguide.test",
  admin: "admin@demo.ghostguide.test",
  operator: "operator@demo.ghostguide.test",
  safety: "safety@demo.ghostguide.test",
  editor: "editor@demo.ghostguide.test",
  support: "support@demo.ghostguide.test",
} as const;

/** Load a seeded demo user as a SessionUser. */
export async function demoUser(key: keyof typeof DEMO_EMAILS): Promise<SessionUser> {
  const email = DEMO_EMAILS[key];
  const [u] = await sql()<{ id: string }[]>`select id from auth.users where email = ${email}`;
  if (!u) throw new Error(`Demo user ${email} not found — did the seed run?`);
  const roles = (await sql()<{ role: StaffRole }[]>`select role from public.staff_roles where user_id = ${u.id}`).map((r) => r.role);
  return { id: u.id, email, roles, isStaff: roles.length > 0 };
}

/** Create a fresh customer account for test isolation. */
export async function createCustomer(label = "test"): Promise<SessionUser> {
  const email = `${label}-${randomUUID().slice(0, 8)}@test.ghostguide.test`;
  const [u] = await withSystem((tx) => tx<{ id: string }[]>`insert into auth.users (email) values (${email}) returning id`);
  return { id: u.id, email, roles: [], isStaff: false };
}

export async function trailBySlug(slug: string) {
  const [t] = await sql()<{ id: string; regionId: string; dailyCapacity: number; basePriceCents: number }[]>`
    select id, region_id, daily_capacity, base_price_cents from public.trails where slug = ${slug}`;
  if (!t) throw new Error(`Trail ${slug} not found`);
  return t;
}

/** A date string N days from today (YYYY-MM-DD, UTC). */
export function daysFromNow(n: number): string {
  const d = new Date(Date.now() + n * 86_400_000);
  return d.toISOString().slice(0, 10);
}
