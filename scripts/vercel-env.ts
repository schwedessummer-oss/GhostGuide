/**
 * Build the Vercel environment variables from .env.local and copy them to
 * the clipboard, ready to paste into Vercel's "Environment Variables" box.
 *
 *   npm run vercel:env
 *
 * - Uses the TRANSACTION pooler (port 6543) for the app, as serverless
 *   functions need.
 * - Generates AUTH_SECRET and CRON_SECRET once and saves them in .env.local,
 *   so running this again gives the same values.
 * - Never prints secrets in full.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env.local");

function readEnvFile(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const strong = (v: string | undefined, min: number) => !!v && v.length >= min && !/^(dev-only|local-demo|e2e-|test-)/.test(v);

function copyToClipboard(text: string): boolean {
  const attempts: [string, string[]][] =
    process.platform === "win32"
      ? [["clip", []]]
      : process.platform === "darwin"
        ? [["pbcopy", []]]
        : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  for (const [cmd, args] of attempts) {
    const r = spawnSync(cmd, args, { input: text, shell: process.platform === "win32" });
    if (r.status === 0) return true;
  }
  return false;
}

function mask(key: string, value: string): string {
  if (/SECRET|KEY$|PASSWORD/.test(key) && !key.startsWith("NEXT_PUBLIC_")) return `${value.slice(0, 10)}…(hidden)`;
  if (key === "DATABASE_URL") return value.replace(/:([^:@/]+)@/, ":***@");
  return value;
}

async function main() {
  const local = readEnvFile();
  const missing = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY", "DATABASE_URL"].filter((k) => !local[k]);
  if (missing.length) {
    console.log(`Missing in .env.local: ${missing.join(", ")}. Run "npm run setup:supabase" first.`);
    process.exitCode = 1;
    return;
  }

  let publishable = local.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!publishable || !publishable.startsWith("sb_publishable_")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      const v = (await rl.question("Paste your Supabase PUBLISHABLE key (Settings → API Keys, starts with sb_publishable_):\n> ")).trim().replace(/^["']|["']$/g, "");
      if (v.startsWith("sb_publishable_")) {
        publishable = v;
        break;
      }
      console.log("  ✗ That doesn't start with sb_publishable_. Please try again.\n");
    }
    rl.close();
  }

  const authSecret = strong(local.AUTH_SECRET, 32) ? local.AUTH_SECRET : randomBytes(32).toString("hex");
  const cronSecret = strong(local.CRON_SECRET, 16) ? local.CRON_SECRET : randomBytes(24).toString("hex");

  // Persist generated values so re-running gives the same secrets.
  const updatedLocal = { ...local, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishable, AUTH_SECRET: authSecret, CRON_SECRET: cronSecret };
  writeFileSync(ENV_FILE, Object.entries(updatedLocal).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", "utf8");

  const transactionUrl = local.DATABASE_URL.replace(/:5432\//, ":6543/");
  const vars: [string, string][] = [
    ["APP_MODE", "demo"],
    ["NEXT_PUBLIC_SUPABASE_URL", local.NEXT_PUBLIC_SUPABASE_URL],
    ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", publishable],
    ["SUPABASE_SECRET_KEY", local.SUPABASE_SECRET_KEY],
    ["DATABASE_URL", transactionUrl],
    ["DATABASE_TRANSACTION_POOLER", "true"],
    ["DATABASE_SSL", "true"],
    ["DATABASE_POOL_MAX", "3"],
    ["AUTH_PROVIDER", "supabase"],
    ["STORAGE_PROVIDER", "supabase"],
    ["SUPABASE_STORAGE_BUCKET", local.SUPABASE_STORAGE_BUCKET || "trail-media"],
    ["AUTH_SECRET", authSecret],
    ["CRON_SECRET", cronSecret],
    ["PAYMENTS_PROVIDER", "demo"],
    ["AI_PROVIDER", "demo"],
    ["NOTIFY_PROVIDER", "demo"],
    ["WEATHER_PROVIDER", "demo"],
    ["LAUNCH_REGION_SLUG", "demo-ghost-ridge"],
  ];
  const block = vars.map(([k, v]) => `${k}=${v}`).join("\n");

  console.log("\nVercel environment variables (secrets hidden here):\n");
  for (const [k, v] of vars) console.log(`  ${k}=${mask(k, v)}`);
  if (!/:6543\//.test(transactionUrl)) console.log("\n  ⚠ DATABASE_URL does not use port 6543; check the connection string in .env.local.");

  if (copyToClipboard(block)) {
    console.log("\n✓ Copied all of them (with the real values) to your clipboard.");
    console.log("  In Vercel: open \"Environment Variables\", click in the first Key box, and paste (Ctrl + V).");
  } else {
    const fallback = path.join(ROOT, ".env.vercel.local"); // git-ignored (.env*)
    writeFileSync(fallback, block + "\n", "utf8");
    console.log("\n✗ Couldn't copy to the clipboard automatically.");
    console.log("  The full list is saved in .env.vercel.local: open it, select all, copy, and paste into Vercel.");
  }
  console.log("  NEXT_PUBLIC_APP_URL is not needed for the first deploy: the app uses your Vercel domain automatically.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
