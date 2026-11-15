# Integrations: real, simulated, deferred

Status as of this build. **Verified** = exercised end to end in this environment (local Postgres,
production Next.js build, headless Chromium). No third-party credentials were available, so no
live vendor API was called.

## Real-data providers (Phase 1)
All calls go through `src/server/providers/http.ts`: an identifying User-Agent, timeouts, bounded
retries, global request spacing where a policy requires it, and per-day usage counters (admin →
Trail data). Base URLs are environment variables, so you can move to self-hosted or commercial
instances without code changes.

| Provider | Used for | License / attribution | Caching | Limits · cost | Status |
|---|---|---|---|---|---|
| **OpenStreetMap via Overpass API** (`OVERPASS_URLS`) | Trail geometry (hiking/foot route relations, named paths), outdoor POIs, nearby services | ODbL 1.0: "© OpenStreetMap contributors" on every map and trail page. A publicly used derivative database must be offered under ODbL on request | Stored per 0.25° tile in `catalog_*`; refreshed after `CATALOG_TILE_TTL_DAYS` (30) | Public instances, tried in order: overpass-api.de (fair use: ~10k queries/day, 2 concurrent per IP), then the public mirrors overpass.private.coffee and overpass.kumi.systems when it is busy or refuses a request. Free; often slow (30–90 s) or briefly unavailable. Requests carry an identifying User-Agent, a Referer naming the site and a broad Accept header; refusals (HTTP 403/406) move on to the next instance and their reason is logged. Production at scale: self-host (~$40–80/mo VPS) or a commercial instance | Parser verified on recorded real responses. On 2026-11-14 the deployed app got HTTP 406 from overpass-api.de with `Accept: application/json` and no Referer; headers and fallbacks changed in response (see the admin "Trail data" usage view for live status). On-demand loading is also verified with mocks in e2e |
| **Nominatim** (`NOMINATIM_URL`) | Place search ("Banff"), reverse admin names (country/region/place) | ODbL (OSM data) | Forward: 30 days per normalized query. Reverse: 180 days per 0.1° cell | Policy: max 1 req/s (enforced globally via `provider_throttle`), no autocomplete, identify the app. Free. At scale: paid geocoder (Mapbox/Stadia/self-hosted) via the same interface | Live-verified (recorded fixtures) |
| **AWS Open Data Terrain Tiles** (`TERRAIN_TILES_URL`) | Elevation profiles, climb/descent, max/min elevation (estimates) | Mapzen/Tilezen terrain (SRTM, USGS 3DEP, GMTED, …); attribution shown | Values stored with each trail; decoded tiles cached in memory | Free, no key | Live-verified |
| **MET Norway Locationforecast 2.0** (`METNO_URL`) | Trail-page forecast: hourly, 7-day, highlights | CC BY 4.0: "Weather data from MET Norway" | `weather_cache` honoring `Expires`; revalidates with `If-Modified-Since`; up to 3 h of the last confirmed forecast if MET is down (dated) | ≤ 20 req/s per app; identifying User-Agent required; coordinates ≤ 4 decimals. Free | Live-verified |
| **US National Weather Service alerts** (`NWS_URL`) | Official alerts on US trail pages | US Government work (public domain) | 5 min | Free; User-Agent required. Other countries: "Official weather alerts aren't available for this region in Ghost Guide" | Live-verified (no active alerts at test time; mapping tested on schema-accurate samples) |
| **Recreation.gov RIDB** (`RIDB_API_KEY`) | US federal facilities (campgrounds, trailheads, visitor centers, ranger stations) | US Government work | Stored as POIs per tile | Free key (ridb.recreation.gov → Profile → API Keys) | Implemented against the documented schema; **not verified live** (no key yet) |
| **OpenFreeMap + MapLibre GL JS** (`NEXT_PUBLIC_MAP_STYLE_URL`) | Basemap (vector tiles), plus terrain hillshade from the AWS tiles | OSM data (ODbL) + OpenMapTiles; attribution in the map | Browser HTTP cache only; tiles are never stored for offline use | Free, no key, no per-load fees | Live-verified in headless Chromium |
| Sun times | Sunrise, sunset, civil twilight, daylight planning | Computed locally (NOAA algorithm) | n/a | n/a | Tested against published times |

