# Ghost Guide

A cloud-hosted platform for **personalized, self-guided hiking experiences**. Customers discover a
hike, get a personalized itinerary, buy a self-guided experience, download their trip, and hike with
GPS-triggered audio narration and optional check-ins. Operators get an admin dashboard for trails,
content, bookings, partners, safety check-ins and integration health.

> **This is an MVP running in demo mode by default.** The launch region and every trail in it are
> **fictional demonstration data** — not for navigation. Payments, partner services (lockers,
> shuttle, meal packs, satellite rentals), notifications, weather and AI text are **simulated**
> unless you configure real providers. See [`/status`](http://localhost:3000/status) in the running app.

## Quick start (local demo, no credentials)
Requires Node ≥ 20.19 and PostgreSQL ≥ 15 (the default `DATABASE_URL` expects `127.0.0.1:54322`).

```bash
cp .env.example .env.local      # set AUTH_SECRET (32+ chars) and CRON_SECRET (16+ chars)
npm install
npm run db:reset                # create DB, apply migrations (+ local Supabase shim), seed demo data
npm run dev                     # http://localhost:3000
npm run jobs:run -- --watch     # second terminal: background jobs (stand-in for cron)
```

Demo accounts (password `ghostguide-demo`, local demo only):

| Account | Role |
|---|---|
| `hiker@demo.ghostguide.test` | customer (has a consenting emergency contact) |
| `hiker2@demo.ghostguide.test` | customer |
| `admin@demo.ghostguide.test` | admin (everything) |
| `operator@demo.ghostguide.test` | operations: bookings, gear, fulfillment, jobs |
| `safety@demo.ghostguide.test` | safety desk: active trips, overdue check-ins, precise locations |
| `editor@demo.ghostguide.test` | content editor: trails, narration approval |
| `support@demo.ghostguide.test` | customer support (no precise location access) |

## Scripts
| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` | `next typegen` + `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run test:unit` / `test:integration` | Vitest (integration uses a fresh `ghostguide_test` DB) |
| `npm run test:e2e` | Playwright end-to-end against a production build and a fresh `ghostguide_e2e` DB |
| `npm run verify` | typecheck + lint + all Vitest tests + production build |
| `npm run db:migrate` / `db:seed` / `db:reset` | database |
| `npm run jobs:run [-- --watch]` | run due background jobs locally |

## Documentation
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — stack, data access & RLS rules, jobs, contracts, safety rules
- [`docs/IMPLEMENTATION_CHECKLIST.md`](docs/IMPLEMENTATION_CHECKLIST.md) — done / simulated / blocked / deferred
- [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) — real vs simulated vs deferred integrations
- [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) — mobile, offline and PWA limitations
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Supabase + Vercel setup, cron, Stripe, Mapbox
- [`docs/LAUNCH_CHECKLIST.md`](docs/LAUNCH_CHECKLIST.md) — credentials, field testing, procedures, approvals

## Safety model (short version)
Ghost Guide is **not an emergency service**. It does not monitor hikers continuously, cannot see a
hiker's location in real time, never contacts 911 or Search and Rescue, and does not provide
satellite SOS. Opt-in check-ins send a notice to a consenting contact when the hiker has not
confirmed by their expected return time plus a grace period — which means *no confirmation was
received*, not that an emergency is happening.
