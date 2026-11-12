# Ghost Guide platform plan: audit and phases

_Last updated: 2026-11-12. Living document: update statuses as phases land._

Ghost Guide is the companion for the **whole outdoor trip**:

**Discover → Plan → Drive → Hike → Protect → Return.**

Every feature answers one of four questions:

- Where should I hike?
- How do I make the whole trip easy?
- How do I stay on course?
- Will someone know if I don't make it back?

## 1. What exists today (audit)

| Area | Implementation | State |
|---|---|---|
| Framework | Next.js 16 App Router, React 19, TypeScript strict, Tailwind 4; PWA; `proxy.ts` (Supabase session refresh) | production-grade |
| Hosting | Vercel (project `ghost-guide`) + Supabase Postgres 17 (`wrvcsdeqkdprroaxghdv`, us-east-1) | deployed (demo mode) |
| Database | Plain SQL migrations (`supabase/migrations`), RLS on every table, column grants, security-hardening migration | solid |
| DB access | `withUser` (RLS as `authenticated` + JWT claims), `withAnon`, `withSystem` (trusted) on postgres.js v4 | solid |
| Auth | Supabase Auth (email + password) with `getClaims()`; demo cookie auth for local/tests; RBAC (7 staff roles × 30 permissions) aligned with RLS | email only; no OAuth yet |
| Background jobs | Postgres queue (dedup keys, `SKIP LOCKED`, backoff, dead letter, operator retry), periodic buckets, runner heartbeat, `/api/cron/jobs` | solid; **per-minute trigger (pg_cron) not yet configured on Supabase** |
| Trails | Curated `trails` table with per-field provenance, sources, closures, permits, POIs, narration (approval workflow) | **only the fictional demo region** |
| Discovery | `/trails` list + SVG overview, Mapbox map when a token exists, `/plan` questionnaire, deterministic recommendation + itinerary | works on fixtures only |
| Commerce | Transparent pricing engine, holds, checkout (simulated or Stripe one-time), idempotent webhooks, refunds, partner add-ons (lockers, shuttle, meals, satellite rental) | add-ons and payments simulated |
| Hike | Offline bundle + service worker, IndexedDB outbox sync, GPS screen (accuracy circle, progress), geofenced approved narration, deviation prompts with accuracy filtering, completion summary | works; foreground PWA only |
| Safety | Emergency contacts with consent + opt-out, opt-in check-ins (expected return, grace, reminders), overdue jobs (version-guarded, deduplicated), safety-net scan, share links (hashed, expiring, revocable), staff safety desk | logic solid; **notifications simulated** |
| Admin | RBAC-gated pages: trails, content, permits, pricing, bookings, refunds, gear, fulfillment, safety, notifications, jobs, flags, staff, audit | solid |
| Tests | 729 Vitest (unit + integration on Postgres 16) + 161 Playwright e2e checks | strong |

## 2. Demo / fake today

- The **"Ghost Ridge" demo region**: 7 fictional trails, their POIs, narration, permits, closures and prices.
- **Simulated adapters, labeled in the UI:**
  - payments
  - notifications (recorded, never delivered)
  - AI text (templates)
  - marketing weather
  - partner services
  - the GPS simulator
- Seeded demo users, bookings and check-ins.

**Policy from Phase 1 on:**

- Fixtures are development-only (`SHOW_DEMO_FIXTURES`, off in production builds).
- Real-data features never fall back to fixtures. When a provider fails, the UI says the data is unavailable.

## 3. What we keep

Most of the platform is reusable as is:

- The DB layer, RLS discipline, job queue, audit log, rate limiting, redacting logger and RBAC/admin shell.
- Supabase Auth.
- The PWA offline machinery (service worker, IndexedDB, outbox).
- The hike engine (projection, geofencing, deviation filtering).
- The check-in state machine with overdue jobs, contact consent/opt-out and share links.
- Stripe webhook processing (idempotency, signature checks).
- The pricing engine, which becomes Ghost Trip cost estimation.
- The test harnesses.

