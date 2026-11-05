# Implementation checklist

Legend: ✅ done & verified · 🟡 simulated (demo adapter, labeled in UI) · ⛔ blocked (needs external access) · ⏭ deferred · ⬜ not started

## M0 — Foundation
- ✅ Next.js 16 + TypeScript + Tailwind 4 project, ESLint flat config
- ✅ Core schema + RLS + column grants (`supabase/migrations/20261105000000_core_schema.sql`)
- ✅ Local Supabase shim so migrations run on plain Postgres (`db/local`)
- ✅ DB layer with per-transaction RLS identity (`withUser` / `withAnon` / `withSystem`)
- ✅ Auth: demo (signed cookie) and Supabase (`@supabase/ssr` + `proxy.ts` + `getClaims`)
- ✅ RBAC permission matrix + staff roles
- ✅ Durable job queue (dedup, SKIP LOCKED, backoff, dead-letter, retry) + cron endpoint + local runner
- ✅ Audit log, integration-event log, rate limiting, feature flags, redacting logger
- ✅ Storage abstraction (local signed URLs / Supabase Storage)
- ✅ Pricing engine (transparent rules)
- ✅ Seed: fictional demo region, 6 published + 1 draft demonstration trails with validated geometry, POIs, approved sourced narration, permits, closure, add-ons, gear, pricing, flags, 7 demo users
- ✅ Foundation tests (geo, tokens, RBAC, redaction, pricing, RLS isolation, job queue)

## M1 — Browse → personalize → save trip
⬜ (slice: discover)

## M2 — Checkout → booking → trip dashboard
⬜ (slice: commerce)

## M3 — Download → start hike → GPS/audio → finish
⬜ (slice: hike)

## M3/M4 — Check-ins, notifications, account & privacy
⬜ (slice: safety)

## M4 — Admin & operations
⬜ (slice: admin)
