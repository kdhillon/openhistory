# OurStory — Project Specification
*Last updated: 2026-03-01*

---

## Vision

OurStory is an open-source, interactive historical atlas of human civilization. It overlays curated, Wikipedia-sourced data — events, cities, and eventually kingdoms, empires, and nations — onto a real-world map with a timeline slider that spans from the earliest human settlements to the present day. Users scroll through history and watch the world change.

Think Google My Maps UI aesthetics + Wikipedia's depth of coverage + the temporal interactivity of a video player.

---

## Guiding Principles

- **Wikipedia as source of truth.** All data traces back to Wikipedia/Wikidata. No invented data.
- **Simplicity first.** Start with the simplest possible data type (point events + cities). Add complexity only after the core experience is solid.
- **Open source, open data.** MIT license. All data pipelines should be reproducible.
- **Real-world base map.** Overlay on an actual map (satellite, terrain, or road). Not a stylized historical art map.
- **My Maps visual language.** Styled pins, polygons, paths on a real-world map — exactly the visual paradigm of Google My Maps.

---

## Phase 1 Scope

Phase 1 delivers the minimal end-to-end experience:

- **Events**: Wikipedia-sourced historical events, each pinned to a location, displayed as styled markers on the map, filterable by category, visible at the correct year on the timeline.
- **Cities**: Wikipedia-sourced cities with founding dates, displayed as styled markers.
- **Timeline**: A bottom-anchored time slider spanning from earliest human civilization (~10,000 BCE) to present day. Year-granularity at minimum; scroll step adjustable up to 100-year increments. Playback mode (auto-advance at set speed).
- **Info panel**: Clicking any marker opens a panel with the Wikipedia summary (first section) and a link out to the full Wikipedia article.
- **Category filters**: Events filterable by category tag.

Explicitly out of scope for Phase 1:
- Historical borders / territory polygons
- Kingdoms, empires, nations as entities
- Historical figures / people
- Trade routes, migration paths, religious spread
- User accounts, user-contributed data
- Shareable links, embeds
- Search

---

## Architecture

### High-Level Stack

```
Frontend (TypeScript)
  ├── MapLibre GL JS          — map rendering engine
  ├── Stadia Maps / Maptiler  — base tile provider (satellite + road + terrain)
  └── Custom time-slider UI   — bottom bar, playback controls

Backend (optional in Phase 1, needed at scale)
  └── PostgreSQL              — events, cities, metadata
      (PostGIS research deferred to sub-project)

Data Pipeline (GCP)
  └── Wikipedia dump processing → structured event/city records
      (separate sub-project)
```

### Why MapLibre GL JS

MapLibre GL JS is the open-source community fork of Mapbox GL JS, released under BSD-2-Clause. It is:
- Written in TypeScript, ships full type declarations
- GPU-accelerated (WebGL2/WebGPU) — handles thousands of animated overlay features
- Vector-tile native — works with Stadia Maps, Maptiler, and self-hosted OpenMapTiles
- Style-expression driven — data-driven styling per feature, analogous to KML StyleUrl patterns
- The closest open-source equivalent to Google Maps JS API's overlay system

Alternatives considered and rejected:
- **Mapbox GL JS v2+**: Proprietary license, mandatory telemetry, incompatible with open source
- **Leaflet**: DOM/SVG-based, performance degrades above ~1,000–2,000 features, no native TypeScript
- **Google Maps JS API**: Proprietary SaaS, billing required, cannot be self-hosted by users
- **OpenLayers**: Viable alternative, stronger OGC/GIS compliance, but more verbose API and less elegant style system for this use case

If performance becomes a bottleneck at very large feature counts, **deck.gl** can be layered on top of MapLibre as a WebGL2/WebGPU rendering overlay without replacing the base map setup.

### Base Tile Provider

Use **Stadia Maps** (free tier: unlimited for open-source) or **Maptiler** (free tier: 100,000 tile requests/month).

Styles needed:
- **Road/political** (default): `Stadia Alidade Smooth` or `Maptiler Streets`
- **Satellite**: `Stadia Alidade Satellite`
- **Terrain**: `Stadia Stamen Terrain`

