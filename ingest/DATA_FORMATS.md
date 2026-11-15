# Ingest data formats

Two hand-maintained, reviewed inputs feed the ingestion pipeline. Both are YAML, one file per hike.

| File | What it holds | Who writes it |
|---|---|---|
| `ingest/seeds/hikes/<slug>.yaml` | Identity of a hike: name, country, managing agency, official URL, Wikidata ids, OSM ids, trip type, access mode, status | Research, reviewed by staff |
| `ingest/curated/<slug>.yaml` | Facts read on **official** web pages, each with its source URL and the date checked | Research, then an independent verifier |

Everything else (OSM geometry and points, Wikidata claims, Commons photos, Wikivoyage/Wikipedia excerpts, NPS/RIDB/DOC API records, elevation profiles) is fetched by the pipeline. It is never typed into these files.

## Hard rules (from the build brief)

1. **Never invent a fact.** If an official page does not state it, leave the field out. The site then shows "Check the official site".
2. **Official sources only for curated facts.** That means government agencies, park and protected-area authorities, the body that manages the trail (e.g. a national trail office, an official trail association), official hut operators for hut rules, and official tourism boards.
   - **Never use:** AllTrails, Komoot, Gaia, Wikiloc, Strava, Outdooractive, FarOut, TripAdvisor, Google, Reddit, blogs, tour operators, guidebooks or news sites.
   - **Wikipedia/Wikivoyage:** not used for facts here; they feed area background text separately.
   - **Wikidata:** may be used for ids, coordinates and official-website links.
3. **Our own words.** `note`, `how_to_apply`, `parking`, `trailhead_access` and `public_transport` are short paraphrases (≤ 300 characters). They never copy a sentence from the page. Numbers, names, dates and prices are facts and are copied exactly.
4. **Every fact carries** `source_url` (the page that states it), `source_title`, `publisher` and `checked_at` (ISO date). One fact may cite one page only. If two pages are needed, record two facts.
5. **Dated facts.** If a page states a season or a year for a fee or rule (e.g. "2026 rates"), record it in `valid_from` / `valid_to` or `season`.
6. **Respect sites.** Read pages with `ingest/research-tools/fetch_text.py` (identifying User-Agent, robots.txt, cache). Never log in, submit forms, enter booking flows or use bots on reservation systems.

## Seed file: `ingest/seeds/hikes/<slug>.yaml`

```yaml
seed_no: 1                      # number in docs/PLAN.md §9
slug: half-dome                 # lowercase, a-z0-9 and hyphens, unique
name: Half Dome                 # common English name
alt_names: [Half Dome Trail]    # optional
route_variant: Mist Trail and John Muir Trail from Happy Isles   # optional
region_group: north-central-america   # north-central-america | south-america | europe | africa | asia-middle-east | oceania
countries: [US]                 # ISO 3166-1 alpha-2, in route order
subdivisions: [US-CA]           # ISO 3166-2 where known, else []
area:
  name: Yosemite National Park
  wikidata: Q180402             # null if unknown
  official_url: https://www.nps.gov/yose/
agency:
  name: National Park Service
  wikidata: Q308439             # null if unknown
hike_wikidata: Q1567409         # Wikidata item of the trail/route itself, null if none
official_url: https://www.nps.gov/yose/planyourvisit/halfdome.htm   # best official page for THIS hike
anchor:                         # approximate start point, used only to search OSM; never published
  lat: 37.7323
  lon: -119.5579
  source: wikidata              # wikidata | official | nominatim
osm:                            # resolved later by the pipeline in CI; research fills what it can
  relation_ids: []              # OSM route relations (preferred)
  way_ids: []                   # when the trail is a chain of named ways
  candidates:                   # unconfirmed leads
    - { osm_type: relation, osm_id: 1234567, name: "Half Dome Trail", via: nominatim }
  confidence: unknown           # confirmed | probable | unknown
  notes: ""
trip_type: day                  # day | overnight | multi_day
typical_days: null              # integer for multi-day trips if an official page states it, else null
access_mode: independent        # independent | licensed_operator_required | guide_recommended
flags: []                       # see below
status:                         # current operating status, from an official page
  value: open                   # open | seasonal | partially_closed | closed | unknown
  note: ""
  source_url: null
  checked_at: 2026-11-15
replacement:                    # only for conditional seeds
  condition: ""                 # e.g. "North Kaibab Trail closed for 2026"
  fallback_slug: ""
  recommendation: keep          # keep | use_fallback | undecided
  reason: ""
```

`flags` values:
- `gr_route_geometry_withheld`: a French GR®/GRP® route; no route line until legal sign-off.
- `operator_only`: a licensed operator or guide is legally required.
- `advisory`: a government travel advisory applies to the area (cite it as a hazard in the curated file).
- `seasonal_access`: open only part of the year.
- `fallback_for:<slug>`: this hike is the backup for another seed.

## Curated facts file: `ingest/curated/<slug>.yaml`

