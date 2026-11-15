import { describe, expect, it } from "vitest";
import { sanitizeAuditMetadata, parsePage, likePattern } from "@/server/admin/common";

describe("audit metadata sanitizer", () => {
  it("keeps ids and dates intact but redacts contact details and coordinates", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const out = sanitizeAuditMetadata({
      ticketId: id,
      day: "2026-11-09",
      at: new Date("2026-11-05T12:00:00Z"),
      email: "a@b.com",
      lat: 47.5,
      note: "call +1 555 555 0123 or mail x@y.org",
      nested: [{ phone: "+15555550123", ok: 3 }],
    }) as Record<string, unknown>;
    expect(out.ticketId).toBe(id);
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
});
