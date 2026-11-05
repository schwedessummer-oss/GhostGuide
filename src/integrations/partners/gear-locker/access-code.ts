import { createHash, createHmac } from "node:crypto";

/**
 * Locker access codes. The 6-digit code is DERIVED (HMAC-SHA256 with the
 * server secret over the reservation id), so it never has to be stored in
 * clear: the database keeps only a SHA-256 hash and the last two digits as a
 * hint. The owner's trip page re-derives it after verifying ownership.
 * Pure (secret passed in) so seeds and unit tests can use it.
 */
export function deriveAccessCode(secret: string, reservationId: string): string {
  const digest = createHmac("sha256", secret).update(`locker-access-code:${reservationId}`).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export function hashAccessCode(reservationId: string, code: string): string {
  return createHash("sha256").update(`${reservationId}:${code}`).digest("hex");
}

export function accessCodeHint(code: string): string {
  return code.slice(-2);
}