Ghost Guard (Phase 3) **extends** the existing check-ins rather than replacing them.

## 4. Recommended production architecture

We keep the stack: Next.js on Vercel and Supabase Postgres, with **PostGIS** added. New pieces:

| Concern | Choice | Why (cost · licensing · coverage) |
|---|---|---|
| Trail geometry + outdoor POIs | **OpenStreetMap via Overpass API**, loaded on demand per 0.25° tile, normalized into `catalog_trails` / `catalog_pois` (PostGIS) | Free, global, ODbL (attribution; derived DB share-alike on request). Public Overpass is slow (~30 s) and best-effort → background jobs + aggressive caching; self-host or a commercial instance at scale (~$40–80/mo VPS) |
| US official data | **Recreation.gov RIDB** (facilities, campgrounds, permits) | Free key; public-domain US data |
| Future official sources | `TrailDataProvider` interface + registry | NPS API, Parks Canada open data, national mapping agencies, … one provider each |
| Place search | **Nominatim** (cached 30 days; 1 req/s global throttle) | Free; policy forbids autocomplete and heavy use → swap to a paid geocoder (Mapbox / Stadia / self-hosted) at scale through the same interface |
| Elevation | **AWS Open Data Terrain Tiles** (Terrarium PNG), sampled server-side at ingestion | Free, no key, global ~30 m; results labeled "estimate" |
| Basemap | **MapLibre GL JS + OpenFreeMap** vector tiles + terrain hillshade | No key, no per-load fees; style URL swappable (MapTiler/Stadia/Protomaps) |
| Weather | **MET Norway Locationforecast** (global, CC BY 4.0) + **NWS alerts** (US); sunrise/sunset computed locally (NOAA algorithm) | Free with identifying User-Agent; cache honoring `Expires`. Global official alerts beyond the US are not available for free → shown as "not available for this region" |
| Nearby services (gas, food, lodging, medical) | **OSM POIs via Overpass** ("services" layer), loaded only when a trail page asks | Free; no ratings or reliable hours → said honestly. Google Places later if needed (high cost, 30-day caching limit) |
| Driving routes (Phase 2) | OpenRouteService (free key) or Mapbox Directions / GraphHopper | Decide on cost at Phase 2 |
| Jobs | Existing queue; per-minute trigger from **Supabase pg_cron + pg_net** (Vercel Hobby crons run daily only) | Required for refresh + Ghost Guard |
| Notifications | Twilio SMS + Resend email (existing adapters), web push (Phase 3/4) | Paid per message; status tracking already exists |
| Payments | Stripe Checkout + Billing (subscriptions) + Customer Portal + webhooks → entitlements table | Phase 5 |

## 5. Accounts and credentials

| Needed for | Account | Cost | Status |
|---|---|---|---|
| Phase 1 | None. Set `DATA_PROVIDER_USER_AGENT` with a real contact email (OSM, MET Norway and NWS policies require it) | free | **you provide a contact email** |
| Phase 1 (US enrichment) | Recreation.gov RIDB API key | free | optional now |
| Phase 1 ops | Supabase pg_cron schedule (script provided) | free | needs `npm run setup:cron` on your PC (uses your CRON_SECRET) |
| Phase 2 | Routing: OpenRouteService key (free tier) or Mapbox | free tier | later |
| Phase 3 | Twilio (SMS) + Resend (email) for real Ghost Guard notices | pay-as-you-go | **required before Ghost Guard is real** |
| Phase 5 | Stripe (live), Google OAuth client, Apple Developer ($99/yr) for Sign in with Apple | | later |
| Scale | Own Overpass/Nominatim server or paid geocoder | ~$40–100/mo | when traffic grows |

## 6. Database changes

- **Phase 1** (`20261112000000_trail_catalog.sql`):
  - enables PostGIS
  - new tables: `catalog_trails`, `catalog_pois`, `catalog_tiles` (coverage), `geocode_cache`, `geo_admin_cache`, `weather_cache`, `external_api_usage`, `provider_throttle` and `saved_trails`
  - public read-only access to open data; everything else server-only or owner-only
