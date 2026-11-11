import { createHmac } from "node:crypto";

/**
 * Locker access codes. The 6-digit code is DERIVED (HMAC-SHA256 with the
 * server secret over the reservation id), so it never has to be stored in
 * clear: the database keeps only a KEYED hash (HMAC with the server secret),
 * so a database or backup leak cannot brute-force the 10^6 code space. No
 * clear-text hint is stored. The owner's trip page re-derives it after
 * verifying ownership. A live locker partner should issue random, rotatable
 * codes instead. Pure (secret passed in) so seeds and unit tests can use it.
 */
export function deriveAccessCode(secret: string, reservationId: string): string {
  const digest = createHmac("sha256", secret).update(`locker-access-code:${reservationId}`).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export function hashAccessCode(secret: string, reservationId: string, code: string): string {
  return createHmac("sha256", secret).update(`locker-access-code-hash:${reservationId}:${code}`).digest("hex");
}

export function accessCodeHint(code: string): string {
  return code.slice(-2);
}
