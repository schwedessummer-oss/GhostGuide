# Ingest fixtures

A small ingest data directory (`data/`) in the layout of `INGEST_DATA_DIR`, used by
`tests/unit/ingest/data.test.ts` and `tests/integration/ingest/load.test.ts`. Tests never touch
the network.

| File | What it is | Source and licence |
|---|---|---|
| `data/seeds/hikes/test-half-dome.yaml` | A complete seed (Half Dome, Yosemite) | Written for the tests from the research seed for Half Dome (data/seed-research branch). Names, ids and URLs are facts: Wikidata ids (CC0), official URLs on nps.gov. |
| `data/seeds/hikes/test-preikestolen.yaml` | A minimal seed without a curated file (publish gate: incomplete) | Written for the tests; the official URL is the regional tourism board's page. Facts only. |
| `data/seeds/hikes/test-broken-seed.yaml` | An invalid seed (unknown region, empty URL, unknown flag) | Invented for the tests. |
| `data/curated/test-half-dome.yaml` | Curated facts: valid, unverified, invalid (non-official source, too many decimals), contradicting and duplicate facts | Facts cited from U.S. National Park Service pages on nps.gov (works of the U.S. federal government, public domain, 17 U.S.C. §105), with notes in our own words. Several `evidence.quote` lines are short excerpts of those public-domain pages; others are abbreviated test strings. The AllTrails URL is there only to test that non-official sources are refused; nothing from that site is used. |

Slugs start with `test-` so the schema test that counts real hikes ignores them; seed numbers
9001-9003 do not clash with the real seed list.
