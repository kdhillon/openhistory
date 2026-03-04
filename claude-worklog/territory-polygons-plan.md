# Territory Polygons Plan

## Source: `aourednik/historical-basemaps`

- **License**: GPL-3.0
- **Format**: GeoJSON MultiPolygon, WGS 84 (EPSG:4326)
- **Coverage**: 47 snapshots from 123,000 BC to 2010 CE
- **Nearest snapshots for our current data (1730-1830)**:
  - `world_1783.geojson` — post-American Revolution
  - `world_1800.geojson` ← primary for 1790-1810 window
  - `world_1815.geojson` — post-Napoleon
- **Feature properties** per polygon: `NAME`, `ABBREVN`, `SUBJECTO`, `BORDERPRECISION`, `PARTOF`
  - No QIDs or Wikipedia links — matching must be name-based
  - `BORDERPRECISION` 1=approximate, 2=moderate, 3=legally determined
  - All geometries are `MultiPolygon` (even single-island entities)
- **Editor**: QGIS 3.0+ recommended (GeoPackage workflow for edits, then export back to GeoJSON)

---

## Schema (already in DB)

`polity_territories` table:
```sql
id          UUID PK
polity_id   UUID → polities.id
year_start  INT     -- start of interval this boundary is valid for
year_end    INT     -- end of interval (null = still valid / open-ended)
boundary    JSONB   -- GeoJSON geometry (Polygon or MultiPolygon)
source      TEXT    -- 'historical-basemaps:1800', 'manual', etc.
created_at  TIMESTAMPTZ
```

Currently empty. `hasTerritory` is hardcoded `False` in `export_geojson.py`.

---

## Short-Term: 1790–1810 Proof of Concept

### Step 1 — Import script `scripts/import-territories.py`

Write a script with this interface:
```
python3 scripts/import-territories.py --snapshot 1800 [--dry-run]
```

**What it does:**
1. Fetches `world_1800.geojson` from a local copy or directly from GitHub raw URL
2. For each polygon feature, attempts to match `NAME` → a polity in our DB:
   - **Tier 1**: exact case-insensitive match on `polities.name` or `polities.short_name`
   - **Tier 2**: `difflib.SequenceMatcher` ratio ≥ 0.82 (catches "Kingdom of France" vs "France")
   - **Tier 3**: no match → write to `unmatched.json` for manual review
3. For matched polities, INSERTs into `polity_territories`:
   ```python
   {
     "polity_id": matched_polity_id,
     "year_start": snapshot_interval_start,  # 1783 for 1800 snapshot
     "year_end": 1815,                        # next snapshot year
     "boundary": feature["geometry"],         # the GeoJSON geometry as JSONB
     "source": "historical-basemaps:1800",
   }
   ```
4. Prints summary: `N matched, M unmatched` — writes `scripts/territory-unmatched.json`

**Interval logic**: Each snapshot represents the world at that year. The territory from snapshot `S` is valid from the previous snapshot year to the next:
- `world_1800.geojson` → `year_start=1783`, `year_end=1815`
- `world_1815.geojson` → `year_start=1815`, `year_end=1880`

**Polity active period check**: only insert if `polity.year_start ≤ snapshot_year ≤ polity.year_end` (or year_end is null).

### Step 2 — Update GeoJSON export

In `export_geojson.py`:

```python
# After fetching polities, also fetch which polity IDs have territory data
cur.execute("SELECT DISTINCT polity_id FROM polity_territories WHERE boundary IS NOT NULL")
polities_with_territory = {str(row["polity_id"]) for row in cur.fetchall()}
```

Then when building polity features:
- Change `"hasTerritory": False` → `"hasTerritory": str(row["id"]) in polities_with_territory`

Also export territory polygons as a **separate GeoJSON source**. Add to export:
```python
cur.execute("""
    SELECT pt.id, pt.polity_id, pt.year_start, pt.year_end, pt.boundary,
           p.name, p.slug, p.polity_type, p.year_start AS polity_year_start, p.year_end AS polity_year_end
    FROM polity_territories pt
    JOIN polities p ON p.id = pt.polity_id
    WHERE pt.boundary IS NOT NULL
""")
```

