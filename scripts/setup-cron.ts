/**
 * Schedule Ghost Guide's background job runners on Supabase (pg_cron + pg_net).
 *
 *   npm run setup:cron
 *
 * Runs on YOUR computer (it uses DATABASE_URL and CRON_SECRET from .env.local,
 * which never leave your machine except to your own Supabase project):
 *   1. checks the deployed site accepts your CRON_SECRET
 *   2. enables pg_cron + pg_net, stores the site URL and CRON_SECRET in Supabase Vault
 *   3. schedules two every-minute calls:
 *        ghostguide-job-runner      → /api/cron/jobs     (safety + commerce jobs; fast)
 *        ghostguide-catalog-runner  → /api/cron/catalog  (trail data loading; slow)
 * Safe to run again (updates secrets and schedules in place).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import postgres from "postgres";

const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env.local");
const DEFAULT_SITE = "https://ghost-guide.vercel.app";

function readEnvFile(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const RUNNERS = [
  { name: "ghostguide-job-runner", path: "/api/cron/jobs", timeoutMs: 58_000 },
  { name: "ghostguide-catalog-runner", path: "/api/cron/catalog", timeoutMs: 290_000 },
] as const;

function cronCommand(runnerPath: string, timeoutMs: number): string {
  // No secrets in the command text: both values are read from Vault at run time.
  return `
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'ghostguide_app_url') || '${runnerPath}',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ghostguide_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := ${timeoutMs}
  );`;
}

async function main() {
  const local = readEnvFile();
  const databaseUrl = local.DATABASE_URL;
  const cronSecret = local.CRON_SECRET;
  if (!databaseUrl || !/supabase\.com/.test(databaseUrl)) {
    console.log('✗ DATABASE_URL in .env.local is missing or is not a Supabase address. Run "npm run setup:supabase" first.');
    process.exitCode = 1;
    return;
  }
  if (!cronSecret || cronSecret.length < 16) {
    console.log('✗ CRON_SECRET is missing in .env.local. Run "npm run vercel:env" (or vercel:secrets) first.');
    process.exitCode = 1;
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Your site address (press Enter for ${DEFAULT_SITE}):\n> `)).trim();
  rl.close();
  const site = (answer || DEFAULT_SITE).replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(site)) {
    console.log("✗ That doesn't look like a site address (it should start with https://).");
    process.exitCode = 1;
    return;
  }

  console.log(`\n→ Checking ${site}/api/cron/jobs accepts your CRON_SECRET…`);
  try {
    const res = await fetch(`${site}/api/cron/jobs`, { headers: { Authorization: `Bearer ${cronSecret}` } });
    if (res.status === 401) {
      console.log("  ✗ The site rejected the secret: the CRON_SECRET in .env.local differs from the one in Vercel.");
      console.log('    → Run "npm run vercel:secrets", paste into Vercel (replace CRON_SECRET), redeploy, then run this again.');
      process.exitCode = 1;
      return;
    }
    if (!res.ok) {
      console.log(`  ✗ The site answered HTTP ${res.status}. Make sure the latest version is deployed, then run this again.`);
      process.exitCode = 1;
      return;
    }
    console.log("  ✓ The job runner answered.");
  } catch (err) {
    console.log(`  ✗ Could not reach ${site}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const sql = postgres(databaseUrl, { max: 1, ssl: "require", onnotice: () => {}, connect_timeout: 15 });
  try {
    console.log("\n→ Enabling pg_cron and pg_net…");
    await sql`create extension if not exists pg_cron`;
    await sql`create extension if not exists pg_net`;

    console.log("→ Storing the site address and CRON_SECRET in Supabase Vault…");
    for (const [name, value] of [
      ["ghostguide_app_url", site],
      ["ghostguide_cron_secret", cronSecret],
    ] as const) {
      const [existing] = await sql<{ id: string }[]>`select id from vault.secrets where name = ${name}`;
      if (existing) await sql`select vault.update_secret(${existing.id}::uuid, ${value})`;
      else await sql`select vault.create_secret(${value}, ${name})`;
    }

    console.log("→ Scheduling the every-minute runners…");
    for (const r of RUNNERS) {
      await sql`select cron.schedule(${r.name}, '* * * * *', ${cronCommand(r.path, r.timeoutMs)})`;
      console.log(`  ✓ ${r.name} → ${r.path}`);
    }
    console.log("\n✓ Done. Within a minute, /status on your site should show background checks as Running.");
    console.log("  To stop later (Supabase SQL editor): select cron.unschedule('ghostguide-job-runner'); select cron.unschedule('ghostguide-catalog-runner');");
  } catch (err) {
    console.log(`\n✗ Setup stopped: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
