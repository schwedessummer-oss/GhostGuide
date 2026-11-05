import type postgres from "postgres";

const CONSENT =
  "I confirm this person has agreed to receive Ghost Guide check-in notices about my trips by text message and/or email, and that I may give Ghost Guide their contact details for this purpose.";

/**
 * Additional demo data for the safety slice (runs after the core seed, on a
 * fresh database). All people and numbers are fictional (555-01xx numbers,
 * reserved .test domains). The core seed already gives the demo hiker one
 * consenting contact ("Casey Contact (demo)").
 */
export async function seedSafety(sql: postgres.Sql) {
  const users = await sql<{ id: string; email: string }[]>`
    select id, email from auth.users where email in ('hiker@demo.ghostguide.test', 'hiker2@demo.ghostguide.test')`;
  const byEmail = Object.fromEntries(users.map((u) => [u.email, u.id]));
  const hiker = byEmail["hiker@demo.ghostguide.test"];
  const hiker2 = byEmail["hiker2@demo.ghostguide.test"];
  if (!hiker || !hiker2) {
    console.log("Safety seed: demo hikers not found; skipping.");
    return;
  }

  // The demo hiker's own phone, so reminders show as (simulated) text messages.
  await sql`update public.profiles set phone = '+15555550100', location_retention_days = 30 where id = ${hiker}`;

  // Hiker 2: one consenting contact (email only) and one saved WITHOUT consent,
  // which the UI shows as "Consent needed" and never offers for check-ins.
  await sql`
    insert into public.emergency_contacts (user_id, name, phone, email, relationship, consent_confirmed_at, consent_statement)
    values
      (${hiker2}, 'Robin Rambler (demo)', null, 'robin@demo.ghostguide.test', 'Partner', now() - interval '10 days', ${CONSENT}),
      (${hiker2}, 'Pat Pending (demo)', '+15555550177', null, 'Neighbour', null, null)`;
  await sql`update public.profiles set location_retention_days = 7, share_location_with_contacts = false where id = ${hiker2}`;

  console.log("Seeded safety demo data: contacts (with and without consent) and privacy settings.");
}
