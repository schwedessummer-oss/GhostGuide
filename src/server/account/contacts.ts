import "server-only";
import { z } from "zod";
import { withUser } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { maskEmail, maskPhone, normalizePhone } from "@/domain/notification-messages";
import { OPEN_STATUSES } from "@/domain/checkin";
import type { Result } from "./profile";

/**
 * Emergency contacts (owner-only via RLS). A contact can be saved without
 * consent, but only contacts whose consent the customer has attested
 * (consent_confirmed_at + the exact statement shown) can be chosen for
 * check-ins, and the send job re-checks consent before every message.
 * Changing a contact's phone or email requires attesting consent again.
 */
export const CONSENT_STATEMENT =
  "I confirm this person has agreed to receive Ghost Guide check-in notices about my trips by text message and/or email, and that I may give Ghost Guide their contact details for this purpose.";

export const MAX_CONTACTS = 10;

export interface ContactView {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  relationship: string | null;
  consentConfirmedAt: Date | null;
  consentStatement: string | null;
  hasConsent: boolean;
  phoneMasked: string | null;
  emailMasked: string | null;
  /** selected on a check-in that is not finished/cancelled */
  usedByOpenCheckin: boolean;
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters.`)
    .transform((v) => v || null);

export const contactSchema = z
  .object({
    name: z.string().trim().min(1, "Enter the contact's name.").max(120, "Use at most 120 characters."),
    phone: z
      .string()
      .trim()
      .max(32)
      .transform((v, ctx) => {
        if (!v) return null;
        const n = normalizePhone(v);
        if (!n) {
          ctx.addIssue({ code: "custom", message: "Enter a mobile number with country code, e.g. +1 555 555 0123." });
          return z.NEVER;
        }
        return n;
      }),
    email: z
      .string()
      .trim()
      .max(254)
      .transform((v, ctx) => {
        if (!v) return null;
        const r = z.email().safeParse(v.toLowerCase());
        if (!r.success) {
          ctx.addIssue({ code: "custom", message: "Enter a valid email address." });
          return z.NEVER;
        }
        return r.data;
      }),
    relationship: optionalText(60),
    consent: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (!v.phone && !v.email) ctx.addIssue({ code: "custom", path: ["phone"], message: "Add a mobile number or an email address (or both)." });
  });

export type ContactInput = z.input<typeof contactSchema>;

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) out[String(issue.path[0] ?? "form")] ??= issue.message;
  return out;
}

const isUuid = (s: string) => z.uuid().safeParse(s).success;

export async function listContacts(user: SessionUser): Promise<ContactView[]> {
  const rows = await withUser(
    user,
    (tx) => tx<(Omit<ContactView, "hasConsent" | "phoneMasked" | "emailMasked">)[]>`
      select ec.id, ec.name, ec.phone, ec.email, ec.relationship, ec.consent_confirmed_at, ec.consent_statement,
             exists (select 1 from public.trip_checkins c where c.emergency_contact_id = ec.id
                     and c.status = any(${OPEN_STATUSES as string[]}::checkin_status[])) as used_by_open_checkin
      from public.emergency_contacts ec
      where ec.user_id = ${user.id}
      order by ec.created_at`,
  );
  return rows.map((r) => ({
    ...r,
    hasConsent: !!r.consentConfirmedAt,
    phoneMasked: r.phone ? maskPhone(r.phone) : null,
    emailMasked: r.email ? maskEmail(r.email) : null,
  }));
}

/** Contacts that may be selected for a check-in. */
export async function listConsentedContacts(user: SessionUser): Promise<ContactView[]> {
  return (await listContacts(user)).filter((c) => c.hasConsent);
}

export async function createContact(user: SessionUser, input: unknown): Promise<Result<{ id: string }>> {
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
  const c = parsed.data;
  return withUser(user, async (tx) => {
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from public.emergency_contacts where user_id = ${user.id}`;
    if (n >= MAX_CONTACTS) return { ok: false as const, error: `You can save up to ${MAX_CONTACTS} contacts.` };
    const [row] = await tx<{ id: string }[]>`
      insert into public.emergency_contacts (user_id, name, phone, email, relationship, consent_confirmed_at, consent_statement)
      values (${user.id}, ${c.name}, ${c.phone}, ${c.email}, ${c.relationship},
              ${c.consent ? new Date() : null}::timestamptz, ${c.consent ? CONSENT_STATEMENT : null})
      returning id`;
    return { ok: true as const, id: row.id };
  });
}

export async function updateContact(user: SessionUser, contactId: string, input: unknown): Promise<Result> {
  if (!isUuid(contactId)) return { ok: false, error: "Contact not found." };
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
  const c = parsed.data;
  return withUser(user, async (tx) => {
    const [existing] = await tx<{ phone: string | null; email: string | null; consentConfirmedAt: Date | null }[]>`
      select phone, email, consent_confirmed_at from public.emergency_contacts where id = ${contactId} and user_id = ${user.id} for update`;
    if (!existing) return { ok: false as const, error: "Contact not found." };
    const detailsChanged = existing.phone !== c.phone || existing.email !== c.email;
    // Keep the original attestation time unless the reachable details changed.
    const consentAt = c.consent ? (existing.consentConfirmedAt && !detailsChanged ? existing.consentConfirmedAt : new Date()) : null;
    await tx`
      update public.emergency_contacts set name = ${c.name}, phone = ${c.phone}, email = ${c.email}, relationship = ${c.relationship},
        consent_confirmed_at = ${consentAt}::timestamptz, consent_statement = ${c.consent ? CONSENT_STATEMENT : null}
      where id = ${contactId} and user_id = ${user.id}`;
    return { ok: true as const };
  });
}

export async function deleteContact(user: SessionUser, contactId: string): Promise<Result> {
  if (!isUuid(contactId)) return { ok: false, error: "Contact not found." };
  const rows = await withUser(
    user,
    (tx) => tx`delete from public.emergency_contacts where id = ${contactId} and user_id = ${user.id} returning id`,
  );
  return rows.length ? { ok: true } : { ok: false, error: "Contact not found." };
}