```yaml
slug: half-dome
researched_at: 2026-11-15
facts:
  - field: permit_required
    value: seasonal                 # see value types below
    note: Day hikers need a permit for the cables section whenever the cables are up.
    source_url: https://www.nps.gov/yose/planyourvisit/hdpermits.htm
    source_title: Half Dome Permits for Day Hikers - Yosemite National Park
    publisher: National Park Service
    checked_at: 2026-11-15
    evidence_heading: Half Dome Permits for Day Hikers   # heading/section on the page where it is stated
    evidence:                                            # INTERNAL ONLY, never published
      page: P2                                           # page id in ingest/research/packs/<slug>.md
      quote: "Permits to hike to the top of Half Dome are required seven days per week when the cables are up"   # exact text from the page (<= 300 chars) that states the fact
  - field: permit
    value:
      name: Half Dome day-hiker permit
      kind: lottery                 # day_use | overnight | lottery | quota | timed_entry | vehicle_reservation | parking | trekking_card | restricted_area | other
      how_to_apply: Apply in the March preseason lottery on Recreation.gov, or in the daily lottery two days ahead.
      booking_window: "Preseason lottery 1–31 March; daily lottery two days before the hike"
      official_url: https://www.recreation.gov/permits/234652
      price: { amount: 10.00, currency: USD, unit: per_application, audience: all, note: "plus per-person fee if awarded" }
      months: [5, 6, 7, 8, 9, 10]   # months the permit is required, if stated
    source_url: ...
    source_title: ...
    publisher: ...
    checked_at: 2026-11-15
verifier: null                      # filled by the verification pass
```

### Fields and value types

| field | value | notes |
|---|---|---|
| `distance_km` | number | Only if the official page states it. Add `basis`: `round_trip` \| `one_way` \| `loop` in the fact. |
| `elevation_gain_m` | number | Convert feet → metres (×0.3048, rounded); say so in `note`. |
| `high_point_m` | number | Same conversion rule. |
| `duration` | `{ min_hours, max_hours }` or `{ min_days, max_days }` | As the official page states it. |
| `route_type` | `loop` \| `out_and_back` \| `point_to_point` | |
| `difficulty_official` | `{ label: "strenuous", scale: "NPS" }` | The agency's own rating, verbatim label. |
| `best_months` | `[int 1–12]` | Only if the page states a season or months. |
| `season_note` | text | Our words. |
| `permit_required` | `yes` \| `no` \| `seasonal` \| `conditional` | `no` only if the page says no permit is needed. |
| `permit` | object (above) | Repeat for each permit. |
| `fee` | `{ name, amount, currency, unit, audience, valid_from, valid_to, note }` | unit: `per_person` \| `per_vehicle` \| `per_group` \| `per_night` \| `per_day` \| `per_application` \| `per_trip`. audience: `all` \| `adult` \| `child` \| `resident` \| `non_resident` \| `senior` \| `student`. Repeat per fee. |
| `entry_fee_none` | `true` | Only if the page says entry is free. |
| `parking` | text | Our words: where, cost, pre-booking. |
| `trailhead_access` | text | Our words: road access, seasonal roads, shuttles. |
| `public_transport` | text | Our words: official shuttle/bus/train options. |
| `rule_dogs` / `rule_drones` / `rule_camping` / `rule_fires` / `rule_group_size` | `{ value: allowed \| not_allowed \| restricted, max_group: int?, note }` | `restricted` needs a note. |
| `hazard` | `{ type, note }` | type: `heat` \| `cold` \| `altitude` \| `flash_flood` \| `river_crossing` \| `exposure` \| `rockfall` \| `avalanche` \| `lightning` \| `weather` \| `wildlife` \| `remoteness` \| `volcanic` \| `tides` \| `security_advisory` \| `other`. Repeat per hazard. |
| `nearest_town` | `{ name, note }` | |
| `access_mode` | `independent` \| `licensed_operator_required` \| `guide_recommended` | Licensed operator only if the official page says it is required. |
| `licensed_operator_list_url` | URL | The official list of licensed operators, if one exists. |
| `closure` | `{ status: open \| seasonal \| partially_closed \| closed, note, as_of }` | Current alerts and closures. |
| `official_url` | URL | Canonical official page for the hike. |

### Verification (mechanical, then a light consistency pass)

Facts are extracted from **evidence packs** (`ingest/research/packs/<slug>.md`, built by `build_packs.py` from cached official pages). Every fact must carry `evidence.quote`: an exact, contiguous piece of text from one `[Pn Lm]` line of the pack, which is text from the page at `source_url`. The quote is internal evidence for verification and is never shown on the site.

`verify_facts.py` then checks every fact mechanically:
- The quote really is on the cached page.
- Every number in the value appears in the quote, or is a miles→km or feet→m conversion of one.
- No 10-word run of our wording is copied from the page.
- The source is not a banned site.

Passing facts get `verified: true`; failing ones get `verified: false` plus `verify_reason`.

A final cheap consistency pass reads only (field, value, quote) triples and flags values the quote does not actually support; those are set to `verified: false`.

The pipeline loads only facts with `verified: true`.
