import "server-only";
import type { Tx } from "@/server/db";
import { randomToken, sha256 } from "@/server/auth/tokens";
import { env } from "@/config/env";

/**
 * One-click opt-out links for emergency contacts. A fresh random token is
 * issued for every notice to a contact (so a token in one message never
 * depends on another); only its SHA-256 hash is stored, scoped to that
 * emergency_contacts row. 12 random bytes = a 16-character token (96 bits),
 * short enough for SMS and unguessable (lookups are also rate limited).
 */
export const OPT_OUT_TOKEN_BYTES = 12;
export const OPT_OUT_TTL_DAYS = 365;
export const OPT_OUT_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

export const optOutPath = (token: string) => `/contact/opt-out/${token}`;
export const optOutUrl = (token: string) => `${env().NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}${optOutPath(token)}`;

export interface IssuedOptOutLink {
  url: string;
  tokenHash: string;
}

/** Issue a link for this contact (inside the caller's transaction). */
export async function issueOptOutLink(tx: Tx, contact: { id: string; userId: string }, now = new Date()): Promise<IssuedOptOutLink> {
  const token = randomToken(OPT_OUT_TOKEN_BYTES);
  const tokenHash = sha256(token);
  await tx`
    insert into public.contact_optout_tokens (contact_id, user_id, token_hash, expires_at)
    values (${contact.id}, ${contact.userId}, ${tokenHash}, ${new Date(now.getTime() + OPT_OUT_TTL_DAYS * 86_400_000)}::timestamptz)`;
  return { url: optOutUrl(token), tokenHash };
}

/** Drop a link whose notice was not created after all (idempotent re-run). */
export async function discardOptOutLink(tx: Tx, tokenHash: string): Promise<void> {
  await tx`delete from public.contact_optout_tokens where token_hash = ${tokenHash} and used_at is null`;
}
