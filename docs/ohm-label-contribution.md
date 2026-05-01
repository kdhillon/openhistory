# Contributing Territory Labels to OpenHistoricalMap

Research doc for adding historical polity labels to OHM from the OpenHistory UX.

## Key Finding

**Users can add territory labels to OHM without drawing polygons or borders.** OHM supports standalone `place=country` nodes — simple lat/lon points with name and date tags. These appear in the `place_points_centroids` vector tile layer, which OpenHistory already consumes via the `ohm-labels` layer.

## OHM Data Model

OHM is a fork of OpenStreetMap (OSM) with the same data model:
- **Nodes**: points with lat/lon and key-value tags
- **Ways**: ordered sequences of nodes (lines/polygons)
- **Relations**: groupings of nodes/ways/relations (used for complex boundaries)

OHM's extension: **temporal tags** (`start_date`, `end_date`) on every feature.

## How Territory Labels Work in OHM Tiles

Two label sources in the vector tiles:

| Layer | Source | Description |
|---|---|---|
| `place_points_centroids` | Standalone `place=country` nodes | Simple point nodes, no geometry needed. ~660 exist today. |
| `land_ohm_centroids` | Auto-generated from `boundary=administrative` relations | Derived from drawn boundary polygons. |

**`place_points_centroids` is what we want.** It's independent of polygons. Creating a `place=country` node with dates makes it appear in the tiles automatically.

## Required Tags for a Label Node

Example for Safavid Iran:

```xml
<node changeset="123" lat="32.6546" lon="51.6680">
  <tag k="place" v="country"/>
  <tag k="name" v="Safavid Iran"/>
  <tag k="name:en" v="Safavid Iran"/>
  <tag k="name:fa" v="دولت صفوی"/>
  <tag k="start_date" v="1501"/>
  <tag k="end_date" v="1736"/>
  <tag k="wikidata" v="Q170596"/>
  <tag k="wikipedia" v="en:Safavid Iran"/>
</node>
```

Optional: `name:*` translations, `scale_rank`, `source`.

## OHM API

OHM uses the **OSM API v0.6** at `https://www.openhistoricalmap.org/api/0.6/`.

### Authentication
- **OAuth 2.0** required for writes (OAuth 1.0a was shut down June 2024)
- Scope: `write_api`
- Register app at: `https://www.openhistoricalmap.org/oauth2/applications`
- Users need a free OHM account

### Editing Workflow (programmatic)

1. `PUT /api/0.6/changeset/create` — create changeset with XML tags (comment, created_by)
2. `POST /api/0.6/nodes` — create node with lat, lon, changeset ID, and tags
3. `PUT /api/0.6/changeset/#id/close` — close changeset

### Constraints
- Each edit attributed to a real OHM user account (ODbL license)
- 10,000 elements per changeset, auto-closes after 24h or 1h inactivity
- Tiles update within minutes to hours after edits (Martin tile server with materialized views)

## Implementation Plan for OpenHistory

### UX Flow

1. User sees an unlocated polity (or notices a missing label on the map)
2. Clicks "Add to OHM" button
3. Redirected to OHM OAuth2 to authorize OpenHistory (one-time)
4. OpenHistory creates a `place=country` node at the polity's capital coordinates
5. Label appears in OHM tiles after next refresh
6. OpenHistory's existing `ohm-labels` layer picks it up automatically

### Technical Steps

1. **Register OAuth2 app** on openhistoricalmap.org
2. **Add OAuth2 flow** — similar to existing Wikidata OAuth (redirect → authorize → token)
3. **Add "Add to OHM" button** in the Unlocated Polities panel or InfoPanel
4. **Backend endpoint** `POST /api/ohm/create-label` that:
   - Creates a changeset
   - Creates a node with `place=country` + dates + wikidata QID + name translations
   - Closes the changeset
5. **Use polity data** from our DB: name, year_start, year_end, wikidata_qid, capital coords

### What We Already Have
- Polity data with names, dates, Wikidata QIDs, and capital coordinates
- Wikidata OAuth flow (can be adapted for OHM OAuth2)
- OHM tile layer already rendering `place_points_centroids`

### What's Missing from OHM (examples)
- Safavid Iran (1501-1736) — no `place=country` node
- Many other historical polities that exist in our Wikidata-sourced DB but not in OHM

## Existing OHM Editing Tools

- **iD editor**: Web editor at `openhistoricalmap.org/edit` (interactive)
- **JOSM**: Desktop editor with OHM presets
- **API v0.6**: Direct HTTP API for programmatic edits
- **OsmChange XML**: Batch editing via `POST /api/0.6/changeset/#id/upload`

## References

- OHM API: `https://www.openhistoricalmap.org/api/0.6/`
- OAuth2 apps: `https://www.openhistoricalmap.org/oauth2/applications`
- OHM wiki/tagging: `https://wiki.openhistoricalmap.org/`
- OHM GitHub: `https://github.com/OpenHistoricalMap/`
- Vector tiles: `https://vtiles.openhistoricalmap.org/maps/ohm/{z}/{x}/{y}.pbf`
