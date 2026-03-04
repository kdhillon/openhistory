# Open History

An open-source interactive historical atlas. A real-world map with a timeline slider that lets you scroll through human history — watching events unfold and civilizations rise and fall.

Built with MapLibre GL JS, React, TypeScript, and Wikipedia/Wikidata as the source of truth.

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
DB="postgresql://ourstory:ourstory@localhost:5433/ourstory"
for f in db/migrations/*.sql; do
  echo "Applying $f..."
  PGPASSWORD=ourstory psql -h localhost -p 5433 -U ourstory -d ourstory -f "$f"
done
```

Or apply individually if you need to resume from a specific migration:
```bash
PGPASSWORD=ourstory psql -h localhost -p 5433 -U ourstory -d ourstory \
  -f db/migrations/001_initial_schema.sql
# ... through 010_polity_sovereign.sql
```

### 3. Run the pipeline

```bash
# Events pipeline — fetch from Wikidata + Wikipedia for a date range
python3 -m pipeline.run_local --min-year 1770 --max-year 1820

# Polities pipeline — fetch sovereign political entities for the same range
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
ANTHROPIC_API_KEY=... python3 scripts/fix-empty-categories.py   # assign missing categories
ANTHROPIC_API_KEY=... python3 scripts/quality-check.py --no-fail  # audit data quality
```

### 4. Run the frontend

```bash
cd frontend && npm install && npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### 5. Run the API server (optional — needed for in-app edits)

```bash
cd server && pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

---

## Data Model

All historical data flows from Wikidata + Wikipedia through the pipeline into three Postgres tables, then exported to a single GeoJSON file consumed by the frontend.

### Entity types

| Class | Table | GeoJSON `featureType` | Description |
|---|---|---|---|
| Historical event | `events` | `'event'` | Battles, treaties, disasters, discoveries, etc. |
| Location | `locations` | `'city'` / `'region'` / `'country'` | Geographic anchors used to pin events |
| Polity | `polities` | `'polity'` | Time-bounded sovereign entities (empires, kingdoms, etc.) |

### `events` table

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Primary key |
| `wikidata_qid` | TEXT UNIQUE | Wikidata Q-identifier |
| `slug` | TEXT | Wikipedia title slug (stable public ID) |
| `title` | TEXT | Display title |
| `wikipedia_title` / `_summary` / `_url` | TEXT | Wikipedia content |
| `year_start` / `year_end` | INT | Year range (negative = BCE) |
| `date_is_fuzzy` | BOOL | Approximate date |
| `date_range_min` / `_max` | INT | Plausible year range for fuzzy dates |
| `location_level` | TEXT | `'point'`, `'city'`, `'region'`, `'country'`, or NULL |
| `lng` / `lat` | FLOAT | Direct coords (point-level events only) |
| `location_wikidata_qid` | TEXT | Soft ref to `locations.wikidata_qid` |
| `location_name` | TEXT | Display name of location |
| `categories` | TEXT[] | Event categories (e.g. `['battle', 'war']`) |
| `p31_qids` | TEXT[] | Wikidata P31 (instance-of) QIDs |
| `part_of_qids` | TEXT[] | Wikidata P361 (part-of) parent event QIDs |
| `sitelinks_count` | INT | Wikipedia language editions (importance signal) |
| `data_version` | INT | Pipeline schema version |
| `pipeline_run` | TEXT | Run identifier |

### `locations` table

Referenced softly by `events.location_wikidata_qid` — no FK, so events are never dropped for a missing location.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Primary key |
| `wikidata_qid` | TEXT UNIQUE | Wikidata Q-identifier |
| `slug` | TEXT | Wikipedia title slug |
| `name` | TEXT | Display name |
| `wikipedia_title` / `_summary` / `_url` | TEXT | Wikipedia content |
| `lng` / `lat` | FLOAT | Centroid coordinates |
| `location_type` | TEXT | `'city'`, `'region'`, or `'country'` |
| `founded_year` / `dissolved_year` | INT | Lifespan from Wikidata P571/P576 |
| `p31_qids` | TEXT[] | Wikidata P31 QIDs |

### `polities` table

Time-bounded sovereign political entities — historically specific ("French First Republic 1792–1804", not just "France").

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Primary key |
| `wikidata_qid` | TEXT UNIQUE | Wikidata Q-identifier |
| `slug` | TEXT | URL-safe identifier |
| `name` | TEXT | Display name |
| `polity_type` | TEXT | `empire`, `kingdom`, `principality`, `republic`, `confederation`, `sultanate`, `papacy`, `other` |
| `wikipedia_title` / `_summary` / `_url` | TEXT | Wikipedia content |
| `year_start` / `year_end` | INT | Active period |
| `capital_name` | TEXT | Capital city name |
| `capital_wikidata_qid` | TEXT | Capital city QID (cross-links to locations) |
| `lng` / `lat` | FLOAT | Representative point (capital coordinates) |
| `preceded_by_qid` / `succeeded_by_qid` | TEXT | Succession chain QIDs |
| `sovereign_qids` | TEXT[] | P17/P361 suzerain/parent polity QIDs |
| `p31_qids` | TEXT[] | Wikidata P31 QIDs |

Rendered as **hollow rings** on the map, distinct from solid event/location dots. The related `polity_territories` table (schema exists, currently empty) will hold time-varying polygon boundaries once the territory editor is built.

### Location resolution (events → map coordinates)

1. **Point** — event has its own P625 coordinates → `location_level = 'point'`
2. **P276 city/region/country** — event's P276 QID resolves to a location record
3. **P17 country fallback** — event's P17 (country) QID → `location_level = 'country'`
4. **Unlocated** — no location data → stored but not shown on map

---

## Post-pipeline workflow

After each `run_local` or `run_polities` run:
1. `python3 scripts/cleanup-non-settlements.py` — removes rivers, palaces, etc. misclassified as locations
2. `python3 scripts/backfill-sitelinks.py` — populates `sitelinks_count` for zoom filtering
3. `python3 scripts/export_geojson.py` — regenerates `frontend/src/data/seed.geojson`

Or run all three: `python3 -m pipeline.post_process`

---

## Project Spec

See [ourstory-spec.md](./ourstory-spec.md) for the full project design.

---

## Future: Semantic Search via Vector Embeddings

> Out of scope for now. Captured here for reference.

In October 2025, **Wikimedia Deutschland + Jina AI** launched the [Wikidata Embedding Project](https://www.wikidata.org/wiki/Wikidata:Embedding_Project) — all ~119M Wikidata entities converted to dense vector embeddings via a free public API. This enables:

1. **"Related Events" in the InfoPanel** — 6 semantically nearest events to whatever the user clicked
2. **Natural language search** — *"revolts against colonial powers"*, *"plagues in the Mediterranean"*
3. **Spatio-temporal + semantic queries** — combine vector distance with viewport/time filters
4. **Auto category outlier detection** — flag miscategorised events by comparing to category centroids
5. **Fill summaryless events** — use Wikidata entity descriptions as fallback for ~2,370 events without Wikipedia summaries

Implementation uses `pgvector` (already a Postgres extension) with no new infrastructure.
