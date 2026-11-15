import { afterAll, describe, expect, it } from "vitest";
import { closeDb, sql } from "@/server/db";
import { parsePage } from "@/server/admin/common";
import { setFlag, listFlags } from "@/server/admin/feature-flags";
import { grantStaffRole, listStaff, revokeStaffRole } from "@/server/admin/staff";
import { getCustomerDetail, searchCustomers } from "@/server/admin/customers";
import { cancelJobAsStaff, listJobs, retryJobAsStaff, listIntegrationEvents } from "@/server/admin/jobs";
import { listTickets, updateTicket } from "@/server/admin/support";
import { listAuditLogs } from "@/server/admin/audit-log";
import { getOverview } from "@/server/admin/overview";
import { createCustomer, demoUser } from "../../helpers/db";
import { expectForbidden } from "./helpers";

afterAll(closeDb);

const page = parsePage();
const ZERO = "00000000-0000-4000-8000-000000000000";

describe("admin RBAC matrix", () => {
  it("support can view customers and work tickets, but not flags, jobs or staff", async () => {
    const support = await demoUser("support");
    const hiker = await demoUser("hiker");
    const detail = await getCustomerDetail(support, hiker.id);
    expect(detail?.profile.email).toBe(hiker.email);
    expect((await listTickets(support, {}, page)).rows.length).toBeGreaterThan(0);
    await expectForbidden(listFlags(support));
    await expectForbidden(setFlag(support, "any_flag", false));
    await expectForbidden(listJobs(support, {}, page));
    await expectForbidden(listStaff(support));
  });

  it("content editors cannot change flags, view customers or run jobs", async () => {
    const editor = await demoUser("editor");
    await expectForbidden(setFlag(editor, "any_flag", false));
    await expectForbidden(listFlags(editor));
    await expectForbidden(searchCustomers(editor, "", page));
    await expectForbidden(listJobs(editor, {}, page));
    await expectForbidden(listTickets(editor, {}, page));
    // but they can open the admin overview
    expect((await getOverview(editor)).kpis).toBeDefined();
  });

  it("operators cannot manage flags or staff", async () => {
    const operator = await demoUser("operator");
    await expectForbidden(setFlag(operator, "any_flag", false));
    await expectForbidden(grantStaffRole(operator, { email: "hiker@demo.ghostguide.test", role: "admin" }));
    await expectForbidden(revokeStaffRole(operator, ZERO, "admin"));
    await expectForbidden(listStaff(operator));
    await expectForbidden(listAuditLogs(operator, {}, page));
    // operators can run operations
    expect((await listJobs(operator, {}, page)).rows).toBeDefined();
    expect((await listIntegrationEvents(operator, {}, page)).rows).toBeDefined();
  });

  it("a customer cannot call any admin use-case", async () => {
    const c = await createCustomer("not-staff");
    const calls: (() => Promise<unknown>)[] = [
      () => getOverview(c),
      () => searchCustomers(c, "", page),
      () => getCustomerDetail(c, c.id),
      () => listJobs(c, {}, page),
      () => retryJobAsStaff(c, 1),
      () => cancelJobAsStaff(c, 1),
      () => listIntegrationEvents(c, {}, page),
      () => listFlags(c),
      () => setFlag(c, "any_flag", false),
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
