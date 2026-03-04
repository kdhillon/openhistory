# OurStory — Project Specification
*Last updated: 2026-03-03*

---

## Vision

OurStory is an open-source, interactive historical atlas of human civilization. It overlays curated, Wikipedia-sourced data — events, cities, regions, and sovereign political entities — onto a real-world map with a timeline slider that spans from the earliest human settlements to the present day. Users scroll through history and watch the world change.

Think Google My Maps UI aesthetics + Wikipedia's depth of coverage + the temporal interactivity of a video player.

---

## Guiding Principles

- **Wikipedia as primary source of truth.** All factual data (event dates, locations, summaries, entity names) traces back to Wikipedia/Wikidata. No invented data.
- **OurStory database for original spatial data.** Some data has no Wikipedia equivalent and must live here: polity territory boundaries (polygons), manually-corrected capital coordinates, hand-curated classifications. These are clearly marked and version-controlled.
- **Simplicity first.** Add complexity only after the core experience is solid.
- **Open source, open data.** MIT license. All data pipelines must be reproducible from scratch.
- **Real-world base map.** Overlay on an actual map (satellite, terrain, or road). Not a stylized historical art map.

---

## Source of Truth — Where Does Data Live?

This is the most important architectural question. Different data types have different authoritative sources:

| Data | Source of Truth | Notes |
|---|---|---|
| Event dates, titles, summaries | **Wikipedia / Wikidata** | Pulled at pipeline time, stored in Postgres |
| Event location (city/region/country) | **Wikidata P276 / P17** | Resolved at pipeline time |
| Location coordinates (cities, regions) | **Wikidata P625** | Pulled at pipeline time |
| Polity names, dates, capital names | **Wikipedia / Wikidata** | Pulled by `run_polities.py` |
| Polity capital coordinates | **Wikidata P36 → P625** | Pulled at pipeline time; manually overridable in DB |
| Manual coordinate corrections | **OurStory DB** | Set via pencil UI; `manually_edited_at` flags these rows; survive pipeline re-runs via upsert |
| Polity territory boundaries (polygons) | **OurStory DB** (future) | No Wikipedia equivalent; will live in `polity_territories` table |
| Event categories | **Pipeline classifier + LLM fallback** | Derived, not directly from Wikipedia |

**The rule**: if Wikipedia/Wikidata has the data, we use it and don't maintain our own copy. If it doesn't exist there (e.g. hand-drawn territory polygons), we own it in the OurStory DB and treat it as original data.

Manual edits made via the pencil UI are protected from pipeline re-runs — the upsert logic skips fields with `manually_edited_at` set, or the edit is stored as an override layer.

---

## Architecture

### Stack

```
Frontend
  ├── React + TypeScript (Vite)
  ├── MapLibre GL JS          — map rendering (BSD-2, GPU-accelerated)
  ├── Stadia Maps             — base tiles (road, satellite, terrain toggle)
  └── Static GeoJSON          — frontend/src/data/seed.geojson
                                Re-exported from Postgres after each pipeline run.

Backend
  ├── PostgreSQL 16 (Docker)  — events, locations, polities, pipeline metadata
  └── FastAPI server          — PATCH endpoints for manual corrections

Data Pipeline (local Python)
  ├── pipeline/run_local.py      — SPARQL → Wikidata API → Wikipedia API → Postgres (events + locations)
  ├── pipeline/run_polities.py   — SPARQL → Wikidata API → Wikipedia API → Postgres (polities only)
  ├── pipeline/extract.py        — entity parsing, P31 classifiers, slug generation
  └── pipeline/load_postgres.py  — upsert logic for all three entity types

Export
  └── scripts/export_geojson.py  — Postgres → seed.geojson (all three entity types)
```

### Data flow

```
Wikidata SPARQL  →  QID list
Wikidata API     →  entity JSON (dates, coords, P31, P361, P36, etc.)
Wikipedia API    →  summaries (parallelized, 8 threads)
pipeline/        →  classify, extract, upsert into Postgres
export_geojson   →  Postgres → seed.geojson → frontend serves statically
```

Events + locations and polities are **separate pipelines** run independently:
- `run_local.py` — events and their location entities together (location resolution requires both)
- `run_polities.py` — polities independently (different SPARQL queries, different table)

---

## Database Setup & Repopulation

### Prerequisites
- Docker Desktop running
- Python 3.11+, `psycopg2-binary`, `requests` installed (`pip install -r pipeline/requirements.txt`)

### Starting the database

```bash
docker compose up -d
psql postgresql://ourstory:ourstory@localhost:5432/ourstory -c "\l"
```

