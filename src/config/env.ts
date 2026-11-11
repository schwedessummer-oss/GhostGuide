import { z } from "zod";

/**
 * Server-side configuration. Never import this from client components:
 * it reads secrets. Public values are exposed via `publicConfig` below.
 *
 * APP_MODE
 *   demo — simulated providers are allowed and clearly labeled in the UI.
 *   live — every integration must be configured with a real provider;
 *          simulated adapters refuse to run (see assertLiveSafe()).
 */
const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_MODE: z.enum(["demo", "live"]).default("demo"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1).default("postgres://postgres:postgres@127.0.0.1:54322/ghostguide"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  /** Set true when connecting through a transaction-mode pooler (Supabase port 6543). */
  DATABASE_TRANSACTION_POOLER: bool.default(false),
  DATABASE_SSL: bool.default(false),

  AUTH_PROVIDER: z.enum(["demo", "supabase"]).default("demo"),
  /** HMAC secret for demo sessions, demo webhooks, share tokens, access codes. */
  AUTH_SECRET: z.string().min(32).default("dev-only-insecure-secret-change-me-0123456789"),

  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),

  STORAGE_PROVIDER: z.enum(["local", "supabase"]).default("local"),
  LOCAL_STORAGE_DIR: z.string().default(".data/storage"),
  SUPABASE_STORAGE_BUCKET: z.string().default("trail-media"),

  PAYMENTS_PROVIDER: z.enum(["demo", "stripe"]).default("demo"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  NEXT_PUBLIC_MAPBOX_TOKEN: z.string().optional(),

  AI_PROVIDER: z.enum(["demo", "anthropic"]).default("demo"),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("claude-sonnet-5-5"),

  NOTIFY_PROVIDER: z.enum(["demo", "live"]).default("demo"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  NOTIFY_FROM_EMAIL: z.string().optional(),

  WEATHER_PROVIDER: z.enum(["demo", "nws"]).default("demo"),
  /** api.weather.gov requires an identifying User-Agent (app name + operator contact). */
  WEATHER_USER_AGENT: z.string().optional(),

  CRON_SECRET: z.string().min(16).default("dev-only-cron-secret"),
  LAUNCH_REGION_SLUG: z.string().default("demo-ghost-ridge"),
  LOCATION_RETENTION_DAYS_DEFAULT: z.coerce.number().int().min(1).max(365).default(30),
  /** Multiplies every rate limit. Automated tests only; must be 1 in live mode. */
  RATE_LIMIT_SCALE: z.coerce.number().int().min(1).max(1000).default(1),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | null = null;

export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Do not print values: they may be secrets.
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid server configuration for: ${fields}`);
  }
  const value = parsed.data;
  if (value.NODE_ENV === "production" && value.APP_MODE === "live") {
    if (value.AUTH_SECRET.startsWith("dev-only")) throw new Error("AUTH_SECRET must be set in live mode");
    if (value.CRON_SECRET.startsWith("dev-only")) throw new Error("CRON_SECRET must be set in live mode");
    if (value.RATE_LIMIT_SCALE !== 1) throw new Error("RATE_LIMIT_SCALE must be 1 in live mode");
  }
  cached = value;
  return value;
}

/** Reset cached env (tests only). */
export function resetEnvCache() {
  cached = null;
}

export const isDemoMode = () => env().APP_MODE === "demo";

/**
 * Throw if a simulated integration is about to run in live mode. Simulated
 * adapters call this so a misconfigured production deploy fails loudly rather
 * than pretending to send a notification or take a payment.
 */
export function assertSimulationAllowed(integration: string) {
  if (env().APP_MODE === "live") {
    throw new Error(`Simulated ${integration} adapter cannot run when APP_MODE=live. Configure a real provider.`);
  }
}

/** Snapshot of which integrations are real vs simulated, for status pages. */
export function integrationStatus() {
  const e = env();
  return {
    mode: e.APP_MODE,
    auth: e.AUTH_PROVIDER === "supabase" ? "live" : "simulated",
    storage: e.STORAGE_PROVIDER === "supabase" ? "live" : "local",
    payments: e.PAYMENTS_PROVIDER === "stripe" ? "live (Stripe test/live keys)" : "simulated",
    maps: e.NEXT_PUBLIC_MAPBOX_TOKEN ? "live (Mapbox)" : "offline vector view (no basemap)",
    ai: e.AI_PROVIDER === "anthropic" && e.ANTHROPIC_API_KEY ? "live (Anthropic)" : "simulated templates",
    notifications: e.NOTIFY_PROVIDER === "live" ? "live" : "simulated",
    weather: e.WEATHER_PROVIDER === "nws" ? "live (api.weather.gov)" : "simulated",
    partners: "simulated (no partner APIs integrated)",
  } as const;
}
