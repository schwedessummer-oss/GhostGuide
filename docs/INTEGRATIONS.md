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
| Recommendations & itineraries | `src/domain/recommendation.ts`, `itinerary.ts` | Deterministic; AI never decides. |
| Pricing | `src/domain/pricing.ts` | Transparent rules (weekend, holiday, high demand, group, flat fee). |
| Booking state, inventory, idempotent webhook processing | `src/server/commerce/**` | Exercised through the simulated payment provider, which uses the same processor as Stripe. |
| Offline download, service worker, IndexedDB, outbox sync | `public/sw.js`, `src/lib/offline/**` | Exercised in headless Chromium. Real-device behavior still needs field testing (see LIMITATIONS.md). |
| Geofenced narration, deviation, reminders | `src/domain/*`, `src/components/hike/**` | Exercised with the demo GPS simulator, not real GPS. |
| Local object storage | `src/integrations/storage` (local) | HMAC-signed expiring media URLs. |

## Implemented against vendor docs, NOT verified with live credentials
| Integration | Env to enable | What was tested |
|---|---|---|
| Supabase Auth (`@supabase/ssr`, `proxy.ts`, `getClaims`) | `AUTH_PROVIDER=supabase` + keys | Running on the hosted preview (Supabase project + Vercel); sign-in flows are covered by the demo-auth e2e suite, not by automated tests against Supabase. |
| Supabase Storage | `STORAGE_PROVIDER=supabase` | Never ran against a project. |
| Stripe Checkout (test mode) + signed webhooks | `PAYMENTS_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Webhook signature verification unit-tested with stripe-node's own signing helpers; session/refund API calls never executed. |
| Anthropic (AI explanations) | `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `AI_MODEL` | Fake-fetch tests only. Output guard falls back to templates on invented numbers or banned claims. |
| Twilio SMS / Resend email | `NOTIFY_PROVIDER=live` + provider keys | Mocked-fetch tests only. Live mode without a provider fails loudly. |
| National Weather Service forecast for marketing drafts | `WEATHER_PROVIDER=nws` | Mocked-fetch tests only (US locations). Trail pages use MET Norway + NWS alerts (above) regardless of this setting. |
| Vercel Cron / Supabase pg_cron trigger | `vercel.json`, `supabase/cron/schedule-job-runner.sql` | Endpoint verified locally; schedulers not deployed. |

## Simulated (demo adapters, labeled "Simulated" in the UI)
| Integration | Behavior |
|---|---|
| Payments | `/checkout/demo/[sessionId]` page; outcomes are delivered as HMAC-signed webhooks through the real processor (duplicate delivery button included). Refuses to run when `APP_MODE=live`. |
| AI text | Deterministic templates built only from scores and the itinerary. |
| Notifications | Recorded in the audit trail with status `simulated`; never delivered. |
| Weather (marketing drafts only) | Deterministic forecast marked simulated, with fetched-at time. Trail pages always use real forecasts. |
| Gear lockers | Reserves seeded gear items; derives a 6-digit access code (HMAC, never stored in clear); return/maintenance flows. |
| Shuttle | Quotes require customer confirmation of pickup, price and time before a (simulated) ride request. |
| Meal packs | Order/cancel; deterministic failure injection for demos. |
| Satellite communicator rental | Reserves a device from inventory; states clearly that Ghost Guide provides no SOS service. |
| GPS | Demo-mode-only simulator (speed, drift, detour, signal loss). |
| Demo region (development fixture) | Fictional region and trails with synthetic geometry, marked "not for navigation"; shown only when `SHOW_DEMO_FIXTURES` is on (off in production). Real trails come from the catalog above. |

## Deferred (not built)
- Live partner adapters (locker vendors, shuttle/rideshare, meal suppliers, satellite-device rental companies, onX or other mapping apps). Each needs official API documentation, a commercial agreement and credentials before building; see `src/integrations/partners/README.md`.
- Satellite messenger SOS/tracking integration (future partner integration only; the app never claims SOS capability).
- Native iOS/Android client for dependable background GPS, lock-screen audio, local notifications and licensed offline map packs.
- Offline basemap tiles in the PWA (not offered: tile terms; a licensed offline package or self-hosted Protomaps extract would be needed).
- Google Places / ratings for nearby services (cost and 30-day caching limits; OSM POIs are used, with "ratings not available" stated).
- Global official weather alerts outside the US (no free, licensable aggregate feed integrated yet; e.g. MeteoAlarm for Europe is a candidate).
- Web push notifications; SMS/email delivery-status webhooks.
- Machine-learning pricing (rules only until there is enough booking data).
- Error-monitoring vendor (e.g. Sentry); structured redacted logs are ready for a log drain.
- Automated permit purchasing (intentionally never: no queue, CAPTCHA or purchase-limit bypass).
