"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/server/auth";
import { checkRateLimit } from "@/server/rate-limit";
import { createContact, deleteContact, updateContact } from "@/server/account/contacts";
import type { AccountFormState } from "@/components/account/form-result";

function contactInput(formData: FormData) {
  const text = (name: string, max = 400) => String(formData.get(name) ?? "").slice(0, max);
  return {
    name: text("name"),
    phone: text("phone"),
    email: text("email"),
    relationship: text("relationship"),
    consent: formData.get("consent") === "on",
    /** the phone/email the consent box was ticked for (set by the form; see updateContact) */
    consentFor: text("consentFor", 800),
  };
}

async function limited(userId: string) {
  return !(await checkRateLimit(`contacts:write:user:${userId}`, 30, 600)).allowed;
}

export async function createContactAction(_prev: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const user = await requireUser("/account/emergency-contacts");
  if (await limited(user.id)) return { ok: false, error: "Too many changes in a short time. Please wait a few minutes." };
  const input = contactInput(formData);
  const r = await createContact(user, input);
  if (!r.ok) return { ok: false, error: r.error, fieldErrors: r.fieldErrors, values: input };
  refresh();
  return {
    ok: true,
    message: input.consent ? `${input.name.trim()} was added and can be chosen for check-ins.` : `${input.name.trim()} was added. Confirm their consent before choosing them for check-ins.`,
  };
}

export async function updateContactAction(contactId: string, _prev: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const user = await requireUser("/account/emergency-contacts");
  if (!z.uuid().safeParse(contactId).success) return { ok: false, error: "Contact not found." };
  if (await limited(user.id)) return { ok: false, error: "Too many changes in a short time. Please wait a few minutes." };
  const input = contactInput(formData);
  const r = await updateContact(user, contactId, input);
  if (!r.ok) return { ok: false, error: r.error, fieldErrors: r.fieldErrors, values: input };
  refresh();
  return {
    ok: true,
    message: r.consentCleared
      ? "Contact saved. Their phone or email changed, so their consent needs confirming again: tick the consent box and save once they've agreed to notices at the new details."
      : "Contact saved.",
  };
}

export async function deleteContactAction(contactId: string, _prev: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const user = await requireUser("/account/emergency-contacts");
  if (!z.uuid().safeParse(contactId).success) return { ok: false, error: "Contact not found." };
  if (formData.get("confirmDelete") !== "yes") return { ok: false, error: "Confirm that you want to delete this contact." };
  const r = await deleteContact(user, contactId);
  if (!r.ok) return { ok: false, error: r.error };
  refresh();
  return { ok: true, message: "Contact deleted." };
}
