# Implementation checklist

Legend: ✅ done and verified in this environment · 🟡 simulated (demo adapter, labeled in UI) ·
🔶 implemented, not verified with live credentials or real devices · ⛔ blocked (needs external access) ·
⏭ deferred · ⬜ not started

"Verified" means: unit and/or integration tests against PostgreSQL 16, plus browser e2e against a
production build in headless Chromium. Nothing has been field-tested on real phones or trails.

## M0 — Foundation
- ✅ Next.js 16 + TypeScript + Tailwind 4 project, ESLint flat config, Vitest unit/integration projects, e2e harness
- ✅ Core schema with RLS and column grants; per-slice additive migrations; security hardening migration
- ✅ Local Supabase shim so the same migrations run on plain Postgres
- ✅ DB layer with per-transaction RLS identity (`withUser` / `withAnon` / `withSystem`)
- ✅ Auth: demo (signed cookie); 🔶 Supabase Auth (`@supabase/ssr`, `proxy.ts`, `getClaims`)
- ✅ RBAC permission matrix + staff roles; RLS aligned with RBAC (prices admin-only, phone restricted, marketing approval)
- ✅ Durable job queue (dedup, `SKIP LOCKED`, backoff, dead-letter, operator retry), cron endpoint, local runner, periodic jobs
- ✅ Audit log, integration-event log, rate limiting (per IP + per account for sign-in), feature flags, redacting logger
- ✅ Storage abstraction: local signed URLs ✅, Supabase Storage 🔶
- ✅ Transparent pricing engine
- ✅ Seed: fictional demo region, 6 published + 1 draft trails with validated synthetic geometry, POIs, approved sourced narration, permits, closures, add-ons, gear, pricing, flags, 7 demo users, sample bookings/check-ins

## M1 — Browse → personalize → save trip
- ✅ Landing page (honest about demo data and limitations)
- ✅ Trail discovery: list view with GET filters; map view = offline SVG overview + text list; 🔶 Mapbox map (needs token)
- ✅ Trail details: distance, elevation, difficulty, terrain, estimated duration (labeled), provenance per field (verified / estimate / operator note / demonstration), sources, freshness, permits with official links, closures
- ✅ Questionnaire (fitness, experience, terrain, pace, time, distance, elevation, date/start, accessibility, group size, equipment, dog), server-validated, works without JS
- ✅ Deterministic recommendation (hard filters + 0–100 scoring with breakdown), excluded trails with reasons, explicit "no route fits" with relax suggestions
- ✅ Deterministic itinerary (pace factor, stops, ETAs, turnaround, latest-finish estimate, reminders)
- 🟡 AI explanations: template provider; 🔶 Anthropic provider with output guard + fallback, rate limits, feature flag
- ✅ Save trip (server re-validates and re-scores; RLS-scoped insert); sign-in resume flow

## M2 — Checkout → confirmed booking → trip dashboard
- ✅ Checkout with transparent quote (weekend/holiday/demand/group rules), add-ons, inventory holds, idempotency keys, closure checks
- 🟡 Simulated checkout page (signed demo webhooks via the real processor, duplicate re-delivery); 🔶 Stripe Checkout + signed webhooks
- ✅ Idempotent webhook processing (dedup table, row locks), late-payment / amount-mismatch → needs_attention + auto refund
- ✅ Reconciliation and hold-expiry jobs
- ✅ My Trips dashboard, trip dashboard hub, receipts, booking history
- ✅ Cancellation with policy-based refunds (refund jobs, provider idempotency keys), check-in cancellation
- 🟡 Partner providers (interfaces + demo adapters): gear lockers (availability, reservation, keyed access codes, return, maintenance), shuttle (customer confirms pickup/price/time before ride request), meal packs, satellite-device rental (no-SOS disclaimer)
- ✅ Per-provider fulfillment status separate from booking status; partial failures → retries → needs_attention, visible to customer and operator

