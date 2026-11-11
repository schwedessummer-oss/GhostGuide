import "server-only";
import { withSystem, type Tx } from "@/server/db";
import { sha256 } from "@/server/auth/tokens";
import { checkRateLimit } from "@/server/rate-limit";
import { recordAudit } from "@/server/audit";
import { log } from "@/server/log";
import { cancelQueuedJobs } from "@/server/jobs/queue";
import { OPEN_STATUSES } from "@/domain/checkin";
import { buildContactOptedOutUserMessage, firstNameOf } from "@/domain/notification-messages";
import { createNotification, NOTIFICATION_TEMPLATES, sendJobDedupKey } from "@/server/notifications/create";
import { userAddress } from "@/server/notifications/addresses";
import { OPT_OUT_TOKEN } from "@/server/notifications/optout";
import { recordCheckinEvent } from "@/server/checkins/core";

/**
 * Contact-side consent: the emergency contact withdraws consent with the
 * link in a notice (/contact/opt-out/<token>), without signing in.
 *
 *  - The page only ever shows the hiker's first name (already in the
 *    message) — never a location, trip status, or contact details.
 *  - GET shows a confirmation; only the POST (button) opts out, so link
 *    previews and prefetchers can't withdraw consent by accident.
 *  - Opting out clears consent_confirmed_at immediately, records
 *    contact_opted_out_at, suppresses undelivered notices to that contact,
 *    writes a checkin_events row on each open check-in that uses the contact
 *    and an audit entry, and tells the hiker (in-app + a notice).
 *  - Rate limited per client (IP); tokens are 96-bit random and stored hashed.
 */
const LIMIT = { limit: 30, windowSec: 600 };

export type OptOutLinkView =
  | { state: "invalid" }
  | { state: "ready" | "opted_out"; hikerFirstName: string | null };

export type OptOutLookup = { rateLimited: true } | { rateLimited: false; view: OptOutLinkView };

export type OptOutResult =
  | { ok: true; alreadyOptedOut: boolean; hikerFirstName: string | null }
  | { ok: false; error: string; rateLimited?: boolean };

interface TokenRow {
  id: string;
  contactId: string;
  userId: string;
  expiresAt: Date;
  usedAt: Date | null;
  contactName: string;
  consentConfirmedAt: Date | null;
  contactOptedOutAt: Date | null;
  fullName: string | null;
}

async function limited(clientKey: string): Promise<boolean> {
  return !(await checkRateLimit(`contact-optout:${sha256(clientKey || "unknown").slice(0, 32)}`, LIMIT.limit, LIMIT.windowSec)).allowed;
}

async function findToken(tx: Tx, token: string, now: Date, lock: boolean): Promise<TokenRow | null> {
  if (typeof token !== "string" || !OPT_OUT_TOKEN.test(token)) return null;
  const rows = lock
    ? await tx<TokenRow[]>`
        select t.id, t.contact_id, t.user_id, t.expires_at, t.used_at, ec.name as contact_name, ec.consent_confirmed_at,
               ec.contact_opted_out_at, p.full_name
        from public.contact_optout_tokens t
        join public.emergency_contacts ec on ec.id = t.contact_id and ec.user_id = t.user_id
        left join public.profiles p on p.id = t.user_id
        where t.token_hash = ${sha256(token)}
        for update of t, ec`
    : await tx<TokenRow[]>`
        select t.id, t.contact_id, t.user_id, t.expires_at, t.used_at, ec.name as contact_name, ec.consent_confirmed_at,
               ec.contact_opted_out_at, p.full_name
        from public.contact_optout_tokens t
        join public.emergency_contacts ec on ec.id = t.contact_id and ec.user_id = t.user_id
        left join public.profiles p on p.id = t.user_id
        where t.token_hash = ${sha256(token)}`;
  const row = rows[0];
  if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
  return row;
}

/** What the opt-out page shows for a token (no location or trip details, ever). */
export async function lookupOptOutLink(token: string, clientKey: string, now = new Date()): Promise<OptOutLookup> {
  if (await limited(clientKey)) return { rateLimited: true };
  const row = await withSystem((tx) => findToken(tx, token, now, false));
  if (!row) return { rateLimited: false, view: { state: "invalid" } };
  return { rateLimited: false, view: { state: row.consentConfirmedAt ? "ready" : "opted_out", hikerFirstName: firstNameOf(row.fullName) } };
}

