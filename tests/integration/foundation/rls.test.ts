import { afterAll, describe, expect, it } from "vitest";
import { closeDb, withAnon, withSystem, withUser } from "@/server/db";
import { createCustomer } from "../../helpers/db";

afterAll(closeDb);

describe("row-level security", () => {
  it("server-only tables are not readable by API roles", async () => {
    const alice = await createCustomer("alice");
    await expect(withUser(alice, (tx) => tx`select * from public.jobs limit 1`)).rejects.toThrow(/permission denied/);
    await expect(withUser(alice, (tx) => tx`select * from public.webhook_events limit 1`)).rejects.toThrow(/permission denied/);
    await expect(withAnon((tx) => tx`select * from public.rate_limits limit 1`)).rejects.toThrow(/permission denied/);
  });

  it("anonymous visitors never see audit logs", async () => {
    const audit = await withAnon((tx) => tx`select * from public.audit_logs`);
    expect(audit).toHaveLength(0);
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
