# GhostGuide: build plan

Approved by the owner on 14 Nov 2026. This file is the reference for Phases 2–7.

## Decisions recorded at approval

- **Q1, facts from official websites: yes.** Individual facts (fees, permit rules, dog/drone/fire/camping/group rules, parking, transport) may be recorded from official agency pages. Written in our own words, with the URL and date checked. No copied text and no scraping.
- **Q2, existing app: remove the out-of-scope features** (§2), after tagging `v0-hiking-companion`. Weather stays hidden behind a switch. The hosted database is backed up and reset to the new schema when the rebuild goes live.
- **Q3, seed list: approved as in §9**, with the 4 swaps, the conditional backups, operator-required treks kept and labelled, and no Antarctica.
- **Defaults in §11 accepted.**
- **Network:** the build environment has unrestricted outbound access for data research. The OSM servers (Overpass, Geofabrik) refuse connections from the build sandbox, so OSM fetching runs in GitHub Actions (the "runs in CI" path).

> **How verified this is.**
> - **Checked against primary pages:** the licence verdicts for the worldwide, US/Canada/Mexico and Europe/Africa/Middle East sources (some open points remain, listed in §5).
> - **From my own knowledge (to mid-2026), not checked live:** the licence notes for Asia, Oceania and South America, and **every seed-hike status** (closures, permits, fees). The research ran out of web searches, and most park websites are blocked from this session.
> - **Before anything is shown:** Phase 2 checks every fact against the official source. Unchecked fields stay null and show "Check the official site".

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Web app | Next.js 16 (App Router), React 19, TypeScript strict, Tailwind 4 | Already in the repo, deployed and tested |
| Database | Supabase Postgres 17 + PostGIS | Spatial filters, "nearby", row-level security |
| Auth | Supabase email sign-in (email + password today; magic link optional) | Already wired |
| Storage | Supabase Storage: a public bucket for approved photos, a private quarantine bucket for uploads | |
| Maps | MapLibre GL + OpenFreeMap tiles | Free, commercial use allowed, no key. Credit OpenFreeMap, OpenMapTiles and OSM. No SLA, so revisit before launch |
| Elevation | AWS Terrain Tiles (USGS 3DEP in the US) or Copernicus GLO-30; computed offline | Each DEM credited on /attributions |
| Payments | Stripe Checkout, **test mode only**, confirmed by webhook | The app refuses to start with an `sk_live_` key |
| Hosting | Vercel (web app only) | |
| **Ingestion** | **New `ingest/` package: a TypeScript CLI that runs on a laptop or in CI, never on Vercel** | Brief: "Keep ingestion scripts separate from the web app" |
| Tests | Vitest (unit + integration on real Postgres/PostGIS) and Playwright end-to-end | Existing harnesses kept |

## 2. What happens to the existing repo (Question 2)

Recommended:
- **Prepare:** tag the current version (`v0-hiking-companion`) so everything can be restored. Back up the hosted database, then **reset it to the new schema** rather than patching the old one.
- **Keep and reuse:**
  - Supabase auth and the proxy.
  - The Stripe adapter, webhook processing (idempotent `webhook_events`), reconciliation and refunds.
  - The background job queue.
  - The admin shell with roles and the audit log.
  - UI primitives (accessible, 44 px touch targets), the MapLibre components, and the explore list/map/filter UI patterns.
  - The elevation sampler, the provider HTTP client (identifying User-Agent, throttling, retries) and the test harnesses.
- **Remove:**
  - Ghost Guard safety check-ins, notifications and emergency contacts.
  - The GPS hike screen with its narration and simulator.
  - Offline downloads, replaced by a self-removing service worker so installed copies stop serving stale pages.
  - The fictional "Ghost Ridge" demo region and its single-trail booking flow.
  - AI explanations and marketing drafts.
  - Gear-locker, shuttle, meal and satellite add-ons.
  - Weekend and demand surcharges.
  - **Live OSM loading from Vercel:** visitors' searches trigger Overpass and Nominatim calls, which conflicts with "respect API terms".
- **Hide:** weather and daylight, behind a switch; decide in Phase 7.
- **Old URLs:** old `/trail/...` URLs return 410 (gone), or redirect where a matching seed hike exists.

## 3. Data model

Principle: **every value carries its source.** OSM-derived data never sits in our own tables.

### Provenance and licensing
- `licenses`: an allow-list keyed by SPDX-style codes (CC0-1.0, CC-BY-4.0, CC-BY-SA-4.0, ODbL-1.0, PD-USGov, OGL-UK-3.0, OGL-CA-2.0, Etalab-2.0, …). Each has flags: commercial_ok, nc, nd, share_alike, attribution_required, allowed. **The database rejects any record, photo or text whose licence isn't allowed** (enforced by a foreign key on `allowed = true`).
- `data_sources`: a registry (osm, wikidata, commons, wikivoyage, wikipedia, nps, ridb, doc_nz, parks_canada, official_site, …) with terms URL, default licence and status.
- `source_records`: one row per fetched item. Fields:
  - source, external id, version or revision, source URL, request URL
  - **licence, attribution text, retrieved_at**
  - content hash, ETag/Last-Modified
  - path to the cached raw payload, ingest run
- `ingest_runs` and `skipped_records`. `docs/skipped-sources.md` is generated from these plus manual source decisions.

### OSM (ODbL), in a separate `osm` schema
- `osm.elements`: raw relations, ways and nodes with their OSM version.
- `osm.routes`: assembled route geometry, way ids, geometry hash.
- `osm.points`: trailheads, parking, huts, water, toilets, viewpoints, peaks, bus stops.
- `osm.route_metrics`: length, elevation profile, gain/loss and high point computed from the OSM line plus a DEM (with DEM source and licence).
- These tables can be exported under ODbL on request. Hike pages read a view that merges OSM and our facts and **labels each field with its source and licence**.