User can toggle base map style. This mirrors the Google My Maps multi-view behavior.

---

## Data Models

### Event

```typescript
interface HistoricalEvent {
  id: string;                    // UUID
  title: string;                 // e.g. "Battle of Thermopylae"
  wikipedia_title: string;       // Wikipedia article title (for link + summary fetch)
  wikipedia_summary: string;     // First section of Wikipedia article, cached
  wikipedia_url: string;         // Full URL

  // Temporal
  year_start: number;            // Start year (negative = BCE). Required.
  year_end: number | null;       // End year, null if instantaneous
  date_is_fuzzy: boolean;        // True if dates are estimated/approximate
  date_range_min: number | null; // Estimated earliest possible year (fuzzy events)
  date_range_max: number | null; // Estimated latest possible year (fuzzy events)

  // Spatial
  // Exactly one of coordinates or location_id will be set, depending on location_level.
  location_level: 'point' | 'city' | 'country' | 'region';
  coordinates: [number, number] | null; // Set only when location_level = 'point'
  location_id: string | null;           // FK to City (or future Country/Region entity) when location_level != 'point'
  location_name: string;                // Human-readable location name (denormalized for display)

  // Classification
  categories: string[];          // e.g. ["battle", "politics", "religion"]

}
```

**Note on location assignment**: Events sourced from Wikipedia rarely have structured location data. An LLM pipeline will assign `location_level` and either `coordinates` (for point events) or `location_id` (for city/country/region events) from the event description and Wikipedia metadata. This is a dedicated sub-project (see SP-2).

### City

```typescript
interface City {
  id: string;
  name: string;
  wikipedia_title: string;
  wikipedia_summary: string;
  wikipedia_url: string;

  coordinates: [number, number];  // [longitude, latitude]

  founded_year: number | null;    // Year city was founded (negative = BCE)
  founded_is_fuzzy: boolean;
  founded_range_min: number | null;
  founded_range_max: number | null;

  dissolved_year: number | null;  // Year city ceased to exist (if applicable)
}
```

### Timeline State

```typescript
interface TimelineState {
  current_year: number;      // Active year shown on map
  step_size: number;         // Years per slider tick (1–100)
  is_playing: boolean;       // Playback mode active
  playback_speed: number;    // Years per second during playback
}
```

---

## Map Overlay Data Model (My Maps Style)

The visual overlay system mirrors Google My Maps' KML/GeoJSON data model.

**Key insight from My Maps research**: My Maps stores overlays as KML `<Folder>` → `<Placemark>` structures with shared `<Style>` definitions. All styling is data-driven per feature. This maps cleanly onto MapLibre GL JS's GeoJSON source + layer expression system.

### Internal Data Format: GeoJSON

All overlay data is stored and transmitted as **GeoJSON FeatureCollections**. KML is used as an import/export format only (relevant for Phase N: allowing users to import My Maps exports).

Each GeoJSON feature carries styling properties that MapLibre expressions consume:

```typescript
// Point feature (Event or City marker)
{
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: {
    id: "uuid",
    featureType: "event" | "city",
    name: "Battle of Thermopylae",
    markerScale: 1.0,
    year: -480,
    // ... other event fields
  }
}
```

### KML Color Format (for future import/export)

KML uses **AABBGGRR** hex (reversed from CSS). Critical conversion:

```typescript
// CSS #FF0000 (red), opacity 0.35 → KML "590000ff"
function hexToKml(hex: string, opacity: number): string {
  const a = Math.round(opacity * 255).toString(16).padStart(2, '0');
  const r = hex.substring(1, 3);
  const g = hex.substring(3, 5);
  const b = hex.substring(5, 7);
  return `${a}${b}${g}${r}`.toLowerCase();
}
```

### MapLibre Layer Definitions

