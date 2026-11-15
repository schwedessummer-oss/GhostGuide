# Integrations: real, simulated, deferred

Status as of this build. **Verified** = exercised end to end in this environment (local Postgres,
production Next.js build, headless Chromium). No third-party credentials were available, so no
live vendor API was called.

## Reusable provider code (no page calls a provider)
The on-demand OpenStreetMap catalog was removed. The pieces below are kept, with their tests, for the
offline ingestion pipeline and hike pages (`docs/PLAN.md`):

| Code | Purpose | Notes |
|---|---|---|
| `src/server/providers/http.ts` | One HTTP client for provider calls | Identifying User-Agent (`DATA_PROVIDER_USER_AGENT`), timeouts, bounded retries, global request spacing, error excerpts, usage counters |
| `src/server/geo/elevation.ts` | Elevation sampling from AWS Open Data terrain tiles (`TERRAIN_TILES_URL`) | Mapzen/Tilezen terrain; attribution required |
| `src/server/weather/*` | MET Norway Locationforecast (`METNO_URL`, CC BY 4.0) and US NWS alerts (`NWS_URL`) clients | Not used by any page; to be attached to hikes behind a switch |
| `src/server/geo/sun.ts` | Sunrise, sunset and twilight, computed locally | Tested against published times |
| `src/components/maps` | MapLibre GL JS with OpenFreeMap vector tiles (`NEXT_PUBLIC_MAP_STYLE_URL`) and AWS terrain hillshade | Browser HTTP cache only; no key |

## Real and verified locally
| Area | Implementation | Notes |
|---|---|---|
| Database schema, RLS, column grants, licence gate | `supabase/migrations/*.sql` | Verified on PostgreSQL 16 with a local shim of Supabase's `auth` schema; integration tests cover cross-user isolation, the licence gate, the publish gate and the go-live archive of the v0 schema. Not yet applied to the hosted Supabase project (it still runs the v0 schema until go-live). |
| Demo authentication | scrypt passwords + HMAC-signed cookie | For local demos only (`AUTH_PROVIDER=demo`). |
| Background jobs | Postgres job table, `/api/cron/jobs`, `npm run jobs:run` | Dedup keys, `SKIP LOCKED` claiming, backoff, dead-letter, operator retry. |
| Service-worker kill switch | `public/sw.js` | Deletes the old offline worker's `gg-*` caches, unregisters itself and reloads open tabs. The app registers no worker. |

## Implemented against vendor docs, NOT verified with live credentials
| Integration | Env to enable | What was tested |
|---|---|---|
| Supabase Auth (`@supabase/ssr`, `proxy.ts`, `getClaims`) | `AUTH_PROVIDER=supabase` + keys | Running on the hosted preview (Supabase project + Vercel); sign-in flows are covered by the demo-auth e2e suite, not by automated tests against Supabase. |
| Stripe Checkout (test mode) adapter (`src/integrations/payments`) | `PAYMENTS_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Webhook signature verification unit-tested with stripe-node's own signing helpers; session/refund API calls never executed. No checkout or webhook route uses the adapter until Phase 6. |
| National Weather Service forecast adapter (`src/integrations/weather`) | `WEATHER_PROVIDER=nws` | Mocked-fetch tests only (US locations). No page uses it since the marketing-draft workflow was removed.  |
| Vercel Cron / Supabase pg_cron trigger | `vercel.json`, `supabase/cron/schedule-job-runner.sql` | Endpoint verified locally; schedulers not deployed. |

## Simulated (demo adapters, labeled "Simulated" in the UI)
| Integration | Behavior |
|---|---|
| Payments (adapter only) | Demo checkout sessions and HMAC-signed, Stripe-shaped events (`src/integrations/payments/demo.ts`). No page or route uses it until Phase 6. Refuses to run when `APP_MODE=live`. |
| Weather adapter (`WEATHER_PROVIDER=demo`, unused by pages) | Deterministic forecast marked simulated, with fetched-at time. |

## Deferred (not built)
- Partner booking providers (`PLAN.md` §3, Phase 6: a mock provider first). Each live provider needs official API documentation, a commercial agreement and credentials before building.
- Error-monitoring vendor (e.g. Sentry); structured redacted logs are ready for a log drain.
- Automated permit purchasing (intentionally never: no queue, CAPTCHA or purchase-limit bypass).

## Removed (Phase 2 clean-up)
The on-demand OpenStreetMap catalog with Overpass and Nominatim loading, Explore, trail pages, saved trails and trail weather panels (pass 3). Safety check-ins and notifications (Twilio, Resend, demo), the GPS hike screen and simulator, offline trip
downloads, and AI explanations (Anthropic) with the marketing-draft workflow (pass 1). The fictional demo region,
the recommendation/itinerary rules, single-trail bookings (pricing, inventory, payment processing, reconciliation,
refunds), local/Supabase object storage, the partner add-on adapters (gear lockers, shuttle, meal packs, satellite
devices) and permit tracking (pass 2). They can be recovered from the `archive/v0-hiking-companion` branch.
