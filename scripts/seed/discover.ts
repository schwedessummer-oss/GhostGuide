import type postgres from "postgres";

/**
 * Additional demo data for the discover slice (runs after the core seed, on a fresh database).
 *
 *  - app_settings.latest_finish_by_month: the conservative "be off the trail by"
 *    planning table per region (an ESTIMATE, not an exact sunset), editable by admins.
 *  - A demonstration ADVISORY on Whisper Falls so the advisory badge and
 *    scoring penalty are visible in the demo (clearly labeled fictional).
 */
export const DEMO_LATEST_FINISH_BY_MONTH: Record<string, string> = {
  "1": "15:45",
  "2": "16:30",
  "3": "17:15",
  "4": "19:00",
  "5": "19:45",
  "6": "20:15",
  "7": "20:00",
  "8": "19:00",
  "9": "18:15",
  "10": "17:15",
  "11": "15:45",
  "12": "15:45",
};

export async function seedDiscover(sql: postgres.Sql) {
  await sql`
    insert into public.app_settings (key, value, description)
    values ('latest_finish_by_month', ${sql.json({ "demo-ghost-ridge": DEMO_LATEST_FINISH_BY_MONTH })},
            'Per-region conservative latest-finish planning times by month (region-local HH:MM). Estimates, not exact sunset times.')
    on conflict (key) do nothing`;

  const [trail] = await sql<{ id: string }[]>`select id from public.trails where slug = 'whisper-falls'`;
  const [source] = await sql<{ id: string }[]>`select id from public.sources where label = 'Simulated field survey (demo)' limit 1`;
  if (trail) {
    await sql`
      insert into public.trail_closures (trail_id, severity, reason, source_id, starts_at, ends_at)
      values (${trail.id}, 'advisory',
              'Seasonal stepping-stone crossing can be slippery after heavy rain (demonstration advisory, fictional).',
              ${source?.id ?? null}, now() - interval '1 day', now() + interval '60 days')`;
  }
  console.log("Seeded discover settings and a demonstration advisory.");
}
