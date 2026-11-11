# Integrations: real, simulated, deferred

Status as of this build. **Verified** = exercised end to end in this environment (local Postgres,
production Next.js build, headless Chromium). No third-party credentials were available, so no
live vendor API was called.

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
| Supabase Auth (`@supabase/ssr`, `proxy.ts`, `getClaims`) | `AUTH_PROVIDER=supabase` + keys | Follows the official Next.js SSR example; never ran against a project. |
| Supabase Storage | `STORAGE_PROVIDER=supabase` | Never ran against a project. |
| Stripe Checkout (test mode) + signed webhooks | `PAYMENTS_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Webhook signature verification unit-tested with stripe-node's own signing helpers; session/refund API calls never executed. |
| Anthropic (AI explanations) | `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `AI_MODEL` | Fake-fetch tests only. Output guard falls back to templates on invented numbers or banned claims. |
| Twilio SMS / Resend email | `NOTIFY_PROVIDER=live` + provider keys | Mocked-fetch tests only. Live mode without a provider fails loudly. |
| National Weather Service (api.weather.gov) | `WEATHER_PROVIDER=nws`, `WEATHER_USER_AGENT` | Mocked-fetch tests only (US locations). |
| Mapbox GL JS maps | `NEXT_PUBLIC_MAPBOX_TOKEN` | Type-checked only; without a token the app uses the offline vector route view. |
| Vercel Cron / Supabase pg_cron trigger | `vercel.json`, `supabase/cron/schedule-job-runner.sql` | Endpoint verified locally; schedulers not deployed. |

## Simulated (demo adapters, labeled "Simulated" in the UI)
| Integration | Behavior |
|---|---|
| Payments | `/checkout/demo/[sessionId]` page; outcomes are delivered as HMAC-signed webhooks through the real processor (duplicate delivery button included). Refuses to run when `APP_MODE=live`. |
| AI text | Deterministic templates built only from scores and the itinerary. |
| Notifications | Recorded in the audit trail with status `simulated`; never delivered. |
| Weather | Deterministic forecast marked simulated, with fetched-at time. |
| Gear lockers | Reserves seeded gear items; derives a 6-digit access code (HMAC, never stored in clear); return/maintenance flows. |
| Shuttle | Quotes require customer confirmation of pickup, price and time before a (simulated) ride request. |
| Meal packs | Order/cancel; deterministic failure injection for demos. |
| Satellite communicator rental | Reserves a device from inventory; states clearly that Ghost Guide provides no SOS service. |
| GPS | Demo-mode-only simulator (speed, drift, detour, signal loss). |
| Trail data | Fictional demo region and trails with synthetic geometry, marked "not for navigation". |

## Deferred (not built)
- Live partner adapters (locker vendors, shuttle/rideshare, meal suppliers, satellite-device rental companies, onX or other mapping apps). Each needs official API documentation, a commercial agreement and credentials before building; see `src/integrations/partners/README.md`.
- Satellite messenger SOS/tracking integration (future partner integration only; the app never claims SOS capability).
- Native iOS/Android client for dependable background GPS, lock-screen audio, local notifications and licensed offline map packs.
- Offline basemap tiles in the PWA (not offered because of tile licensing).
- Web push notifications; SMS/email delivery-status webhooks.
- Machine-learning pricing (rules only until there is enough booking data).
- Error-monitoring vendor (e.g. Sentry); structured redacted logs are ready for a log drain.
- Automated permit purchasing (intentionally never: no queue, CAPTCHA or purchase-limit bypass).
