import { hmac } from "./tokens";

/**
 * Device "owner hint": a short, non-secret HMAC of the signed-in user's id,
 * stored in a readable (non-HttpOnly) cookie. Offline trip data saved on the
 * device is tagged with the same hint; offline pages refuse to show (and
 * purge) downloaded data whose hint does not match the current cookie, so a
 * different or signed-out person on a shared device cannot read the previous
 * hiker's trip, location or queued points. It reveals nothing about the user.
 */
export const OWNER_HINT_COOKIE = "gg_owner";
export const OWNER_HINT_MAX_AGE_SEC = 60 * 60 * 24 * 30;

export function ownerHint(secret: string, userId: string): string {
  return hmac(secret, `device-owner:${userId}`).slice(0, 22);
}
