import "server-only";
import { withSystem, type Tx } from "@/server/db";
import { parseCancellationPolicy, type CancellationPolicy } from "@/domain/booking";

/**
 * Commerce settings from app_settings (admin-editable). app_settings is
 * staff-readable only under RLS, so trusted server code reads it here; the
 * values themselves are not sensitive and are shown to customers.
 */
export interface CommerceSettings {
  holdMinutes: number;
  policy: CancellationPolicy;
}

export const DEFAULT_HOLD_MINUTES = 30;

export async function getCommerceSettings(tx?: Tx): Promise<CommerceSettings> {
  const read = (t: Tx) =>
    t<{ key: string; value: unknown }[]>`
      select key, value from public.app_settings where key in ('checkout_hold_minutes', 'cancellation_policy')`;
  const rows = tx ? await read(tx) : await withSystem(read);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const hold = Number(byKey.checkout_hold_minutes);
  return {
    holdMinutes: Number.isInteger(hold) && hold >= 5 && hold <= 24 * 60 ? hold : DEFAULT_HOLD_MINUTES,
    policy: parseCancellationPolicy(byKey.cancellation_policy),
  };
}