Write to `frontend/src/data/territories.geojson` — a separate FeatureCollection where each feature has `featureType: 'polity-territory'`, `polityId`, `politySlug`, `polityType`, `polityYearStart`, `polityYearEnd`, `intervalStart`, `intervalEnd`.

Keeping territories separate from `seed.geojson` prevents the main file from ballooning in size (polygon data is ~10-50× larger than point data).

### Step 3 — MapView rendering

Add a fill layer in `MapView.tsx` using `territories.geojson` as a second source:

```typescript
map.addSource('territories', {
  type: 'geojson',
  data: territoriesGeojson,
});

map.addLayer({
  id: 'fills-polity',
  type: 'fill',
  source: 'territories',
  paint: {
    'fill-color': ['get', '_color'],
    'fill-opacity': 0.25,
  },
}, 'circles-polity');  // render below the ring dots

map.addLayer({
  id: 'fills-polity-border',
  type: 'line',
  source: 'territories',
  paint: {
    'line-color': ['get', '_color'],
    'line-width': 1.5,
    'line-opacity': 0.7,
  },
}, 'circles-polity');
```

Time filter for territory polygons: show when `intervalStart ≤ currentYear ≤ intervalEnd`.

The existing ring layer (`circles-polity`) stays for click detection and labels — just reduce its opacity/size when `hasTerritory = true` to avoid visual clutter.

### Step 4 — Validate and iterate

1. Run import script: `python3 scripts/import-territories.py --snapshot 1800 --dry-run`
2. Review `scripts/territory-unmatched.json` — manually assign any important polities
3. Re-run without `--dry-run`
4. Re-export: `python3 scripts/export_geojson.py`
5. Open the app, advance timeline to 1795–1805 — polity territory fills should appear
6. Open QGIS, connect to PostGIS (`localhost:5433/ourstory`), inspect `polity_territories` — fix any badly matched polygons directly in the DB

---

## Long-Term: All of Human History

### Snapshot inventory

The full historical-basemaps snapshot list (47 files). Key ancient/medieval ones:
```
world_-100000.geojson   (100,000 BC)
world_-3000.geojson     (3000 BC)
world_-1000.geojson     (1000 BC)
world_-323.geojson      (death of Alexander)
world_-200.geojson
world_1.geojson
world_200.geojson
world_400.geojson
world_500.geojson
world_600.geojson
world_700.geojson
world_800.geojson
world_900.geojson
world_1000.geojson
world_1100.geojson
world_1200.geojson
world_1279.geojson      (Mongol Empire peak)
world_1300.geojson
world_1400.geojson
world_1492.geojson
world_1500.geojson
world_1530.geojson
world_1600.geojson
world_1650.geojson
world_1700.geojson
world_1715.geojson
world_1783.geojson
world_1800.geojson  ← current window
world_1815.geojson
world_1880.geojson
... (1900, 1914, 1920, 1930, 1938, 1945, 1960, 1994, 2000, 2010)
```

### Strategy

**For each event data window we add, run the corresponding snapshot(s):**

When we expand pipeline to e.g. 1700-1730, run:
```bash
python3 scripts/import-territories.py --snapshot 1700
python3 scripts/import-territories.py --snapshot 1715
```

The script is idempotent — if a (polity_id, source) row already exists, update rather than insert.

**Interval coverage**: for a polity active 1492–1700, it would get one territory row per snapshot that falls within its active period:
- boundary from 1500 snapshot → interval 1492–1530
- boundary from 1530 snapshot → interval 1530–1600
- boundary from 1600 snapshot → interval 1600–1650
- boundary from 1650 snapshot → interval 1650–1700

The MapView picks the territory row where `intervalStart ≤ currentYear ≤ intervalEnd`.

**Ancient/medieval coverage**: As we expand backwards (e.g. to 1000 CE, 1 CE, etc.), the same pipeline pattern applies. For polities that span large gaps between snapshots (e.g. a polity 1200-1500 has only the 1279, 1300, 1400 snapshots), the territory row for 1200-1279 uses the 1279 snapshot as the best available approximation.