```typescript
// Event/City markers
map.addLayer({
  id: 'markers',
  type: 'circle',
  source: 'overlay',
  filter: ['==', ['geometry-type'], 'Point'],
  paint: {
    'circle-color': ['match', ['get', 'primaryCategory'], /* category → color map defined in theme config */
      'battle', '#DB4436',
      'politics', '#4285F4',
      'discovery', '#0F9D58',
      /* ... */
      '#9E9E9E' /* default */
    ],
    'circle-radius': ['*', ['get', 'markerScale'], 8],
    'circle-stroke-color': '#ffffff',
    'circle-stroke-width': 1.5,
  }
});

// Future: Polygon territories
map.addLayer({
  id: 'polygons-fill',
  type: 'fill',
  source: 'overlay',
  filter: ['==', ['geometry-type'], 'Polygon'],
  paint: {
    'fill-color': ['get', 'fillColor'],
    'fill-opacity': ['get', 'fillOpacity'],
  }
});

map.addLayer({
  id: 'polygons-stroke',
  type: 'line',
  source: 'overlay',
  filter: ['==', ['geometry-type'], 'Polygon'],
  paint: {
    'line-color': ['get', 'strokeColor'],
    'line-width': ['get', 'strokeWeight'],
    'line-opacity': ['get', 'strokeOpacity'],
  }
});
```

---

## UI / UX Design

### Layout

```
┌─────────────────────────────────────────────────────────┐
│  [OurStory]          [Map Style ▼]  [Filters ▼]         │  ← top nav bar
├─────────────────────────────────────────────────────────┤
│                                                         │
│                                                         │
│              MapLibre GL Map                            │
│         (full viewport, real-world)                     │
│                                                         │
│   ● Event/City markers overlaid on map                  │
│                                                         │
│                                                         │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  ◀◀  ▶  [━━━━━━━━●━━━━━━━━━━━━━━━━━━━]  10,000 BCE  ▶▶ │  ← timeline bar
│  Step: [1yr ▼]                                          │
└─────────────────────────────────────────────────────────┘
```

When a marker is clicked, an info panel slides up from the right (or bottom on mobile):

```
┌──────────────────────────────────┐
│  Battle of Thermopylae      [✕]  │
│  480 BCE · Battle · Greece       │
│                                  │
│  [Wikipedia summary text, first  │
│   section, 2–4 sentences]        │
│                                  │
│  [→ View on Wikipedia]           │
└──────────────────────────────────┘
```

### Timeline Bar

- **Scrubbing**: Drag the thumb to any year
- **Year display**: Always visible, formatted as "480 BCE" or "1453 CE"
- **Step size selector**: Dropdown — 1yr, 5yr, 10yr, 25yr, 50yr, 100yr. Controls how far one tick-step moves the slider.
- **Playback**: Play/pause button. When playing, the year advances at `playback_speed` years/second. Default: 10 years/second. Speed can be adjusted.
- **Keyboard**: Arrow keys step by current step size

### Map Interaction

- **Click marker**: Open info panel
- **Hover marker**: Tooltip with event/city name + year
- **Map base style toggle**: Road / Satellite / Terrain (top-right)
- **Zoom/pan**: Standard MapLibre behavior

### Category Filters

A filter dropdown shows all event categories. Each category has a color dot. Users can show/hide categories. Active filters persist across timeline scrubbing.

---

## Date Handling

The timeline spans approximately **-10000 to 2025** (year 0 exists — we use astronomical year numbering where year 0 = 1 BCE for simplicity in arithmetic, with display converting to BCE/CE).

```typescript
function displayYear(year: number): string {
  if (year < 0) return `${Math.abs(year)} BCE`;
  if (year === 0) return '1 BCE';  // or display as year 0 — TBD
  return `${year} CE`;
}
```

Fuzzy dates are stored as `year_start` (best estimate), `date_range_min`, `date_range_max`. The UI shows the best-estimate year; a tooltip or detail panel shows the range.

Events with `date_is_fuzzy = true` appear on the timeline at `year_start` and are shown with a visual indicator (e.g. slightly different pin style or a "~" prefix on the year display).

---

## Sub-Projects

These are identified work streams that are separate design and implementation projects, organized by type and the order in which they should be tackled.

---

### Frontend / UX (Phase 1 — Build This First)

#### SP-0: UX — Interactive Historical Map Viewer
**Goal**: Build the full Phase 1 frontend experience — a real-world map with a time-slider and styled event/city markers.

