import { afterAll, describe, expect, it } from "vitest";
import { closeDb, sql, withSystem, withUser } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { parsePage } from "@/server/admin/common";
import { savePricingRule, updateTrailBasePrice, updateAddon, createAddon, getPricingData, deletePricingRule } from "@/server/admin/pricing";
import { setFlag, listFlags } from "@/server/admin/feature-flags";
import { grantStaffRole, listStaff, revokeStaffRole } from "@/server/admin/staff";
import { getCustomerDetail, revealCustomerSensitive, searchCustomers } from "@/server/admin/customers";
import { listActiveHikes, listNotifications, revealHikeLocation } from "@/server/admin/safety";
import { cancelJobAsStaff, listJobs, retryJobAsStaff, listIntegrationEvents } from "@/server/admin/jobs";
import { createTrail, listAdminTrails, setTrailStatus, updateTrailFact } from "@/server/admin/trails";
import { approveNarration, listNarrations } from "@/server/admin/content";
import { createClosure } from "@/server/admin/closures";
import { listBookings, getBookingDetail } from "@/server/admin/bookings";
import { getGearOverview, setReservationStatus } from "@/server/admin/gear";
import { listFulfillments } from "@/server/admin/fulfillment";
import { getAvailability, setDayInventory } from "@/server/admin/availability";
import { generateMarketingDraft, publishMarketingDraft, approveMarketingDraft } from "@/server/admin/marketing";
import { listUpcomingTripPermits, updateTripPermit, createPermitRequirement } from "@/server/admin/permits";
import { listTickets, updateTicket } from "@/server/admin/support";
import { listAuditLogs } from "@/server/admin/audit-log";
import { getOverview } from "@/server/admin/overview";
import { uploadRouteFile } from "@/server/admin/route-files";
import { createCustomer, demoUser, trailBySlug } from "../../helpers/db";
import { enc, expectForbidden, expectOk } from "./helpers";

afterAll(closeDb);

const page = parsePage();
const ZERO = "00000000-0000-4000-8000-000000000000";
const rule = {
  name: "Test rule",
  kind: "flat_fee" as const,
  value: "100",
  threshold: "",
  minParty: "",
  dates: "",
  scope: "global" as const,
  regionId: "",
  trailId: "",
  priority: "50",
  effectiveFrom: "",
  effectiveTo: "",
  active: false,
};

async function activeSessionFor(user: SessionUser) {
  const trail = await trailBySlug("lantern-creek-loop");
  return withSystem(async (tx) => {
    const [trip] = await tx<{ id: string }[]>`
      insert into public.trips (user_id, region_id, trail_id, status, planned_date, start_time) values (${user.id}, ${trail.regionId}, ${trail.id}, 'active', current_date, '09:00') returning id`;
    const [s] = await tx<{ id: string }[]>`
      insert into public.hike_sessions (trip_id, user_id, status, last_sync_at, last_location_at) values (${trip.id}, ${user.id}, 'active', now(), now()) returning id`;
    await tx`insert into public.hike_last_locations (hike_session_id, user_id, lat, lng, accuracy_m, recorded_at) values (${s.id}, ${user.id}, 47.5051, -121.7019, 8, now())`;
    return s.id;
  });
}

