import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { closeDb, sql, withSystem } from "@/server/db";
import { getAvailability, setDayInventory } from "@/server/admin/availability";
import { createPermitRequirement, deletePermitRequirement } from "@/server/admin/permits";
import { updateTrailBasePrice } from "@/server/admin/pricing";
import { createTrail } from "@/server/admin/trails";
import { createClosure, endClosure, listClosureImpacts } from "@/server/admin/closures";
import { createAddon, getPricingData, updateAddon, type AddonCreateInput } from "@/server/admin/pricing";
import { getOverview } from "@/server/admin/overview";
import { HIGH_PRIORITY_QUEUE_HREF, listTickets } from "@/server/admin/support";
import { parsePage } from "@/server/admin/common";
import { loadOfferedAddons } from "@/server/commerce/checkout";
import { localDateInZone } from "@/lib/time";
import { createCustomer, demoUser, trailBySlug } from "../../helpers/db";
import { expectForbidden, expectOk } from "./helpers";

afterAll(closeDb);

async function lastAudit(action: string, entityId?: string) {
  const rows = await sql()<{ metadata: Record<string, unknown> }[]>`
    select metadata from public.audit_logs
    where action = ${action} and (${entityId ?? null}::text is null or entity_id = ${entityId ?? null}::text)
    order by id desc limit 1`;
  return rows[0];
}

describe("availability: empty capacity override", () => {
  it("stores NULL (trail default), so a note-only save does not close the day", async () => {
    const operator = await demoUser("operator");
    const trail = await trailBySlug("lantern-creek-loop");
    const avail = await getAvailability(operator, trail.id);
    const day = avail!.rows[9].day;

    const blocked = await setDayInventory(operator, trail.id, { day, capacity: "", blocked: true, note: "Crew day (capacity test)" });
    expectOk(blocked);
    const unblocked = await setDayInventory(operator, trail.id, { day, capacity: "", blocked: false, note: "" });
    expectOk(unblocked);
    expect(unblocked.message).toBe(`${day} saved (capacity ${trail.dailyCapacity}).`);
    const [row] = await sql()<{ capacity: number | null }[]>`select capacity from public.trail_day_inventory where trail_id = ${trail.id} and day = ${day}::date`;
    expect(row.capacity).toBeNull();
    const after = await getAvailability(operator, trail.id);
    expect(after!.rows[9]).toMatchObject({ capacityOverride: null, capacity: trail.dailyCapacity, blocked: false });
    expect(after!.rows[9].remaining).toBeGreaterThan(0);

    // an explicit 0 is still possible (and says so)
    const zero = await setDayInventory(operator, trail.id, { day, capacity: "0", blocked: false, note: "" });
    expectOk(zero);
    expect(zero.message).toBe(`${day} saved (capacity 0).`);
    expectOk(await setDayInventory(operator, trail.id, { day, capacity: "", blocked: false, note: "" }));
  });
});

describe("other blank number fields are never stored as 0", () => {
  it("a permit requirement with an empty lead time stores NULL (no lead time), and 0 stays 0", async () => {
    const admin = await demoUser("admin");
    const trail = await trailBySlug("whisper-falls");
    const base = {
      name: "Test day-use permit (blank lead time)",
      authority: "Test Land Agency",
      officialUrl: "https://example.org/permits",
      requirementSummary: "A free day-use permit is required for each car.",
      howToObtain: "",
      sourceId: "",
      verifiedAt: "",
    };
    const blank = await createPermitRequirement(admin, trail.id, { ...base, leadTimeDays: "" });
    expectOk(blank);
    const zero = await createPermitRequirement(admin, trail.id, { ...base, name: "Test day-use permit (zero lead time)", leadTimeDays: "0" });
    expectOk(zero);
    try {
      const rows = await sql()<{ id: string; leadTimeDays: number | null }[]>`
        select id, lead_time_days from public.permit_requirements where id = any(${[blank.data!.id, zero.data!.id]}::uuid[])`;
      expect(rows.find((r) => r.id === blank.data!.id)?.leadTimeDays).toBeNull();
      expect(rows.find((r) => r.id === zero.data!.id)?.leadTimeDays).toBe(0);
    } finally {
      for (const id of [blank.data!.id, zero.data!.id]) await deletePermitRequirement(admin, id);
    }
  });

  it("an empty trail base price is refused instead of setting the price to $0", async () => {
    const admin = await demoUser("admin");
    const trail = await trailBySlug("lantern-creek-loop");
    const [before] = await sql()<{ basePriceCents: number }[]>`select base_price_cents from public.trails where id = ${trail.id}`;
    const r = await updateTrailBasePrice(admin, trail.id, "");
    expect(r).toMatchObject({ ok: false, error: "Enter a price (0 for free)." });
    const [after] = await sql()<{ basePriceCents: number }[]>`select base_price_cents from public.trails where id = ${trail.id}`;
    expect(after.basePriceCents).toBe(before.basePriceCents);
  });

  it("a new trail with a blank trailhead or capacity is refused (never 0,0 or capacity 0)", async () => {
    const admin = await demoUser("admin");
    const input = {
      name: `Blank fields test ${Date.now() % 100000}`,
      summary: "",
      description: "",
      distanceKm: "3.2",
      elevationGainM: "120",
      difficulty: "easy" as const,
      routeType: "loop" as const,
      estimatedDurationMin: "75",
      trailheadName: "",
      trailheadLat: "45.1",
      trailheadLng: "-121.2",
      basePriceCents: "1500",
      dailyCapacity: "20",
      isDemo: true,
    };
    const lat = await createTrail(admin, { ...input, trailheadLat: "" });
    expect(lat).toMatchObject({ ok: false, error: "Enter the trailhead latitude." });
    const cap = await createTrail(admin, { ...input, dailyCapacity: " " });
    expect(cap).toMatchObject({ ok: false, error: "Enter the daily capacity." });
    const [{ n }] = await sql()<{ n: number }[]>`select count(*)::int as n from public.trails where name = ${input.name}`;
    expect(n).toBe(0);
  });
});

