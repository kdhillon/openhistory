# Territory Linking System

## Territory Sources

The app supports two territory data sources, controlled by `territorySource` in `App.tsx` (currently hardcoded to `'ohm'`):

- **HB (historical-basemaps)**: GeoJSON polygons from the `territories` table (rolling `year_start`/`year_end` ranges). Served via `GET /api/territories`. GPL-3.0.
- **OHM (OpenHistoricalMap)**: Vector tiles from `vtiles.openhistoricalmap.org`, admin boundaries with day-level precision. CC0.

When `territorySource = 'ohm'`, HB polygon layers (`fills-territory`, `borders-territory`, `labels-territory`) are hidden. Only OHM fills/borders and centroid labels are visible.

## OHM Territory Linking

OHM territories are matched to polities by name (auto-match) or via manual DB links (`ohm_territory_links` table).

**Auto-match**: `rebuildColors()` in `MapView.tsx` runs on `sourcedata`/`moveend` events. It queries rendered OHM features, strips date suffixes (e.g. "French Republic (1800)" → "French Republic"), and matches against polity titles (case-insensitive). Matched territories get colored with the polity's category color.

**Manual DB links**: `ohm_territory_links` table stores `(ohm_name, polity_id, color, explicitly_unlinked)`. Manual links take priority over auto-match. Suppressed names (`explicitly_unlinked=TRUE`) skip auto-match entirely.

**Server endpoints:**
- `POST /api/ohm-territory-links` — save/upsert a manual link
- `DELETE /api/ohm-territory-links?ohm_name=...` — unlink (sets `explicitly_unlinked=TRUE`)

## Polity Label Rendering

Polity names are displayed via two independent label systems:

### 1. Star + Capital Labels (`stars-polity` + `labels-polity` layers)
- Source: `features` GeoJSON source (polity features from `seed.geojson`)
- Rendered at the polity's capital coordinates as a star icon + text label
- Filtered by `_hasTerritory`: if a polity has a visible centroid label (see below), the star label is hidden to avoid duplication
- Filtered by `_minZoom`: zoom threshold based on `sitelinks_count` and polity type

### 2. Centroid Labels (`polity-centroid-labels` layer)
- Source: `polity-centroid-src` GeoJSON source (dynamically computed)
- Rendered at the centroid of each territory's largest polygon
- Computed inside `rebuildColors()` from OHM rendered features
- **Yellow text**: mapped territories (polity name matched or manually linked)
- **Gray text**: unmapped territories (raw OHM `name_en`)
- Visible when "Show territory labels" toggle is **OFF** (default)
- Hidden when "Show territory labels" is ON (OHM's own `ohm-labels` layer shows instead)

### How centroid labels are computed

In `rebuildColors()`:
1. Query all rendered OHM fill features via `queryRenderedFeatures`
2. For each feature, strip date suffix from `name_en`/`name`
3. Check if mapped (manual link or auto-match by polity name)
4. Group by key: polity ID (mapped) or `ohm::{fullName}` (unmapped)
5. For each group, find the polygon ring with the largest area
6. Compute centroid of that ring using `ringCentroid()`
7. Set data on `polity-centroid-src` source

### Star label suppression (`_hasTerritory`)

To avoid showing both a star label and a centroid label for the same polity:
1. `rebuildColors()` builds `centroidPolityIdsRef` — a Set of all polity IDs that have centroid labels, using `polityIdsByName` to handle duplicate polity names (e.g. two "Kingdom of Naples" entries)
2. `rebuildColors()` then calls `updateFilterRef.current()` to re-run the feature filter
3. In `updateFilter()`, `_hasTerritory` is set to `true` if `centroidPolityIdsRef.current.has(p.id)` — this causes the `labels-polity` filter `['!', ['coalesce', ['get', '_hasTerritory'], false]]` to hide the star label

**Timing**: `rebuildColors()` explicitly triggers `updateFilter()` after computing centroid IDs. This eliminates the race condition where `updateFilter()` could run before OHM tiles are loaded.

## Clicking Territories

### OHM polygon click (`ohm-fills` layer)
1. Query all OHM features at click point
2. Resolve each to a polity (manual link → auto-match → unmatched)
3. Matched: open polity info panel (cycles through overlapping polities on repeated clicks)
4. Unmatched: open `OhmMappingModal` via `onOhmTerritoryClick(name, wikidataQid)`

### Centroid label click (`polity-centroid-labels` layer)
1. If `mapped=true`: find polity by title match, open info panel
2. If `mapped=false`: open `OhmMappingModal` via `onOhmTerritoryClick(name, null)`

### Hover × unlink button
Both `ohm-labels` and `polity-centroid-labels` layers support hover:
- Hovering a yellow (mapped) label shows an × button
- Clicking × calls `onUnlinkOhmTerritory(name)` → sets `explicitly_unlinked=TRUE` in DB
- The territory reverts to gray (unmapped) on next `rebuildColors()` cycle

## HB Territory Linking (legacy, still functional)

When `territorySource = 'hb'`, the `territories` table is used:

**DB table**: `territories` — rolling date ranges with `polity_id` (NULL = unmatched), `explicitly_unlinked` flag.

**Assign**: `POST /api/territories/{id}/assign` — body `{ polityId }`. Validates overlap, slices the territory's date range to match the polity, creates gap rows for before/after periods.

**Unlink**: `PATCH /api/territories/{id}/unlink` — sets `explicitly_unlinked=TRUE, polity_id=NULL`.

**Clear polity**: `DELETE /api/territories/by-polity/{polityId}` — NULLs polity_id on all rows for that polity.

**Optimistic UI**: `localMappings` and `localPolygonUnlinks` in App.tsx, applied via `patchedTerritories` memo.