## M3 — Download → start hike → GPS/audio → finish
- ✅ PWA manifest + icons; hand-written service worker (versioned caches, per-trip caches, no Mapbox caching)
- ✅ Offline bundle API (owner-only, approved narration only, geometry checksum), download manager, completeness check (presence + checksum)
- ✅ Pre-hike page: checklist, permits, add-on readiness, permission check (GPS test, audio test, wake-lock support, storage), limitations panel, check-in setup
- ✅ Active hike screen: route view with accuracy circle, progress, elapsed time, remaining distance, last saved location, last sync, connection status, pause/resume/finish/help
- ✅ Geofenced approved narration (accuracy gating, dwell, hysteresis, once per session, out-and-back aware), transcripts, replay, mute, configurable trigger distance, device-voice TTS fallback
- ✅ Route-deviation prompts with accuracy filtering + persistence thresholds; general pacing/hydration reminders (not medical advice)
- ✅ Local persistence (IndexedDB) + outbox sync (batched, idempotent, backoff, reconnect flush)
- 🟡 Demo GPS simulator (demo mode only)
- ✅ Help screen (offline): last coordinates + accuracy + timestamp + stale warning, tel: link, honest instructions
- ✅ Completion summary + feedback
- ✅ Shared-device privacy: offline data wiped on sign-out; data tagged with a device owner hint
- ⏭ Dependable background GPS / lock-screen audio / local notifications (native client required; see LIMITATIONS.md)
- ⏭ Offline basemap tiles (licensing)

## M3/M4 — Check-ins & emergency contacts
- ✅ Emergency contacts with explicit consent attestation; consent cleared when contact details change; one-click opt-out link in every notice to a contact
- ✅ Opt-in check-ins: expected return, grace, configurable reminders, "I'm okay", "Extend my trip", "Finish trip"
- ✅ Server-side jobs: reminders, overdue (version-guarded, deduplicated), periodic safety-net scan (recovers late-queued jobs), retention purge; job-runner heartbeat shown on /status, admin and check-in screens
- ✅ Staff can annotate or resolve overdue check-ins (/admin/safety); "Extend my trip" also queued offline from the hike screen
- ✅ Notification audit trail (masked recipients); notices include last coordinates, timestamp, accuracy, stale label; never claim an emergency; state that emergency services were not contacted
- 🟡 Demo notification provider (recorded, never delivered); 🔶 Twilio SMS / Resend email (live mode only, fails loudly when unconfigured)
- ✅ Expiring, revocable trip-share links (hashed tokens, rate-limited lookups)
- ✅ Account, privacy (retention setting, location-sharing toggle, delete location history), emergency-contact settings
- ⏭ Satellite-device integration (future partner integration only)

## M4 — Admin & operations
- ✅ RBAC-gated admin dashboard with audit logging of sensitive actions
- ✅ Trails, facts with provenance, sources, closures, POIs, permit requirements; GeoJSON/GPX route upload with validation and activation
- ✅ Narration approval queue (source required), revisions
- ✅ Customers (sensitive data behind safety permission + audited reveal), bookings, payments, refunds, cancellations
- ✅ Gear inventory, reservations, maintenance; partner fulfillment queue with retry / manual status
- ✅ Safety desk: active hikes, overdue check-ins with timelines, notification delivery log
- ✅ Job retry queue, integration failures, failed webhooks; demo "run due jobs now"
- ✅ Pricing rules with live preview; availability (capacity overrides, blocked days); feature flags
- ✅ Marketing drafts from sourced facts + 🟡 simulated weather (🔶 NWS provider) with freshness warnings and approval before publication
- ✅ Permits: requirements, trip permit status tracking, daily in-app reminders; no automation of permit purchasing
- ✅ Support tickets, staff roles (last admin protected), audit log viewer
- ⏭ ML pricing (rules only until enough data)

## Verification status (last run)
- `npm run typecheck` — clean. `npm run lint` — clean.
- `npm test` — 79 files, **729 tests passing** (unit + integration against PostgreSQL 16 with all migrations and seeds), stable across repeated runs.
- `npm run test:e2e` — production build + fresh database, **161/161 browser checks passing** (discover, commerce, hike incl. offline/service worker, safety/check-ins, admin/RBAC), headless Chromium at phone and desktop sizes.
- Not verified: anything requiring real credentials (Supabase project, Stripe, Anthropic, Twilio/Resend, NWS, Mapbox), real phones (GPS, screen lock, background behavior, battery), or real trails.

## Known gaps (deferred)
- Emergency contacts consent is the hiker's attestation; contacts can opt out from every notice but do not confirm before the first one.
- Overdue check-ins that staff never resolve stay open (and keep the last location) until resolved; no auto-close policy yet.
- A Finish that the server permanently refuses (e.g. trip cancelled meanwhile) stays pending on the device; the sign-out guard still warns about it.
- If a partner accepts an order but the response is lost and the booking is then cancelled, the partner order needs manual cancellation (needs a partner API that cancels by our idempotency key).
- Admin "reveal sensitive details" form clears its reason field after a rejected submission (minor).