describe("closures list the bookings they affect", () => {
  it("lists upcoming paid bookings on days a full closure covers, with zone-correct day overlap", async () => {
    const admin = await demoUser("admin");
    const editor = await demoUser("editor");
    const trail = await trailBySlug("whisper-falls");
    const [{ timezone }] = await sql()<{ timezone: string }[]>`select r.timezone from public.trails t join public.regions r on r.id = t.region_id where t.id = ${trail.id}`;
    const today = localDateInZone(new Date(), timezone);
    const dayAt = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const D = dayAt(150);
    const owner = await createCustomer("closure-impact");
    const book = (date: string, status: string, party = 2) =>
      withSystem(async (tx) => {
        const [trip] = await tx<{ id: string }[]>`
          insert into public.trips (user_id, region_id, trail_id, planned_date, party_size, status)
          values (${owner.id}, ${trail.regionId}, ${trail.id}, ${date}::date, ${party}, 'booked') returning id`;
        const [b] = await tx<{ id: string }[]>`
          insert into public.bookings (user_id, trip_id, trail_id, hike_date, party_size, status, subtotal_cents, total_cents, payment_provider, idempotency_key)
          values (${owner.id}, ${trip.id}, ${trail.id}, ${date}::date, ${party}, ${status}, 0, 0, 'demo', ${`impact-${randomUUID()}`}) returning id`;
        return b.id;
      });
    const onDay = await book(D, "confirmed", 3);
    const cancelledOnDay = await book(D, "cancelled");
    const nextDay = await book(dayAt(151), "confirmed");
    const dayBefore = await book(dayAt(149), "confirmed");

    // D 06:00–18:00 local: only bookings on D
    const c = await createClosure(admin, trail.id, { severity: "closed", reason: "Bridge replacement (impact test)", sourceId: "", startsAt: `${D}T06:00`, endsAt: `${D}T18:00` });
    expectOk(c);
    // Other suites may hold bookings on the same far-future day: assert on this test's own bookings.
    expect(c.warnings?.join(" ")).toMatch(/upcoming paid booking.*on days this closure covers/);
    // ends exactly at local midnight of D: covers D-1 only (zone-correct boundary)
    const edge = await createClosure(admin, trail.id, { severity: "closed", reason: "Edge window (impact test)", sourceId: "", startsAt: `${dayAt(149)}T10:00`, endsAt: `${D}T00:00` });
    expectOk(edge);
    // advisories are not full closures
    const adv = await createClosure(admin, trail.id, { severity: "advisory", reason: "Muddy (impact test)", sourceId: "", startsAt: `${D}T06:00`, endsAt: `${D}T18:00` });
    expectOk(adv);

    try {
      const impacts = await listClosureImpacts(admin, trail.id);
      const mine = new Set([onDay, cancelledOnDay, nextDay, dayBefore]);
      const own = (id: string) => (impacts[id]?.bookings ?? []).filter((b) => mine.has(b.id));
      expect(impacts[c.data!.id].count).toBeGreaterThanOrEqual(1);
      expect(impacts[c.data!.id].hikers).toBeGreaterThanOrEqual(3);
      expect(own(c.data!.id).map((b) => b.id)).toEqual([onDay]);
      expect(own(c.data!.id)[0]).toMatchObject({ hikeDate: D, status: "confirmed", customerEmail: owner.email });
      expect(own(edge.data!.id).map((b) => b.id)).toEqual([dayBefore]);
      expect(impacts[adv.data!.id]).toBeUndefined();
      const all = Object.values(impacts).flatMap((i) => (i.bookings ?? []).map((b) => b.id));
      expect(all).not.toContain(cancelledOnDay);
      expect(all).not.toContain(nextDay);

      // content editors (no bookings.view) get counts, never customer details
      const forEditor = await listClosureImpacts(editor, trail.id);
      expect(forEditor[c.data!.id]).toMatchObject({ count: impacts[c.data!.id].count, hikers: impacts[c.data!.id].hikers, bookings: null });

      // ended closures no longer list anything
      expectOk(await endClosure(admin, c.data!.id));
      expect((await listClosureImpacts(admin, trail.id))[c.data!.id]).toBeUndefined();
    } finally {
      for (const id of [c.data!.id, edge.data!.id, adv.data!.id]) await withSystem((tx) => tx`delete from public.trail_closures where id = ${id}`);
    }
  });

  it("requires closures.manage", async () => {
    const support = await demoUser("support");
    const trail = await trailBySlug("whisper-falls");
    await expectForbidden(listClosureImpacts(support, trail.id));
  });
});

