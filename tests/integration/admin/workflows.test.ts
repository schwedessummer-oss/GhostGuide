import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { closeDb, sql, withSystem } from "@/server/db";
import { parsePage } from "@/server/admin/common";
import { listFlags, setFlag } from "@/server/admin/feature-flags";
import { grantStaffRole, revokeStaffRole } from "@/server/admin/staff";
import { cancelJobAsStaff, retryJobAsStaff } from "@/server/admin/jobs";
import { opsHandlers } from "@/server/jobs/handlers/ops";
import { enqueueJob, runDueJobs } from "@/server/jobs/queue";
import { listAuditLogs } from "@/server/admin/audit-log";
import { demoUser } from "../../helpers/db";
import { expectOk } from "./helpers";

afterAll(closeDb);

async function lastAudit(action: string, entityId?: string) {
  const rows = await sql()<{ action: string; actorId: string; actorRoles: string[]; entityId: string; metadata: Record<string, unknown> }[]>`
    select action, actor_id, actor_roles, entity_id, metadata from public.audit_logs
    where action = ${action} and (${entityId ?? null}::text is null or entity_id = ${entityId ?? null}::text)
    order by id desc limit 1`;
  return rows[0];
}

describe("audit entries for sensitive actions", () => {
  it("records flag, role and job-retry changes with the actor", async () => {
    const admin = await demoUser("admin");
    const operator = await demoUser("operator");

    // No flags are seeded: toggle a test flag row.
    const flagKey = `test_flag_${randomUUID().slice(0, 6)}`;
    await withSystem((tx) => tx`insert into public.feature_flags (key, enabled, description) values (${flagKey}, true, 'Test flag')`);
    try {
      expect((await listFlags(admin)).find((f) => f.key === flagKey)).toMatchObject({ enabled: true, known: false });
      expectOk(await setFlag(admin, flagKey, false));
      const flag = await lastAudit("flag.toggled", flagKey);
      expect(flag).toMatchObject({ actorId: admin.id, metadata: { from: true, to: false } });
      expect(flag.actorRoles).toContain("admin");
      expectOk(await setFlag(admin, flagKey, true));
      expect((await setFlag(admin, "no_such_flag", true)).ok).toBe(false);
    } finally {
      await withSystem((tx) => tx`delete from public.feature_flags where key = ${flagKey}`);
    }

    expectOk(await grantStaffRole(admin, { email: "support@demo.ghostguide.test", role: "content_editor" }));
    const support = await demoUser("support");
    expect((await lastAudit("staff.role_granted", support.id)).metadata).toMatchObject({ role: "content_editor" });
    expectOk(await revokeStaffRole(admin, support.id, "content_editor"));
    expect((await lastAudit("staff.role_revoked", support.id)).metadata).toMatchObject({ role: "content_editor" });

    const kind = `test.audit.${randomUUID().slice(0, 6)}`;
    const { id } = await enqueueJob(null, kind, {}, { maxAttempts: 1 });
    await runDueJobs({ [kind]: async () => { throw new Error("boom"); } }, { kinds: [kind] });
    const [dead] = await sql()<{ status: string }[]>`select status from public.jobs where id = ${id}`;
    expect(dead.status).toBe("dead");
    expectOk(await retryJobAsStaff(operator, id));
    const [requeued] = await sql()<{ status: string }[]>`select status from public.jobs where id = ${id}`;
    expect(requeued.status).toBe("queued");
    expect(await lastAudit("job.retried", String(id))).toMatchObject({ actorId: operator.id, metadata: { kind, from: "dead" } });
    // a queued job cannot be "retried", but can be cancelled (audited)
    expect((await retryJobAsStaff(operator, id)).ok).toBe(false);
    expectOk(await cancelJobAsStaff(operator, id));
    expect((await lastAudit("job.cancelled", String(id))).actorId).toBe(operator.id);

    // admins can read the audit log through the viewer (RLS)
    const page = await listAuditLogs(admin, { action: "job." }, parsePage());
    expect(page.rows.some((r) => r.entityId === String(id))).toBe(true);
  });

  it("the seeded dead job can be retried from the queue", async () => {
    const admin = await demoUser("admin");
    const [job] = await sql()<{ id: number }[]>`select id from public.jobs where dedup_key = 'seed:admin:dead-job-example'`;
    expectOk(await retryJobAsStaff(admin, job.id));
    const s = await runDueJobs(opsHandlers, { kinds: ["ops.purge_rate_limits"] });
    expect(s.succeeded).toBeGreaterThanOrEqual(1);
    const [after] = await sql()<{ status: string }[]>`select status from public.jobs where id = ${job.id}`;
    expect(after.status).toBe("succeeded");
  });
});

describe("staff roles", () => {
  it("cannot remove the last remaining admin (use-case and database)", async () => {
    const admin = await demoUser("admin");
    const [{ n }] = await sql()<{ n: number }[]>`select count(*)::int as n from public.staff_roles where role = 'admin'`;
    expect(n).toBe(1);
    const r = await revokeStaffRole(admin, admin.id, "admin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/last remaining admin/);
    await expect(withSystem((tx) => tx`delete from public.staff_roles where user_id = ${admin.id} and role = 'admin'`)).rejects.toThrow(/last remaining admin/);

    // with a second admin, removal works (and the remaining one is protected again)
    expectOk(await grantStaffRole(admin, { email: "operator@demo.ghostguide.test", role: "admin" }));
    const operator = await demoUser("operator");
    expectOk(await revokeStaffRole(admin, operator.id, "admin"));
    const [{ n: after }] = await sql()<{ n: number }[]>`select count(*)::int as n from public.staff_roles where role = 'admin'`;
    expect(after).toBe(1);
    expect((await grantStaffRole(admin, { email: "nobody@nowhere.test", role: "support" })).ok).toBe(false);
  });
});
