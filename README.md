# Ghost Guide

A minimalist website for **finding, planning and booking the world's best hikes**, with strict data
licensing. It is being rebuilt to the approved plan in [`docs/PLAN.md`](docs/PLAN.md). The earlier
"hiking companion" (safety check-ins, GPS hike screen, offline downloads, AI explanations, the
fictional "Ghost Ridge" demo region with its trip planner, single-trail bookings, partner add-ons,
permit tracking, and the on-demand OpenStreetMap trail catalog with Explore, trail pages, saved
trails and trail weather) has been removed; it is preserved on the `archive/v0-hiking-companion`
branch and the `v0-hiking-companion` tag.

**What runs today:**

- A placeholder home page: Ghost Guide is being rebuilt and the hike catalog is coming soon.
  Old `/trail/...` URLs answer **410 Gone**.
- Accounts: sign up, sign in, sign out, and a profile (name and preferred units).
- The admin area: overview, customers, support tickets, jobs and integration log, feature flags,
  staff roles and the audit log.
- `/status`: what is live versus simulated in a deployment, and the job runner's health.

No page calls an external data provider. The hike catalog will be loaded by an offline ingestion
pipeline (Phase 2 of [`docs/PLAN.md`](docs/PLAN.md)), never by visitors' requests. Browse and hike
pages, community features, trips and checkout follow in Phases 3 to 6.

Kept for later phases, but not used by any page yet:

- the provider HTTP client (`src/server/providers/http.ts`) and the elevation sampler
  (`src/server/geo/elevation.ts`), for the ingestion pipeline;
- the MapLibre map component (`src/components/maps`), for hike pages;
- the weather clients (`src/server/weather`, `src/integrations/weather`) and sun times
  (`src/server/geo/sun.ts`): weather stays hidden behind a switch until Phase 7;
- the Stripe Checkout adapter (`src/integrations/payments`), for Phase 6.

## Architecture (short)

| Layer | Technology |
|---|---|
| App | Next.js 16 App Router (React 19, TypeScript strict, Tailwind 4), `proxy.ts` for Supabase sessions and the 410 for old trail URLs. No service worker: `public/sw.js` only removes the one older versions installed |
| Data | Supabase Postgres 17 + PostGIS (local: PostgreSQL 16 + PostGIS 3.4 with a small Supabase shim). Row-level security on every table |
| DB access | `withUser` (RLS as `authenticated`), `withAnon` (public reads), `withSystem` (trusted server code: jobs, cron), on postgres.js |
| Jobs | Postgres queue; `/api/cron/jobs` runs it (Supabase pg_cron every minute via `npm run setup:cron`, plus a daily Vercel cron) |

More: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Local setup

Requires Node ≥ 20.19 and PostgreSQL ≥ 15 **with PostGIS** (Debian/Ubuntu:
`apt install postgresql-16-postgis-3`). The default `DATABASE_URL` expects `127.0.0.1:54322`.

```bash
cp .env.example .env.local
```

In `.env.local`, set `AUTH_SECRET` (32+ characters) and `CRON_SECRET` (16+ characters). Then:

```bash
npm install
```

```bash
npm run db:reset
```

```bash
npm run dev
```

- `npm run db:reset` creates the database, applies the migrations (plus the local shim) and seeds
  the demo accounts, sample support tickets, a dead job and a failed provider event. There is no
  hike data.
- `npm run dev` serves the app on http://localhost:3000.
- `npm run jobs:run -- --watch` runs background jobs in a second terminal (a stand-in for cron).

Demo accounts (local only; password from `SEED_DEMO_PASSWORD`, default `ghostguide-demo`):

| Account | Role |
|---|---|
| `hiker@demo.ghostguide.test` | customer |
| `hiker2@demo.ghostguide.test` | customer |
| `admin@demo.ghostguide.test` | admin (everything) |
| `operator@demo.ghostguide.test` | operations: customers, support, jobs |
| `editor@demo.ghostguide.test` | content editor (admin overview only until the data-review page arrives) |
| `support@demo.ghostguide.test` | customer support (customers, tickets) |

## Environment variables

Every variable is documented in [`.env.example`](.env.example): its purpose, where to get it, and
whether it is server-only or public (`NEXT_PUBLIC_*`). Nothing needs a paid key.

## Database and migrations

Migrations live in `supabase/migrations` as plain SQL. They still create tables for removed
features; the Phase 2 schema (`docs/PLAN.md` §3) replaces them.

- **Local:** `npm run db:migrate` (or `db:reset`).
- **Supabase:** `supabase db push`, or apply each file in order.

## Testing

| Command | What it runs |
|---|---|
| `npm run typecheck` / `npm run lint` | `next typegen` + `tsc`; ESLint |
| `npm run test:unit` | pure logic: geo, elevation and sun math, weather parsing, navigation, env, security helpers, … |
| `npm run test:integration` | Postgres + PostGIS: RLS, jobs, the session route, the provider client and weather caches, admin |
| `npm run test:e2e` | production build + headless Chromium: the public site (home, links, 410s, sitemap, sign-in) and the admin area |
| `npm run verify` | typecheck + lint + all Vitest tests + production build |

Tests never call real providers. The fixtures are recorded real responses (MET Norway data under
CC BY 4.0, NWS alerts, AWS terrain tiles), with attribution in each fixtures README.

## Deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for Supabase + Vercel setup: environment variables,
migrations, the job runner and Supabase Auth URLs. Nothing takes payments today: the order
checkout with Stripe (test mode) is Phase 6.

## Documentation

- [`docs/PLAN.md`](docs/PLAN.md): the approved rebuild plan (data model, licence rules, phases)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): code layout and engineering rules
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md): Supabase + Vercel, cron
- [`docs/PLATFORM_PLAN.md`](docs/PLATFORM_PLAN.md): the earlier Phase 1 audit and plan (historical)
- [`docs/IMPLEMENTATION_CHECKLIST.md`](docs/IMPLEMENTATION_CHECKLIST.md), [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md),
  [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md), [`docs/LAUNCH_CHECKLIST.md`](docs/LAUNCH_CHECKLIST.md):
  status notes from before the rebuild, trimmed to what still exists; Phase 7 rewrites them