### QGIS Workflow for Custom Edits

For polities not matched by name (e.g. minor kingdoms, tribal confederacies) or where the imported boundary is wrong:

1. Open QGIS → Add PostGIS Layer → connect to `localhost:5433/ourstory`
2. Load `polity_territories` table as an editable layer
3. For existing rows: use Edit → modify polygon vertices
4. For new rows: use Add Feature → draw polygon → fill in `polity_id`, `year_start`, `year_end`, `source='manual'`
5. Save → runs UPDATE/INSERT directly in DB
6. Re-run `python3 scripts/export_geojson.py` to refresh frontend

**Contributing improvements back**: If we correct a historical-basemaps polygon, submit a PR:
1. Export the corrected feature from QGIS as GeoJSON
2. Fork `aourednik/historical-basemaps`, update the relevant `world_YYYY.geojson`
3. Submit PR with description of the correction and source

### File size management

A full territories.geojson for all snapshots would be large. Mitigation options:
- Only export territories for the currently loaded time window (server-side filtering)
- Or: load territories lazily from the server as the user scrubs the timeline
- For now (static GeoJSON): the 1790-1810 window should be manageable (~50-100 polygons)
- Long-term: move to a `/api/territories?year=1800` server endpoint that returns polygons on demand

---

## Files to Create / Modify

| File | Change |
|---|---|
| `scripts/import-territories.py` | New: fetch historical-basemaps snapshot, name-match → polity_territories |
| `scripts/export_geojson.py` | Update `hasTerritory` dynamically; export `territories.geojson` |
| `frontend/src/data/territories.geojson` | New: territory polygon GeoJSON (git-ignored for large builds) |
| `frontend/src/components/MapView.tsx` | Add fills-polity + fills-polity-border layers |
| `frontend/vite.config.ts` | Import `territories.geojson` (same as `seed.geojson`) |
| `frontend/src/App.tsx` | Pass territories data down to MapView |

---

## Contributing Back to historical-basemaps

### Snapshot status tracking

Each `territory_snapshots` row has `imported_count`, `verified_count`, `edited_count`.
A "world status" view shows: for each snapshot year, what % of polygons have been independently reviewed.

Example status dashboard output:
```
1800 snapshot: 52 polygons total — 3 edited, 2 verified, 47 imported (unreviewed)
Last reviewed: 2026-03-05 (USA, France, Spain)
```

### Export-to-PR workflow (future)

When contributing corrections to `aourednik/historical-basemaps`:
- Export only `edited` + `verified` features from the target snapshot year
- Generate a modified `world_YYYY.geojson` replacing only those features in the original
- PR description auto-generated: "Modified N features (edited geometry), confirmed M features (verified correct). Remaining X features are unmodified pass-throughs."
- The maintainer can cherry-pick just the reviewed features without accepting unreviewed pass-throughs

Script idea: `scripts/export-snapshot-pr.py --year 1800 --out world_1800_corrected.geojson`
- Reads original `world_1800.geojson` from historical-basemaps
- Replaces polygons where `accuracy IN ('edited', 'added')` with our version
- Adds a `VERIFIED` property on `accuracy='verified'` features
- Unreviewed (`imported`) features are passed through unchanged with no metadata modification

### Key principle
We are not claiming the whole snapshot is correct — we're claiming specific features within it.
The `accuracy` column makes this explicit at the feature level.

---

## Immediate Next Steps

1. Write migration `db/migrations/010_territory_snapshots.sql`
   - Drop old `polity_territories`
   - Create `territory_snapshots`, `snapshot_polygons`, `territory_name_mappings`
2. Write `scripts/import-territories.py --snapshot 1800 [--dry-run]`
   - Fetch `world_1800.geojson` from historical-basemaps GitHub raw
   - Name-match → `territory_name_mappings`, then → `snapshot_polygons`
   - Dry run: print match rate, write `territory-unmatched.json`
3. Run dry-run, evaluate match quality
4. Update `export_geojson.py` → output `frontend/src/data/territories.geojson`
5. Update `MapView.tsx` → add fill + border layers for polity territories
6. Validate in app: advance timeline to 1795, confirm fills appear
