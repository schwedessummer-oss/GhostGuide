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
- ✅ On-demand loading: tile claims with a global Overpass concurrency cap, deduplicated jobs, after-response loading, stale refresh + cache purge jobs on a separate `/api/cron/catalog` runner (commerce jobs never wait on downloads)
- ✅ Geocoded search ("Banff", "trails near Denver"; Nominatim 1 req/s, cached) and PostGIS search with all filters, sorts, honest coverage states
- ✅ Explore: map-first (MapLibre + OpenFreeMap, clustering, search this area, list/map sync, filters, URL state, no-JS fallback), phone bottom sheet + tab bar
- ✅ Trail pages `/trail/<country>/<region>/<slug>`: map, elevation profile, stats with labeled estimates, live MET Norway forecast + highlights, NWS alerts (US) / "not available" elsewhere, sunrise/sunset + daylight planning, trailhead amenities, nearby services, sources + freshness, JSON-LD, canonical, sitemap, robots
- ✅ Saved trails (owner RLS) + /saved
- ✅ Admin → Trail data: provider health, API usage + estimated cost, coverage/failures with retry, catalog counts, catalog jobs, audited hide/unhide moderation
- ✅ Demo region gated as development fixtures (`SHOW_DEMO_FIXTURES`, off in production)
- ⏭ Ratings / reliable opening hours for services (no free licensed source), global official weather alerts outside the US, photos/reviews (Phase 5)

## M0 — Foundation
- ✅ Next.js 16 + TypeScript + Tailwind 4 project, ESLint flat config, Vitest unit/integration projects, e2e harness
- ✅ Core schema with RLS and column grants; per-slice additive migrations; security hardening migration
- ✅ Local Supabase shim so the same migrations run on plain Postgres
- ✅ DB layer with per-transaction RLS identity (`withUser` / `withAnon` / `withSystem`)
- ✅ Auth: demo (signed cookie); 🔶 Supabase Auth (`@supabase/ssr`, `proxy.ts`, `getClaims`)
- ✅ RBAC permission matrix + staff roles; RLS aligned with RBAC (prices admin-only)
- ✅ Durable job queue (dedup, `SKIP LOCKED`, backoff, dead-letter, operator retry), cron endpoint, local runner, periodic jobs
- ✅ Audit log, integration-event log, rate limiting (per IP + per account for sign-in), feature flags, redacting logger
- ✅ Storage abstraction: local signed URLs ✅, Supabase Storage 🔶
- ✅ Transparent pricing engine
- ✅ Seed: fictional demo region, 6 published + 1 draft trails with validated synthetic geometry, POIs, approved sourced narration, permits, closures, add-ons, gear, pricing, flags, 6 demo users, sample bookings

## M1 — Browse → personalize → save trip
- ✅ Landing page (honest about demo data and limitations)
- ✅ Trail discovery: list view with GET filters; map view = tile-free SVG overview + text list; 🔶 Mapbox map (needs token)
- ✅ Trail details: distance, elevation, difficulty, terrain, estimated duration (labeled), provenance per field (verified / estimate / operator note / demonstration), sources, freshness, permits with official links, closures
- ✅ Questionnaire (fitness, experience, terrain, pace, time, distance, elevation, date/start, accessibility, group size, equipment, dog), server-validated, works without JS
- ✅ Deterministic recommendation (hard filters + 0–100 scoring with breakdown), excluded trails with reasons, explicit "no route fits" with relax suggestions
- ✅ Deterministic itinerary (pace factor, stops, ETAs, turnaround, latest-finish estimate, reminders)
- ✅ Save trip (server re-validates and re-scores; RLS-scoped insert); sign-in resume flow

## M2 — Checkout → confirmed booking → trip dashboard
- ✅ Checkout with transparent quote (weekend/holiday/demand/group rules), add-ons, inventory holds, idempotency keys, closure checks
- 🟡 Simulated checkout page (signed demo webhooks via the real processor, duplicate re-delivery); 🔶 Stripe Checkout + signed webhooks
- ✅ Idempotent webhook processing (dedup table, row locks), late-payment / amount-mismatch → needs_attention + auto refund
- ✅ Reconciliation and hold-expiry jobs
- ✅ My Trips dashboard, trip dashboard hub, receipts, booking history
- ✅ Cancellation with policy-based refunds (refund jobs, provider idempotency keys)
- 🟡 Partner providers (interfaces + demo adapters): gear lockers (availability, reservation, keyed access codes, return, maintenance), shuttle (customer confirms pickup/price/time before ride request), meal packs, satellite-device rental (no-SOS disclaimer)
- ✅ Per-provider fulfillment status separate from booking status; partial failures → retries → needs_attention, visible to customer and operator

## M4 — Admin & operations
- ✅ RBAC-gated admin dashboard with audit logging of sensitive actions
- ✅ Trails, facts with provenance, sources, closures, POIs, permit requirements; GeoJSON/GPX route upload with validation and activation
- ✅ Narration approval queue (source required), revisions
- ✅ Customers, bookings, payments, refunds, cancellations
- ✅ Gear inventory, reservations, maintenance; partner fulfillment queue with retry / manual status
- ✅ Job retry queue, integration failures, failed webhooks; demo "run due jobs now"
- ✅ Pricing rules with live preview; availability (capacity overrides, blocked days); feature flags
- ✅ Permits: requirements, trip permit status tracking, daily in-app reminders; no automation of permit purchasing
- ✅ Support tickets, staff roles (last admin protected), audit log viewer
- ⏭ ML pricing (rules only until enough data)

## Verification status (last run)
- After removal pass 1: `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration`,
  `npm run build` and `npm run test:e2e` all pass (see the commit for counts).
- Not verified: anything requiring real credentials (Supabase project, Stripe, NWS), real phones, or real trails.

## Known gaps (deferred)
- If a partner accepts an order but the response is lost and the booking is then cancelled, the partner order needs manual cancellation (needs a partner API that cancels by our idempotency key).

## Removed (Phase 2 clean-up)
- Pass 1: Ghost Guard safety check-ins, overdue logic, notifications (Twilio, Resend, demo), emergency contacts and
  contact opt-out, location retention and sharing, trip-share links, the safety desk and notification log in admin,
  the `safety` staff role, emergency numbers on trail pages; the GPS hike screen (prepare, hike, help, complete,
  narration playback, geofences, deviation prompts, reminders, GPS simulator, hike APIs and jobs); offline trip
  downloads (bundle/download APIs, IndexedDB outbox, service worker, replaced by a kill switch in `public/sw.js`);
  AI explanations and summaries (Anthropic) and the marketing-draft workflow.
- Later passes: the fictional demo region and its booking flow, add-ons, surcharges, live OSM loading (`PLAN.md` §2).
