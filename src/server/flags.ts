import "server-only";
import { withAnon } from "@/server/db";

/**
 * Known feature flags (key → description), each backed by a row in
 * public.feature_flags. Unknown keys evaluate to false. None are defined at
 * the moment: add an entry here, and seed its row, when a feature needs a
 * switch.
 */
export const FLAGS = {} as const satisfies Record<string, string>;

export type FlagKey = keyof typeof FLAGS;

export async function getFlags(): Promise<Record<string, boolean>> {
  const rows = await withAnon((tx) => tx<{ key: string; enabled: boolean }[]>`select key, enabled from public.feature_flags`);
  return Object.fromEntries(rows.map((r) => [r.key, r.enabled]));
}

export async function isEnabled(key: FlagKey): Promise<boolean> {
  const flags = await getFlags();
  return flags[key] === true;
}