### Our catalog (curated, every value traceable)
- `agencies`, `areas` (park or reserve; ISO 3166 country and subdivision; timezone; official and booking URLs), `macro_regions` (Alps, Patagonia, Himalaya, …).
- `hikes`:
  - Identity and the **published value of each non-OSM fact, all nullable:** distance, elevation gain, high point, difficulty, duration (minutes plus typical days), route type, best months, permit status, parking, trailhead access, public transport, nearest town, official URL.
  - `access_mode`: independent, licensed operator required, or guide recommended.
  - `last_verified_at`, and status: draft, review, published or archived.
- `hike_facts`: field-level provenance with history.
  - Fields: field, value, method (ingested, curated or calculated), **source_record_id (required)**, licence, checked_at, verified_by, superseded_at.
  - One current value per field. Publishing copies current facts into `hikes`, so there is only one writer.
- `hike_routes`: links a hike to an OSM route or an official route (exactly one). `official_routes` holds government GIS routes with their own licence.
- `hike_stages`: multi-day stages (start and end, distance, gain, overnight hut).
- `permits` + `hike_permits`: shared, seasonal, lottery or quota permits, booking window, official URL.
- `fees`: amount in minor units plus currency; unit (per person, vehicle, night, …); resident or non-resident; valid dates; source.
- `hike_rules`: dogs, drones, camping, fires and group size, each with a value, limit, note and source. `hike_hazards` uses an enum plus a note and source.
- `area_texts`: Wikivoyage/Wikipedia excerpts (page, revision, licence version, modified flag), **kept apart from our own text** because of share-alike.
- `places`: towns and sights from Wikidata or official data, for "nearby". OSM huts and parking come from `osm.points`.
- `hike_cost_estimates`, `currencies` (with decimals: JPY 0, KWD 3), `fx_rates` (dated, sourced), `hike_redirects`.

### Photos
- `photos`:
  - Origin: commons, government or user.
  - File page, author, credit line, licence code and URL, **licence evidence as retrieved**.
  - Retrieved and last-verified dates, status, storage variants, EXIF stripped, perceptual hash.
- `photo_links`: a photo can belong to several hikes or areas.
- `license_grants` plus a per-upload grant record for user photos: ownership confirmed and licence version accepted.
- A re-verification job re-checks Commons licences and deletions.

### Community
- `profiles` and `saved_hikes`.
- `reviews`: one per user per hike; status pending, published, hidden or removed.
- `reports`: typed targets, reason enum (spam, offensive, copyright, privacy, inaccurate, other), one per reporter.
- `moderation_actions`, with a statement of reasons to the user.

### Trips
- `trips`: owner, title, dates, party size.
- `trip_days`: date and position.
- `trip_items`: a hike, a bookable item, or your own item, with dates, quantity, a price snapshot and its timestamp, and a fractional position for reordering.
- `trip_shares`: hashed, revocable link tokens. The shared view is read-only and noindex, with no prices paid.

### Booking and payments
- `bookable_items`: type **PARTNER | OFFICIAL_LINK | FIRST_PARTY**, enforced by database checks:
  - **OFFICIAL_LINK:** needs an official URL; any price shown needs a source record. It can **never** be charged.
  - **PARTNER:** needs a provider and a product reference.
  - **FIRST_PARTY:** needs our own price.
- `partner_providers`:
  - Adapter: `mock` first.
  - **Fulfilment mode:** booked through our checkout, or an affiliate link-out.
  - Commission rate, terms URL, and status locked to `test`.
- `orders`, `order_items` (FIRST_PARTY and API-bookable PARTNER only; a check bans OFFICIAL_LINK), and `order_official_steps` ("book these yourself", with links).
- `payments`, `refunds`, `webhook_events`. One currency per order.

### Security
- Row-level security on every table:
  - The public reads published rows only. Owner-only policies use `(select auth.uid())`.
  - Ingestion and admin tables are server-only.
  - Column grants stop users from setting status or price columns.

## 4. Licence rules as implemented

1. **Licence gate:** a value can be published only if its source record has an allowed licence (CC0, PD, CC BY, CC BY-SA, ODbL, or a clearly open government licence allowing commercial use: OGL, Licence Ouverte, dl-de/by, NLOD, GSI terms, Taiwan OGDL, KOGL Type 1, GODL-India). Anything NC, ND, unclear or proprietary is skipped and logged.
2. **Photos are stricter (per the brief):** only CC0, public domain, CC BY or CC BY-SA, even from governments. US federal photos count only when credited to the agency with no © mark. RIDB photos are skipped (mixed ownership). DOC NZ photos are excluded by DOC's own terms.
3. **Credit on every photo:** title, author, source link and licence link, shown on the photo and on /attributions.
4. **OSM:**
   - Credit "© OpenStreetMap contributors" linked to the OSM copyright page, on maps and on pages that show OSM-derived facts.
   - OSM-derived values (including computed distance and elevation) live only in the `osm` schema.
   - We never correct, verify or geocode our own data against OSM (the OSMF Collective Database guideline).
   - **Get a lawyer's review of the ODbL set-up before launch.**
