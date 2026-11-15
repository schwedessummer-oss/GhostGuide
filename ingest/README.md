# Ingestion (`ingest/`)

The offline pipeline that turns the hand-curated hike inputs and open data into the catalog
tables (docs/PLAN.md §3, §4, §6). It runs on a developer laptop or in CI, **never inside the
Next.js app or on Vercel**. It imports nothing server-only from `src/`.

```bash
npm run ingest -- <command> [options]
```

| Command | What it does |
|---|---|
| `check` | Validates every `seeds/hikes/*.yaml` and `curated/*.yaml` in `INGEST_DATA_DIR` against `DATA_FORMATS.md`, prints the problems per file, exits non-zero on errors. No network, no database. |
| `load [--slug x]` | Loads seeds and **verified** curated facts into the database, one transaction per hike. Idempotent: unchanged input changes nothing. |
| `publish [--slug x] [--dry-run]` | Evaluates the database publish gate (`public.hike_publish_problems`) per hike, prints what is missing, and publishes draft/review hikes that pass. `--dry-run` only reports. |
| `report [--out file]` | Writes `ingest/reports/coverage.md` (tracked in git): filled vs empty key fields per hike, status, source counts and totals. |
| `report-skipped [--out file]` | Regenerates the "Run-time skips" section of `docs/skipped-sources.md` from `skipped_records`. |

Environment (read from `.env.local` / `.env` when not set):

| Variable | Default | |
|---|---|---|
| `INGEST_DATA_DIR` | `ingest/` in this repo | Holds `seeds/hikes/` and `curated/`. For local runs against the research worktree: `INGEST_DATA_DIR=/home/user/gg-data/ingest`. |
| `INGEST_CACHE_DIR` | `ingest/.cache/` (git-ignored) | Raw HTTP responses for the adapters. |
| `DATABASE_URL` | from `.env.local` | Run `npm run db:reset` first on a fresh local database. |

Typical local run:

```bash
npm run db:reset
INGEST_DATA_DIR=/home/user/gg-data/ingest npm run ingest -- check
INGEST_DATA_DIR=/home/user/gg-data/ingest npm run ingest -- load
npm run ingest -- publish --dry-run
npm run ingest -- report
npm run ingest -- report-skipped
```

## What `load` writes

Per hike, in one transaction:

1. **Source records** (`official_site`, licence `CITED-FACT`): one per page URL and date checked
   (deduplicated on both). The attribution text names the publisher and the page title, e.g.
   `National Park Service, "Half Dome Day Hike - Yosemite National Park (U.S. National Park Service)"`.
   The seed's own pages (hike and area official URLs) use the seed's `status.checked_at` and take
   the page title from a curated fact citing the same URL when there is one.
2. **Agency and area**, found by Wikidata QID, else by name and country. The first seed that names
   them creates them; later seeds only fill what is still missing.
3. **The hike's identity columns** from the seed. `status` is never changed by `load`: new hikes
   start as `draft`, published hikes stay published (and the load fails for a published hike
   whose new data would fail the publish gate).
4. **`hike_facts`**, method `curated`: a changed value supersedes the current row
   (`superseded_at`), so history is kept. A fact the file no longer supports (removed, unverified,
   invalid or contradicted) stops being current. When the curated file is missing or unusable,
   facts are left as they are.
5. **Typed rows** derived from the facts: `fees` (amount in minor units using the currency's
   `minor_unit`), `permits` + `hike_permits` (a permit price becomes a permit fee), `hike_rules`,
   `hike_hazards`; a `closure` fact sets `operating_status`.
6. **Published values**: the fact columns of `hikes` (distance, gain, duration, best months,
   permit status, parking, transport, ...) are copied from the current verified facts. This is the
   only writer of those columns, so they always match what the publish gate checks.

Rules applied on the way:

- Only facts with `verified: true` are loaded. Invalid facts are reported and skipped, never
  repaired or guessed.
- When several verified facts give one field (DATA_FORMATS rule 4 allows one page per fact),
  facts that **agree** keep the first one in the file (our-words text such as parking or access
  notes, or the same rule value with different notes); facts that **contradict** each other
  (different numbers, statuses or rule values) are all skipped until the file is fixed. `check`
  lists them as warnings.
- Facts citing a non-official site (AllTrails, Wikipedia, ...) are errors in `check`; `load` logs
  the source in `skipped_records` as `source_excluded`.
- Evidence quotes are never stored. `hike_facts.evidence` keeps `{ heading }` only, and that column
  is not readable by `anon` / `authenticated` anyway.
- Extra keys written by the research tools (`discovery_notes` in seeds, `mechanical_check` in
  curated files) are accepted and ignored; any other unknown key is an error.

## Code layout and adding an adapter

```
ingest/src/
  cli.ts              command registry (COMMANDS) and argument parsing
  config.ts           paths and environment
  commands/           check, load, publish, report, report-skipped
  data/               zod schemas (DATA_FORMATS.md), YAML reader, reference lists
  load/               fact resolution and published values (pure), database writes (apply.ts)
  lib/
    http.ts           HTTP client: identifying User-Agent, cache with ETag/If-Modified-Since,
                      per-host rate limit, retries with backoff (Retry-After honoured)
    licence.ts        licence mapper: code / name / URL -> licence code; rejects NC, ND, unknown
    sources.ts        source-record writer (licence-checked, deduplicated)
    skips.ts          skip logger (skipped_records, deduplicated)
    db.ts             connection, ingest_runs start/finish
```

An adapter (Wikidata, OSM, DEM, Commons, Wikivoyage, NPS, ...) is a further entry in `COMMANDS`
that uses these services:

- fetch with `new HttpClient({ cacheDir: cacheDir() })` (User-Agent
  `GhostGuideIngest/0.1 (+https://github.com/schwedessummer-oss/GhostGuide)`; never a vercel.app
  host, Overpass rejects it). Per-host intervals are in `DEFAULT_HOST_INTERVALS`.
- Wikidata entities come from `wikidataEntityUrl(qid)` (`Special:EntityData/<QID>.json`); the
  client refuses `api.php`, which rate-limits us. SPARQL (`query.wikidata.org`, about one request a
  minute) is only for resolving missing QIDs, in its own long-running command.
- every stored item gets a record from `SourceRecordWriter.write()` with the licence **as found**
  upstream; a licence we may not use is logged by the skip logger and nothing is written. The
  database licence gate remains the final check.
- OSM-derived values go to schema `osm` only (PLAN §4.4); the database rejects them elsewhere.

## Tests

- Unit (`tests/unit/ingest/`): schemas and the data reader, fact resolution and money, the licence
  mapper, the HTTP client (fake fetch and clock), report rendering.
- Integration (`tests/integration/ingest/`): loads `tests/fixtures/ingest/data` into the test
  database, checks a re-run changes nothing, an NC licence is rejected and logged, a changed fact
  supersedes the old one, and the publish gate passes for a complete hike and reports what an
  incomplete one is missing.
- Tests never touch the network. Fixture sources and licences: `tests/fixtures/ingest/README.md`.
