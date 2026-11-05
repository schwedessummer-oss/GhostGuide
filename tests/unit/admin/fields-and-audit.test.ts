import { describe, expect, it } from "vitest";
import { parseFactValue } from "@/server/admin/trail-fields";
import { sanitizeAuditMetadata, parsePage, likePattern, localDateTimeToUtc } from "@/server/admin/common";
import { reconciliationHints } from "@/server/admin/bookings";

describe("trail fact parsing", () => {
  it("parses each field type", () => {
    expect(parseFactValue("distance_km", { value: "7.25" })).toEqual({ ok: true, value: { distance_km: 7.25 } });
    expect(parseFactValue("max_elevation_m", { value: "" })).toEqual({ ok: true, value: { max_elevation_m: null } });
    expect(parseFactValue("difficulty", { value: "hard" })).toEqual({ ok: true, value: { difficulty: "hard" } });
    expect(parseFactValue("terrain", { values: ["forest", "ridge", "forest"] })).toEqual({ ok: true, value: { terrain: ["forest", "ridge"] } });
    expect(parseFactValue("dogs_allowed", { value: "unknown" })).toEqual({ ok: true, value: { dogs_allowed: null } });
    expect(parseFactValue("permit_required", { value: "yes" })).toEqual({ ok: true, value: { permit_required: true } });
    expect(parseFactValue("trailhead_location", { lat: "47.5", lng: "-121.7" })).toEqual({ ok: true, value: { trailhead_lat: 47.5, trailhead_lng: -121.7 } });
  });

  it("rejects invalid values", () => {
    expect(parseFactValue("distance_km", { value: "-1" }).ok).toBe(false);
    expect(parseFactValue("difficulty", { value: "extreme" }).ok).toBe(false);
    expect(parseFactValue("terrain", { values: ["lava"] }).ok).toBe(false);
    expect(parseFactValue("estimated_duration_min", { value: "1.5" }).ok).toBe(false);
    expect(parseFactValue("trailhead_location", { lat: "100", lng: "0" }).ok).toBe(false);
  });
});

describe("audit metadata sanitizer", () => {
  it("keeps ids and dates intact but redacts contact details and coordinates", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const out = sanitizeAuditMetadata({
      closureId: id,
      day: "2026-11-09",
      at: new Date("2026-11-05T12:00:00Z"),
      email: "a@b.com",
      lat: 47.5,
      note: "call +1 555 555 0123 or mail x@y.org",
      nested: [{ phone: "+15555550123", ok: 3 }],
    }) as Record<string, unknown>;
    expect(out.closureId).toBe(id);
    expect(out.day).toBe("2026-11-09");
    expect(out.at).toBe("2026-11-05T12:00:00.000Z");
    expect(out.email).toBe("[redacted]");
    expect(out.lat).toBe("[redacted]");
    expect(out.note).toBe("call [phone] or mail [email]");
    expect(out.nested).toEqual([{ phone: "[redacted]", ok: 3 }]);
  });
});

describe("admin helpers", () => {
  it("clamps pagination and escapes LIKE wildcards", () => {
    expect(parsePage({ limit: "1000", offset: "-5" })).toEqual({ limit: 25, offset: 0 });
    expect(parsePage({ limit: "50", offset: "100" })).toEqual({ limit: 50, offset: 100 });
    expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });

  it("converts region-local datetime inputs to UTC", () => {
    expect(localDateTimeToUtc("2026-11-14T08:30", "America/Los_Angeles")?.toISOString()).toBe("2026-11-14T16:30:00.000Z");
    expect(localDateTimeToUtc("2026-07-14T08:30", "America/Los_Angeles")?.toISOString()).toBe("2026-07-14T15:30:00.000Z");
    expect(localDateTimeToUtc("garbage", "America/Los_Angeles")).toBeNull();
  });

  it("explains reconciliation states", () => {
    const now = new Date("2026-11-05T12:00:00Z");
    const base = { createdAt: new Date("2026-11-05T08:00:00Z"), totalCents: 5000, currency: "usd", refundedCents: 0, paidAt: null };
    const expired = reconciliationHints({ ...base, status: "pending_payment", holdExpiresAt: new Date("2026-11-05T08:30:00Z") }, null, null, null, 30, now);
    expect(expired.join(" ")).toMatch(/hold expired/);
    expect(expired.join(" ")).toMatch(/payments.reconcile/);
    const na = reconciliationHints({ ...base, status: "needs_attention", holdExpiresAt: null }, [], [], "paid_after_hold_expired_no_capacity", null, now);
    expect(na[0]).toMatch(/paid_after_hold_expired_no_capacity/);
    const noPay = reconciliationHints({ ...base, status: "confirmed", holdExpiresAt: null }, [], [], null, null, now);
    expect(noPay.join(" ")).toMatch(/no captured payment/);
  });
});
