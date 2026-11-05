import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signing scheme for SIMULATED payment webhooks, modeled on Stripe's:
 *
 *   header  x-demo-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * Verification recomputes the HMAC over the exact raw body, compares in
 * constant time and rejects timestamps outside a 5-minute window (replay
 * protection). Pure functions (secret passed in) so they are unit tested.
 */
export const DEMO_SIGNATURE_HEADER = "x-demo-signature";
export const DEMO_SIGNATURE_TOLERANCE_SEC = 300;

export function computeDemoSignature(secret: string, timestampSec: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`).digest("hex");
}

export function signDemoWebhook(secret: string, rawBody: string, timestampSec = Math.floor(Date.now() / 1000)): string {
  return `t=${timestampSec},v1=${computeDemoSignature(secret, timestampSec, rawBody)}`;
}

export type DemoSignatureFailure = "missing" | "malformed" | "mismatch" | "stale";

export function verifyDemoSignature(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = DEMO_SIGNATURE_TOLERANCE_SEC,
): { ok: true; timestamp: number } | { ok: false; reason: DemoSignatureFailure } {
  if (!header) return { ok: false, reason: "missing" };
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return i > 0 ? [kv.slice(0, i).trim(), kv.slice(i + 1).trim()] : [kv.trim(), ""];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1 ?? "";
  if (!Number.isInteger(t) || t <= 0 || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: "malformed" };
  const expected = Buffer.from(computeDemoSignature(secret, t, rawBody), "hex");
  const given = Buffer.from(v1, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "mismatch" };
  if (Math.abs(nowSec - t) > toleranceSec) return { ok: false, reason: "stale" };
  return { ok: true, timestamp: t };
}