/** The contact confirmed: withdraw their consent now. Idempotent. */
export async function optOutWithLink(token: string, clientKey: string, now = new Date()): Promise<OptOutResult> {
  if (await limited(clientKey)) return { ok: false, rateLimited: true, error: "Too many requests. Please wait a few minutes and try again." };
  return withSystem(async (tx) => {
    const row = await findToken(tx, token, now, true);
    if (!row) return { ok: false as const, error: "This link isn't valid or has expired." };
    const hikerFirstName = firstNameOf(row.fullName);
    await tx`update public.contact_optout_tokens set used_at = coalesce(used_at, ${now}::timestamptz) where id = ${row.id}`;
    if (!row.consentConfirmedAt) return { ok: true as const, alreadyOptedOut: true, hikerFirstName };

    await tx`
      update public.emergency_contacts
      set consent_confirmed_at = null, consent_statement = null, contact_opted_out_at = ${now}::timestamptz
      where id = ${row.contactId} and user_id = ${row.userId}`;

    // Undelivered notices to this contact are never sent now (the send job
    // would refuse them anyway; this makes the hiker's history say why).
    const pending = await tx<{ id: string }[]>`
      update public.notifications set status = 'suppressed', error = 'Not sent: your contact opted out of Ghost Guide notices.'
      where recipient_kind = 'emergency_contact' and recipient_ref = ${row.contactId} and user_id = ${row.userId}
        and status in ('queued', 'failed')
      returning id`;
    for (const n of pending) await cancelQueuedJobs(tx, sendJobDedupKey(n.id));

    const open = await tx<{ checkinId: string; tripId: string; trailName: string }[]>`
      select c.id as checkin_id, c.trip_id, t.name as trail_name
      from public.trip_checkins c
      join public.trips tr on tr.id = c.trip_id
      join public.trails t on t.id = tr.trail_id
      where c.emergency_contact_id = ${row.contactId} and c.user_id = ${row.userId}
        and c.status = any(${OPEN_STATUSES as string[]}::checkin_status[])`;
    const [profile] = await tx<{ phone: string | null; email: string | null }[]>`
      select p.phone, coalesce(nullif(p.email, ''), u.email) as email
      from auth.users u left join public.profiles p on p.id = u.id where u.id = ${row.userId}`;
    const addr = profile ? userAddress(profile) : null;
    for (const c of open) {
      await recordCheckinEvent(tx, c.checkinId, "contact_opted_out", { actor: "system", actorId: null }, {
        contactId: row.contactId,
        via: "opt_out_link",
        suppressedNotices: pending.length,
      });
      const channel = addr?.channel ?? "email";
      const msg = buildContactOptedOutUserMessage({ channel, contactName: row.contactName, trailName: c.trailName });
      await createNotification(tx, {
        userId: row.userId,
        tripId: c.tripId,
        checkinId: c.checkinId,
        checkinVersion: null,
        channel,
        recipientKind: "user",
        recipientRef: row.userId,
        recipientMasked: addr?.masked ?? "no phone or email on file",
        template: NOTIFICATION_TEMPLATES.contactOptedOut,
        subject: msg.subject,
        body: msg.body,
        dedupKey: `notify:${c.checkinId}:contact_opted_out:${row.id}:user:${row.userId}:${channel}`,
        ...(addr ? {} : { status: "suppressed" as const, error: "No phone number or email address on file." }),
      });
    }
    await recordAudit(tx, { id: null, roles: [] }, "emergency_contact.opted_out", "emergency_contact", row.contactId, {
      userId: row.userId,
      via: "opt_out_link",
      openCheckins: open.length,
      suppressedNotices: pending.length,
    });
    log.info("contact.opted_out", { contactId: row.contactId, openCheckins: open.length, suppressedNotices: pending.length });
    return { ok: true as const, alreadyOptedOut: false, hikerFirstName };
  });
}
