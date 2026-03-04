# Open History

An open-source interactive historical atlas. A real-world map with a timeline slider that lets you scroll through human history — watching events unfold and civilizations rise and fall.

Built with MapLibre GL JS, React, TypeScript, and Wikipedia/Wikidata as the source of truth for all historical data.

---

## Status: In Progress

This project is under active development. The core map and data pipeline are working; the focus now is expanding data coverage and polishing the UX.

### Done
- **Map** — MapLibre GL JS with OpenFreeMap basemap (light Wikipedia-style theme)
- **Timeline** — scrubber, play/pause, step controls, keyboard shortcuts (←/→/Space)
- **Events** — Maki icon markers per category (battle, war, politics, religion, disaster, exploration, science, culture)
- **Locations** — cities, regions, and countries shown at appropriate zoom levels
- **Polities** — time-bounded sovereign entities (empires, kingdoms, republics, etc.) shown as distinct markers at their capitals
- **Category filter** — two-row bar for toggling event/location/polity types
- **Info panel** — Wikipedia summary, categories, date range, and location for any clicked feature
- **In-app editing** — dates and locations can be corrected in-app; edits persist via a FastAPI overrides system
- **Data pipeline** — Wikidata SPARQL + Wikipedia API → PostgreSQL (37 active event categories using transitive P279*)
- **Polity pipeline** — separate pipeline for sovereign political entities
- **Post-processing** — cleanup, sitelinks backfill, GeoJSON export, LLM category assignment
- **Event fade-out** — single-year events fade out over a 10-year window rather than snapping off
- **Zoom filtering** — events filtered by importance (`sitelinks_count`) at low zoom levels
- **Data loaded** — 1790–1810 (2,125 events, 742 locations)

### To Do
- **Data coverage** — pipeline has only been run for 1790–1810; needs to expand across all of history
- **Territory polygons** — `polity_territories` table is in the schema but unpopulated; no territory editor yet
- **Location dates** — `founded_year` / `dissolved_year` mostly NULL; needs Wikidata backfill
- **Polity succession** — `preceded_by` / `succeeded_by` chain is stored but not surfaced in the UI
- **Related events** — semantically related events panel in the info card (see Vector Embeddings section below)
- **Natural language search** — search by concept, not just by name
- **Mobile layout** — not yet optimized for small screens
- **Deployment** — not yet deployed; target is Vercel (frontend) + Railway (backend + DB)
- **User contributions** — no account system yet; edits are local-admin only

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React 18, TypeScript, Vite |
| Map | MapLibre GL JS, OpenFreeMap tiles |
| Backend | FastAPI (Python), PostgreSQL 16 |
| Data | Wikidata SPARQL, Wikipedia REST API |
| Infrastructure | Docker (local DB), Vercel + Railway (planned) |

---

## Getting Started

### Prerequisites
- Docker
- Node.js 20+
- Python 3.10+

### 1. Start the database

The DB runs in a Docker container on port **5433** (5432 is reserved for other local projects).

```bash
# First time — create the container
docker run -d \
  --name openhistory-postgres \
  -e POSTGRES_DB=ourstory \
  -e POSTGRES_USER=ourstory \
  -e POSTGRES_PASSWORD=ourstory \
  -p 5433:5432 \
  -v openhistory_pgdata:/var/lib/postgresql/data \
  postgres:16

# Subsequent runs — just start the existing container
docker start openhistory-postgres
```

### 2. Apply schema migrations

```bash
for f in db/migrations/*.sql; do
  echo "Applying $f..."
  PGPASSWORD=ourstory psql -h localhost -p 5433 -U ourstory -d ourstory -f "$f"
done
```

Migrations run from `001_initial_schema.sql` through `010_polity_sovereign.sql`. Apply them in order; they are idempotent.

### 3. Copy the environment file

```bash
cp .env.example .env
# Add your ANTHROPIC_API_KEY if you want to use LLM category assignment
```

### 4. Run the pipeline

```bash
# Events — fetch from Wikidata + Wikipedia for a date range
python3 -m pipeline.run_local --min-year 1770 --max-year 1820

# Polities — fetch sovereign political entities for the same range
python3 -m pipeline.run_polities --min-year 1770 --max-year 1820
```

Then run post-processing:

```bash
# Runs cleanup, sitelinks backfill, and GeoJSON export in one step
python3 -m pipeline.post_process

# Or individually:
python3 scripts/cleanup-non-settlements.py
python3 scripts/backfill-sitelinks.py
python3 scripts/export_geojson.py
```