5. **Wikivoyage/Wikipedia:** short excerpts in `area_texts` only, with page title, history link, licence version and a "modified" note if trimmed. Share-alike applies to the excerpt, not to our pages.
6. **Our own words:** descriptions are written fresh, never copied from anywhere.
7. **Good citizenship:**
   - robots.txt respected; per-host rate limits.
   - Identifying User-Agent with a contact URL (not a personal email).
   - Every response cached. Conditional requests where supported.
   - No bots on booking systems, ever.

## 5. Data sources per region

Legend: **use** = ingest under an open licence. **link** = official page shown as a link only (no content reused). **skip** = logged in skipped-sources.

| Region | Use (licence) | Link only | Skip (reason) |
|---|---|---|---|
| **Worldwide** | OSM via Overpass for the seeds (batched by id, cached) and Geofabrik extracts when scaling (ODbL)<br>Wikidata (CC0): ids, coordinates, official URLs, agencies, OSM relation ids (P402)<br>Commons photos (per file: CC0/PD/BY/BY-SA, read from extmetadata)<br>Wikivoyage/Wikipedia (CC BY-SA 4.0)<br>OpenFreeMap basemap<br>AWS Terrain Tiles / Copernicus DEM | — | OSM editing API (its usage policy forbids read-only projects)<br>AllTrails, Komoot, Gaia, Strava, Wikiloc, Trailforks, Outdooractive, FarOut, CalTopo, onX, Google, TripAdvisor, Instagram, blogs (proprietary)<br>WDPA/Protected Planet (non-commercial) |
| **USA** | NPS API (public domain; photos only if NPS-credited, no ©)<br>RIDB (CC BY 4.0, "Data Source: Recreation.gov")<br>USGS National Digital Trails and 3DEP (PD)<br>USFS trails (CC BY 4.0, checked per dataset)<br>BLM trails (PD) | Recreation.gov permits, lotteries, timed entry; Hawaii DLNR / Hāʻena | RIDB photos<br>PCT and AT official centerlines, Hawaii Na Ala Hele GIS (no licence found)<br>WTA, TrailLink, Hiking Project |
| **Canada** | Parks Canada open data: trails, facilities, accommodations (OGL-Canada 2.0)<br>NRCan CanVec; BC and Alberta datasets only where the record says OGL | Parks Canada and BC Parks reservations | Parks Canada website text and photos; BC Parks API (licence unclear); Trans Canada Trail files |
| **Mexico, Central America** | INEGI / datos.gob.mx base data (Libre Uso MX); trails from OSM | SINAC (Chirripó), CONAP | Costa Rica SNIT (commercial use not authorised); CONAP GIS (no licence) |
| **South America** | No open trail data confirmed → OSM + Wikidata. Argentina datos.gob.ar / APN pages (CC BY, to verify) | Machu Picchu / Inca Trail, SERNANP, CONAF, APN, PNN, MAATE | SERNANP, CONAF, PNN, MAATE geodata (unclear); ICMBio (CC BY-ND); Andes Handbook |
| **UK and Ireland** | OS OpenData; Natural England National Trails and Coast Path; NatureScot; Lake District rights of way (OGL v3); Wales Coast Path (OGL, verify)<br>Sport Ireland National Trails; Tailte Éireann (CC BY 4.0) | — | OS premium mapping; Eryri route data (restricted licence); Scotland's Great Trails geodata (unclear) |
| **Rest of Europe** | IGN France (Licence Ouverte 2.0); swisstopo incl. hiking network (OGD); IGN Spain (CC BY 4.0); Portugal DGT (CC BY)<br>Norway Kartverket incl. trail database; Sweden Lantmäteriet and Naturvårdsverket (CC0); Iceland (CC BY 4.0)<br>Germany BKG (dl-de/by); Austria (CC BY 4.0); South Tyrol (CC0); SAT Trentino (ODbL); Slovenia GURS (CC BY 4.0) | Caminito del Rey, Cinque Terre Card, Samaria e-tickets, TPN tickets, Madeira IFCN fees, GR20 refuges, FÍ huts | **FFRandonnée GR® routes and names (claimed rights)**<br>IGN SCAN rasters; CAI trail register; DNT/UT.no (NC); SAC hut API<br>Lycian Way official GPX (no licence); Outdooractive/alpenvereinaktiv |
| **Africa and Middle East** | No open official trail data found → OSM + Wikidata + Commons | SANParks, TANAPA, KWS, NWR, UWA, RSCN, Oman ministry, Georgia APA | Jordan Trail GPX (no licence); SANParks content (all rights reserved) |
| **Oceania** | NZ DOC API and open data; LINZ (CC BY 4.0, DOC photos and logos excluded)<br>Australian state portals: DataVic, NSW SEED, WA DBCA (CC BY 4.0), Tasmania LIST (CC BY 3.0 AU), checked per dataset | DOC Great Walks bookings, Tasmania PWS, NSW NPWS, Parks Victoria, NT Parks, Kokoda Track Authority | NT open data (unclear); Wildwalks, Hema (proprietary) |
| **Asia** | Japan GSI; Taiwan OGDL 1.0; Korea KOGL **Type 1 only**; India GODL (all open with attribution) | Nepal permits (DNPWC, ACAP, Immigration); Bhutan; Fuji (Yamanashi); Yushan; Hallasan; Kinabalu; eRinjani; Ladakh | YAMAP, Yamareco, Hiking Biji, Naver/Kakao, 2bulu, Amap/Baidu; Survey of India maps; KOGL Types 2–4 |

Open licence points to confirm in Phase 2:
- RIDB: CC BY versus CC0 (treated as CC BY).
- USFS: dataset use constraints.
- OGL-BC commercial clause.
- Copernicus "commercial" wording.
- Wikimedia API rate limits.
- Japan Survey Act (whether derived maps need GSI approval).
- Every Asia/Oceania/South America verdict above.