- **Phase 2:** `ghost_trips` + `trip_stops` (ordered stops: home, fuel, food, trailhead, …), cost lines, trips linked to catalog trails.
- **Phase 3:** hike sessions linked to catalog trails and Ghost Guard sessions (vehicle, hikers, note), `watch_tokens`, `sos_events`, and notification attempts with delivery states.
- **Phase 4:** offline packages per catalog trail and guide preferences.
- **Phase 5:** `subscriptions`, `entitlements`, `commerce_offers` / clicks / conversions, `product_events`, and `trail_reviews` + reports (moderation).

## 7. Phases and status

| Phase | Scope | Status |
|---|---|---|
| **1 Real data** | provider architecture (OSM, RIDB), PostGIS catalog, on-demand tile ingestion + refresh jobs, geocoded search with filters, map/list explore with clustering, SEO trail pages (geometry, elevation, conditions, amenities, safety info), weather + alerts + daylight planning, nearby services, saved trails, provider usage admin | **in progress** |
| 2 Trip platform | Ghost Trip planner (home → stops → trailhead → home), driving route, fuel/food/lodging stops, costs, saved trips | planned |
| 3 Safety | hike sessions on real trails, Ghost Guard, live watch page, overdue escalation, SOS, off-route on real geometry; **real notification delivery** | planned (builds on existing check-ins) |
| 4 Hiking experience | offline packages for catalog trails, dynamic ETA, audio guide modes, weather change alerts, pacing, summaries | planned (builds on existing hike engine) |
| 5 Business | auth hardening (OAuth), Stripe subscriptions + entitlements, commerce/affiliate architecture, analytics, admin, monitoring | planned |

A feature is "done" only when real data flows through it and it has loading, empty, error and mobile states, persistence, auth checks, handled API failures, tests and documented configuration.

## 8. Security and safety concerns (threat model highlights)

- **Abuse amplification:** a public search endpoint triggers expensive upstream calls (Overpass, Nominatim). Mitigations:
  - per-IP rate limits
  - a cap on tiles per search and a deduplicated job queue
  - global request spacing per provider
  - aggressive caching and usage dashboards
- **Provider policies:**
  - identifying User-Agent with contact on all OSM, MET and NWS calls
  - no Nominatim autocomplete
  - honor MET `Expires` headers
  - ODbL attribution on every map and trail page
- **Live hike links (Phase 3):**
  - 256-bit random tokens stored hashed
  - expiry and revocation
  - `noindex`, rate-limited lookups, minimal personal data
  - no history beyond the active session
- **Location data:**
  - collected only during an active hike with explicit consent
  - owner-only through RLS
  - retention purge (existing job); staff access to precise history only with the sensitive permission and audited
- **IDOR:** every user-owned row is behind RLS (`withUser`), and server code re-checks ownership. Saved trails are owner-only.
- **Emergency semantics:**
  - never claim emergency services are contacted
  - an `EmergencyProvider` interface (Phase 3) with only verified workflows: dial links, country emergency numbers, trusted-contact escalation
- **Secrets:**
  - server-only keys stay server-side; only `NEXT_PUBLIC_*` values are public (map style URLs, Supabase publishable key)
  - Stripe webhooks are signature-verified and idempotent
- **Honesty in data:**
  - estimates are labeled (duration, DEM elevation, estimated difficulty)
  - missing data is shown as missing
  - community reports (Phase 5) are kept separate from official information

## Known platform limits (stated honestly)

- **Background GPS:** a web app cannot guarantee GPS tracking or audio with the screen locked. Dependable background tracking needs a native app (React Native/Capacitor shell), planned after Phase 4.
- **Weather alerts:** official alerts are integrated only where a free official feed exists (US: NWS). Elsewhere the app says alerts are not available.
- **OSM data quality** varies by country. Trail pages show source, license and last sync time.
