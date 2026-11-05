import "server-only";
import { withAnon } from "@/server/db";

/** Known feature flags (seeded). Unknown keys evaluate to false. */
export const FLAGS = {
  checkout_enabled: "Allow customers to start checkout",
  ai_explanations: "Use the AI provider for itinerary explanations (falls back to templates)",
  addon_gear_locker: "Offer gear-locker add-on",
  addon_shuttle: "Offer shuttle add-on",
  addon_meal_pack: "Offer meal-pack add-on",
  addon_satellite_device: "Offer satellite-communicator rental add-on",
  trip_sharing: "Allow customers to create expiring trip-share links",
  checkins_enabled: "Allow customers to opt in to trip check-ins",
  marketing_drafts: "Enable the marketing-draft workflow in admin",
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
