# OurStory — Data Pipeline Execution Worklog
*Started: 2026-03-01*

## Plan

Build the data pipeline to populate OurStory's database with every historical event on Wikipedia,
sourced from Wikidata. Full plan: `data-pipeline-research-and-plan.md`.

---

## Known Issues to Fix Before Full Run

- [complete] Add `wikidata_qid` column to `events` and `cities` — `db/migrations/002_add_wikidata_qid_and_slug.sql`
- [complete] Add `slug` column to `events` and `cities` — same migration (linkable entities)
- [complete] Resolve `location_id` FK: cities must load before events — handled in `pipeline/load_postgres.py`
- [ ] Define cities Tier 2 extraction job (parallel to events, needed for Phase 1)
- [ ] Add DBpedia RDF → NDJSON parsing script (Step 2)

---

## Steps

### Phase 0: Validation (local, no GCP)

- [complete] **Step V1**: Write validation script — fetch 10 diverse Wikidata events via API, run extraction logic, output JSON matching DB schema, print coverage summary
- [complete] **Step V2**: Validate output — 10/10 dates ✓, 10/10 locations ✓, 10/10 categories ✓, BCE years parse correctly (Thermopylae=-480, Marathon=-490, Caesar=-44) ✓, spans work (Black Death 1346-1352) ✓, location QID resolution needed for 2/10 ✓

### Phase 1: Taxonomy & Infrastructure

- [complete] **Step 0b**: `db/migrations/002_add_wikidata_qid_and_slug.sql` — adds `wikidata_qid` + `slug` columns to events & cities
- [complete] **Step 0d**: Created `pipeline/` module structure: `extract.py`, `load_postgres.py`, `run_local.py`
- [complete] **Step 0e**: Expanded frontend category system: renamed `natural_disaster`→`disaster`, added `war`/`discovery`/`exploration`/`science`/`culture`
- [complete] **Step 0f**: Added `slug` + `locationSlug` to GeoJSON export — foundation for linkable entities
- [ ] **Step 0**: Run SPARQL taxonomy enumeration — fetch all event subclass QIDs (P279* of Q1190554), save to `pipeline/data/event_classes.json`
- [ ] **Step 0c**: Define and validate cities Tier 2 extraction logic (mirror of events step)

### Run 1: Local API (500 events)

- [complete] **Run 1**: Executed `python3 -m pipeline.run_local --limit 500`
  - 497 QIDs via SPARQL (battles/wars/disasters/revolutions/elections)
  - 497 entities fetched from Wikidata API
  - 285 cities resolved from P276 location QIDs
  - 359 events + 285 cities upserted to Postgres (slug-based idempotent upsert)
  - 138 skipped (no resolvable location — needs LLM enrichment in Run 5)
  - 195/497 Wikipedia summaries fetched (39% — some disambiguation/list pages)
  - GeoJSON exported: 665 features (372 events + 293 cities)
  - Frontend build: clean compile, zero TypeScript errors
  - Timeline bounds expanded: -600 to 2025 (covers full data range)

### Phase 2: Data Downloads (GCP)

- [ ] **Step 1**: Download Wikidata JSON dump to GCS (`gs://ourstory-data/wikidata/latest-all.json.bz2`, ~100 GB)
- [ ] **Step 2**: Download DBpedia short abstracts, write parsing script RDF → NDJSON lookup table

### Phase 3: Pipeline (Dataproc)

- [ ] **Step 3**: Tier 1 — structural filter (Dataproc PySpark job), output `spatiotemporal-entities` to GCS
- [ ] **Step 3b**: Tier 2 — event filter from Step 3 output, output `events-raw` NDJSON
- [ ] **Step 3c**: Tier 2 — city filter from Step 3 output, output `cities-raw` NDJSON
- [ ] **Step 4**: Structured extraction — parse all fields, date strings → integers, output Parquet
- [ ] **Step 5**: Join with DBpedia abstracts — add `wikipedia_summary` field

### Phase 4: Enrichment

- [ ] **Step 6**: Category mapping — P31 QIDs → OurStory categories (static map first)
- [ ] **Step 7a**: Location enrichment Bucket 2 — resolve P276 location QIDs to coordinates via Wikidata API batch
- [ ] **Step 7b**: Location enrichment Bucket 3 — LLM assignment for events with no location data

### Phase 5: Load

- [ ] **Step 8a**: Load cities to Postgres (must run before events for FK resolution)
- [ ] **Step 8b**: Load events to Postgres, resolving location QIDs → city UUIDs

---

## Progress Log

**2026-03-01** — Phase 0 validation complete. `scripts/validate-sample.py` runs against live Wikidata API, extracts 10 events, 10/10 field coverage. Output in `scripts/sample-events.json`. Extraction logic (date parsing, category mapping, coordinate extraction) confirmed working. Extended `WIKIDATA_TO_CATEGORY` map with 15 additional QIDs discovered from real event data (disease outbreak, city fire, revolution, amphibious warfare, etc.).

**2026-03-01** — Pipeline module structure built. `pipeline/extract.py` (pure extraction, no I/O), `pipeline/load_postgres.py` (psycopg2 upsert loader, cities-before-events ordering), `pipeline/run_local.py` (Run 1: SPARQL → Wikidata API → Wikipedia REST → extract → load). Ready to execute Run 1.

**2026-03-01** — DB migration 002 created: adds `wikidata_qid` + `slug` to both tables; back-fills slug from existing seed data. Category system expanded: `natural_disaster`→`disaster`, added `war`, `discovery`, `exploration`, `science`, `culture`. GeoJSON export updated with `slug` + `locationSlug` properties.

**2026-03-01** — Linkable entities concept: every entity exposes a `slug` (Wikipedia title as URL path, e.g. `Battle_of_Thermopylae`) as its stable public ID. Events also carry `locationSlug` pointing to their linked city entity. Frontend `FeatureProperties` type updated. Frontend navigation for cross-entity linking (click city name → zoom to city, open card, seek to founding year) is the next frontend step.

**2026-03-01** — Run 1 complete. 665 GeoJSON features, full timeline coverage -600 to 2025. Category gap: 110 events (30%) unmapped — mostly disaster subtypes and regional election types with unlisted P31 QIDs. Summary gap: 61% — expected rate for list/disambiguation pages that return empty extract from REST API. Both gaps acceptable for Run 1; will be addressed by LLM enrichment in Run 5.