**Deliverables**:
- MapLibre GL JS map (full viewport) with Stadia Maps base tiles (road, satellite, terrain toggle)
- Event and city markers rendered as styled circle pins, color-driven by category via MapLibre `match` expression
- Time slider (bottom bar): scrubbing, year display (BCE/CE + Year 0), step size selector (1/5/10/25/50/100 yr), playback mode with adjustable speed, keyboard arrow key support
- Click-to-open info panel: Wikipedia summary + link, event title, year, location name, category tags
- Category filter controls (show/hide by category)
- Fuzzy date visual indicator on markers and in the info panel

**Stack**:
- TypeScript
- MapLibre GL JS
- Stadia Maps (maintainer API key, no user account required)
- Framework TBD (React recommended for component model; to be confirmed before build starts)
- No backend required for Phase 1 if seeded with a static dataset (e.g. Histography); swap to Postgres API when pipeline data is ready

**Data contract**: Consumes a GeoJSON FeatureCollection of events and cities. Fields per feature defined in the data models section. Can be seeded from a static JSON file initially.

**Key design constraints**:
- Overlapping pins are acceptable for Phase 1 — no clustering required
- Snap (not animate) between time steps
- Info panel content is Wikipedia summary cached at pipeline time — no live API calls
- All styling derived from category; no per-feature color stored in data

**Open questions for this sub-project**:
- React vs another framework?
- Where does the category→color theme config live (constants file, CSS variables, MapLibre style JSON)?
- Mobile layout — is it in scope for Phase 1?

---

### Data & Research (Do First)

#### SP-1: Histography Dataset Research
**Goal**: Determine if Histography's event dataset is publicly available and usable as a bootstrap.
- Histography (histography.io) has a curated set of Wikipedia-sourced historical events with years, already categorized
- **Questions**: Is the dataset downloadable? What license? What's the coverage (years, event types)?
- **Opportunity**: Could seed the database and inform the event taxonomy before the full Wikipedia pipeline is built — do this first

#### SP-2: Wikipedia Data Pipeline (GCP)
**Goal**: Parse a Wikipedia dump and extract structured event and city records at scale.
- **Input**: Wikipedia XML dump (~22GB compressed) or Wikidata JSON dump
- **Output**: Postgres tables for events and cities
- **Technology**: GCP (Dataflow / Dataproc / BigQuery public Wikipedia dataset)
- **Open questions**:
  - BigQuery public Wikipedia dataset vs raw dump processing
  - Wikidata for structured facts (coordinates, dates) + Wikipedia for summaries
  - How to identify "event" articles vs other article types
- **Note**: This is the largest sub-project. Probably a Spark or Beam pipeline on GCP Dataproc.
- **Dependency**: SP-1 informs scope and may reduce the work needed here

---

### AI / ML Pipelines (After Data Is Available)

#### SP-3: Event Categorization
**Goal**: Define a taxonomy of event categories and classify all events.
- **Input**: Large sample of Wikipedia historical events (from SP-1 or SP-2)
- **Output**: Category taxonomy (10–30 top-level categories) + per-event category tags
- **Approach**: Exploratory analysis of real event distribution → LLM classification at scale
- **Examples**: Battle, Treaty, Discovery, Natural Disaster, Political Change, Cultural Event, Exploration, Scientific Achievement
- **Dependency**: Needs SP-1 or SP-2 output to explore real event distribution

#### SP-4: LLM Location Assignment Pipeline
**Goal**: Assign `location_level` and either `coordinates` (point events) or `location_id` (city/country/region events) to every extracted event.
- **Input**: Event title, Wikipedia summary text, Wikipedia categories
- **Output**: Location level + coordinates or location FK + location name
- **Approach**: LLM (Claude API) with geocoding fallback (Nominatim / Google Geocoding)
- **Open questions**:
  - Confidence scoring — when to flag for human review
  - Batch processing cost at scale (millions of events)
  - Handling events with genuinely no single location (e.g. "Age of Enlightenment")
- **Dependency**: Needs SP-2 output; SP-3 category tags may improve location inference

---

### Infrastructure (As Needed)

