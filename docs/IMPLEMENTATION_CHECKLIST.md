# Implementation checklist

Legend: ✅ done and verified in this environment · 🟡 simulated (demo adapter, labeled in UI) ·
🔶 implemented, not verified with live credentials or real devices · ⛔ blocked (needs external access) ·
⏭ deferred · ⬜ not started

"Verified" means: unit and/or integration tests against PostgreSQL 16, plus browser e2e against a
production build in headless Chromium. Nothing has been field-tested on real phones or trails.

The rebuild to [`PLAN.md`](PLAN.md) removes the out-of-scope features in passes; see "Removed" at
the end. Everything removed is preserved on the `archive/v0-hiking-companion` branch.

## Platform Phase 1 — Real data (see docs/PLATFORM_PLAN.md)
- ✅ PostGIS trail catalog (`catalog_trails`, `catalog_pois`), coverage tiles, caches, API usage, saved trails; public-read / owner-only / server-only RLS
- ✅ Provider architecture (`TrailDataProvider` + registry); one HTTP client with User-Agent, timeouts, retries, global throttle, usage accounting
- ✅ OpenStreetMap provider (Overpass): route relations, named-way grouping, tag normalization, outdoor + services POIs — verified on recorded real data; 🔶 live public Overpass intermittently refused this build sandbox (verified with mocks in e2e)
- 🔶 Recreation.gov RIDB provider (US facilities) — built to the documented schema; needs `RIDB_API_KEY` to verify live
- ✅ Enrichment: DEM elevation (AWS Terrain Tiles, live-verified), linear routes oriented from the trailhead, Tobler duration + out-and-back totals, SAC/effort difficulty, trailhead selection, features/amenities, admin names (Nominatim, live-verified), time zone, stable slugs, cross-tile merge, retire-not-delete
- ✅ On-demand loading: tile claims with a global Overpass concurrency cap, deduplicated jobs, after-response loading, stale refresh + cache purge jobs on a separate `/api/cron/catalog` runner (other jobs never wait on downloads)
- ✅ Geocoded search ("Banff", "trails near Denver"; Nominatim 1 req/s, cached) and PostGIS search with all filters, sorts, honest coverage states
- ✅ Explore: map-first (MapLibre + OpenFreeMap, clustering, search this area, list/map sync, filters, URL state, no-JS fallback), phone bottom sheet + tab bar
- ✅ Trail pages `/trail/<country>/<region>/<slug>`: map, elevation profile, stats with labeled estimates, live MET Norway forecast + highlights, NWS alerts (US) / "not available" elsewhere, sunrise/sunset + daylight planning, trailhead amenities, nearby services, sources + freshness, JSON-LD, canonical, sitemap, robots
- ✅ Saved trails (owner RLS) + /saved
- ✅ Admin → Trail data: provider health, API usage + estimated cost, coverage/failures with retry, catalog counts, catalog jobs, audited hide/unhide moderation
- ⏭ Ratings / reliable opening hours for services (no free licensed source), global official weather alerts outside the US, photos/reviews (Phase 5)

## M0 — Foundation
- ✅ Next.js 16 + TypeScript + Tailwind 4 project, ESLint flat config, Vitest unit/integration projects, e2e harness
- ✅ Core schema with RLS and column grants; per-slice additive migrations; security hardening migration
- ✅ Local Supabase shim so the same migrations run on plain Postgres
- ✅ DB layer with per-transaction RLS identity (`withUser` / `withAnon` / `withSystem`)
- ✅ Auth: demo (signed cookie); 🔶 Supabase Auth (`@supabase/ssr`, `proxy.ts`, `getClaims`)
- ✅ RBAC permission matrix + staff roles; RLS aligned with RBAC
- ✅ Durable job queue (dedup, `SKIP LOCKED`, backoff, dead-letter, operator retry), cron endpoint, local runner, periodic jobs
- ✅ Audit log, integration-event log, rate limiting (per IP + per account for sign-in), feature flags, redacting logger
- ✅ Seed: 6 demo users (2 customers, one per staff role), demo support tickets, a dead job and a failed integration event; no trail data
- 🟡 Payments adapter kept for Phase 6: simulated provider (signed demo webhooks) ✅; 🔶 Stripe Checkout + signed webhooks (no checkout uses it today)

## M4 — Admin & operations
- ✅ RBAC-gated admin dashboard with audit logging of sensitive actions
- ✅ Customers (profile and support tickets)
- ✅ Job retry queue, integration failures; demo "run due jobs now"
- ✅ Feature flags (none defined today)
- ✅ Support tickets, staff roles (last admin protected), audit log viewer

## Verification status (last run)
- After removal pass 2: `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration`,
  `npm run build` and `npm run test:e2e` all pass (see the commit for counts).
- Not verified: anything requiring real credentials (Supabase project, Stripe, NWS), real phones, or real trails.

## Removed (Phase 2 clean-up)
- Pass 1: Ghost Guard safety check-ins, overdue logic, notifications (Twilio, Resend, demo), emergency contacts and
  contact opt-out, location retention and sharing, trip-share links, the safety desk and notification log in admin,
  the `safety` staff role, emergency numbers on trail pages; the GPS hike screen (prepare, hike, help, complete,
  narration playback, geofences, deviation prompts, reminders, GPS simulator, hike APIs and jobs); offline trip
  downloads (bundle/download APIs, IndexedDB outbox, service worker, replaced by a kill switch in `public/sw.js`);
  AI explanations and summaries (Anthropic) and the marketing-draft workflow.
- Pass 2: the fictional "Ghost Ridge" demo region (demo trails, POIs, narration, closures, permits, prices,
  bookings and their seeds; `/trails`, the `/plan` questionnaire with recommendations and itineraries, the home-page
  demo section, `SHOW_DEMO_FIXTURES` and `LAUNCH_REGION_SLUG`; the demo-trail admin with route upload, the narration
  review queue, the route-file storage and `/api/media`); the single-trail booking model (`/checkout`, `/bookings`,
  `/trips`, the commerce and trips server modules, pricing with weekend/demand surcharges, inventory, holds,
  reconciliation, refunds, cancellation, the Stripe and demo payment webhook routes, receipts, and the bookings,
  availability and pricing admin pages); partner add-ons (gear lockers, shuttles, meal packs, satellite devices,
  their demo adapters, fulfillment and admin pages); trip permit tracking and `permits.remind` reminders. The Stripe
  Checkout adapter (`src/integrations/payments`) stays for Phase 6.
- Pass 3 (next): live OSM loading; the trail catalog, explore and trail pages and weather are dealt with there (`PLAN.md` §2).
