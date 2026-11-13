# Deployment guide (Supabase + Vercel)

This takes the project from a local demo to a **private preview** on Vercel backed
by Supabase. Everything runs in demo mode (simulated payments, partners and
notifications) until you configure real providers.

> Nothing here has been run against your accounts yet: no Supabase, Vercel,
> Stripe or Mapbox credentials were available while this was built. The steps
> follow current vendor documentation; verify each one as you go.

## 0. Prerequisites
- Node.js ≥ 20.19 (22 LTS recommended), npm.
- A Supabase project (free tier is fine for a preview), a Vercel account, and
  optionally a Stripe account in **test mode** and a Mapbox account.
- Supabase CLI (`npm i -g supabase` or `npx supabase`) for applying migrations.

## 1. Supabase project
1. Create a project and pick a region close to your Vercel region (e.g. both in us-west).
2. **Database connection string**: Project → Connect → *Transaction pooler* (port 6543).
   Use it as `DATABASE_URL` with `DATABASE_TRANSACTION_POOLER=true` and `DATABASE_SSL=true`.
   The app switches to the `authenticated` role per transaction (`SET LOCAL ROLE`), which
   works in transaction mode. Verify once in the SQL editor:
   `begin; set local role authenticated; select current_user; rollback;` → `authenticated`.
3. **Apply migrations** (they are Supabase-CLI compatible; do *not* apply `db/local/*`):
   ```bash
   npx supabase init        # only if supabase/config.toml does not exist yet; keeps existing migrations
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```
   The Phase 1 migrations (`20261112*`) enable **PostGIS** in the `extensions` schema (available
   on every Supabase plan) and add the trail catalog. They are additive.
4. **Auth**: Authentication → URL configuration: set *Site URL* to your Vercel URL and add
   `https://<your-domain>/**` to redirect URLs. Keep email confirmation on for real users.
5. **API keys**: Project settings → API keys: copy the *publishable* key
   (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) and a *secret* key (`SUPABASE_SECRET_KEY`, server-only).
6. **Defense in depth**: the app does not use the Data API (PostgREST) — it talks to Postgres
   directly and uses Supabase only for Auth and Storage. RLS and column grants already protect
   every table, but you can also remove `public` from *Exposed schemas* (API settings).
7. **Storage**: `NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SECRET_KEY=… npx tsx scripts/setup-supabase-storage.ts`
   creates the private `trail-media` bucket.
8. **Seed demo data (optional, for a demo preview)**:
   ```bash
   DATABASE_URL=<session or direct connection string> DATABASE_SSL=true AUTH_PROVIDER=supabase \
   NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SECRET_KEY=… SEED_DEMO_PASSWORD='<choose one>' npm run db:seed
   ```
   This creates fictional demo trails and demo staff accounts (`admin@demo.ghostguide.test`, …)
   through the Supabase Auth admin API. **Do not seed demo accounts into a production project.**
9. **Staff roles** for real staff: insert rows into `public.staff_roles` (SQL editor) or use
   `/admin/staff` once one admin exists:
   `insert into public.staff_roles (user_id, role) select id, 'admin' from auth.users where email = 'you@company.com';`

## 2. Vercel project
1. Import the Git repository. Framework preset: Next.js. Build command `next build` (default).
2. Environment variables (Production *and* Preview), see `.env.example`.
   Shortcut: after `npm run setup:supabase`, run `npm run vercel:env`. It builds the whole list
   below from `.env.local` (switching to the transaction pooler on port 6543), generates
   `AUTH_SECRET`/`CRON_SECRET` once (saved in `.env.local`), and copies it to the clipboard;
   paste it into the first *Key* box in Vercel and the rows fill in.


   | Variable | Value |
   |---|---|
   | `APP_MODE` | `demo` for previews; `live` only after the launch checklist |
   | `NEXT_PUBLIC_APP_URL` | `https://<your-domain>`; optional on Vercel (defaults to the production domain) |
   | `DATABASE_URL` | Supabase transaction pooler URL |
   | `DATABASE_TRANSACTION_POOLER` / `DATABASE_SSL` | `true` / `true` |
   | `AUTH_PROVIDER` | `supabase` |
   | `AUTH_SECRET` | `openssl rand -hex 32` (signs share links, demo webhooks, locker codes) |
   | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | from Supabase |
   | `STORAGE_PROVIDER` | `supabase` |
   | `CRON_SECRET` | random ≥ 16 chars (Vercel sends it as `Authorization: Bearer …` to cron routes) |
   | `PAYMENTS_PROVIDER` | `demo`, or `stripe` with keys below |
   | `AI_PROVIDER` | `demo`, or `anthropic` with `ANTHROPIC_API_KEY` |
   | `NOTIFY_PROVIDER` | `demo` (recorded, never delivered) or `live` with Twilio/Resend |
   | `WEATHER_PROVIDER` | marketing drafts only: `demo` or `nws` (trail pages always use real MET Norway + NWS data) |
   | `DATA_PROVIDER_USER_AGENT` | `GhostGuide/1.0 (+https://<your-domain>; <contact email>)`. Required by OSM/Nominatim, MET Norway and NWS policies. Without it, the app sends `GhostGuide/0.1 (+<site URL>)` |
   | `RIDB_API_KEY` | optional, free: US federal facilities (ridb.recreation.gov → Profile → API Keys) |
   | `OVERPASS_URLS`, `NOMINATIM_URL`, … | optional: only to switch to self-hosted/commercial instances (defaults are the public services) |
   | `SHOW_DEMO_FIXTURES` | leave unset in production (the fictional demo region stays hidden) |

   **If Supabase's Vercel integration is connected**, it adds `POSTGRES_*` and `SUPABASE_*` variables
   (plus `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`) but
   none of Ghost Guide's own settings. Add the non-secret ones from the table, then run
   `npm run vercel:secrets` and paste just `DATABASE_URL`, `AUTH_SECRET` and `CRON_SECRET`.
   Symptom of a missing `DATABASE_URL`: every page fails and the logs say
   "DATABASE_URL is not set for this Vercel deployment" (older builds: `ECONNREFUSED 127.0.0.1:54322`).

