# v0 migrations (retired)

These SQL files built the **v0 "hiking companion" schema**: the demo region, single-trail
bookings and add-ons, the GPS hike screen, Ghost Guard safety check-ins and the on-demand
OpenStreetMap trail catalog.

- **The hosted database already has them applied.** Its migration history still lists
  these versions.
- **They are no longer run.** `npm run db:migrate` and `npm run db:reset` apply only
  `supabase/migrations/` (the Phase 2 schema, `docs/PLAN.md` §3). Do not move these files
  back, and do not edit them: they are the record of what the hosted database contains.
- The only code that still reads them is the integration test
  `tests/integration/catalog/archive-v0.test.ts`, which builds a v0 database to prove the
  go-live path below.

## Go-live: moving the hosted database to the new schema

1. Take a backup.
2. Run `scripts/db/archive-v0-hosted.sql` by hand (it is never run automatically). In one
   transaction it moves every v0 table the new baseline does not reuse into schema
   `legacy_v0`, keeps copies of the v0 columns the baseline drops, and revokes all access to
   `legacy_v0` from the API roles. It does not touch `auth.*`, so user accounts survive.
3. Apply the new migrations in `supabase/migrations/` (from `20261115000000`). Their
   baseline is written with guarded statements so it applies on top of the archived
   database; with the Supabase CLI, first mark these v0 versions as reverted
   (`supabase migration repair --status reverted …`, the exact command is at the top of the
   archive script).

The archive script's header explains how to restore v0 and how to drop `legacy_v0` later.
