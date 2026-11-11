import "server-only";
import { z } from "zod";
import { withSystem, withUser } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { recordAudit } from "@/server/audit";
import { normalizePhone } from "@/domain/notification-messages";

/**
 * Profile and privacy settings. Writes go through withUser (RLS + column
 * grants: only full_name, phone, units, location_retention_days,
 * share_location_with_contacts, marketing_opt_in are writable by customers).
 */
export interface ProfileView {
  id: string;
  email: string;
  fullName: string | null;
  phone: string | null;
  units: "imperial" | "metric";
  locationRetentionDays: number;
  shareLocationWithContacts: boolean;
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; fieldErrors?: Record<string, string> };

export async function getProfile(user: SessionUser): Promise<ProfileView> {
  const [p] = await withUser(
    user,
    (tx) => tx<Omit<ProfileView, "email">[]>`
      select id, full_name, public.profile_phone(id) as phone, units, location_retention_days, share_location_with_contacts
      from public.profiles where id = ${user.id}`,
  );
  return {
    id: user.id,
    email: user.email,
    fullName: p?.fullName ?? null,
    phone: p?.phone ?? null,
    units: p?.units ?? "imperial",
    locationRetentionDays: p?.locationRetentionDays ?? 30,
    shareLocationWithContacts: p?.shareLocationWithContacts ?? true,
  };
}

const optionalPhone = z
  .string()
  .trim()
  .max(32)
  .transform((v, ctx) => {
    if (!v) return null;
    const n = normalizePhone(v);
    if (!n) {
      ctx.addIssue({ code: "custom", message: "Enter a phone number with country code, e.g. +1 555 555 0123." });
      return z.NEVER;
    }
    return n;
  });

export const profileSchema = z.object({
  fullName: z.string().trim().min(1, "Enter your name.").max(120, "Use at most 120 characters."),
  phone: optionalPhone,
  units: z.enum(["imperial", "metric"], { message: "Choose units." }),
});

export const privacySchema = z.object({
  locationRetentionDays: z.coerce
    .number({ message: "Enter a number of days." })
    .int("Use whole days.")
    .min(1, "Keep location history for at least 1 day.")
    .max(365, "Keep location history for at most 365 days."),
  shareLocationWithContacts: z.boolean(),
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
  const { fullName, phone, units } = parsed.data;
  const rows = await withUser(
    user,
    (tx) => tx`update public.profiles set full_name = ${fullName}, phone = ${phone}, units = ${units} where id = ${user.id} returning id`,
  );
  return rows.length ? { ok: true } : { ok: false, error: "We couldn't save your profile. Please try again." };
}

export async function updatePrivacySettings(user: SessionUser, input: unknown): Promise<Result> {
  const parsed = privacySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
  await ensureProfile(user);
  const { locationRetentionDays, shareLocationWithContacts } = parsed.data;
  const rows = await withUser(
    user,
    (tx) => tx`
      update public.profiles set location_retention_days = ${locationRetentionDays}, share_location_with_contacts = ${shareLocationWithContacts}
      where id = ${user.id} returning id`,
  );
  if (!rows.length) return { ok: false, error: "We couldn't save your settings. Please try again." };
  await withSystem((tx) =>
    recordAudit(tx, { id: user.id, roles: user.roles }, "privacy.settings_updated", "profile", user.id, {
      retentionDays: locationRetentionDays,
      shareWithContacts: shareLocationWithContacts,
    }),
  );
  return { ok: true };
}

/**
 * "Delete my location history now": every location point and last-known
 * location of THIS user, in one transaction with its audit entry. Runs as
 * trusted code scoped explicitly to user.id (audit_logs is not writable by
 * API roles).
 */
export async function deleteLocationHistory(user: SessionUser): Promise<{ pointsDeleted: number; lastFixesDeleted: number }> {
  return withSystem(async (tx) => {
    const points = await tx`delete from public.location_points where user_id = ${user.id} returning id`;
    const fixes = await tx`delete from public.hike_last_locations where user_id = ${user.id} returning hike_session_id`;
    await recordAudit(tx, { id: user.id, roles: user.roles }, "privacy.location_history_deleted", "profile", user.id, {
      pointsDeleted: points.length,
      lastFixesDeleted: fixes.length,
    });
    return { pointsDeleted: points.length, lastFixesDeleted: fixes.length };
  });
}

/** Counts shown on the privacy page (own data, RLS). */
export async function locationHistoryStats(user: SessionUser): Promise<{ points: number; oldest: Date | null; lastFixes: number }> {
  return withUser(user, async (tx) => {
    const [p] = await tx<{ points: number; oldest: Date | null }[]>`
      select count(*)::int as points, min(recorded_at) as oldest from public.location_points where user_id = ${user.id}`;
    const [f] = await tx<{ n: number }[]>`select count(*)::int as n from public.hike_last_locations where user_id = ${user.id}`;
    return { points: p?.points ?? 0, oldest: p?.oldest ?? null, lastFixes: f?.n ?? 0 };
  });
}
