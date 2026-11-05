import { afterAll, describe, expect, it } from "vitest";
import { closeDb, withAnon, withSystem, withUser } from "@/server/db";
import { createCustomer, demoUser, trailBySlug } from "../../helpers/db";

afterAll(closeDb);

describe("row-level security", () => {
  it("customers cannot read another customer's trips, contacts or locations", async () => {
    const alice = await createCustomer("alice");
    const bob = await createCustomer("bob");
    const trail = await trailBySlug("lantern-creek-loop");
    const [trip] = await withUser(alice, (tx) =>
      tx<{ id: string }[]>`insert into public.trips (user_id, region_id, trail_id) values (${alice.id}, ${trail.regionId}, ${trail.id}) returning id`,
    );
    await withUser(alice, (tx) => tx`insert into public.emergency_contacts (user_id, name, phone) values (${alice.id}, 'Mom', '+15550000000')`);

    const bobTrips = await withUser(bob, (tx) => tx`select id from public.trips where id = ${trip.id}`);
    expect(bobTrips).toHaveLength(0);
    const bobContacts = await withUser(bob, (tx) => tx`select id from public.emergency_contacts where user_id = ${alice.id}`);
    expect(bobContacts).toHaveLength(0);
    // Bob cannot update Alice's trip either (RLS filters the row: 0 rows updated)
    const updated = await withUser(bob, (tx) => tx`update public.trips set party_size = 5 where id = ${trip.id} returning id`);
    expect(updated).toHaveLength(0);
  });

  it("customers cannot insert rows for other users or write lifecycle columns", async () => {
    const alice = await createCustomer("alice");
    const bob = await createCustomer("bob");
    const trail = await trailBySlug("lantern-creek-loop");
    await expect(
      withUser(bob, (tx) => tx`insert into public.trips (user_id, region_id, trail_id) values (${alice.id}, ${trail.regionId}, ${trail.id})`),
    ).rejects.toThrow(/row-level security/);
    const [trip] = await withUser(alice, (tx) =>
      tx<{ id: string }[]>`insert into public.trips (user_id, region_id, trail_id) values (${alice.id}, ${trail.regionId}, ${trail.id}) returning id`,
    );
    // status is a lifecycle column: column privilege denies the write
    await expect(withUser(alice, (tx) => tx`update public.trips set status = 'booked' where id = ${trip.id}`)).rejects.toThrow(
      /permission denied/,
    );
    // bookings are server-written only
    await expect(
      withUser(alice, (tx) => tx`
        insert into public.bookings (user_id, trip_id, trail_id, hike_date, party_size, subtotal_cents, total_cents, payment_provider, idempotency_key)
        values (${alice.id}, ${trip.id}, ${trail.id}, current_date, 1, 0, 0, 'demo', ${`k-${trip.id}`})`),
    ).rejects.toThrow(/permission denied/);
  });

  it("server-only tables are not readable by API roles", async () => {
    const alice = await createCustomer("alice");
    await expect(withUser(alice, (tx) => tx`select * from public.jobs limit 1`)).rejects.toThrow(/permission denied/);
    await expect(withUser(alice, (tx) => tx`select * from public.webhook_events limit 1`)).rejects.toThrow(/permission denied/);
    await expect(withAnon((tx) => tx`select * from public.rate_limits limit 1`)).rejects.toThrow(/permission denied/);
  });

  it("anonymous visitors see published trails only, never drafts or audit logs", async () => {
    const rows = await withAnon((tx) => tx<{ slug: string }[]>`select slug from public.trails`);
    expect(rows.map((r) => r.slug)).not.toContain("cinder-spur-draft");
    expect(rows.length).toBeGreaterThanOrEqual(5);
    const audit = await withAnon((tx) => tx`select * from public.audit_logs`);
    expect(audit).toHaveLength(0);
  });

  it("precise locations and emergency contacts are visible to safety staff but not support staff", async () => {
    const hiker = await demoUser("hiker");
    const safety = await demoUser("safety");
    const support = await demoUser("support");
    const safetySees = await withUser(safety, (tx) => tx`select id from public.emergency_contacts where user_id = ${hiker.id}`);
    expect(safetySees.length).toBeGreaterThan(0);
    const supportSees = await withUser(support, (tx) => tx`select id from public.emergency_contacts where user_id = ${hiker.id}`);
    expect(supportSees).toHaveLength(0);
    const supportLocations = await withUser(support, (tx) => tx`select * from public.hike_last_locations`);
    expect(supportLocations).toHaveLength(0);
  });

  it("a customer cannot grant themselves a staff role", async () => {
    const mallory = await createCustomer("mallory");
    await expect(withUser(mallory, (tx) => tx`insert into public.staff_roles (user_id, role) values (${mallory.id}, 'admin')`)).rejects.toThrow(
      /row-level security/,
    );
    const roles = await withSystem((tx) => tx`select * from public.staff_roles where user_id = ${mallory.id}`);
    expect(roles).toHaveLength(0);
  });
});
