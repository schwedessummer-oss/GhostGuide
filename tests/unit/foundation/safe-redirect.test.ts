import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "@/lib/safe-redirect";

describe("safeRedirectPath (post-sign-in redirects)", () => {
  it("keeps same-origin paths with query and hash", () => {
    expect(safeRedirectPath("/plan/results?trail=a&x=1#card-a")).toBe("/plan/results?trail=a&x=1#card-a");
    expect(safeRedirectPath("/trips")).toBe("/trips");
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
    expect(safeRedirectPath(value)).toBe("/trips");
  });
  it("rejects non-strings and absurd lengths", () => {
    expect(safeRedirectPath(null)).toBe("/trips");
    expect(safeRedirectPath(undefined)).toBe("/trips");
    expect(safeRedirectPath(`/${"a".repeat(5000)}`)).toBe("/trips");
  });
});