Postgres runs at `localhost:5432`, credentials `ourstory/ourstory`, database `ourstory`.

### Schema setup

```bash
psql postgresql://ourstory:ourstory@localhost:5432/ourstory -f db/schema.sql
```

`db/schema.sql` is the single authoritative schema file. All statements use `IF NOT EXISTS`.

### Running the pipelines

```bash
# Events + locations (run multiple times — additive and idempotent)
python3 -m pipeline.run_local --min-year 1750 --max-year 1830

# Polities (run separately, same date window)
python3 -m pipeline.run_polities --min-year 1750 --max-year 1830

# Re-export GeoJSON after any pipeline run
python3 scripts/export_geojson.py
```

Post-processing (run after events pipeline):
```bash
python3 scripts/cleanup-non-settlements.py
python3 scripts/backfill-sitelinks.py
ANTHROPIC_API_KEY=... python3 scripts/fix-empty-categories.py  # run twice
```

---

## Data Models

### Concept Overview — Three Entity Types

OurStory has three distinct entity types. Understanding the difference matters:

| | Events | Locations | Polities |
|---|---|---|---|
| **What** | Things that happened | Places that exist | Sovereign political entities |
| **Examples** | Battle of Waterloo, French Revolution | Paris, Normandy, France | French First Republic, Ottoman Empire |
| **Temporal** | Point-in-time or date range | Founded → dissolved (or present) | Inception → dissolution |
| **Spatial** | Pinned to a location | IS a location (has coords) | Pinned to capital (has coords) |
| **On map** | Solid colored dot | Solid colored dot | Hollow colored ring |
| **DB table** | `events` | `locations` | `polities` |
| **Filter section** | Events | Locations | Polities |

**Key distinction — polities vs locations:**
- `locations` (type `country`) = geographic anchors used to resolve event locations. "France" is a location; it pins Battle of Waterloo to a map coordinate.
- `polities` = time-bounded sovereign states. "French First Republic (1792–1804)" is a polity; it existed for 12 years and then was superseded.
- A polity can reference a matching geographic location via `location_wikidata_qid`, but they are separate records with different purposes.

---

### `events` table

```sql
events (
  id                    UUID         PRIMARY KEY,
  wikidata_qid          TEXT         UNIQUE,
  slug                  TEXT,
  title                 TEXT         NOT NULL,
  wikipedia_title       TEXT         NOT NULL,
  wikipedia_summary     TEXT,
  wikipedia_url         TEXT         NOT NULL,
  year_start            INT,
  month_start           INT,
  day_start             INT,
  year_end              INT,
  month_end             INT,
  day_end               INT,
  date_is_fuzzy         BOOL         DEFAULT false,
  date_range_min        INT,
  date_range_max        INT,
  location_level        TEXT,        -- 'point'|'city'|'region'|'country'|NULL
  location_name         TEXT,
  location_wikidata_qid TEXT,        -- soft ref to locations.wikidata_qid (no FK)
  lng                   FLOAT,       -- only set when location_level='point'
  lat                   FLOAT,
  categories            TEXT[],
  p31_qids              TEXT[],      -- Wikidata P31 (instance-of)
  part_of_qids          TEXT[],      -- Wikidata P361 (part-of), GIN indexed
  sitelinks_count       INT,         -- number of Wikipedia editions (importance signal)
  manually_edited_at    TIMESTAMPTZ,
  data_version          INT,
  pipeline_run          TEXT
)
```

**Location resolution order (pipeline):**
```
P625 on event       → location_level='point',   no QID     (exact coords on event itself)
P276 → city P31     → location_level='city',    QID=P276
P276 → region P31   → location_level='region',  QID=P276
P276 → country P31  → location_level='country', QID=P276
P17  → country      → location_level='country', QID=P17    (country fallback)
nothing             → location_level=NULL                   (stored but not shown on map)
```

---

### `locations` table

```sql
locations (
  id                UUID         PRIMARY KEY,
  wikidata_qid      TEXT         UNIQUE,
  slug              TEXT,
  name              TEXT         NOT NULL,
  wikipedia_title   TEXT,
  wikipedia_summary TEXT,
  wikipedia_url     TEXT,
  lng               FLOAT        NOT NULL,
  lat               FLOAT        NOT NULL,
  founded_year      INT,
  founded_is_fuzzy  BOOL         DEFAULT false,
  founded_range_min INT,
  founded_range_max INT,
  dissolved_year    INT,
  location_type     TEXT         NOT NULL DEFAULT 'city',  -- 'city'|'region'|'country'
  p31_qids          TEXT[],
  data_version      INT,
  pipeline_run      TEXT
)
```