3. **Keep previews private**: Settings → Deployment Protection → enable Vercel Authentication
   for Preview (and Production while in demo).
4. Deploy. Visit `/status` to confirm which integrations are live vs simulated.

## 3. Background jobs (required for check-ins and trail data)
- Two runners:
  - `/api/cron/jobs` (60 s): safety and commerce jobs.
  - `/api/cron/catalog` (300 s): trail-data downloads, stale refresh and cache purge, kept separate
    so slow provider downloads never delay a safety notice.
- `vercel.json` registers a **daily** cron on `/api/cron/jobs` (allowed on every plan; Hobby
  plans reject anything more frequent).
- Check-in reminders, overdue notices and trail refreshes need **minute** precision. Either:
  - **Supabase pg_cron + pg_net (works on any Vercel plan)**: run `npm run setup:cron` on your
    computer. It reads `DATABASE_URL` and `CRON_SECRET` from `.env.local`, checks that the deployed
    site accepts the secret, stores the site URL and secret in Supabase Vault, and schedules both
    runners every minute. It is safe to re-run. `supabase/cron/schedule-job-runner.sql` documents
    the same SQL, or
  - **Vercel Pro**: change the schedule in `vercel.json` to `* * * * *` and add a cron for
    `/api/cron/catalog`.
- Without per-minute cron, trails still load on demand right after a search (after-response work),
  but stale areas are not refreshed and check-in notices wait for the daily run.
- Verify: `curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/jobs` returns
  `{"ok":true,…}`. Admin → Jobs shows queued/dead jobs.
- Note: Vercel only runs cron jobs on **Production** deployments.

## 4. Stripe (test mode)
1. Dashboard (test mode) → Developers → API keys: `STRIPE_SECRET_KEY=sk_test_…`.
2. Webhooks → add endpoint `https://<domain>/api/webhooks/stripe` with events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`.
   Copy the signing secret to `STRIPE_WEBHOOK_SECRET`.
3. Set `PAYMENTS_PROVIDER=stripe`. Local testing:
   `stripe listen --forward-to localhost:3000/api/webhooks/stripe`.
4. Test with card `4242 4242 4242 4242`. Bookings are confirmed **only** by the signed webhook
   (the success page just shows status); missed webhooks are recovered by the
   `payments.reconcile` job.

## 5. Maps
Maps use MapLibre GL JS with OpenFreeMap vector tiles (free, no key) and AWS terrain hillshade on wide maps (set `NEXT_PUBLIC_MAP_TERRAIN_TILES_URL=off` to disable it).
To use another provider (MapTiler, Stadia, self-hosted Protomaps), set
`NEXT_PUBLIC_MAP_STYLE_URL` to its MapLibre style URL (public value) and rebuild. The PWA never
stores basemap tiles for offline use.

## 6. Notifications (live)
Only after legal/ops review (see `docs/LAUNCH_CHECKLIST.md`):
- SMS: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (complete A2P 10DLC / toll-free
  verification for US SMS first).
- Email: `RESEND_API_KEY`, `NOTIFY_FROM_EMAIL` on a verified sending domain.
- Set `NOTIFY_PROVIDER=live`. In live mode a channel without a configured provider **fails loudly**
  (visible in Admin → Notifications) rather than pretending to send.

## 7. Local demo (no credentials)
```bash
cp .env.example .env.local   # then set AUTH_SECRET and CRON_SECRET
# Postgres 15+ on 127.0.0.1:54322 (or change DATABASE_URL)
npm install
npm run db:reset             # create, migrate (with local Supabase shim), seed
npm run dev                  # http://localhost:3000
npm run jobs:run -- --watch  # in another terminal: runs due jobs every 15 s (stand-in for cron)
```
Demo accounts (local only): `hiker@demo.ghostguide.test`, `admin@demo.ghostguide.test`,
`safety@demo.ghostguide.test`, `operator@demo.ghostguide.test`, `editor@demo.ghostguide.test`,
`support@demo.ghostguide.test`, all with password `ghostguide-demo`.
