"use server";

import { refresh } from "next/cache";
import { requireUser } from "@/server/auth";
import { checkRateLimit } from "@/server/rate-limit";
import { deleteLocationHistory, updatePrivacySettings, updateProfile } from "@/server/account/profile";
import type { AccountFormState } from "@/components/account/form-result";

/** Account server actions: resolve the user, validate with zod (in the use-case), write via withUser. */
export async function updateProfileAction(_prev: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const user = await requireUser("/account");
  const r = await updateProfile(user, {
    fullName: String(formData.get("fullName") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    units: String(formData.get("units") ?? ""),
  });
  if (!r.ok) return { ok: false, error: r.error, fieldErrors: r.fieldErrors };
  refresh();
  return { ok: true, message: "Profile saved." };
}

export async function updatePrivacyAction(_prev: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const user = await requireUser("/account/privacy");
  const r = await updatePrivacySettings(user, {
    locationRetentionDays: String(formData.get("locationRetentionDays") ?? ""),
    shareLocationWithContacts: formData.get("shareLocationWithContacts") === "on",
  });
  if (!r.ok) return { ok: false, error: r.error, fieldErrors: r.fieldErrors };
  refresh();
  return { ok: true, message: "Privacy settings saved." };
}

export async function deleteLocationHistoryAction(_prev: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const user = await requireUser("/account/privacy");
  if (formData.get("confirmDelete") !== "on") return { ok: false, error: "Tick the box to confirm you want to delete your location history." };
  const limit = await checkRateLimit(`privacy:delete-locations:user:${user.id}`, 5, 600);
  if (!limit.allowed) return { ok: false, error: "Please wait a few minutes before trying again." };
  const r = await deleteLocationHistory(user);
  refresh();
  return {
    ok: true,
    message:
      r.pointsDeleted + r.lastFixesDeleted === 0
        ? "There was no stored location history to delete."
        : `Deleted ${r.pointsDeleted} location point${r.pointsDeleted === 1 ? "" : "s"} and ${r.lastFixesDeleted} last-known location${r.lastFixesDeleted === 1 ? "" : "s"}.`,
  };
}
