/**
 * Guided Supabase setup (works in PowerShell, cmd, macOS and Linux terminals).
 *
 *   npm run setup:supabase
 *
 * Asks for the secret key, the database password and a demo password; finds
 * the project's connection pooler address by itself; writes .env.local
 * (git-ignored); checks the database; creates the private storage bucket;
 * and loads the demo data. Nothing is sent anywhere except your own
 * Supabase project.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import postgres from "postgres";

const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env.local");

/** Supabase regions; the project's own region is tried first when known. */
const REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "sa-east-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-central-2", "eu-north-1",
  "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-northeast-2",
];

const rl = createInterface({ input: process.stdin, output: process.stdout });

function say(msg = "") {
  process.stdout.write(`${msg}\n`);
}

/** Remove surrounding quotes and a pair of [ ] someone kept around a value. */
function clean(v: string): string {
  return v.trim().replace(/^["']|["']$/g, "").trim().replace(/^\[(.*)\]$/, "$1");
}

async function ask(question: string, validate: (v: string) => string | null): Promise<string> {
  for (;;) {
    const raw = clean(await rl.question(`${question}\n> `));
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

const isRealHost = (h: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.pooler\.supabase\.com$/i.test(h);

/** Parse a pasted connection string loosely (it may contain a placeholder host or brackets). */
function parseConnectionString(v: string): { ref: string | null; password: string; host: string | null } | null {
  const m = v.match(/^postgres(?:ql)?:\/\/([^:/@]+):(.*)@([^@/]+?)(?::\d+)?(?:\/[^/]*)?$/i);
  if (!m) return null;
  let password = m[2];
  try {
    password = decodeURIComponent(password);
  } catch {
    /* keep as typed */
  }
  const user = m[1];
  return {
    ref: /^postgres\.([a-z0-9]{20})$/i.test(user) ? user.split(".")[1].toLowerCase() : null,
    password: clean(password),
    host: isRealHost(m[3]) ? m[3].toLowerCase() : null,
  };
}

type Attempt = { ok: true; tables: number } | { ok: false; kind: "auth" | "tenant" | "dns" | "timeout" | "other"; message: string };

async function tryConnect(url: string): Promise<Attempt> {
  const sql = postgres(url, { max: 1, ssl: "require", connect_timeout: 10, onnotice: () => {} });
  try {
    const [row] = await sql<{ tables: number }[]>`
      select count(*)::int as tables from information_schema.tables
      where table_schema = 'public' and table_name in ('trails', 'trips', 'bookings')`;
    return { ok: true, tables: row.tables };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = /password authentication failed/i.test(message)
      ? "auth"
      : /tenant or user not found/i.test(message)
        ? "tenant"
        : /ENOTFOUND|EAI_AGAIN|EINVAL|getaddrinfo/i.test(message)
          ? "dns"
          : /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET/i.test(message)
            ? "timeout"
            : "other";
    return { ok: false, kind, message };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

async function main() {
  const existing = readExistingEnv();
  say("Ghost Guide: Supabase setup\n");
  say("You will need, from your Supabase dashboard:");
  say("  1. the SECRET key (Settings → API Keys, starts with sb_secret_)");
  say("  2. your DATABASE PASSWORD (Settings → Database; reset it there if you don't know it)");
  say("Tip: in PowerShell, right-click to paste.\n");

  const secretKey = await ask("Paste your Supabase SECRET key:", (v) =>
    !v ? "Nothing was pasted." : !v.startsWith("sb_secret_") ? "That doesn't start with sb_secret_. Copy the SECRET key, not the publishable one." : null,
  );

  // ---- project reference -----------------------------------------------------
  let ref = (existing.NEXT_PUBLIC_SUPABASE_URL ?? "").match(/^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/i)?.[1]?.toLowerCase() ?? null;

  // ---- database password (or a full connection string) ---------------------------
  let password = "";
  let givenHost: string | null = null;
  await ask("Type or paste your DATABASE PASSWORD (you may also paste the whole connection string):", (v) => {
    if (!v) return "Nothing was entered.";
    if (/^postgres(ql)?:\/\//i.test(v)) {
      const parsed = parseConnectionString(v);
      if (!parsed) return "That connection string looks incomplete. You can also just type the database password.";
      if (!parsed.password || /^YOUR-PASSWORD$/i.test(parsed.password)) return "The string still has [YOUR-PASSWORD] in it. Type just your database password instead.";
      password = parsed.password;
      givenHost = parsed.host;
      if (parsed.ref) ref = parsed.ref;
      return null;
    }
    if (/^YOUR-PASSWORD$/i.test(v)) return "That's the placeholder, not your password.";
    password = v;
    return null;
  });

  if (!ref) {
    const projectUrl = await ask("Paste your Supabase Project URL (Settings → API Keys, looks like https://abcd….supabase.co):", (v) =>
      /^https:\/\/[a-z0-9]{20}\.supabase\.co\/?$/i.test(v) ? null : "It should look like https://<20 letters/numbers>.supabase.co",
    );
    ref = projectUrl.match(/^https:\/\/([a-z0-9]{20})/i)![1].toLowerCase();
  }

  const demoPassword = await ask("Choose a password for the demo accounts (at least 10 characters):", (v) =>
    v.length < 10 ? "Use at least 10 characters." : /\s/.test(v) ? "Please don't use spaces." : null,
  );
  rl.close();

  // ---- find the connection pooler and check the database ----------------------------
  say("\n→ Finding your database (this can take up to a minute)…");
  const candidates: string[] = [];
  if (givenHost) candidates.push(givenHost);
  for (const prefix of ["aws-0", "aws-1", "aws-2"]) for (const region of REGIONS) candidates.push(`${prefix}-${region}.pooler.supabase.com`);
  const user = `postgres.${ref}`;
  const urlFor = (host: string) => `postgresql://${user}:${encodeURIComponent(password)}@${host}:5432/postgres`;

  let databaseUrl: string | null = null;
  let tables = 0;
  let sawTimeout = false;
  for (const host of [...new Set(candidates)]) {
    const attempt = await tryConnect(urlFor(host));
    if (attempt.ok) {
      databaseUrl = urlFor(host);
      tables = attempt.tables;
      say(`  ✓ Connected via ${host}`);
      break;
    }
    if (attempt.kind === "auth") {
      say("  ✗ Supabase found your database but rejected the password.");
      say("    → Reset the database password in Settings → Database (letters and numbers only), then run this again.");
      process.exitCode = 1;
      return;
    }
    if (attempt.kind === "timeout") sawTimeout = true;
    if (attempt.kind === "other") {
      say(`  ✗ Unexpected error from ${host}: ${attempt.message}`);
      process.exitCode = 1;
      return;
    }
    // tenant / dns: not this pooler, keep looking
  }
  if (!databaseUrl) {
    say("  ✗ Couldn't reach your database through any Supabase connection pooler.");
    if (sawTimeout) say("    → Connections timed out: check your internet connection, VPN or firewall (port 5432 must be allowed).");
    else say(`    → Check that the project ${ref} exists and is not paused (Supabase dashboard).`);
    process.exitCode = 1;
    return;
  }
  if (tables < 3) {
    say("  ✗ Connected, but the Ghost Guide tables are missing: the database migrations have not been applied to this project.");
    process.exitCode = 1;
    return;
  }
  say("  ✓ The Ghost Guide tables are there.");

  // ---- save settings ------------------------------------------------------
  const supabaseUrl = `https://${ref}.supabase.co`;
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
  say("\nFor Vercel, use the TRANSACTION pooler: the same DATABASE_URL with :6543 instead of :5432,");
  say("plus DATABASE_TRANSACTION_POOLER=true and DATABASE_SSL=true.");
}

main().catch((err) => {
  rl.close();
  say(`\nSetup stopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
