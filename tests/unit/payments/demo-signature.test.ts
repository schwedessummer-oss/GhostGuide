import { describe, expect, it } from "vitest";
import { computeDemoSignature, signDemoWebhook, verifyDemoSignature, DEMO_SIGNATURE_TOLERANCE_SEC } from "@/integrations/payments/demo-signature";

const SECRET = "unit-test-secret-0123456789abcdef0123456789";
const body = JSON.stringify({ id: "demo_evt_1", type: "checkout.session.completed", data: { object: { amount_total: 1900 } } });
const now = 1_793_000_000;

describe("demo webhook signature", () => {
  it("accepts a valid signature", () => {
    const header = signDemoWebhook(SECRET, body, now);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyDemoSignature(SECRET, body, header, now)).toEqual({ ok: true, timestamp: now });
  });

  it("rejects a tampered body", () => {
    const header = signDemoWebhook(SECRET, body, now);
    const tampered = body.replace("1900", "1");
    expect(verifyDemoSignature(SECRET, tampered, header, now)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a tampered timestamp (signature covers it)", () => {
    const header = signDemoWebhook(SECRET, body, now);
    const forged = header.replace(`t=${now}`, `t=${now + 10}`);
    expect(verifyDemoSignature(SECRET, body, forged, now + 10)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a signature made with another secret", () => {
    const header = signDemoWebhook("another-secret-0123456789abcdef0123456789", body, now);
    expect(verifyDemoSignature(SECRET, body, header, now)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("enforces the 5-minute replay window in both directions", () => {
    const header = signDemoWebhook(SECRET, body, now);
    expect(verifyDemoSignature(SECRET, body, header, now + DEMO_SIGNATURE_TOLERANCE_SEC).ok).toBe(true);
    expect(verifyDemoSignature(SECRET, body, header, now + DEMO_SIGNATURE_TOLERANCE_SEC + 1)).toEqual({ ok: false, reason: "stale" });
    expect(verifyDemoSignature(SECRET, body, header, now - DEMO_SIGNATURE_TOLERANCE_SEC - 1)).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects missing and malformed headers", () => {
    expect(verifyDemoSignature(SECRET, body, null, now)).toEqual({ ok: false, reason: "missing" });
    expect(verifyDemoSignature(SECRET, body, "garbage", now)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyDemoSignature(SECRET, body, `t=${now},v1=zz`, now)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyDemoSignature(SECRET, body, `v1=${computeDemoSignature(SECRET, now, body)}`, now)).toEqual({ ok: false, reason: "malformed" });
  });
});
