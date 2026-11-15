import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "@/lib/safe-redirect";

describe("safeRedirectPath (post-sign-in redirects)", () => {
  it("keeps same-origin paths with query and hash", () => {
    expect(safeRedirectPath("/admin/support?status=open&priority=high#tickets")).toBe("/admin/support?status=open&priority=high#tickets");
    expect(safeRedirectPath("/account")).toBe("/account");
  });
  it.each([
    "//evil.example",
    "/\t/evil.example/x",
    "/\n/evil.example/x",
    "/\r\n/evil.example",
    "/\\evil.example",
    "/\\/evil.example",
    "https://evil.example",
    "javascript:alert(1)",
    "evil.example",
    "",
    "/%0a/evil.example".replace("%0a", "\n"),
  ])("rejects %j", (value) => {
    expect(safeRedirectPath(value)).toBe("/account");
  });
  it("rejects non-strings and absurd lengths", () => {
    expect(safeRedirectPath(null)).toBe("/account");
    expect(safeRedirectPath(undefined)).toBe("/account");
    expect(safeRedirectPath(`/${"a".repeat(5000)}`)).toBe("/account");
  });
});