#### SP-5: PostGIS Evaluation
**Goal**: Determine whether PostGIS spatial extensions are needed vs plain Postgres.
- **Questions**:
  - Can viewport queries be handled with simple lat/lng range queries on a plain Postgres index?
  - When does PostGIS become necessary (territory polygons, spatial overlap queries)?
- **Likely answer**: Plain Postgres is sufficient for Phase 1 point features. PostGIS becomes necessary when territory polygons are added in Phase 2.
- **Timing**: Evaluate before Phase 2 begins

---

### Phase 2+ Features (Deferred)

#### SP-6: Historical Borders & Territory Polygons
**Goal**: Add kingdom/empire/nation territory polygons to the map, changing over time.
- **Data sources to evaluate**:
  - GeaCron (existing historical border dataset — slow/outdated UI but may have usable data)
  - QGIS historical shapefiles
  - Wikipedia-derived descriptions + LLM polygon generation (last resort)
- **Vector data format**: GeoJSON polygons with `year_start`/`year_end` properties
- **MapLibre rendering**: `fill` + `line` layers with data-driven style expressions (see KML polygon style model)
- **Note**: Hardest technical and data problem in the project. Do not start until Phase 1 is stable.

#### SP-7: Kingdoms / Empires / Nations as Entities
**Goal**: Model political entities as first-class objects with lifespans, not just events pinned to locations.
- **Data model**: Entity with `name`, `year_start`, `year_end`, `type` (kingdom/empire/nation/city-state), Wikipedia link, territory polygon FK
- **UX**: Clicking a territory polygon shows the entity info panel
- **Dependency**: Requires SP-6

#### SP-8: Historical Figures / People
**Goal**: Add notable historical people as entities — birthplace pin, lifespan on the timeline.
- **Deferred**: People introduce significant complexity (multiple locations over a lifetime, relevance filtering at scale)
- **Future design questions**: Do people move on the map during their lifetime? What notability threshold determines inclusion?

---

## Future Phases (High Level)

| Phase | Key Addition |
|---|---|
| Phase 1 | Events + Cities + Timeline slider |
| Phase 2 | Territory polygons for major empires (SP-4 + SP-6) |
| Phase 3 | Historical figures / people (SP-7) |
| Phase 4 | Trade routes, migration paths, religious spread as path overlays |
| Phase 5 | Shareable links, embeds, user annotations |
| Phase N | Full self-serve "My Maps"-style editing layer |

---

## Technical Decisions Log

| Decision | Choice | Rationale |
|---|---|---|
| Mapping library | MapLibre GL JS | BSD-2, TypeScript-native, GPU-accelerated, closest open-source analog to Google Maps |
| Base tile provider | Stadia Maps (primary) | Free for open-source, satellite + terrain + road styles |
| Overlay data format | GeoJSON | Universal, MapLibre-native, extensible |
| KML | Import/export only | My Maps compatibility for Phase N |
| KML color format | AABBGGRR | OGC standard, not CSS RGBA — document carefully to avoid bugs |
| Timeline granularity | Year (Phase 1) | Sufficient for most historical data; sub-year deferred |
| Year 0 display | "Year 0" | Astronomcial year 0 displayed as "Year 0", not "1 BCE" |
| Date arithmetic | Astronomical year (0-indexed) | Simplifies math; display layer converts to BCE/CE |
| Wikipedia summary caching | Pipeline-time (Postgres) | Faster UX, no live API dependency; acceptable staleness for historical data |
| Tile provider API key | Maintainer-held Stadia account | Users need no account; maintainer holds API key. No self-hosted fallback needed. |
| Repo structure | Monorepo | Single repo for frontend, backend, and pipeline |
| Backend | PostgreSQL | Reliable, well-known, extensible to PostGIS |
| Cloud provider (pipeline) | GCP | Public Wikipedia BigQuery dataset available; natural fit |
| Language | TypeScript (full stack) | Single language, strong typing |

---

## Open Questions (Unresolved)

- **Event density UX**: At high zoom-out with many events in one region, overlapping pins may become hard to read. Address if it becomes a real problem post-launch.

---

*This document is the living spec for OurStory. Update it as decisions are made and sub-projects are clarified.*