describe("admin RBAC matrix", () => {
  it("support cannot change pricing, nor see precise locations or emergency contacts", async () => {
    const support = await demoUser("support");
    const hiker = await demoUser("hiker");
    const trail = await trailBySlug("lantern-creek-loop");
    await expectForbidden(savePricingRule(support, null, rule));
    await expectForbidden(updateTrailBasePrice(support, trail.id, "10"));
    await expectForbidden(getPricingData(support));
    await expectForbidden(revealCustomerSensitive(support, hiker.id, "checking on the customer"));
    await expectForbidden(revealHikeLocation(support, ZERO, "check"));
    await expectForbidden(listActiveHikes(support));
    await expectForbidden(listNotifications(support, {}, page));

    // support CAN view customers, but the detail is flagged restricted and RLS returns no contacts
    const detail = await getCustomerDetail(support, hiker.id);
    expect(detail?.canSeeSensitive).toBe(false);
    const contacts = await withUser(support, (tx) => tx`select id from public.emergency_contacts where user_id = ${hiker.id}`);
    expect(contacts).toHaveLength(0);
    // defense in depth: even a direct write to pricing through RLS changes nothing
    const updated = await withUser(support, (tx) => tx`update public.pricing_rules set value = 99 returning id`);
    expect(updated).toHaveLength(0);
  });

  it("safety and admin can reveal a precise location; the access is audited", async () => {
    const safety = await demoUser("safety");
    const hiker = await createCustomer("located");
    const sessionId = await activeSessionFor(hiker);
    await expect(revealHikeLocation(safety, sessionId, "")).resolves.toMatchObject({ ok: false });
    const r = await revealHikeLocation(safety, sessionId, "Overdue follow-up");
    expectOk(r);
    expect(r.data?.lat).toBeCloseTo(47.5051, 4);
    const [a] = await sql()<{ action: string; actorId: string }[]>`
      select action, actor_id from public.audit_logs where entity_type = 'hike_session' and entity_id = ${sessionId} order by id desc limit 1`;
    expect(a).toMatchObject({ action: "safety.view_location", actorId: safety.id });
    // operators may monitor hikes but not see coordinates
    const operator = await demoUser("operator");
    expect((await listActiveHikes(operator)).some((h) => h.id === sessionId)).toBe(true);
    await expectForbidden(revealHikeLocation(operator, sessionId, "curious"));
  });

  it("content editors cannot change flags or pricing", async () => {
    const editor = await demoUser("editor");
    const trail = await trailBySlug("lantern-creek-loop");
    await expectForbidden(setFlag(editor, "checkout_enabled", false));
    await expectForbidden(listFlags(editor));
    await expectForbidden(savePricingRule(editor, null, rule));
    await expectForbidden(updateTrailBasePrice(editor, trail.id, "12"));
    const addon = { name: "Snack pack", description: "", price: "1", pricingUnit: "per_person", dailyCapacity: "", requiresCustomerConfirmation: false, regionId: "", active: true } as const;
    await expectForbidden(updateAddon(editor, ZERO, addon));
    await expectForbidden(createAddon(editor, { ...addon, code: "snack-pack", kind: "meal_pack" }));
    await expectForbidden(listBookings(editor, {}, page));
    // but they can work on trails and content
    expect((await listAdminTrails(editor)).length).toBeGreaterThan(0);
    expect((await listNarrations(editor, {}, page)).rows.length).toBeGreaterThan(0);
  });

  it("operators cannot manage flags or staff", async () => {
    const operator = await demoUser("operator");
    await expectForbidden(setFlag(operator, "checkout_enabled", false));
    await expectForbidden(grantStaffRole(operator, { email: "hiker@demo.ghostguide.test", role: "admin" }));
    await expectForbidden(revokeStaffRole(operator, ZERO, "admin"));
    await expectForbidden(listStaff(operator));
    await expectForbidden(listAuditLogs(operator, {}, page));
    await expectForbidden(savePricingRule(operator, null, rule));
    // operators can run operations
    expect((await listJobs(operator, {}, page)).rows).toBeDefined();
    expect((await getGearOverview(operator)).lockers.length).toBeGreaterThan(0);
  });

  it("operators can edit trail facts with provenance (RLS aligned with trails.manage)", async () => {
    const operator = await demoUser("operator");
    const trail = await trailBySlug("miners-meadow-loop");
    const r = await updateTrailFact(operator, trail.id, { field: "parking_info", value: "Gravel lot (demo, updated)", kind: "operator_note", sourceId: "", verifiedAt: "", note: "Updated by test" });
    expectOk(r);
    const [p] = await sql()<{ kind: string; verifiedBy: string }[]>`
      select kind, verified_by from public.trail_field_provenance where trail_id = ${trail.id} and field = 'parking_info'`;
    expect(p).toMatchObject({ kind: "operator_note", verifiedBy: operator.id });
  });

  it("a customer cannot call any admin use-case", async () => {
    const c = await createCustomer("not-staff");
    const trail = await trailBySlug("lantern-creek-loop");
    const calls: (() => Promise<unknown>)[] = [
      () => getOverview(c),
      () => listAdminTrails(c),
      () => createTrail(c, {} as never),
      () => updateTrailFact(c, trail.id, { field: "distance_km", value: "1", kind: "demo" }),
      () => setTrailStatus(c, trail.id, "draft"),
      () => uploadRouteFile(c, trail.id, { filename: "x.geojson", bytes: enc("{}") }),
      () => createClosure(c, trail.id, { severity: "closed", reason: "nope nope", sourceId: "", startsAt: "", endsAt: "" }),
      () => createPermitRequirement(c, trail.id, {} as never),
      () => listNarrations(c, {}, page),
      () => approveNarration(c, ZERO, { sourceId: ZERO, sourceCitation: "x" }),
      () => searchCustomers(c, "", page),
      () => getCustomerDetail(c, c.id),
      () => revealCustomerSensitive(c, c.id, "because"),
      () => listBookings(c, {}, page),
      () => getBookingDetail(c, ZERO),
      () => getGearOverview(c),
      () => setReservationStatus(c, ZERO, "returned"),
      () => listFulfillments(c, {}, page),
      () => listActiveHikes(c),
      () => revealHikeLocation(c, ZERO, "because"),
      () => listNotifications(c, {}, page),
      () => listJobs(c, {}, page),
      () => retryJobAsStaff(c, 1),
      () => cancelJobAsStaff(c, 1),
      () => listIntegrationEvents(c, {}, page),
      () => getPricingData(c),
      () => savePricingRule(c, null, rule),
      () => deletePricingRule(c, ZERO),
      () => getAvailability(c, trail.id),
      () => setDayInventory(c, trail.id, { day: "2030-01-01", capacity: "", blocked: false, note: "" }),
      () => listFlags(c),
      () => setFlag(c, "checkout_enabled", false),
      () => generateMarketingDraft(c, { trailId: trail.id, channel: "web" }),
      () => approveMarketingDraft(c, ZERO, true),
      () => publishMarketingDraft(c, ZERO),
      () => listUpcomingTripPermits(c),
      () => updateTripPermit(c, ZERO, ZERO, { status: "obtained" }),
      () => listTickets(c, {}, page),
      () => updateTicket(c, ZERO, { status: "open", priority: "low", assignedTo: "" }),
      () => listStaff(c),
      () => grantStaffRole(c, { email: c.email, role: "admin" }),
      () => revokeStaffRole(c, ZERO, "admin"),
      () => listAuditLogs(c, {}, page),
    ];
    for (const call of calls) await expectForbidden(call());
    const roles = await sql()`select * from public.staff_roles where user_id = ${c.id}`;
    expect(roles).toHaveLength(0);
  });
});
