/**
 * Core seed: the demo accounts (customers and one account per staff role)
 * used for local runs and automated tests. No hike data: hikes will come
 * from the offline ingestion pipeline (docs/PLAN.md §6), never from seeds.
 */
import type postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { hashPassword } from "../../src/server/auth/password";

export const DEMO_PASSWORD = "ghostguide-demo";
export const DEMO_USERS = [
  { email: "hiker@demo.ghostguide.test", name: "Hana Hiker", roles: [] as string[] },
  { email: "hiker2@demo.ghostguide.test", name: "Ravi Rambler", roles: [] as string[] },
  { email: "admin@demo.ghostguide.test", name: "Ada Admin", roles: ["admin"] },
  { email: "operator@demo.ghostguide.test", name: "Omar Operator", roles: ["operator"] },
  { email: "editor@demo.ghostguide.test", name: "Eda Editor", roles: ["content_editor"] },
  { email: "support@demo.ghostguide.test", name: "Sue Support", roles: ["support"] },
];

const ADMIN_EMAIL = "admin@demo.ghostguide.test";

/** Creates the demo accounts on an empty database. Returns false when they already exist. */
export async function seedCore(sql: postgres.Sql) {
  const existing = await sql`
    select 1 from public.staff_roles sr join auth.users u on u.id = sr.user_id
    where u.email = ${ADMIN_EMAIL} and sr.role = 'admin'`;
  if (existing.length) {
    console.log("Core seed already present; skipping.");
    return false;
  }

  const userIds: Record<string, string> = {};
  if (process.env.AUTH_PROVIDER === "supabase") {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("Seeding Supabase Auth users needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY");
    const admin = createClient(url, key, { auth: { persistSession: false } }).auth.admin;
    for (const u of DEMO_USERS) {
      const { data, error } = await admin.createUser({
        email: u.email,
        password: process.env.SEED_DEMO_PASSWORD ?? DEMO_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: u.name },
      });
      if (error && !/already/i.test(error.message)) throw error;
      const id = data?.user?.id ?? (await sql<{ id: string }[]>`select id from auth.users where email = ${u.email}`)[0]?.id;
      userIds[u.email] = id;
    }
  } else {
    const hash = await hashPassword(DEMO_PASSWORD);
    for (const u of DEMO_USERS) {
      const [row] = await sql<{ id: string }[]>`
        insert into auth.users (email, encrypted_password, raw_user_meta_data)
        values (${u.email}, ${hash}, ${sql.json({ full_name: u.name })})
        returning id`;
      userIds[u.email] = row.id;
    }
  }
  for (const u of DEMO_USERS) {
    await sql`update public.profiles set full_name = ${u.name} where id = ${userIds[u.email]}`;
    for (const role of u.roles) {
      await sql`insert into public.staff_roles (user_id, role) values (${userIds[u.email]}, ${role}) on conflict do nothing`;
    }
  }

  console.log(`Seeded ${DEMO_USERS.length} demo users.`);
  return true;
}
