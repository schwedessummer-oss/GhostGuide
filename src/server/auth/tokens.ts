import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Small HMAC helpers shared by demo sessions, demo webhooks, trip-share links
 * and locker access codes. Pure functions (secret passed in) so they are unit
 * testable without the Next.js runtime.
 */
export function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export interface SessionPayload {
  sub: string;
  email: string;
  /** expiry, seconds since epoch */
  exp: number;
}

export function signSession(secret: string, payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(secret, `session:${body}`)}`;
}

export function verifySession(
  secret: string,
  token: string | undefined | null,
  nowSec = Date.now() / 1000,
): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  if (!safeEqual(sig, hmac(secret, `session:${body}`))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp < nowSec) return null;
    return payload;
  } catch {
    return null;
  }
}
