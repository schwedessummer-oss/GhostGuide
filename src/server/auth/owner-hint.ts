import { hmac } from "./tokens";

/**
 * Device sign-in hint: a short, non-secret HMAC of the signed-in user's id,
 * stored in a readable (non-HttpOnly) cookie. The site chrome uses it as a
 * first guess of "signed in" before /api/session answers (see
 * src/components/site/session.ts). It reveals nothing about the user and is
 * never used for authorization.
 */
export const OWNER_HINT_COOKIE = "gg_owner";
export const OWNER_HINT_MAX_AGE_SEC = 60 * 60 * 24 * 30;

export function ownerHint(secret: string, userId: string): string {
  return hmac(secret, `device-owner:${userId}`).slice(0, 22);
}
