# Ghost Guide

The digital hiking companion that helps you **plan the whole outdoor trip, guides you through it, and
helps you get home safely**:

**Discover → Plan → Drive → Hike → Protect → Return.**

Ghost Guide is being turned from a demo into a production platform in phases (see
[`docs/PLATFORM_PLAN.md`](docs/PLATFORM_PLAN.md)). **Phase 1 (real data) is what runs today:**

- **Real trails worldwide** from OpenStreetMap, loaded on demand per area and refreshed by
  background jobs. Recreation.gov facilities are added in the US once a free RIDB key is set.
- **Explore:** geographic search ("Banff", "trails near Denver"), a map/list view with clustering
  and filters, and "search this area".
- **Trail pages** (`/trail/<country>/<region>/<slug>`), each with:
  - route map and elevation profile (estimated from terrain data)
  - honest stats, with estimates labeled
  - live MET Norway forecast, plus official NWS alerts in the US
  - daylight planning
  - parking and restrooms, plus nearby gas, food, lodging and medical care
  - emergency numbers
  - source attribution and freshness
- **Saved trails**, a sitemap and structured data for search engines.
- **Admin "Trail data" view:** provider health, API usage and estimated cost, coverage and retries,
  and moderation.

Still from the earlier MVP, working on the **fictional demo region** (development fixtures, hidden
in production):

- booking/checkout (payments simulated)
- offline trip download
- the GPS hike screen with geofenced narration
- opt-in check-ins with overdue notices (notifications simulated)

Phases 2–5 bring these flows to real trails: Ghost Trip planner, Ghost Guard safety with real
notification delivery, the offline/hike experience, then Stripe subscriptions, analytics and auth
hardening.