## 6. Ingestion pipeline (`ingest/`)

- **Inputs:**
  - `ingest/seeds/hikes.yaml`: the approved list, with Wikidata QID, OSM relation or way ids, agency, official URL and the planned source per field.
  - `ingest/curated/<slug>.yaml` (if Question 1 is yes): facts from official sites, each with value, our own wording, URL, date checked and a page fingerprint to spot changes later. No copied text.
- **Per hike, in order:**
  1. Wikidata entity.
  2. OSM route and points from Overpass (one batched query per region, identifying User-Agent, cached).
  3. Route assembly and DEM metrics.
  4. Country adapters (NPS, RIDB, Parks Canada, DOC NZ, …).
  5. Commons photos (licence gate; resized WebP/AVIF variants into storage).
  6. Wikivoyage/Wikipedia excerpt pinned to a revision.
  7. Curated facts.
  8. Validation, then one database transaction (source records first).
- **Output report per hike:** fields filled versus null, sources used, items skipped and why. Re-runs are idempotent: an unchanged upstream means no changes.
- **Review:** an admin data-review page lists facts per hike with source and licence. You publish when happy. Publishing requires name, country, coordinates, official URL and a route or trailhead, all with sources. Everything else may be null and shows "Check the official site".
- **Adding a region later:**
  1. Add hikes to a region seed file.
  2. Add an adapter and licence entry if the region has open data.
  3. Run `npm run ingest -- --region <name>`.
  4. Review and publish.
- **Tests:** recorded fixtures (each with its licence noted), licence-gate tests, a test that no OSM-derived value appears in catalog tables, idempotency.

## 7. Feature notes

- **Browse:**
  - Map plus list.
  - Filters: region (macro-region, country), difficulty, distance, gain, duration, season (month), permit required, estimated cost.
  - Sorts on the same fields. Shareable URLs.
  - Loading, empty and error states.
- **Hike page:**
  - Top block answers **can I do this** (difficulty, distance, gain, duration, access mode), **when** (best months, permit and season windows) and **what does it cost** (required fees, with source and date).
  - Below: gallery with credits, stats with per-field source, elevation profile, map, parking and access, public transport, rules, permits and fees, hazards, best season, nearby, reviews.
- **Estimated cost:** required official costs only (entry, permits, and a mandatory operator minimum when sourced), per person in USD at dated rates. Labelled "lodging and travel not included". Mock partner prices are labelled TEST.
- **Reviews:** signed-in users only; rating plus text plus their own photos. They confirm ownership and accept the licence grant. Held for approval at first. Report button on reviews and photos. No imported reviews. A rating summary is shown only above a minimum number of reviews.
- **Trip builder:**
  - Choose hikes and dates; add items (lodging, guide, shuttle, gear, permits) or your own items.
  - Reorder days by drag or keyboard.
  - Running total split into "we charge", "you pay the agency directly" and "your own items".
  - Save; share as a read-only link.
- **Recommendations (explainable rules):**
  - Similar hikes: same area or macro-region, difficulty band, duration band, then distance.
  - Fitness: difficulty plus gain and duration thresholds.
  - Season: the chosen month is in best months.
  - Budget: estimated cost.
  - Each card says why, e.g. "Same region · similar length · in season in October".
- **Checkout:**
  - Trip to cart to order (USD), then Stripe Checkout (test).
  - Charged: FIRST_PARTY items, API-bookable PARTNER items and our service fee as its own line, all shown itemised before payment.
  - OFFICIAL_LINK items are listed as "Book these yourself" steps with official links, before payment and on the order page.
  - The webhook marks the order paid; the mock partner booking runs as a job; order history appears in the account.

## 8. Build phases

Each phase ends with the app running, all tests passing, a short demo (screenshots), and **a stop for your review**.

| Phase | Delivers |
|---|---|
| **1. Plan** (this) | On your OK: commit this plan, the data model, the seed list and the initial `docs/skipped-sources.md` |
| **2. Clean-up + ingestion** | Tag v0; remove out-of-scope features; back up and reset the hosted DB; new schema with licence gate and RLS; `ingest/` CLI with adapters; load and verify the seed hikes; data-review admin page; tests |
| **3. Browse and hike pages** | Map + list, all filters and sorts, hike pages with the top summary, gallery credits, elevation profile, map, access, rules, permits and fees, nearby; basic /attributions; design system (one accent, one typeface, photo-led, mobile first) |
| **4. Accounts and community** | Email sign-in, saved hikes, reviews, photo uploads (EXIF stripped, quarantine), moderation queue, report button, account pages |
| **5. Trips and recommendations** | Multi-day trip builder, reorder, running totals, save and share; similar hikes and rule-based suggestions with reasons |
| **6. Booking and checkout** | Bookable item types with DB invariants, mock partner provider, cart, Stripe test checkout, webhook-confirmed orders, "book these yourself" steps, order history, refunds; end-to-end tests of a mixed cart |
| **7. Polish** | Performance budget, WCAG AA audit, SEO (sitemap of published hikes, JSON-LD with image credits), complete /attributions, README (setup, env vars, ingestion, adding a region or booking provider; PowerShell commands included) |

"Done means" checks, built into the tests:
- Every published hike and photo has a source and licence.
- /attributions lists them all.
- A scan finds no data from disallowed sources in the repo.
- Filters, trip builder and test checkout pass end to end.

## 9. Seed list (108 hikes), for approval

Access is the **expected** rule, to be verified in Phase 2. ⚠ = needs a decision or check in Phase 2. **NEW** = swap from my draft. "Operator" = a licensed guide or operator is legally required.

