"use server";

import { refresh } from "next/cache";
import { requireUser } from "@/server/auth";
import { updateProfile } from "@/server/account/profile";
import type { AccountFormState } from "@/components/account/form-result";

/** Account server actions: resolve the user, validate with zod (in the use-case), write via withUser. */
/** A text field as submitted (bounded), for validation and for echoing back on an error. */
const text = (formData: FormData, name: string, max = 400) => String(formData.get(name) ?? "").slice(0, max);

export async function updateProfileAction(_prev: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const user = await requireUser("/account");
  const input = { fullName: text(formData, "fullName"), units: text(formData, "units", 20) };
  const r = await updateProfile(user, input);
  if (!r.ok) return { ok: false, error: r.error, fieldErrors: r.fieldErrors, values: input };
  refresh();
  return { ok: true, message: "Profile saved." };
}