describe("add-on configuration", () => {
  const base = (over: Partial<AddonCreateInput> = {}): AddonCreateInput => ({
    code: `test-pack-${randomUUID().slice(0, 6)}`,
    kind: "meal_pack",
    name: "Test trail snack pack",
    description: "Snacks collected at the locker (simulated partner).",
    price: "9.50",
    pricingUnit: "per_person",
    dailyCapacity: "15",
    requiresCustomerConfirmation: false,
    regionId: "",
    active: true,
    ...over,
  });

  it("admins create and edit add-ons; changes are validated, audited and reach checkout", async () => {
    const admin = await demoUser("admin");
    const trail = await trailBySlug("lantern-creek-loop");
    const input = base();
    const created = await createAddon(admin, input);
    expectOk(created);
    const id = created.data!.id;
    try {
      const [row] = await sql()<{ code: string; providerKey: string; priceCents: number; dailyCapacity: number | null; regionId: string | null; pricingUnit: string }[]>`
        select code, provider_key, price_cents, daily_capacity, region_id, pricing_unit from public.addons where id = ${id}`;
      expect(row).toEqual({ code: input.code, providerKey: "demo", priceCents: 950, dailyCapacity: 15, regionId: null, pricingUnit: "per_person" });
      expect((await lastAudit("pricing.addon_created", id)).metadata).toMatchObject({ code: input.code, kind: "meal_pack", priceCents: 950, dailyCapacity: 15 });
      expect((await loadOfferedAddons(trail.regionId)).map((a) => a.code)).toContain(input.code);
      expect((await getPricingData(admin)).addons.find((a) => a.id === id)).toMatchObject({ description: input.description, regionName: null, requiresCustomerConfirmation: false });

      const edit = await updateAddon(admin, id, { ...base(), name: "Test snack pack (edited)", price: "11", pricingUnit: "per_booking", dailyCapacity: "", regionId: trail.regionId, requiresCustomerConfirmation: true });
      expectOk(edit);
      expect(edit.warnings?.join(" ")).toMatch(/keep the add-on price they were charged/);
      const audit = (await lastAudit("pricing.addon_updated", id)).metadata;
      expect(audit).toMatchObject({
        kind: "meal_pack",
        before: { priceCents: 950, pricingUnit: "per_person", dailyCapacity: 15, regionId: null },
        after: { name: "Test snack pack (edited)", priceCents: 1100, pricingUnit: "per_booking", dailyCapacity: null, regionId: trail.regionId, requiresCustomerConfirmation: true },
      });
      const offered = (await loadOfferedAddons(trail.regionId)).find((a) => a.code === input.code);
      expect(offered).toMatchObject({ priceCents: 1100, pricingUnit: "per_booking", dailyCapacity: null, requiresCustomerConfirmation: true });

      // deactivating removes it from checkout
      expectOk(await updateAddon(admin, id, { ...base(), regionId: trail.regionId, active: false }));
      expect((await loadOfferedAddons(trail.regionId)).map((a) => a.code)).not.toContain(input.code);
    } finally {
      await withSystem((tx) => tx`update public.addons set active = false where id = ${id}`);
    }
  });

  it("rejects invalid input and enforces product rules", async () => {
    const admin = await demoUser("admin");
    const dupCode = await createAddon(admin, base({ code: "meal-pack" }));
    expect(dupCode).toMatchObject({ ok: false });
    expect(dupCode.ok ? "" : dupCode.error).toMatch(/already used/);
    const shuttle = await createAddon(admin, base({ kind: "shuttle", requiresCustomerConfirmation: false }));
    expect(shuttle.ok ? "" : shuttle.error).toMatch(/pickup location, price and time/);
    expect((await createAddon(admin, base({ dailyCapacity: "0" }))).ok).toBe(false);
    expect((await createAddon(admin, base({ price: "" }))).ok).toBe(false);
    expect((await createAddon(admin, base({ price: "-2" }))).ok).toBe(false);
    expect((await createAddon(admin, base({ code: "Bad Code!" }))).ok).toBe(false);
    expect((await createAddon(admin, base({ kind: "other" as never }))).ok).toBe(false);
    expect((await createAddon(admin, base({ regionId: randomUUID() }))).ok).toBe(false);
    const [seeded] = await sql()<{ id: string }[]>`select id from public.addons where code = 'shuttle-trailhead'`;
    const off = await updateAddon(admin, seeded.id, { ...base(), requiresCustomerConfirmation: false });
    expect(off.ok ? "" : off.error).toMatch(/Shuttle add-ons must require customer confirmation/);
  });

  it("is admin-only (pricing.manage)", async () => {
    const operator = await demoUser("operator");
    const editor = await demoUser("editor");
    await expectForbidden(createAddon(operator, base()));
    await expectForbidden(updateAddon(editor, randomUUID(), base()));
  });
});

