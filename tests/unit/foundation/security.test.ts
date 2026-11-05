import { describe, expect, it } from "vitest";
import { signSession, verifySession } from "@/server/auth/tokens";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { can } from "@/server/auth/rbac";
import { redact, redactString } from "@/server/log";

const SECRET = "unit-test-secret-0123456789abcdef0123456789";

describe("demo session tokens", () => {
  it("round-trips a valid session", () => {
    const token = signSession(SECRET, { sub: "u1", email: "a@b.c", exp: Date.now() / 1000 + 60 });
    expect(verifySession(SECRET, token)?.sub).toBe("u1");
  });
  it("rejects tampered, foreign-secret and expired tokens", () => {
    const token = signSession(SECRET, { sub: "u1", email: "a@b.c", exp: Date.now() / 1000 + 60 });
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "admin", email: "x", exp: 9e9 })).toString("base64url");
    expect(verifySession(SECRET, `${forged}.${sig}`)).toBeNull();
    expect(verifySession("another-secret-0123456789abcdef0123", token)).toBeNull();
    expect(verifySession(SECRET, `${body}.`)).toBeNull();
    const expired = signSession(SECRET, { sub: "u1", email: "a@b.c", exp: Date.now() / 1000 - 1 });
    expect(verifySession(SECRET, expired)).toBeNull();
  });
});

describe("password hashing", () => {
  it("verifies correct and rejects wrong passwords", async () => {
    const h = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
  });
});

describe("RBAC", () => {
  it("grants by role and denies customers", () => {
    expect(can(["admin"], "pricing.manage")).toBe(true);
    expect(can(["operator"], "pricing.manage")).toBe(false);
    expect(can(["support"], "safety.sensitive")).toBe(false);
    expect(can(["safety"], "safety.sensitive")).toBe(true);
    expect(can([], "admin.access")).toBe(false);
    expect(can(undefined, "admin.access")).toBe(false);
  });
});

describe("log redaction", () => {
  it("removes sensitive keys and scrubs strings", () => {
    const out = redact({ email: "a@b.com", nested: { lat: 47.1, accessCode: "1234", ok: 1 }, msg: "call +1 555 555 0123 at 47.12345, -121.12345" }) as { email: string; msg: string; nested: Record<string, unknown> };
    expect(out.email).toBe("[redacted]");
    expect(out.nested.lat).toBe("[redacted]");
    expect(out.nested.accessCode).toBe("[redacted]");
    expect(out.nested.ok).toBe(1);
    expect(out.msg).not.toMatch(/555/);
    expect(out.msg).not.toMatch(/47\.12345/);
    expect(redactString("key sk_test_abcdefghijklmnop")).toBe("key [key]");
  });
});
