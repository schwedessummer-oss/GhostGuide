import { afterAll, describe, expect, it } from "vitest";
import { closeDb, withSystem } from "@/server/db";
import { getOverview } from "@/server/admin/overview";
import { HIGH_PRIORITY_QUEUE_HREF, listTickets } from "@/server/admin/support";
import { parsePage } from "@/server/admin/common";
import { createCustomer, demoUser } from "../../helpers/db";

afterAll(closeDb);

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
    const support = await demoUser("support");
    try {
      await setHeartbeat(20);
      const o = await getOverview(admin);
      const a = o.alerts.find((x) => x.key === "jobRunner");
      expect(a?.title).toBe("Background jobs have not run for 20 min — background work is delayed");
      expect(o.alerts[0].key).toBe("jobRunner");
      expect(a?.href).toBe("/admin/jobs");
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

  it("the high-priority ticket card links to exactly the tickets it counts; titles have no (s)", async () => {
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
    await withSystem((tx) => tx`delete from public.support_tickets where user_id = ${customer.id}`);
  });
});