Locations are populated automatically as a side-effect of event resolution. When an event's P276/P17 QID is not yet in the DB, the pipeline fetches and inserts it.

---

### `polities` table

```sql
polities (
  id                    UUID         PRIMARY KEY,
  wikidata_qid          TEXT         UNIQUE,
  slug                  TEXT         UNIQUE NOT NULL,
  name                  TEXT         NOT NULL,
  short_name            TEXT,
  polity_type           TEXT         NOT NULL,  -- see types below
  wikipedia_title       TEXT,
  wikipedia_summary     TEXT,
  wikipedia_url         TEXT,
  year_start            INT,
  year_end              INT,
  date_is_fuzzy         BOOL         DEFAULT false,
  capital_name          TEXT,
  capital_wikidata_qid  TEXT,
  lng                   DOUBLE PRECISION,  -- capital coordinates (always preferred over entity P625)
  lat                   DOUBLE PRECISION,
  preceded_by_qid       TEXT,        -- Wikidata P1365
  succeeded_by_qid      TEXT,        -- Wikidata P1366
  location_wikidata_qid TEXT,        -- soft ref to matching geographic entity in locations
  p31_qids              TEXT[],
  manually_edited_at    TIMESTAMPTZ,
  data_version          INT,
  pipeline_run          TEXT
)
```

**`polity_type` values** (in priority order for classification):
| Type | Description | Color |
|---|---|---|
| `papacy` | Pontificate / papal state | Gold |
| `sultanate` | Sultanate, khanate, emirate, caliphate | Burnt sienna |
| `confederation` | Confederation, league | Deep purple |
| `republic` | Republic, commonwealth | Dark green |
| `empire` | Empire, colonial empire | Deep crimson |
| `kingdom` | Kingdom, realm, monarchy | Midnight blue |
| `principality` | Principality, duchy, vassal state, Indian princely state, HRE state | Dark brown |
| `other` | Real polity but type unresolvable from Wikidata | Blue-grey |

**Coordinate rule**: polities always use capital (P36) coordinates, not the entity's own P625. This ensures e.g. "French colonial empire" shows at Paris rather than a geographic centroid in Africa.