Cross-cutting checks:
- A US$100 non-resident surcharge at 11 US national parks from 2026 (affects #1–4, 6, 7, 13, 16).
- NZ's planned charges for international visitors at some sites (#96, 100, 102).
- Nepal's guide rule after the 2025 political change.

### North and Central America (24)
| # | Hike | Where | Manager | Type | Access (expected) | Note |
|---|---|---|---|---|---|---|
| 1 | Half Dome (Mist Trail / JMT) | USA · Yosemite NP | NPS | Day | Cables permit (lottery) | |
| 2 | Angels Landing | USA · Zion NP | NPS | Day | Permit (lottery) | |
| 3 | The Narrows (bottom-up) | USA · Zion NP | NPS | Day | Park entry; no permit bottom-up | Flash-flood closures |
| 4 | Rim-to-Rim (North Kaibab → Bright Angel) | USA · Grand Canyon NP | NPS | Multi-day | Backcountry permit to camp | ⚠ North Rim closed after the July 2025 fire; backup: South Kaibab–Bright Angel via Phantom Ranch |
| 5 | Mount Whitney Trail | USA · Inyo NF (summit on Sequoia NP line) | USFS | Day / overnight | Permit (lottery) | |
| 6 | John Muir Trail | USA · Yosemite → Whitney | NPS + USFS | Multi-day | Wilderness permit (lottery) | |
| 7 | Highline Trail (Logan Pass) | USA · Glacier NP | NPS | Day | Park entry + seasonal vehicle reservation | |
| 8 | Delicate Arch | USA · Arches NP | NPS | Day | Park entry + seasonal timed entry | |
| 9 | The Wave (Coyote Buttes North) | USA · Vermilion Cliffs NM | BLM | Day | Permit (lottery) | |
| 10 | Kalalau Trail | USA · Nā Pali Coast SWP, Kauaʻi | Hawaii DLNR | Multi-day | Hāʻena entry reservation + camping permit | Booking platform reportedly changed in 2026 |
| 11 | Skyline Trail (Paradise) | USA · Mount Rainier NP | NPS | Day | Park entry (timed entry: check) | |
| 12 | Wonderland Trail | USA · Mount Rainier NP | NPS | Multi-day | Wilderness permit (lottery) | |
| 13 | Teton Crest Trail | USA · Grand Teton NP | NPS + USFS | Multi-day | Backcountry permit | |
| 14 | Old Rag | USA · Shenandoah NP | NPS | Day | Day-use ticket (Mar–Nov) + park entry | |
| 15 | McAfee Knob | USA · Appalachian NST, Virginia | NPS (corrected) | Day | None | |
| 16 | Sky Pond via Glacier Gorge | USA · Rocky Mountain NP | NPS | Day | Park entry + seasonal timed entry | |
| 17 | Chilkoot Trail | USA / Canada | NPS + Parks Canada | Multi-day | Permit (Parks Canada reservation) | |
| 18 | West Coast Trail | Canada · Pacific Rim NPR | Parks Canada | Multi-day | Reservation + orientation | |
| 19 | Plain of Six Glaciers | Canada · Banff NP | Parks Canada | Day | Park pass; paid parking or shuttle | |
| 20 | Iceline Trail | Canada · Yoho NP | Parks Canada | Day | Park pass | |
| 21 | Berg Lake Trail | Canada · Mount Robson PP | BC Parks | Multi-day | Campground reservations | ⚠ Verify status after the 2021 flood damage |
| 22 | Gros Morne Mountain | Canada · Gros Morne NP | Parks Canada | Day | Park pass | |
| 23 | Volcán Acatenango | Guatemala | CONAP | Overnight | Entry fee; usually guided | ⚠ Fuego eruptions suspend ascents; US "reconsider travel" |
| 24 | Cerro Chirripó | Costa Rica · Chirripó NP | SINAC | Multi-day | Reservation (quota) | |

### South America (14)
| # | Hike | Where | Manager | Type | Access (expected) | Note |
|---|---|---|---|---|---|---|
| 25 | Inca Trail (Classic) | Peru · Machu Picchu Historic Sanctuary | Min. de Cultura / SERNANP | Multi-day | **Operator**; closed in February | |
| 26 | Salkantay Trek | Peru · Cusco | Community lands | Multi-day | No permit known; Machu Picchu ticket if ending there | |
| 27 | Huayhuash Circuit | Peru · Cordillera Huayhuash | Communities | Multi-day | Community fees | |
| 28 | Santa Cruz Trek | Peru · Huascarán NP | SERNANP | Multi-day | Park ticket | Check guide rule |
| 29 | Laguna 69 | Peru · Huascarán NP | SERNANP | Day | Park ticket | |
| 30 | Rainbow Mountain (Vinicunca) | Peru · Cusco | Community | Day | Community fee | |
| 31 | Torres del Paine: W Trek / O Circuit | Chile · Torres del Paine NP | CONAF | Multi-day | Park ticket + every night booked | W and O merged into one entry |
| 32 | **NEW** Nahuel Huapi Traverse (Frey–Jakob–Laguna Negra–López) | Argentina · Nahuel Huapi NP | APN | Multi-day | Trekker registration | Replaces the separate O Circuit |
| 33 | Laguna de los Tres (Fitz Roy) | Argentina · Los Glaciares NP | APN | Day | Historically free; check new fees | |
| 34 | Cerro Castillo Circuit | Chile · Cerro Castillo NP | CONAF | Multi-day | Fees and registration | |
| 35 | Ciudad Perdida | Colombia · Sierra Nevada de Santa Marta | ICANH | Multi-day | **Operator** | |
| 36 | Valle de Cocora | Colombia · Quindío | CRQ / landowners | Day | Small landowner fees | |
| 37 | Quilotoa Loop | Ecuador · Cotopaxi | Communities | Multi-day | Small crater fee | |
| 38 | Vale do Pati | Brazil · Chapada Diamantina NP | ICMBio | Multi-day | None known; guides common | |

### Europe (28)
| # | Hike | Where | Manager | Type | Access (expected) | Note |
|---|---|---|---|---|---|---|
| 39 | Tour du Mont Blanc | France / Italy / Switzerland | Communes | Multi-day | None; book huts | ⚠ GR®: no route line in France until legal sign-off |
| 40 | GR20 | France · Corsica | PNR Corse | Multi-day | Refuge booking | ⚠ GR®: no route line until sign-off; Cirque de la Solitude closed since 2015 (variant used) |
| 41 | Alta Via 1 | Italy · Dolomites | Several parks | Multi-day | None; book rifugi | Summer road closure to Lago di Braies |
| 42 | Tre Cime di Lavaredo circuit | Italy · Dolomites | Auronzo (toll road) | Day | None to walk; toll road | Check road pre-booking |
| 43 | Walker's Haute Route | France / Switzerland | Communes | Multi-day | None; book huts | |
| 44 | Eiger Trail | Switzerland · Grindelwald | Local | Day | None (train access) | |
| 45 | Camino Francés | France / Spain (corrected) | Regional governments | Multi-day | Pilgrim credential | Route Napoléon closed in winter |
| 46 | Caminito del Rey | Spain · Málaga | Diputación de Málaga | Day | Timed ticket | |
| 47 | Path of the Gods | Italy · Amalfi Coast | Monti Lattari regional park | Day | None | |
| 48 | Sentiero Azzurro | Italy · Cinque Terre NP | Park | Day | Cinque Terre Card | ⚠ Manarola–Corniglia closed since 2012; Via dell'Amore separate ticket |
| 49 | Kungsleden (Abisko–Nikkaluokta) | Sweden · Lapland | Länsstyrelsen Norrbotten | Multi-day | None; pay at huts | |
| 50 | Laugavegur | Iceland | Ferðafélag Íslands (huts) | Multi-day | None; book huts | |
| 51 | Preikestolen | Norway · Rogaland | Stavanger Turistforening | Day | None; paid parking | |
| 52 | Trolltunga | Norway · Vestland | Municipality | Day | None; paid parking | |
| 53 | Cliffs of Moher Coastal Walk | Ireland · Clare | Clare County Council | Day | None (visitor-centre fee if used) | ⚠ Check section closures; backup: Glendalough Spinc loop |
| 54 | West Highland Way | UK · Scotland | Councils / NP | Multi-day | None; camping permit zones Mar–Sep | |
| 55 | Ben Nevis Mountain Track | UK · Scotland | John Muir Trust | Day | None | |
| 56 | Yr Wyddfa via Pyg Track | UK · Wales · Eryri NP | Eryri NPA | Day | None; Pen-y-Pass parking pre-booked | |
| 57 | Hadrian's Wall Path | UK · England | National Trails | Multi-day | None | |
| 58 | Samaria Gorge | Greece · Crete | NECCA | Day | Ticket; seasonal | |
| 59 | Mount Olympus (Prionia–Mytikas) | Greece · Olympus NP | NECCA | 2 days | None; book refuge | |
| 60 | Lycian Way | Türkiye | Culture Routes Society | Multi-day | None; summer forest bans | Official GPX unlicensed → OSM |
| 61 | Seven Rila Lakes | Bulgaria · Rila NP | Park directorate | Day | None known | |
| 62 | Mount Triglav | Slovenia · Triglav NP | Park | 2 days | None; book huts | |
| 63 | Rysy from Morskie Oko | Poland · Tatra NP | TPN | Day | Park ticket + pre-booked parking | |
| 64 | PR1 Pico do Arieiro–Pico Ruivo | Portugal · Madeira | IFCN | Day | Non-resident trail fee (2025) | ⚠ Fire/rockfall closures; backup: PR8 São Lourenço |
| 65 | Fishermen's Trail | Portugal · Rota Vicentina | Associação Rota Vicentina | Multi-day | None | |
| 66 | Malerweg | Germany · Saxon Switzerland | Tourism association / NP | Multi-day | None | ⚠ Diversions since the 2022 fire |

### Africa (9)
| # | Hike | Where | Manager | Type | Access (expected) | Note |
|---|---|---|---|---|---|---|
| 67 | Kilimanjaro (Machame) | Tanzania · Kilimanjaro NP | TANAPA | Multi-day | **Operator** | |
| 68 | Mount Kenya (Sirimon–Chogoria) | Kenya · Mount Kenya NP | KWS | Multi-day | Park fees (eCitizen) | Check guide rule |
| 69 | Jebel Toubkal | Morocco · Toubkal NP | ANEF | 2 days | **Licensed guide** (since 2019) | |
| 70 | Fish River Canyon | Namibia · \|Ai-\|Ais Hot Springs Game Park (corrected) | MEFT; booking via NWR | Multi-day | Permit, group of 3+, medical certificate; season | |
| 71 | Otter Trail | South Africa · Garden Route NP | SANParks | Multi-day | Booking (sells out a year ahead) | |
| 72 | Tugela Falls chain ladders | South Africa · Sentinel car park, Free State (corrected) | Unclear | Day | Gate fee | |
| 73 | Platteklip Gorge | South Africa · Table Mountain NP | SANParks | Day | None | |
| 74 | **NEW** Mount Mulanje hut-to-hut | Malawi · Mulanje Mountain Forest Reserve | Dept of Forestry | Multi-day | Fees; guide rule to check | Replaces Simien (Amhara conflict advisories) |
| 75 | Rwenzori Central Circuit | Uganda · Rwenzori Mountains NP | UWA | Multi-day | **Licensed guides** | ⚠ Check advisories; backup: Mount Elgon Sasa–Sipi |

### Asia and Middle East (20)
| # | Hike | Where | Manager | Type | Access (expected) | Note |
|---|---|---|---|---|---|---|
| 76 | Everest Base Camp | Nepal · Sagarmatha NP | DNPWC | Multi-day | Park + municipality permits | Check guide rule |
| 77 | Annapurna Circuit | Nepal · Annapurna CA | NTNC (ACAP) | Multi-day | ACAP permit; **licensed guide** (2023 rule) | |
| 78 | Annapurna Base Camp | Nepal · Annapurna CA | NTNC (ACAP) | Multi-day | Same | |
| 79 | Manaslu Circuit | Nepal · Manaslu CA | Immigration / NTNC | Multi-day | Restricted-area permit via agency; 2+ trekkers; **guide** | |
| 80 | **NEW** MacLehose Trail | Hong Kong · country parks | AFCD | Multi-day | None | Replaces Druk Path (Bhutan: operator + daily fee) |
| 81 | Markha Valley | India · Ladakh · Hemis NP | Ladakh wildlife dept | Multi-day | Ladakh and park fees | |
| 82 | Kumano Kodō Nakahechi | Japan · Wakayama | Prefecture / Tanabe | Multi-day | None; book inns | |
| 83 | Mount Fuji (Yoshida Trail) | Japan · Yamanashi | Prefecture | Overnight | Fee + online registration; Jul–Sep | |
| 84 | Nakasendō Magome–Tsumago | Japan · Gifu / Nagano | Municipalities | Day | None | |
| 85 | Yushan Main Peak | Taiwan · Yushan NP | Park HQ | 2 days | Park permit + lodge lottery; police permit | |
| 86 | Hallasan (Seongpanak) | South Korea · Jeju | Park office | Day | Reservation | |
| 87 | Tiger Leaping Gorge High Trail | China · Yunnan | Scenic area | 2 days | Ticket | |
| 88 | Mount Kinabalu | Malaysia · Kinabalu Park | Sabah Parks | 2 days | Permit + **mandatory guide** + lodge | |
| 89 | Mount Rinjani | Indonesia · Rinjani NP | Park | Multi-day | eRinjani + **licensed organiser** | Closed in the wet season |
| 90 | Ala Kul | Kyrgyzstan · Karakol NP | Park | Multi-day | Park fee | |
| 91 | Mestia–Ushguli | Georgia · Svaneti | — | Multi-day | None | |
| 92 | **NEW** Valley of Flowers (+ Hemkund) | India · Uttarakhand | Forest Dept | Multi-day | Forest entry fee | Replaces Fairy Meadows (Pakistan advisories) |
| 93 | Jordan Trail: Dana–Petra | Jordan | Jordan Trail Assoc. / RSCN | Multi-day | Petra ticket + reserve fees | Official GPX unlicensed → OSM |
| 94 | Wadi Mujib Siq | Jordan · Mujib Biosphere Reserve | RSCN | Day | Ticket; seasonal | |
| 95 | Balcony Walk (W6) | Oman · Jebel Shams | Ministry of Heritage & Tourism | Day | None | |

### Oceania (13)
| # | Hike | Where | Manager | Type | Access (expected) | Note |
|---|---|---|---|---|---|---|
| 96 | Milford Track | NZ · Fiordland NP | DOC | Multi-day | Great Walk booking | |
| 97 | Routeburn Track | NZ · Fiordland / Mt Aspiring NP | DOC | Multi-day | Great Walk booking | |
| 98 | Kepler Track | NZ · Fiordland NP | DOC | Multi-day | Great Walk booking | |
| 99 | Abel Tasman Coast Track | NZ · Abel Tasman NP | DOC | Multi-day | Booking all year | ⚠ Check 2025 flood damage |
| 100 | Tongariro Alpine Crossing | NZ · Tongariro NP | DOC | Day | None; 4-hour parking limit | |
| 101 | Roys Peak | NZ · Wānaka | DOC | Day | None; lambing closure 1 Oct–10 Nov | |
| 102 | Hooker Valley | NZ · Aoraki/Mount Cook NP | DOC | Day | None | |
| 103 | Overland Track | Australia · Tasmania | PWS | Multi-day | Booking + fee in season | |
| 104 | Larapinta Trail | Australia · NT | NT Parks | Multi-day | NT Parks Pass | |
| 105 | Grand Canyon Track | Australia · Blue Mountains NP | NSW NPWS | Day | None | Check closures |
| 106 | Kings Canyon Rim Walk | Australia · Watarrka NP | NT Parks | Day | NT Parks Pass; heat closures | |
| 107 | Great Ocean Walk | Australia · Victoria | Parks Victoria | Multi-day | Campsite booking | |
| 108 | Kokoda Track | Papua New Guinea | Kokoda Track Authority | Multi-day | KTA permit + **operator** | |

**Antarctica:** none. It's reachable only by expedition cruise, which doesn't fit a self-planned hike. Say if you want one anyway.

**Licensed operator or guide required (kept, clearly labelled):** #25, 35, 67, 69, 75, 77, 78, 79, 88, 89, 108 (and usually #23). These get `access_mode = licensed operator required`. The booking panel links to the official list of licensed operators, or to a PARTNER tour if one exists.

## 10. Initial `docs/skipped-sources.md`

Created in Phase 1 and then generated from the ingest log. Each entry records the source, why it was skipped and the date checked.
- **Proprietary:** AllTrails, Komoot, Gaia GPS, Strava Heatmap, Wikiloc, Trailforks, Hiking Project, WTA, TrailLink, Outdooractive/alpenvereinaktiv, FarOut, CalTopo, onX, Google Maps/Reviews, TripAdvisor, Instagram, blogs, YAMAP, Yamareco, Hiking Biji, Naver/Kakao Map, Amap/Baidu/2bulu, Wildwalks, Hema Maps, Andes Handbook.
- **Licence excludes us:**
  - WDPA/Protected Planet (non-commercial).
  - DNT/UT.no (CC BY-NC).
  - ICMBio website (CC BY-ND).
  - Costa Rica SNIT (commercial use not authorised).
  - KOGL Types 2–4 (NC or ND).
  - OS premium; IGN SCAN rasters; Tailte Éireann restricted data.
- **No licence found:**
  - PCT centerline and AT official centerline.
  - Hawaii Na Ala Hele trail GIS.
  - Trans Canada Trail files.
  - BC Parks API.
  - Parks Canada website text and photos.
  - CONAP GIS; SERNANP, CONAF, PNN, MAATE and IGN Argentina geodata.
  - Scotland's Great Trails geodata; Eryri route data.
  - CAI trail register; PZS trail cadastre; GIP.at; DIGIWAY.
  - Lycian Way and Jordan Trail official GPX.
  - NT open data; Survey of India maps; Trans Bhutan Trail.
- **Access policy:** OSM editing API (not for read-only projects); OSMF tile and Nominatim servers for bulk use.
- **Rights claimed:** FFRandonnée GR®/GRP®/PR® routes and names. **Pending a legal opinion.**
- **Photos:** RIDB/Recreation.gov media (mixed ownership); DOC NZ photos and logos.

## 11. Questions and defaults (answered, see top)

**Questions:**
1. **Facts from official websites.** May I record individual facts from official park pages in my own words, with link and date checked? These are fees, permit rules and dog/drone/fire rules that have no open licence. That means no copied text and no scraping. If not, those fields stay null with "Check the official site".
2. **The existing app.** Remove the out-of-scope features and reset the hosted database after a backup (§2)? Is there any real user data to keep?
3. **Seed list.** Approve the 108 above, including the 4 swaps, the conditional backups, the operator-required treks and no Antarctica?

**Defaults unless you say otherwise:**
- **Checkout:**
  - Currency: USD only. Official fees are shown in their local currency with an approximate USD figure (dated rates).
  - Service fee: 5% of the items we charge, shown as its own line before payment, never on OFFICIAL_LINK items.
  - Products: two placeholder FIRST_PARTY products ("Itinerary package", "Planning bundle") with test prices editable in admin.
- **PARTNER:** the mock provider covers both "book through our checkout" and "affiliate link-out". Real partners need contracts (and likely Stripe Connect) before going live.
- **Reviews and uploads:** pre-moderated. The uploader keeps ownership and grants a non-exclusive licence (draft text, for legal review).
- **GR® French routes:** no route line until legal sign-off.
- **Other:** sign-in stays email + password; maps stay on OpenFreeMap; weather stays hidden.

## 12. Risks and pre-launch items (not blocking the test build)

- **Merchant of record:** charging PARTNER items means collecting money for third parties. That needs partner contracts or Stripe Connect, and may bring EU Package Travel duties.
- **ODbL:** get a legal review of the OSM separation before launch.
- **User content duties:** EU DSA notice-and-action and statements of reasons, copyright takedowns, EXIF/location privacy, minimum age, review-verification disclosure.
- **Sparse data:** outside open-data countries many fields will be null. Question 1 decides how sparse.
- **Third-party limits:** OpenFreeMap has no SLA; Overpass, Wikidata and NPS/RIDB have usage limits. Plan fallbacks before scaling.
- **Bugs to fix in passing:** money formatting assumes 2 decimals for every currency (wrong for JPY and KWD); no guard against live Stripe keys; demo auth can run in live mode.
- **Old indexed URLs:** OSM trail URLs already indexed need 410 or redirects.
- **Database reset:** backup first, and only on your explicit OK.

## 13. What Phase 2 will need from you (requested through approval prompts, never in chat)

- **Network access for this cloud environment:**
  - Wikimedia (www.wikidata.org, query.wikidata.org, commons.wikimedia.org, upload.wikimedia.org, en.wikivoyage.org, en.wikipedia.org).
  - OSM (overpass-api.de, download.geofabrik.de).
  - Agency APIs (developer.nps.gov, ridb.recreation.gov, api.doc.govt.nz, open.canada.ca).
  - The official park websites used to check facts. That's many hosts, so unrestricted outbound access for this environment may be simpler; your call then.
- **Free API keys for NPS, RIDB and DOC NZ,** entered in the secure credential form.

## 14. Loose ends from before

- `npm run setup:cron`: skip it for now. The live OSM loading it schedules is being removed, and the job cron returns in Phase 6.
- The saved-trails database fix waiting on your "go" is no longer needed; that table is being replaced.
- The live site still loads OSM from Overpass on demand, and the 406 fix is unconfirmed. Switching that off is the first step after your OK.
- The duplicate "ghostguide" Vercel project still exists. Delete it in Vercel when convenient, or tell me to leave it.