describe("overview", () => {
  const setHeartbeat = (minutesAgo: number) =>
    withSystem(
      (tx) => tx`
        insert into public.app_settings (key, value, description)
        values ('job_runner_heartbeat', ${tx.json({ at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), summary: {} })}, 'test')
        on conflict (key) do update set value = excluded.value`,
    );

  it("warns when background jobs have not run, to the roles that depend on them", async () => {
    const admin = await demoUser("admin");
    const safety = await demoUser("safety");
    const support = await demoUser("support");
    try {
      await setHeartbeat(20);
      const o = await getOverview(admin);
      const a = o.alerts.find((x) => x.key === "jobRunner");
      expect(a?.title).toBe("Background jobs have not run for 20 min — check-in reminders and overdue notices are delayed");
      expect(o.alerts[0].key).toBe("jobRunner");
      expect(a?.href).toBe("/admin/jobs");
      expect((await getOverview(safety)).alerts.find((x) => x.key === "jobRunner")?.href).toBe("/status");
      const forSupport = await getOverview(support);
      expect(forSupport.runner).toBeNull();
      expect(forSupport.alerts.find((x) => x.key === "jobRunner")).toBeUndefined();

      await setHeartbeat(1);
      const fresh = await getOverview(admin);
      expect(fresh.runner?.stale).toBe(false);
      expect(fresh.alerts.find((x) => x.key === "jobRunner")).toBeUndefined();
    } finally {
      await withSystem((tx) => tx`delete from public.app_settings where key = 'job_runner_heartbeat'`);
    }
  });

  it("the high-priority ticket card links to exactly the tickets it counts; titles have no (s) and refunds show currency", async () => {
    const admin = await demoUser("admin");
    const customer = await createCustomer("tickets");
    await withSystem(
      (tx) => tx`
        insert into public.support_tickets (user_id, subject, body, status, priority) values
          (${customer.id}, 'High open (test)', 'x', 'open', 'high'),
          (${customer.id}, 'Urgent pending (test)', 'x', 'pending', 'urgent'),
          (${customer.id}, 'Urgent resolved (test)', 'x', 'resolved', 'urgent'),
          (${customer.id}, 'Normal open (test)', 'x', 'open', 'normal')`,
    );
    const o = await getOverview(admin);
    const card = o.alerts.find((a) => a.key === "tickets")!;
    expect(card.href).toBe(HIGH_PRIORITY_QUEUE_HREF);
    const q = new URL(card.href, "http://x").searchParams;
    const linked = await listTickets(admin, { status: q.get("status") ?? undefined, priority: q.get("priority") ?? undefined }, parsePage({ limit: 100 }));
    const count = Number(/^(\d+) /.exec(card.title)?.[1]);
    expect(linked.total).toBe(count);
    expect(linked.rows.every((t) => t.status !== "resolved" && (t.priority === "high" || t.priority === "urgent"))).toBe(true);
    expect(linked.rows.map((t) => t.subject)).toEqual(expect.arrayContaining(["High open (test)", "Urgent pending (test)"]));
    for (const a of o.alerts) expect(a.title).not.toContain("(s)");
    expect(o.kpis.find((k) => k.key === "revenue7d")?.hint).toMatch(/\$\d+\.\d{2} refunded/);
    await withSystem((tx) => tx`delete from public.support_tickets where user_id = ${customer.id}`);
  });
});
