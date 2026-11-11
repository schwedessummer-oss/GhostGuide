import { afterAll, describe, expect, it } from "vitest";
import { closeDb, withSystem, withUser } from "@/server/db";
import { createCustomer, demoUser, trailBySlug } from "../../helpers/db";

afterAll(closeDb);

/**
 * Regression tests for the security review: the Supabase Data API exposes
 * these tables to the `authenticated` role, so each abuse is attempted
 * directly in SQL as that role.
 */
describe("security hardening", () => {
  it("a customer cannot delete their trip (which would cascade-delete bookings and payments)", async () => {
    const alice = await createCustomer("alice");
    const trail = await trailBySlug("lantern-creek-loop");
    const [trip] = await withUser(alice, (tx) =>
      tx<{ id: string }[]>`insert into public.trips (user_id, region_id, trail_id) values (${alice.id}, ${trail.regionId}, ${trail.id}) returning id`,
    );
    await expect(withUser(alice, (tx) => tx`delete from public.trips where id = ${trip.id}`)).rejects.toThrow(/permission denied/);
    const still = await withSystem((tx) => tx`select id from public.trips where id = ${trip.id}`);
    expect(still).toHaveLength(1);
  });

  it("a trip's region must match its trail's region", async () => {
    const alice = await createCustomer("alice");
    const trail = await trailBySlug("lantern-creek-loop");
    const [other] = await withSystem((tx) =>
      tx<{ id: string }[]>`insert into public.regions (slug, name, center_lat, center_lng, is_active) values (${`r-${alice.id.slice(0, 8)}`}, 'Other', 0, 0, true) returning id`,
    );
    await expect(
      withUser(alice, (tx) => tx`insert into public.trips (user_id, region_id, trail_id) values (${alice.id}, ${other.id}, ${trail.id})`),
    ).rejects.toThrow(/row-level security/);
  });

  it("support staff cannot read customer phone numbers; safety staff and the owner can", async () => {
    const support = await demoUser("support");
    const safety = await demoUser("safety");
    const customer = await createCustomer("phone");
    await withSystem((tx) => tx`update public.profiles set phone = '+15550001111' where id = ${customer.id}`);
    await expect(withUser(support, (tx) => tx`select phone from public.profiles where id = ${customer.id}`)).rejects.toThrow(/permission denied/);
    const [s] = await withUser(support, (tx) => tx<{ phone: string | null }[]>`select public.profile_phone(${customer.id}) as phone`);
    expect(s.phone).toBeNull();
    const [has] = await withUser(support, (tx) => tx<{ has: boolean }[]>`select public.profile_has_phone(${customer.id}) as has`);
    expect(has.has).toBe(true);
    const [sa] = await withUser(safety, (tx) => tx<{ phone: string | null }[]>`select public.profile_phone(${customer.id}) as phone`);
    expect(sa.phone).toBe("+15550001111");
    const [own] = await withUser(customer, (tx) => tx<{ phone: string | null }[]>`select public.profile_phone(${customer.id}) as phone`);
    expect(own.phone).toBe("+15550001111");
  });

  it("only admins can change prices", async () => {
    const operator = await demoUser("operator");
    const editor = await demoUser("editor");
    const admin = await demoUser("admin");
    const trail = await trailBySlug("whisper-falls");
    await expect(withUser(operator, (tx) => tx`update public.trails set base_price_cents = 1 where id = ${trail.id}`)).rejects.toThrow(
      /Only admins/,
    );
    await expect(withUser(editor, (tx) => tx`update public.trails set base_price_cents = 1 where id = ${trail.id}`)).rejects.toThrow(/Only admins/);
    // non-price edits by editors still work
    await withUser(editor, (tx) => tx`update public.trails set summary = summary where id = ${trail.id}`);
    const rows = await withUser(operator, (tx) => tx`update public.addons set price_cents = 1 returning id`);
    expect(rows).toHaveLength(0);
    await withUser(admin, (tx) => tx`update public.trails set base_price_cents = ${trail.basePriceCents} where id = ${trail.id}`);
  });

  it("content editors cannot approve or publish marketing drafts", async () => {
    const editor = await demoUser("editor");
    const trail = await trailBySlug("lantern-creek-loop");
    const [d] = await withUser(editor, (tx) =>
      tx<{ id: string }[]>`insert into public.marketing_drafts (trail_id, title, body, created_by) values (${trail.id}, 'T', 'B', ${editor.id}) returning id`,
    );
    await expect(
      withUser(editor, (tx) => tx`update public.marketing_drafts set status = 'published', approved_at = now() where id = ${d.id}`),
    ).rejects.toThrow(/Only admins and operators/);
    await expect(
      withUser(editor, (tx) => tx`insert into public.marketing_drafts (trail_id, title, body, status, approved_at) values (${trail.id}, 'T', 'B', 'approved', now())`),
    ).rejects.toThrow(/Only admins and operators/);
  });

  it("locker access-code material is not readable through the API roles", async () => {
    const operator = await demoUser("operator");
    await expect(withUser(operator, (tx) => tx`select access_code_hash from public.gear_reservations limit 1`)).rejects.toThrow(/permission denied/);
    await expect(withUser(operator, (tx) => tx`select access_code_hint from public.gear_reservations limit 1`)).rejects.toThrow(/permission denied/);
  });
});