## Real and verified locally
| Area | Implementation | Notes |
|---|---|---|
| Database schema, RLS, column grants | `supabase/migrations/*.sql` | Verified on PostgreSQL 16 with a local shim of Supabase's `auth` schema; integration tests cover cross-user isolation. Not yet applied to a hosted Supabase project. |
| Demo authentication | scrypt passwords + HMAC-signed cookie | For local demos only (`AUTH_PROVIDER=demo`). |
| Background jobs | Postgres job table, `/api/cron/jobs`, `npm run jobs:run` | Dedup keys, `SKIP LOCKED` claiming, backoff, dead-letter, operator retry. |
| Service-worker kill switch | `public/sw.js` | Deletes the old offline worker's `gg-*` caches, unregisters itself and reloads open tabs. The app registers no worker. |

## Implemented against vendor docs, NOT verified with live credentials
| Integration | Env to enable | What was tested |
|---|---|---|
| Supabase Auth (`@supabase/ssr`, `proxy.ts`, `getClaims`) | `AUTH_PROVIDER=supabase` + keys | Running on the hosted preview (Supabase project + Vercel); sign-in flows are covered by the demo-auth e2e suite, not by automated tests against Supabase. |
| Stripe Checkout (test mode) adapter (`src/integrations/payments`) | `PAYMENTS_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Webhook signature verification unit-tested with stripe-node's own signing helpers; session/refund API calls never executed. No checkout or webhook route uses the adapter until Phase 6. |
| National Weather Service forecast adapter (`src/integrations/weather`) | `WEATHER_PROVIDER=nws` | Mocked-fetch tests only (US locations). No page uses it since the marketing-draft workflow was removed. Trail pages use MET Norway + NWS alerts (above) regardless of this setting. |
| Vercel Cron / Supabase pg_cron trigger | `vercel.json`, `supabase/cron/schedule-job-runner.sql` | Endpoint verified locally; schedulers not deployed. |

## Simulated (demo adapters, labeled "Simulated" in the UI)
| Integration | Behavior |
|---|---|
| Payments (adapter only) | Demo checkout sessions and HMAC-signed, Stripe-shaped events (`src/integrations/payments/demo.ts`). No page or route uses it until Phase 6. Refuses to run when `APP_MODE=live`. |
| Weather adapter (`WEATHER_PROVIDER=demo`, unused by pages) | Deterministic forecast marked simulated, with fetched-at time. Trail pages always use real forecasts. |

## Deferred (not built)
- Partner booking providers (`PLAN.md` §3, Phase 6: a mock provider first). Each live provider needs official API documentation, a commercial agreement and credentials before building.
- Google Places / ratings for nearby services (cost and 30-day caching limits; OSM POIs are used, with "ratings not available" stated).
- Global official weather alerts outside the US (no free, licensable aggregate feed integrated yet; e.g. MeteoAlarm for Europe is a candidate).
- Error-monitoring vendor (e.g. Sentry); structured redacted logs are ready for a log drain.
- Automated permit purchasing (intentionally never: no queue, CAPTCHA or purchase-limit bypass).

## Removed (Phase 2 clean-up)
Safety check-ins and notifications (Twilio, Resend, demo), the GPS hike screen and simulator, offline trip
downloads, and AI explanations (Anthropic) with the marketing-draft workflow (pass 1). The fictional demo region,
the recommendation/itinerary rules, single-trail bookings (pricing, inventory, payment processing, reconciliation,
refunds), local/Supabase object storage, the partner add-on adapters (gear lockers, shuttle, meal packs, satellite
devices) and permit tracking (pass 2). They can be recovered from the `archive/v0-hiking-companion` branch.
