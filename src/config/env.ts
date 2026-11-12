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

  // ---- Real-data providers (trail catalog, geocoding, elevation, trail weather).
  // Base URLs are configurable so tests can point at local mocks and production
  // can move to self-hosted / commercial instances without code changes.
  /**
   * Identifying User-Agent sent to OpenStreetMap services (Overpass, Nominatim),
   * MET Norway and NWS. Their usage policies require an app name plus a contact
   * (URL or email), e.g. "GhostGuide/1.0 (+https://ghostguide.app; ops@ghostguide.app)".
   */
  DATA_PROVIDER_USER_AGENT: z.string().min(8).optional(),
  /** Comma-separated Overpass API endpoints, tried in order. */
  OVERPASS_URLS: z.string().min(8).default("https://overpass-api.de/api/interpreter"),
  NOMINATIM_URL: z.string().url().default("https://nominatim.openstreetmap.org"),
  METNO_URL: z.string().url().default("https://api.met.no/weatherapi"),
  NWS_URL: z.string().url().default("https://api.weather.gov"),
  /** Terrarium-encoded terrain tiles ({z}/{x}/{y}); default: AWS Open Data Terrain Tiles. */
  TERRAIN_TILES_URL: z.string().min(8).default("https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png"),
  RIDB_URL: z.string().url().default("https://ridb.recreation.gov/api/v1"),
  /** Recreation.gov RIDB API key (free). Enables US facilities/permit enrichment. */
  RIDB_API_KEY: z.string().optional(),
  /** Days before a loaded catalog tile is refreshed from its provider. */
  CATALOG_TILE_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Most tiles one search may request to load (bigger areas ask the user to zoom in). */
  CATALOG_MAX_TILES_PER_SEARCH: z.coerce.number().int().min(1).max(64).default(16),
  /** Start loading missing tiles right after a search responds (in addition to the job runner). */
  CATALOG_INLINE_INGEST: bool.default(true),
  /**
   * Show the fictional demo region (curated trails, demo bookings) in discovery.
   * Default: on in development/test, off in production builds.
   */
  SHOW_DEMO_FIXTURES: bool.optional(),

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
  const source: Record<string, string | undefined> = { ...process.env };
  // On Vercel, default the public URL to the project's production domain
  // (system env var) so a first deploy works before NEXT_PUBLIC_APP_URL is set.
  if (!source.NEXT_PUBLIC_APP_URL) {
    const vercelHost = source.VERCEL_PROJECT_PRODUCTION_URL || source.VERCEL_URL;
    if (vercelHost) source.NEXT_PUBLIC_APP_URL = `https://${vercelHost}`;
  }
  const parsed = schema.safeParse(source);
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

/**
 * On Vercel, never fall back to the local development database: a missing
 * DATABASE_URL would otherwise surface as a confusing
 * "connect ECONNREFUSED 127.0.0.1:54322" on every page.
 */
export function assertDatabaseConfigured(source: Record<string, string | undefined> = process.env) {
  if (source.VERCEL && !source.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set for this Vercel deployment. Add it in Vercel → Settings → Environment Variables " +
        "(run `npm run vercel:secrets` locally to copy it), then redeploy. See docs/DEPLOYMENT.md.",
    );
  }
}

/** Reset cached env (tests only). */
export function resetEnvCache() {
  cached = null;
}

export const isDemoMode = () => env().APP_MODE === "demo";

/**
 * Whether the fictional demo region (development fixtures) is shown in
 * discovery. Production experiences use only real provider data.
 */
export function showDemoFixtures(): boolean {
  const e = env();
  return e.SHOW_DEMO_FIXTURES ?? e.NODE_ENV !== "production";
}

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
    trailData: "live (OpenStreetMap via Overpass, loaded on demand)",
    usFacilities: e.RIDB_API_KEY ? "live (Recreation.gov RIDB)" : "not configured (needs RIDB_API_KEY)",
    geocoding: "live (Nominatim, OpenStreetMap)",
    elevation: "live (AWS Terrain Tiles; estimates)",
    maps: "live (MapLibre + OpenFreeMap vector tiles)",
    trailWeather: "live (MET Norway forecasts; NWS alerts in the US)",
    ai: e.AI_PROVIDER === "anthropic" && e.ANTHROPIC_API_KEY ? "live (Anthropic)" : "simulated templates",
    notifications: e.NOTIFY_PROVIDER === "live" ? "live" : "simulated",
    weather: e.WEATHER_PROVIDER === "nws" ? "live (api.weather.gov)" : "simulated",
    partners: "simulated (no partner APIs integrated)",
  } as const;
}
