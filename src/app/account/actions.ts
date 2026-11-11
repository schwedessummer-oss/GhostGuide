"use server";

import { refresh } from "next/cache";
import { requireUser } from "@/server/auth";
import { checkRateLimit } from "@/server/rate-limit";
import { deleteLocationHistory, updatePrivacySettings, updateProfile } from "@/server/account/profile";
import type { AccountFormState } from "@/components/account/form-result";

/** Account server actions: resolve the user, validate with zod (in the use-case), write via withUser. */
/** A text field as submitted (bounded), for validation and for echoing back on an error. */
const text = (formData: FormData, name: string, max = 400) => String(formData.get(name) ?? "").slice(0, max);

export async function updateProfileAction(_prev: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const user = await requireUser("/account");
  const input = { fullName: text(formData, "fullName"), phone: text(formData, "phone"), units: text(formData, "units", 20) };
  const r = await updateProfile(user, input);
  if (!r.ok) return { ok: false, error: r.error, fieldErrors: r.fieldErrors, values: input };
  refresh();
  return { ok: true, message: "Profile saved." };
}

export async function updatePrivacyAction(_prev: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const user = await requireUser("/account/privacy");
  const input = {
    locationRetentionDays: text(formData, "locationRetentionDays", 20),
    shareLocationWithContacts: formData.get("shareLocationWithContacts") === "on",
  };
  const r = await updatePrivacySettings(user, input);
  if (!r.ok) return { ok: false, error: r.error, fieldErrors: r.fieldErrors, values: input };
  refresh();
  return {
    ok: true,
    message: input.shareLocationWithContacts
      ? "Privacy settings saved. Check-in notices will include your last reported location."
      : "Privacy settings saved. Check-in notices will say no location has been reported.",
  };
}

export async function deleteLocationHistoryAction(_prev: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const user = await requireUser("/account/privacy");
  if (formData.get("confirmDelete") !== "on") return { ok: false, error: "Tick the box to confirm you want to delete your location history." };
  const limit = await checkRateLimit(`privacy:delete-locations:user:${user.id}`, 5, 600);
  if (!limit.allowed) return { ok: false, error: "Please wait a few minutes before trying again." };
  const r = await deleteLocationHistory(user);
  refresh();
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  return {
    ok: true,
    message:
      r.pointsDeleted + r.lastFixesDeleted + r.noticesRedacted === 0
        ? "There was no stored location history to delete."
        : `Deleted ${plural(r.pointsDeleted, "location point")} and ${plural(r.lastFixesDeleted, "last-known location")}.` +
          (r.noticesRedacted ? ` Removed the location from ${plural(r.noticesRedacted, "stored notice")}.` : ""),
  };
}
