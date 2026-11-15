import "server-only";
import { z } from "zod";
import { withUser } from "@/server/db";
import type { SessionUser } from "@/server/auth";

/**
 * Profile settings. Writes go through withUser (RLS + column grants: only a
 * few profile columns, among them full_name and units, are writable by
 * customers).
 */
export interface ProfileView {
  id: string;
  email: string;
  fullName: string | null;
  units: "imperial" | "metric";
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; fieldErrors?: Record<string, string> };

export async function getProfile(user: SessionUser): Promise<ProfileView> {
  const [p] = await withUser(
    user,
    (tx) => tx<Omit<ProfileView, "email">[]>`select id, full_name, units from public.profiles where id = ${user.id}`,
  );
  return {
    id: user.id,
    email: user.email,
    fullName: p?.fullName ?? null,
    units: p?.units ?? "imperial",
  };
}

export const profileSchema = z.object({
  fullName: z.string().trim().min(1, "Enter your name.").max(120, "Use at most 120 characters."),
  units: z.enum(["imperial", "metric"], { message: "Choose units." }),
});

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] ??= issue.message;
  }
  return out;
}

/** Ensure the profile row exists (normally created by the auth trigger). */
async function ensureProfile(user: SessionUser) {
  await withUser(user, (tx) => tx`insert into public.profiles (id, email) values (${user.id}, ${user.email}) on conflict (id) do nothing`);
}

export async function updateProfile(user: SessionUser, input: unknown): Promise<Result> {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
  await ensureProfile(user);
  const { fullName, units } = parsed.data;
  const rows = await withUser(
    user,
    (tx) => tx`update public.profiles set full_name = ${fullName}, units = ${units} where id = ${user.id} returning id`,
  );
  return rows.length ? { ok: true } : { ok: false, error: "We couldn't save your profile. Please try again." };
}
