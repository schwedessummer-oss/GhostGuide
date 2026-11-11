/**
 * Guided Supabase setup (works in PowerShell, cmd, macOS and Linux terminals).
 *
 *   npm run setup:supabase
 *
 * Asks for three values, writes them to .env.local (git-ignored), checks the
 * database connection, creates the private storage bucket, and loads the
 * demo data. Nothing is sent anywhere except your own Supabase project.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import postgres from "postgres";

const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env.local");

const rl = createInterface({ input: process.stdin, output: process.stdout });

function say(msg = "") {
  process.stdout.write(`${msg}\n`);
}

async function ask(question: string, validate: (v: string) => string | null): Promise<string> {
  for (;;) {
    const raw = (await rl.question(`${question}\n> `)).trim().replace(/^["']|["']$/g, "");
    const problem = validate(raw);
    if (!problem) return raw;
    say(`  ✗ ${problem}`);
    say("  Please try again.\n");
  }
}

function readExistingEnv(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function run(label: string, command: string, env: NodeJS.ProcessEnv): boolean {
  say(`\n→ ${label}…`);
  const r = spawnSync(command, { cwd: ROOT, env, stdio: "inherit", shell: true });
  if (r.status === 0) {
    say(`  ✓ ${label} done.`);
    return true;
  }
  say(`  ✗ ${label} failed (see the message above).`);
  return false;
}

async function main() {
  say("Ghost Guide: Supabase setup\n");
  say("You will need, from your Supabase dashboard:");
  say("  1. the SECRET key (Settings → API Keys, starts with sb_secret_)");
  say("  2. the SESSION POOLER connection string (Connect button → Session pooler),");
  say("     with your database password filled in instead of [YOUR-PASSWORD]");
  say("Tip: in PowerShell, right-click to paste.\n");

  const secretKey = await ask("Paste your Supabase SECRET key:", (v) =>
    !v ? "Nothing was pasted." : !v.startsWith("sb_secret_") ? "That doesn't start with sb_secret_. Copy the SECRET key, not the publishable one." : null,
  );

  const databaseUrl = await ask("Paste your SESSION POOLER connection string:", (v) => {
    if (!v) return "Nothing was pasted.";
    if (!/^postgres(ql)?:\/\//.test(v)) return "It should start with postgresql://";
    if (/\[YOUR-PASSWORD\]|YOUR-PASSWORD/i.test(v)) return "Replace [YOUR-PASSWORD] (including the brackets) with your database password first.";
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return "That doesn't look like a complete connection string.";
    }
    if (!/^postgres\.[a-z0-9]{20}$/.test(decodeURIComponent(u.username))) return "The user part should look like postgres.<your-project-id> (the pooler string, not the direct one).";
    if (!u.password) return "The password is missing (it goes between the ':' and the '@').";
    if (u.port !== "5432") return `Use the SESSION pooler string (port 5432). This one uses port ${u.port || "(none)"}.`;
    if (!u.hostname.endsWith("pooler.supabase.com")) return "Use the pooler string (host ends with pooler.supabase.com), not the direct connection.";
    return null;
  });

  const projectRef = decodeURIComponent(new URL(databaseUrl).username).split(".")[1];
  const supabaseUrl = `https://${projectRef}.supabase.co`;

  const demoPassword = await ask("Choose a password for the demo accounts (at least 10 characters):", (v) =>
    v.length < 10 ? "Use at least 10 characters." : /\s/.test(v) ? "Please don't use spaces." : null,
  );
  rl.close();

  // ---- save settings ------------------------------------------------------
  const existing = readExistingEnv();
  const values: Record<string, string> = {
    ...existing,
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    SUPABASE_SECRET_KEY: secretKey,
    DATABASE_URL: databaseUrl,
    DATABASE_SSL: "true",
    AUTH_PROVIDER: "supabase",
    STORAGE_PROVIDER: "supabase",
    SEED_DEMO_PASSWORD: demoPassword,
  };
  writeFileSync(ENV_FILE, Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", "utf8");
  say(`\n✓ Saved settings to .env.local (this file stays on your computer; git ignores it).`);
  say(`  Project: ${supabaseUrl}`);

  // ---- check the database connection -------------------------------------
  say("\n→ Checking the database connection…");
  const sql = postgres(databaseUrl, { max: 1, ssl: "require", connect_timeout: 15, onnotice: () => {} });
  try {
    const [row] = await sql<{ tables: number }[]>`
      select count(*)::int as tables from information_schema.tables where table_schema = 'public' and table_name in ('trails', 'trips', 'bookings')`;
    if (row.tables < 3) {
      say("  ✗ Connected, but the Ghost Guide tables are missing. The database migrations have not been applied to this project.");
      process.exitCode = 1;
      return;
    }
    say("  ✓ Connected, and the Ghost Guide tables are there.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    say(`  ✗ Could not connect: ${msg.replace(databaseUrl, "[connection string]")}`);
    if (/password authentication failed/i.test(msg)) say("    → The database password is wrong. Reset it in Settings → Database, then run this again.");
    else if (/ENOTFOUND|getaddrinfo/i.test(msg)) say("    → The host name wasn't found. Copy the Session pooler string again from the Connect dialog.");
    else if (/timeout|ETIMEDOUT|ECONNREFUSED/i.test(msg)) say("    → The connection timed out. Check your internet connection or firewall, then try again.");
    else if (/tenant or user not found/i.test(msg)) say("    → The user part is wrong. It must be postgres.<your-project-id>, as shown in the Connect dialog.");
    process.exitCode = 1;
    return;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }

  // ---- storage bucket + demo data ------------------------------------------
  const env = { ...process.env, ...values };
  if (!run("Creating the private file bucket", "npx tsx scripts/setup-supabase-storage.ts", env)) {
    process.exitCode = 1;
    return;
  }
  if (!run("Loading the demo trails and demo accounts", "npm run -s db:seed", env)) {
    process.exitCode = 1;
    return;
  }

  say("\n✓ All done. Demo accounts (password = the one you just chose):");
  say("    admin@demo.ghostguide.test   hiker@demo.ghostguide.test   safety@demo.ghostguide.test");
  say("    operator@demo.ghostguide.test   editor@demo.ghostguide.test   support@demo.ghostguide.test");
}

main().catch((err) => {
  rl.close();
  say(`\nSetup stopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
