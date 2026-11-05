import "server-only";
import { z } from "zod";
import { withSystem, type Tx } from "@/server/db";
import { env } from "@/config/env";
import { GRACE_MAX, GRACE_MIN, normalizeReminderOffsets } from "@/domain/checkin";
import { DEFAULT_STALE_MINUTES } from "@/domain/staleness";

/**
 * Safety-related operator settings (app_settings, staff-readable only, so
 * read here as trusted server code). Invalid or missing values fall back to
 * safe defaults instead of failing a safety job.
 */
export interface SafetySettings {
  graceMinutes: number;
  reminderOffsetsMin: number[];
  staleLocationMinutes: number;
  retentionDefaultDays: number;
}

const checkinDefaults = z.object({
  graceMinutes: z.number().int().min(GRACE_MIN).max(GRACE_MAX),
  reminderOffsetsMin: z.array(z.number().int()).max(10),
});

export async function getSafetySettings(tx?: Tx): Promise<SafetySettings> {
  const read = (t: Tx) =>
    t<{ key: string; value: unknown }[]>`
      select key, value from public.app_settings
      where key in ('checkin_defaults', 'stale_location_minutes', 'location_retention_default_days')`;
  const rows = tx ? await read(tx) : await withSystem(read);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const defaults = checkinDefaults.safeParse(byKey.checkin_defaults);
  const stale = z.number().int().min(1).max(24 * 60).safeParse(byKey.stale_location_minutes);
  const retention = z.number().int().min(1).max(365).safeParse(byKey.location_retention_default_days);
  return {
    graceMinutes: defaults.success ? defaults.data.graceMinutes : 60,
    reminderOffsetsMin: defaults.success ? normalizeReminderOffsets(defaults.data.reminderOffsetsMin) : [60, 15],
    staleLocationMinutes: stale.success ? stale.data : DEFAULT_STALE_MINUTES,
    retentionDefaultDays: retention.success ? retention.data : env().LOCATION_RETENTION_DAYS_DEFAULT,
  };
}
