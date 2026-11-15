import "server-only";
import { withAnon } from "@/server/db";

/** Known feature flags (seeded). Unknown keys evaluate to false. */
export const FLAGS = {
  checkout_enabled: "Allow customers to start checkout",
  addon_gear_locker: "Offer gear-locker add-on",
  addon_shuttle: "Offer shuttle add-on",
  addon_meal_pack: "Offer meal-pack add-on",
  addon_satellite_device: "Offer satellite-communicator rental add-on",
} as const;

export type FlagKey = keyof typeof FLAGS;

export async function getFlags(): Promise<Record<string, boolean>> {
  const rows = await withAnon((tx) => tx<{ key: string; enabled: boolean }[]>`select key, enabled from public.feature_flags`);
  return Object.fromEntries(rows.map((r) => [r.key, r.enabled]));
}

export async function isEnabled(key: FlagKey): Promise<boolean> {
  const flags = await getFlags();
  return flags[key] === true;
}