**Capital coordinates are manually overridable** via the pencil UI in the info panel. Corrections are stored directly on the polity record and survive pipeline re-runs (pipeline upserts won't overwrite `manually_edited_at` rows).

---

### `polity_territories` table (empty — future)

```sql
polity_territories (
  id           UUID    PRIMARY KEY,
  polity_id    UUID    NOT NULL REFERENCES polities(id) ON DELETE CASCADE,
  year_start   INT,
  year_end     INT,
  boundary     JSONB,  -- GeoJSON Polygon or MultiPolygon
  source       TEXT    -- 'manual' | 'imported' | 'generated'
)
```

This table is the **first place where OurStory owns original spatial data** with no Wikipedia equivalent. Territory boundaries will be hand-drawn or imported from historical GIS sources and are not derivable from Wikidata. Once populated, polities will switch from hollow ring rendering to filled polygon overlays on the map.

---

### GeoJSON Feature Schema

All three entity types are exported to `seed.geojson` as GeoJSON Features. Common fields:

```typescript
interface FeatureProperties {
  featureType:      'event' | 'city' | 'region' | 'country' | 'polity';
  id:               string;
  slug:             string;
  title:            string;
  wikipediaTitle:   string;
  wikipediaSummary: string;
  wikipediaUrl:     string;
  yearStart:        number | null;
  yearEnd:          number | null;
  dateIsFuzzy:      boolean;
  locationName:     string;
  categories:       Category[];
  primaryCategory:  Category;
  wikidataClasses?: string[];
  yearDisplay:      string;
}
```

**Event-only fields**: `monthStart/End`, `dayStart/End`, `dateRangeMin/Max`, `locationLevel`, `locationSlug`, `partOf`, `partOfResolved`, `sitelinksCount`

**Location-only fields**: `wikidataQid` (used for capital cross-linking from polities), `cityImportance` ('major'|'minor')

**Polity-only fields**: `polityType`, `capitalName`, `capitalWikidataQid`, `precededByQid`, `succeededByQid`, `hasTerritory`

**Implementation note**: MapLibre stores all GeoJSON properties as flat strings. Nested objects like `partOfResolved` arrive as JSON strings at runtime and are parsed defensively in InfoPanel.tsx.

---

## Polity Classification Pipeline

Polities go through a three-tier classification to assign `polity_type`:

**Tier 1 — Direct P31 match**: hardcoded sets of canonical QIDs per type (e.g. Q417175 = historical kingdom → `kingdom`). Fast O(1) lookup.

**Tier 2 — Transitive BFS**: for P31 QIDs not in Tier 1, walks the P279 (subclass-of) hierarchy upward up to 4 levels via the Wikidata API. Resolves things like "constitutional monarchy" → "monarchy" → "kingdom".

**Tier 3 — Name-based fallback**: if Tiers 1+2 yield nothing, scans the entity name for keywords ("Republic of X" → `republic`, "Empire of X" → `empire`, "Duchy of X" → `principality`, etc.).

**Remaining `other`**: entities where all three tiers fail. These are real polities (they passed the sovereign-state gate) but have only generic Wikidata tags like `dynasty` or `historical country` with no keyword in the name. Examples: Qajar Iran, Zand dynasty.

---

## Data Pipeline — Event SPARQL Categories

Each category queries Wikidata for instances/subclasses of a root QID, filtered to the requested date window.

| Label | Root QID |
|---|---|
| conflicts | Q180684 |
| coups | Q45382 |
| elections | Q40231 |
| revolutions | Q10931 |
| treaties | Q131569 |
| assassinations | Q1139665 |
| coronations | Q175331 |
| disasters | Q8065 |
| epidemics | Q3241045 |
| famines | Q168247 |
| massacres | Q3199915 |
| expeditions | Q170584 |
| spaceflights | Q752783 |
| ecclesiastical councils | Q82821 |
| conclaves | Q29102902 |
| founding events | Q17633526 |

**WDQS timeout patterns**: Q1656682 (political event) and Q2085381 (religious event) are too broad for the 60s timeout. Always use narrower subclasses.

---

## Current Data State (as of 2026-03-03, window 1750–1830)

| Entity | Count |
|---|---|
| Events (total) | ~2,125 |
| Events with location | ~1,722 (81%) |
| Events without location | ~403 (stored, not shown on map) |
| Locations | ~742 (578 cities · 60 regions · 104 countries) |
| Polities | 1,275 total · 983 with coordinates |
| GeoJSON features | ~5,363 |

**Polity type breakdown**: principality 525 · kingdom 243 · other 196 · sultanate 145 · republic 76 · confederation 46 · empire 43 · papacy 1

*DB currently contains only 1750–1830 data. Broader date ranges require additional pipeline runs.*

---

## UI / UX

### Map rendering by entity type

| Type | Visual | Visibility rule |
|---|---|---|
| Event | Solid dot, category color | Visible at `yearStart` ± fade window |
| City | Solid blue dot | Visible at `foundedYear`; major cities always shown |
| Region / Country | Solid dot, muted color | Visible at `foundedYear` |
| Polity | **Hollow ring**, type color | Requires both `yearStart` AND `yearEnd`; appears at inception, disappears at dissolution |

### Filter sections

Three independent filter sections in the top nav: **Events** | **Locations** | **Polities**. Each has its own active-category state. Principalities are **off by default** (too numerous and visually noisy).

### Info panel

- **Collapsed**: category tags, title, date range, location/capital, summary snippet, Wikipedia link
- **Expanded**: image carousel, full Wikipedia article (section accordion, History auto-opened), cross-entity navigation links
- **Editable fields**: date (pencil → Wikipedia edit), location (pencil → Wikipedia edit), capital coordinates/name for polities (pencil → direct DB edit via `PATCH /api/polities/{id}`)

---

## Phase Roadmap

| Phase | Key Addition | Status |
|---|---|---|
| 1 | Events + Locations + Timeline + Info panel + Part-of hierarchy | ✅ Complete |
| 1.5 | Polities (sovereign states as first-class entities) | ✅ Complete |
| 2 | Search, pin clustering, territory polygons | 🔄 Next |
| 3 | Historical figures / people | Deferred |
| 4 | Stories (guided narrative tours) | Deferred |
| 5 | Shareable links, embeds, user annotations | Deferred |

### Phase 2 priorities

**Search**: client-side Fuse.js fuzzy search over the loaded GeoJSON. Sufficient for current scale (~5,000–50,000 features). Postgres full-text only needed above ~50,000.

**Territory polygons (SP-8)**: first major OurStory-original dataset. Polities already exist in the DB with the `polity_territories` table schema ready. Needs a polygon editing UI or import from historical GIS sources (GeaCron, Natural Earth historical shapefiles). Rendering switches from hollow ring → filled polygon once `hasTerritory = true`.

**Pin clustering**: MapLibre built-in `cluster` property. Design question: per-featureType clusters vs unified?

### Phase 4 — Stories

A **Story** is a curated, narrated tour through a set of historical events. Think of it as a guided documentary layer over the map — the user presses Play and watches history unfold, event by event, with context provided at each step.

**Core concept**: a Story is an ordered list of *steps*. Each step references one or more features (events, polities, locations) and carries a short annotation written by the story's author. On playback:
1. The timeline seeks to the step's date
2. The map flies to center the relevant feature(s)
3. The annotation text appears in a narration panel (distinct from the info panel)
4. After a dwell time (or on user advance), moves to the next step

**Example — "The French Revolution":**
> *Step 1 (1789): The Estates-General convenes at Versailles* — "For the first time in 175 years, Louis XVI calls together France's three estates to address a fiscal crisis. What begins as a budget meeting will end the monarchy…"
> *Step 2 (1789): Storming of the Bastille* — "On July 14th, Parisian crowds storm the royal fortress. The governor is killed; the Revolution has its first symbolic victory…"
> … 40 more steps through to Napoleon's coronation

**Playback modes to consider:**
- **Auto-play**: steps advance automatically at a configurable pace (1 step / 5 seconds)
- **Manual**: user taps → next step, ← previous step, or clicks directly on map events
- **Timeline-driven**: story plays in sync with the normal timeline slider; annotations surface when the slider crosses each step's date

**Narration panel**: a distinct UI element from the info panel — probably a bottom or left overlay with the step number, annotation text, and prev/next controls. The info panel can still open for a selected feature alongside it.

**Story filtering**: during playback, optionally dim all map features not in the story so the relevant events stand out. Toggle to show full map context.

**Data model (sketch):**
```sql
stories (
  id          UUID PRIMARY KEY,
  slug        TEXT UNIQUE,
  title       TEXT,
  description TEXT,
  author      TEXT,
  created_at  TIMESTAMPTZ
)

story_steps (
  id           UUID PRIMARY KEY,
  story_id     UUID REFERENCES stories(id),
  position     INT,         -- ordering within the story
  feature_id   UUID,        -- nullable; links to an event/polity
  feature_type TEXT,        -- 'event' | 'polity' | 'location'
  annotation   TEXT,        -- the narration text for this step
  year         INT,         -- explicit year override if no feature linked
  lng          FLOAT,       -- map center override (optional)
  lat          FLOAT
)
```

**Open design questions:**
- Who can author stories initially? Probably just the OurStory team for quality control, then opened to users with accounts.
- Does a story need to be exhaustive (every event in the French Revolution) or curated (just the 10 most important)? Probably both modes — exhaustive auto-generated stories from `part_of_qids` groupings, hand-curated stories for narrative quality.
- Can a story be auto-generated? A story for any war could be bootstrapped from all events where `part_of_qids` contains the war's QID, ordered by `year_start`. Author then edits the annotation text.
- Mobile: story playback is especially well-suited to phone UX (swipe to advance).

---

## Open Questions

- **Territory polygon source**: GeaCron vs QGIS shapefiles vs hand-drawn — needs a research spike
- **LLM location enrichment**: ~400 events have no Wikidata location. LLM geocoding from title + summary would close this gap.
- **Location dates**: `founded_year` / `dissolved_year` mostly NULL for pipeline-created locations. Mechanical Wikidata P571/P576 backfill not yet done.
- **Broad date range coverage**: current DB only covers 1750–1830. Expanding to full history requires multiple pipeline passes.

---

## Technical Decisions Log

| Decision | Choice | Rationale |
|---|---|---|
| Mapping library | MapLibre GL JS | BSD-2, TypeScript-native, GPU-accelerated |
| Frontend framework | React + Vite | Component model, fast HMR |
| Base tile provider | Stadia Maps | Free for open-source; satellite + terrain + road |
| Overlay data format | Static GeoJSON | Universal, MapLibre-native; no backend needed at current scale |
| Backend | PostgreSQL 16 (Docker) | Reliable; extensible to PostGIS; reproducible locally |
| Polities vs extending locations | Separate `polities` table | Different schema, different pipeline, different rendering — cleaner separation |
| Polity coordinate rule | Always use capital P36 → P625 | Entity's own P625 often points to wrong geographic centroid |
| Manual edit protection | `manually_edited_at` timestamp | Pipeline upserts can skip manually-edited rows |
| Cloud pipeline | None — local Python | Wikidata API sufficient at current scale; GCP deferred |
| Location FK | Soft `location_wikidata_qid TEXT` | Allows events with unresolved locations to be stored |

---

*This document is the living spec for OurStory. Update it whenever significant architecture decisions are made or the data model changes.*
