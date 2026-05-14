# OpenHistory

An open-source interactive atlas of human history.

**Live at [openhistory.app](https://openhistory.app)**

Built with MapLibre GL JS, React, TypeScript, FastAPI, and PostgreSQL. Polities and events sourced from [Wikidata](https://www.wikidata.org); territory boundaries from [OpenHistoricalMap](https://www.openhistoricalmap.org).

---

## Data Sources

### Territory Boundaries — OpenHistoricalMap

Territory boundaries (the shaded regions on the map) come from [OpenHistoricalMap](https://www.openhistoricalmap.org) (OHM), a community-driven project that maps historical boundaries with day-level precision (CC0). A territory is linked to a polity when its OHM relation carries a `wikidata=Q…` tag pointing at the matching Wikidata entity — when that link exists, the boundary, the label, and the polity card all refer to the same entity, and colors propagate across the parent hierarchy.

Anyone can contribute boundary edits directly on the OHM website and they appear here automatically on the next tile refresh.

### Events, Locations & Polities — Wikipedia / Wikidata

The ground truth for all events, locations, and political entities is [Wikipedia](https://www.wikipedia.org) and its structured data layer, [Wikidata](https://www.wikidata.org) (CC BY-SA). The pipeline queries the Wikidata SPARQL API to fetch:

- **Events** — battles, elections, treaties, disasters, discoveries, etc., each with a date and location
- **Locations** — cities, regions, and countries referenced by events
- **Polities** — kingdoms, empires, republics, colonies, viceroyalties, indigenous nations, peoples, and other political entities. They may have founding/dissolution dates and a capital, and can be linked to a territory via the OHM `wikidata` tag.

### Parent Polity Linkage

Polities know their **parent state** at each point in time (e.g. Saxony → German Confederation 1815–1866, Viceroyalty of Peru → Spanish Empire). This is derived from Wikidata signals (P150, P361, P131, P127, P17) with year-range intersection so links are temporally accurate. Multiple parents over time are supported.

The color cascade reflects this hierarchy: child polities render in the same color as their umbrella entity at the current timeline year. See [`docs/polity-parent-coloring.md`](docs/polity-parent-coloring.md) for details.

---

## Contributing Data

### Editing Events, Locations & Polities

When you correct a date or location for an event, location, or polity, that change is submitted **directly to Wikidata** — it improves the source data for everyone, not just OpenHistory. To make edits you need a free [Wikimedia account](https://www.mediawiki.org/wiki/Special:CreateAccount). Click any feature on the map, then use the edit button in the info panel to log in and submit a correction.

### Tagging Territories with their Polity

A territory appears in **grey** when its OHM boundary isn't yet tagged with a Wikidata QID. The fix lives on OpenHistoricalMap itself — add a `wikidata=Q…` tag to the relation and OpenHistory will pick it up on the next tile refresh:

1. Find the territory on [openhistoricalmap.org](https://www.openhistoricalmap.org) and open it in the iD editor
2. Look up the matching Wikidata entity (e.g. on [wikidata.org](https://www.wikidata.org)) to get its Q-ID
3. Add a `wikidata` tag with that Q-ID to the OHM relation, and save

You'll need a free [OpenHistoricalMap account](https://www.openhistoricalmap.org/user/new) (OSM-style login). An in-app one-click tagging flow is planned but not live yet.

### Editing Territory Boundaries

Boundary *shapes* (where a territory's edges lie) are edited on OpenHistoricalMap itself — they're not stored in OpenHistory. Open the territory on [openhistoricalmap.org](https://www.openhistoricalmap.org) in OHM's iD editor and adjust the polygon vertices. Edits propagate to OpenHistory on OHM's next tile refresh.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React 18, TypeScript, Vite, MapLibre GL JS |
| Backend | FastAPI (Python), PostgreSQL 16 (Railway-hosted) |
| Data | Wikidata SPARQL, Wikipedia REST API, OHM Overpass + vector tiles |
| Map | OpenFreeMap basemap tiles |
| Infrastructure | Railway (DB + production hosting) |

---

## Status

The core map, data pipeline, and deployment are working. Current focus is expanding data coverage, polishing the polity-cascade UX, and adding the in-app OHM tagging flow.

### Recent work (May 2026)

- **Polity parent linkage** — every polity knows its umbrella entity at the relevant year (German Confederation, Spanish Empire, etc.); child polygons inherit parent color
- **Capital-city color grouping** — Spain / Spanish Empire / Crown of Castile all share a color via shared Madrid capital
- **OHM direct integration** — vector tiles + OAuth scaffolding (one-click tagging in progress)
- **Importance-driven label sizing** — bigger labels for more globally significant polities
- **Promoted orphan dated regions** — Lower Canada, Congress Poland, Captaincy of Venezuela, etc. now first-class polities

### Open items

- In-app one-click OHM tagging flow (OAuth is wired, the write path isn't live yet)
- Manual override registry for Wikidata curation gaps (e.g. Bavaria has no Wikidata link to the German Confederation)
- Natural language search over events/polities (likely via [Wikidata Embeddings](https://www.wikidata.org/wiki/Wikidata:Embedding_Project) + pgvector)
- Polity succession chain (`preceded_by_qid` / `succeeded_by_qid` are stored but not surfaced in the UI)

---

## Getting Started (Development)

### Prerequisites
- Node.js 20+
- Python 3.10+
- PostgreSQL client (`psql`)

### 1. Database connection

OpenHistory uses a hosted PostgreSQL database on [Railway](https://railway.app). There is no local database — all scripts read `DATABASE_URL` from the environment.

```bash
cp .env.example .env
# Fill in DATABASE_URL with your Railway Postgres URL
# Add ANTHROPIC_API_KEY if you want to use LLM category assignment
source .env
```

### 2. Apply schema migrations

```bash
source .env
for f in db/migrations/*.sql; do
  echo "Applying $f..."
  psql "$DATABASE_URL" -f "$f"
done
```

Migrations are in `db/migrations/` and numbered sequentially. They are idempotent (`IF NOT EXISTS`, `ON CONFLICT`, etc.) so re-running is safe.

### 3. Run the pipeline (optional — production DB already has data)

```bash
# Events
python3 -m pipeline.run_local --min-year 1770 --max-year 1820
# Polities
python3 -m pipeline.run_polities --min-year 1770 --max-year 1820
# Post-processing: cleanup, parent backfill, sitelinks, GeoJSON export
python3 -m pipeline.post_process
```

### 4. Run the frontend

```bash
cd frontend && npm install && npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The Vite dev server proxies `/api` to `localhost:8000`.

### 5. Run the API server (needed for in-app edits)

```bash
source .env && uvicorn server.main:app --reload --port 8000
```

---

## Data Model

All historical data flows from Wikidata / OHM through the pipeline into Postgres, then exported to GeoJSON files consumed by the frontend.

### Entity types

| Class | Table | GeoJSON `featureType` | Description |
|---|---|---|---|
| Historical event | `events` | `event` | Battles, treaties, disasters, etc. |
| Location | `locations` | `city` / `region` | Geographic anchors used to pin events |
| Polity | `polities` | `polity` | Time-bounded political entities (empires, kingdoms, colonies, etc.) |
| Territory polygon | — (served as OHM vector tiles) | — | Boundary shapes; linked to polities via OHM's `wikidata` tag |

### `polities` table

Time-bounded political entities — historically specific ("French First Republic 1792–1804", not just "France"). Each row has:

- `wikidata_qid` — Wikidata Q-identifier (unique)
- `polity_type` — `empire` / `kingdom` / `principality` / `republic` / `confederation` / `sultanate` / `papacy` / `colony` / `people` / `other`
- `year_start` / `year_end` — active period
- `capital_name` / `capital_wikidata_qid` — capital city (used for the color-cascade fallback)
- `lng` / `lat` — representative point (capital coordinates)
- `preceded_by_qid` / `succeeded_by_qid` — succession chain
- `parents` — JSONB array of `{qid, yearStart, yearEnd, source}` entries describing each parent at each time slice (see [`docs/polity-parent-coloring.md`](docs/polity-parent-coloring.md))

### `events` table

| Column | Type | Description |
|---|---|---|
| `wikidata_qid` | TEXT UNIQUE | Wikidata Q-identifier |
| `title` | TEXT | Display title |
| `year_start` / `year_end` | INT | Year range (negative = BCE) |
| `date_is_fuzzy` | BOOL | Approximate date |
| `location_level` | TEXT | `point`, `city`, `region`, `country`, or NULL |
| `lng` / `lat` | FLOAT | Direct coords (point-level events only) |
| `location_wikidata_qid` | TEXT | Soft ref to `locations.wikidata_qid` |
| `categories` | TEXT[] | e.g. `['battle', 'war']` |
| `part_of_qids` | TEXT[] | Wikidata P361 (part-of) parent event QIDs |
| `sitelinks_count` | INT | Wikipedia language editions (importance signal for zoom-aware label sizing) |

### Location resolution (events → map coordinates)

1. **Point** — event has its own P625 coordinates → `location_level = 'point'`
2. **P276** — event's P276 (location) QID resolves to a location record
3. **P17 fallback** — event's P17 (country) QID → `location_level = 'country'`
4. **Unlocated** — no location data → stored but not shown on map

---

## Further Reading

- [`docs/polity-parent-coloring.md`](docs/polity-parent-coloring.md) — full reference for the polity parent-linkage and color cascade system
- [`docs/data-sources.md`](docs/data-sources.md) — data-source details (licensing, refresh cadence)
- [`docs/territory-linking.md`](docs/territory-linking.md) — territory ↔ polity linking semantics

---

## License

- **Code** — MIT
- **Event / location / polity data** — CC BY-SA (Wikidata / Wikipedia contributors)
- **Territory boundaries** — CC0 (OpenHistoricalMap contributors)
- **Basemap tiles** — © [OpenFreeMap](https://openfreemap.org)

Found a bug or have an idea? Open an issue or pull request on [GitHub](https://github.com/kdhillon/openhistory/issues).