> **Honesty rules.**
> - Data is never invented. When a provider has no value, the UI says so. When a provider fails,
>   the UI says the data is unavailable and never falls back to fake data.
> - Estimates (duration, DEM elevation, difficulty) are labeled.
> - Ghost Guide does **not** contact emergency services.
>
> See [`/status`](http://localhost:3000/status) for what is live versus simulated in a deployment.

## Architecture (short)

| Layer | Technology |
|---|---|
| App | Next.js 16 App Router (React 19, TypeScript strict, Tailwind 4), PWA, `proxy.ts` for Supabase sessions |
| Data | Supabase Postgres 17 + **PostGIS** (local: PostgreSQL 16 + PostGIS 3.4 with a small Supabase shim). Row-level security on every table |
| DB access | `withUser` (RLS as `authenticated`), `withAnon` (public reads), `withSystem` (trusted jobs/webhooks), on postgres.js |
| Trail data | `TrailDataProvider` interface (`src/server/trails/providers/**`): OSM via Overpass, RIDB. Normalized → enriched → `catalog_trails` / `catalog_pois` |
| On-demand loading | 0.25° tile grid (`catalog_tiles`). A search requests missing tiles → deduplicated jobs plus immediate after-response loading. Global cap of 2 concurrent Overpass downloads |
| Enrichment | AWS Terrain Tiles elevation (smoothed gain/loss, measured from the trailhead), Tobler duration incl. out-and-back totals, SAC/effort difficulty, trailhead (OSM trailhead → parking → route start), features and amenities from nearby POIs, admin names (Nominatim reverse), time zone, stable SEO slugs, cross-tile merging |
| Maps | MapLibre GL JS + OpenFreeMap vector tiles + terrain hillshade (no API key) |
| Weather | MET Norway Locationforecast (cached, honoring `Expires`/`If-Modified-Since`), NWS alerts (US); sun times computed locally |
| Jobs | Postgres queue. `/api/cron/jobs` runs fast safety/commerce jobs; `/api/cron/catalog` runs slow trail downloads. Both are triggered every minute by Supabase pg_cron (`npm run setup:cron`) |
| Provider calls | One client (`src/server/providers/http.ts`): identifying User-Agent, timeouts, retries, global throttles, daily usage accounting |

More: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (data access, jobs, safety contracts) and
[`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) (every provider, its license, caching and cost).

## Local setup

Requires Node ≥ 20.19 and PostgreSQL ≥ 15 **with PostGIS** (Debian/Ubuntu:
`apt install postgresql-16-postgis-3`). The default `DATABASE_URL` expects `127.0.0.1:54322`.

```bash
cp .env.example .env.local
```

In `.env.local`, set `AUTH_SECRET` (32+ characters), `CRON_SECRET` (16+ characters) and
`DATA_PROVIDER_USER_AGENT`. Then:

```bash
npm install
```

```bash
npm run db:reset
```

```bash
npm run dev
```

```bash
npm run jobs:run -- --watch
```

- `npm run db:reset` creates the database, applies the migrations (plus the local shim) and seeds
  the demo data.
- `npm run dev` serves the app on http://localhost:3000. Open `/explore` and search any place.
- `npm run jobs:run -- --watch` runs background jobs in a second terminal (a stand-in for cron).

Real trails load from the public Overpass API when you search. Overpass is free but can be slow or
busy. To work offline, load the recorded OpenStreetMap samples (Table Rock State Park, SC) through
the real pipeline:

```bash
npm run db:seed:catalog-fixtures
```

Demo accounts (local only; password from `SEED_DEMO_PASSWORD`, default `ghostguide-demo`):

| Account | Role |
|---|---|
| `hiker@demo.ghostguide.test` | customer (has a consenting emergency contact) |
| `hiker2@demo.ghostguide.test` | customer |
| `admin@demo.ghostguide.test` | admin (everything) |
| `operator@demo.ghostguide.test` | operations: bookings, gear, fulfillment, jobs, trail data |
| `safety@demo.ghostguide.test` | safety desk: active trips, overdue check-ins, precise locations |
| `editor@demo.ghostguide.test` | content editor: curated trails, narration approval |
| `support@demo.ghostguide.test` | customer support (no precise location access) |

## Environment variables

Every variable is documented in [`.env.example`](.env.example): its purpose, where to get it, and
whether it is server-only or public (`NEXT_PUBLIC_*`). Phase 1 needs **no paid keys**:

- `DATA_PROVIDER_USER_AGENT`: an identifying app name plus a contact URL or email. The OSM, MET
  Norway and NWS policies require it.
- `RIDB_API_KEY` (optional, free): US federal facilities.
- Provider base URLs (`OVERPASS_URLS`, `NOMINATIM_URL`, `METNO_URL`, `NWS_URL`, `TERRAIN_TILES_URL`,
  `NEXT_PUBLIC_MAP_STYLE_URL`): change them to move to self-hosted or commercial instances; the tests
  point them at mocks.
- `SHOW_DEMO_FIXTURES`: shows the fictional region. Off by default in production builds.

## Database and migrations

Migrations live in `supabase/migrations` as plain SQL.

- **Local:** `npm run db:migrate` (or `db:reset`).
- **Supabase:** `supabase db push`, or apply each file in order. The Phase 1 files enable PostGIS
  (`extensions` schema) and add the catalog tables, then the ingestion state (aliases, merge parts),
  then the stored hike totals.

## Background jobs

| Runner | Kinds | Trigger |
|---|---|---|
| `/api/cron/jobs` (60 s) | check-in reminders and overdue notices, holds, reconciliation, retention purges, permit reminders | pg_cron every minute, plus a daily Vercel cron as a safety net |
| `/api/cron/catalog` (300 s) | `catalog.ingest_tile`, `catalog.refresh_stale` (hourly), `catalog.purge_caches` (daily) | pg_cron every minute |

Schedule both runners once from your computer:

```bash
npm run setup:cron
```

It uses `DATABASE_URL` and `CRON_SECRET` from `.env.local` and stores the secret in Supabase Vault.
All jobs are idempotent: dedup keys, row claims, fenced tile claims, retries with backoff and a dead
letter for jobs that keep failing.

## Testing

| Command | What it runs |
|---|---|
| `npm run typecheck` / `npm run lint` | `next typegen` + `tsc`; ESLint |
| `npm run test:unit` | pure logic: OSM parsing, geo/elevation/sun math, estimates, highlights, URL state, … |
| `npm run test:integration` | Postgres + PostGIS: RLS, search filters, ingestion/merge/retire, coverage, jobs, conditions, saved trails, admin |
| `npm run test:e2e` | production build + headless Chromium, with **mock data providers** (`tests/e2e/mock-providers.mjs`): search → on-demand loading → results → trail page → save |
| `npm run verify` | typecheck + lint + all Vitest tests + production build |

Tests never call real providers. The fixtures are recorded real responses (OSM data under ODbL,
MET Norway data under CC BY 4.0), with attribution in each fixtures README.

## Deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for Supabase + Vercel setup: environment variables,
migrations, the cron runners, Supabase Auth URLs and Stripe webhooks.

Payments today are one-time Stripe Checkout for demo bookings, with signed, idempotent webhooks.
Subscriptions (Ghost+), entitlements and the customer portal are Phase 5.

## Safety model (short version)

Ghost Guide is **not an emergency service**. It does not monitor hikers continuously and cannot see
a hiker's location in real time. It never contacts 911 or Search and Rescue, and it does not provide
satellite SOS.

Opt-in check-ins notify a consenting contact when the hiker has not confirmed by their expected
return time plus a grace period. That means *no confirmation was received*, not that an emergency is
happening.

Trail pages show the country's emergency numbers and remind hikers that phones may have no signal.
See [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).

## Documentation

- [`docs/PLATFORM_PLAN.md`](docs/PLATFORM_PLAN.md): audit, architecture, accounts, phases, threat model
- [`docs/IMPLEMENTATION_CHECKLIST.md`](docs/IMPLEMENTATION_CHECKLIST.md): done / simulated / deferred, by phase
- [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md): every provider (license, caching, cost, status)
- [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md): data, mobile, offline and platform limitations
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md): Supabase + Vercel, cron, Stripe
- [`docs/LAUNCH_CHECKLIST.md`](docs/LAUNCH_CHECKLIST.md): before real customers
