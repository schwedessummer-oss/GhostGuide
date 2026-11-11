import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fieldLabel, zodFail } from "@/server/admin/common";
import { capacityOverrideSchema } from "@/server/admin/availability";
import { addonCapacitySchema, addonRuleCheck } from "@/server/admin/pricing";
import { plural, runnerAlert } from "@/server/admin/overview";
import { blankAsNull, notBlank } from "@/server/admin/number-fields";
import { parseFactValue } from "@/server/admin/trail-fields";
import { formatAdminDateTime } from "@/components/admin/time";

describe("availability capacity override", () => {
  it("empty or blank means no override (NULL), not capacity 0", () => {
    expect(capacityOverrideSchema.parse("")).toBeNull();
    expect(capacityOverrideSchema.parse("   ")).toBeNull();
    expect(capacityOverrideSchema.parse(undefined)).toBeNull();
  });

  it("an explicit number is kept, including 0", () => {
    expect(capacityOverrideSchema.parse("0")).toBe(0);
    expect(capacityOverrideSchema.parse("12")).toBe(12);
    expect(capacityOverrideSchema.parse(" 7 ")).toBe(7);
  });

  it("rejects negatives, fractions, text and huge values", () => {
    for (const v of ["-1", "2.5", "abc", "1001"]) expect(capacityOverrideSchema.safeParse(v).success, v).toBe(false);
  });
});

describe("form errors never show internal field keys", () => {
  const schema = z.object({ sourceId: z.string().min(1, "Choose the source this narration is based on."), effectiveTo: z.number(), minParty: z.number() });

  it("custom messages are used as written", () => {
    const r = schema.safeParse({ sourceId: "", effectiveTo: 1, minParty: 2 });
    if (r.success) throw new Error("expected failure");
    const f = zodFail(r.error);
    expect(f.error).toBe("Choose the source this narration is based on.");
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
    expect(plural(0, "check-in")).toBe("0 check-ins");
  });

  it("alerts when the job runner is stale, with the delay and its consequence", () => {
    const now = new Date("2026-11-11T12:00:00Z");
    const stale = runnerAlert({ lastRunAt: new Date(now.getTime() - 17 * 60_000), minutesSinceRun: 17, stale: true }, true);
    expect(stale?.title).toBe("Background jobs have not run for 17 min — check-in reminders and overdue notices are delayed");
    expect(stale?.href).toBe("/admin/jobs");
    expect(runnerAlert({ lastRunAt: null, minutesSinceRun: null, stale: true }, false)?.href).toBe("/status");
    expect(runnerAlert({ lastRunAt: now, minutesSinceRun: 1, stale: false }, true)).toBeNull();
  });
});

describe("blank number fields are never stored as 0", () => {
  const n = z.coerce.number("Enter a number").int().min(0).max(365);
  it("blankAsNull: blank → null, numbers (including 0) kept", () => {
    const s = blankAsNull(n);
    for (const v of ["", "  ", null, undefined]) expect(s.parse(v), String(v)).toBeNull();
    expect(s.parse("0")).toBe(0);
    expect(s.parse(" 14 ")).toBe(14);
    expect(s.parse(3)).toBe(3);
    expect(s.safeParse("x").success).toBe(false);
  });
  it("notBlank: blank is an error with the given message, 0 is allowed", () => {
    const s = notBlank(n, "Enter the lead time.");
    for (const v of ["", "  ", null, undefined]) {
      const r = s.safeParse(v);
      expect(r.success, String(v)).toBe(false);
      expect(r.error?.issues[0]?.message).toBe("Enter the lead time.");
    }
    expect(s.parse("0")).toBe(0);
    expect(s.parse(" 7")).toBe(7);
  });
  it("a blank trailhead location or elevation is rejected, not saved as 0", () => {
    expect(parseFactValue("trailhead_location", { lat: "", lng: "" }).ok).toBe(false);
    expect(parseFactValue("trailhead_location", { lat: "45.5", lng: "-121.7" })).toEqual({ ok: true, value: { trailhead_lat: 45.5, trailhead_lng: -121.7 } });
    expect(parseFactValue("elevation_gain_m", { value: "" }).ok).toBe(false);
    expect(parseFactValue("elevation_gain_m", { value: "0" })).toEqual({ ok: true, value: { elevation_gain_m: 0 } });
    expect(parseFactValue("distance_km", { value: " " }).ok).toBe(false);
  });
});

describe("admin times carry a zone label", () => {
  it("uses the trail region's zone when given", () => {
    expect(formatAdminDateTime("2026-11-05T02:29:00Z", "America/Los_Angeles")).toBe("Nov 4, 2026, 6:29 PM PST");
  });
  it("labels UTC otherwise (never the server's implicit zone)", () => {
    expect(formatAdminDateTime("2026-11-05T02:29:00Z")).toBe("Nov 5, 2026, 2:29 AM UTC");
  });
});

describe("add-on configuration rules", () => {
  it("daily capacity: empty = no limit, otherwise a positive whole number", () => {
    expect(addonCapacitySchema.parse("")).toBeNull();
    expect(addonCapacitySchema.parse("20")).toBe(20);
    for (const v of ["0", "-3", "1.5", "x"]) expect(addonCapacitySchema.safeParse(v).success, v).toBe(false);
  });

  it("a shuttle always requires customer confirmation", () => {
    expect(addonRuleCheck("shuttle", { requiresCustomerConfirmation: false, description: "" }).error).toMatch(/pickup location, price and time/);
    expect(addonRuleCheck("shuttle", { requiresCustomerConfirmation: true, description: "" }).error).toBeUndefined();
    expect(addonRuleCheck("meal_pack", { requiresCustomerConfirmation: false, description: "" }).error).toBeUndefined();
  });

  it("a satellite device rental must say Ghost Guide does not provide SOS", () => {
    expect(addonRuleCheck("satellite_device", { requiresCustomerConfirmation: false, description: "Two-way messenger." }).warnings.join(" ")).toMatch(/does not provide SOS/);
    expect(addonRuleCheck("satellite_device", { requiresCustomerConfirmation: false, description: "Ghost Guide does not provide SOS service." }).warnings).toEqual([]);
  });
});