Optional LLM passes (requires `ANTHROPIC_API_KEY`):

```bash
python3 scripts/fix-empty-categories.py   # assign missing categories
python3 scripts/quality-check.py --no-fail  # audit data quality
```

### 5. Run the frontend

```bash
cd frontend && npm install && npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### 6. Run the API server (needed for in-app edits)

```bash
cd server && pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The frontend proxies `/api` to `localhost:8000` in dev via Vite config.

---

## Data Model

All historical data flows from Wikidata + Wikipedia through the pipeline into three Postgres tables, then exported to a single GeoJSON file consumed by the frontend.

### Entity types

| Class | Table | GeoJSON `featureType` | Description |
|---|---|---|---|
| Historical event | `events` | `'event'` | Battles, treaties, disasters, etc. |
| Location | `locations` | `'city'` / `'region'` / `'country'` | Geographic anchors used to pin events |
| Polity | `polities` | `'polity'` | Time-bounded sovereign entities (empires, kingdoms, etc.) |

### `events` table

| Column | Type | Description |
|---|---|---|
| `wikidata_qid` | TEXT UNIQUE | Wikidata Q-identifier |
| `slug` | TEXT | Wikipedia title slug |
| `title` | TEXT | Display title |
| `year_start` / `year_end` | INT | Year range (negative = BCE) |
| `date_is_fuzzy` | BOOL | Approximate date |
| `location_level` | TEXT | `'point'`, `'city'`, `'region'`, `'country'`, or NULL |
| `lng` / `lat` | FLOAT | Direct coords (point-level events only) |
| `location_wikidata_qid` | TEXT | Soft ref to `locations.wikidata_qid` |
| `categories` | TEXT[] | e.g. `['battle', 'war']` |
| `part_of_qids` | TEXT[] | Wikidata P361 (part-of) parent event QIDs |
| `sitelinks_count` | INT | Wikipedia language editions (importance signal for zoom filtering) |

### `locations` table

Referenced softly by `events.location_wikidata_qid` — no FK, so events are never dropped for a missing location.

| Column | Type | Description |
|---|---|---|
| `wikidata_qid` | TEXT UNIQUE | Wikidata Q-identifier |
| `name` | TEXT | Display name |
| `lng` / `lat` | FLOAT | Centroid coordinates |
| `location_type` | TEXT | `'city'`, `'region'`, or `'country'` |
| `founded_year` / `dissolved_year` | INT | Lifespan from Wikidata P571/P576 |

### `polities` table

Time-bounded sovereign political entities — historically specific ("French First Republic 1792–1804", not just "France").

| Column | Type | Description |
|---|---|---|
| `wikidata_qid` | TEXT UNIQUE | Wikidata Q-identifier |
| `polity_type` | TEXT | `empire`, `kingdom`, `principality`, `republic`, `confederation`, `sultanate`, `papacy`, `other` |
| `year_start` / `year_end` | INT | Active period |
| `capital_name` | TEXT | Capital city name |
| `lng` / `lat` | FLOAT | Representative point (capital coordinates) |
| `preceded_by_qid` / `succeeded_by_qid` | TEXT | Succession chain |
| `sovereign_qids` | TEXT[] | Parent polity QIDs |

The related `polity_territories` table (schema exists, currently empty) will hold time-varying polygon boundaries once a territory editor is built.

### Location resolution (events → map coordinates)

1. **Point** — event has its own P625 coordinates → `location_level = 'point'`
2. **P276** — event's P276 (location) QID resolves to a location record
3. **P17 fallback** — event's P17 (country) QID → `location_level = 'country'`
4. **Unlocated** — no location data → stored but not shown on map

---

## Future: Semantic Search via Vector Embeddings

> Out of scope for now. Captured here for reference.

In October 2025, **Wikimedia Deutschland + Jina AI** launched the [Wikidata Embedding Project](https://www.wikidata.org/wiki/Wikidata:Embedding_Project) — all ~119M Wikidata entities converted to dense vector embeddings via a free public API. This enables:

1. **"Related Events" in the InfoPanel** — semantically nearest events to whatever the user clicked
2. **Natural language search** — *"revolts against colonial powers"*, *"plagues in the Mediterranean"*
3. **Spatio-temporal + semantic queries** — combine vector distance with viewport/time filters
4. **Auto category outlier detection** — flag miscategorised events by comparing to category centroids

Implementation would use `pgvector` (Postgres extension) with no new infrastructure required.
