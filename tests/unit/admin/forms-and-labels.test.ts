import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fieldLabel, zodFail } from "@/server/admin/common";
import { plural, runnerAlert } from "@/server/admin/overview";
import { formatAdminDateTime } from "@/components/admin/time";

describe("form errors never show internal field keys", () => {
  const schema = z.object({ sourceId: z.string().min(1, "Choose the source for this value."), effectiveTo: z.number(), minParty: z.number() });

  it("custom messages are used as written", () => {
    const r = schema.safeParse({ sourceId: "", effectiveTo: 1, minParty: 2 });
    if (r.success) throw new Error("expected failure");
    const f = zodFail(r.error);
    expect(f.error).toBe("Choose the source for this value.");
    expect(f.error).not.toMatch(/sourceId/);
  });

  it("generic zod messages get a readable label instead of the key", () => {
    const r = schema.safeParse({ sourceId: "x", effectiveTo: "soon", minParty: 2 });
    if (r.success) throw new Error("expected failure");
    const f = zodFail(r.error);
    expect(f.error).toMatch(/^Effective to: Invalid input/);
    for (const msgs of Object.values(f.fieldErrors)) for (const m of msgs) expect(m).not.toMatch(/[a-z][A-Z]/);
  });

  it("labels", () => {
    expect(fieldLabel(["sourceId"])).toBe("Source");
    expect(fieldLabel(["effectiveTo"])).toBe("Effective to");
    expect(fieldLabel(["items", 2, "minParty"])).toBe("Min party");
  });
});

describe("overview copy", () => {
  it("pluralizes without (s)", () => {
    expect(plural(1, "dead job")).toBe("1 dead job");
    expect(plural(2, "dead job")).toBe("2 dead jobs");
    expect(plural(0, "ticket")).toBe("0 tickets");
  });

  it("alerts when the job runner is stale, with the delay and its consequence", () => {
    const now = new Date("2026-11-11T12:00:00Z");
    const stale = runnerAlert({ lastRunAt: new Date(now.getTime() - 17 * 60_000), minutesSinceRun: 17, stale: true }, true);
    expect(stale?.title).toBe("Background jobs have not run for 17 min — background work is delayed");
    expect(stale?.href).toBe("/admin/jobs");
    expect(runnerAlert({ lastRunAt: null, minutesSinceRun: null, stale: true }, false)?.href).toBe("/status");
    expect(runnerAlert({ lastRunAt: now, minutesSinceRun: 1, stale: false }, true)).toBeNull();
  });
});

describe("admin times carry a zone label", () => {
  it("uses the given zone", () => {
    expect(formatAdminDateTime("2026-11-05T02:29:00Z", "America/Los_Angeles")).toBe("Nov 4, 2026, 6:29 PM PST");
  });
  it("labels UTC otherwise (never the server's implicit zone)", () => {
    expect(formatAdminDateTime("2026-11-05T02:29:00Z")).toBe("Nov 5, 2026, 2:29 AM UTC");
  });
});
