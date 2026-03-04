# Territory Borders — Architecture Brainstorm
*Saved 2026-03-03 — do not lose this context*

---

## Core concept

Polities need time-varying territory polygons. A polity's border at 1807 is different from 1812. The data model is: a sorted sequence of polygon "snapshots", each valid from a start date until the next snapshot's start date.

---

## DB Schema

```sql
polity_territories (
  id                UUID PRIMARY KEY,
  polity_id         UUID NOT NULL REFERENCES polities(id) ON DELETE CASCADE,

  -- Day-level precision, matching events table convention
  date_start_year   INT NOT NULL,
  date_start_month  INT,          -- NULL = year-only precision
  date_start_day    INT,          -- NULL = year or month precision

  date_end_year     INT,          -- optional explicit override
  date_end_month    INT,
  date_end_day      INT,

  boundary     geometry(MultiPolygon, 4326) NOT NULL,
  label        TEXT,              -- e.g. "After Treaty of Tilsit"
  source       TEXT DEFAULT 'manual',  -- 'manual' | 'naturalearth' | 'geacron'
  notes        TEXT
)

-- Indexes
CREATE INDEX ON polity_territories (date_start_year, date_start_month, date_start_day);
CREATE INDEX ON polity_territories USING GIST (boundary);  -- for future bbox queries
```

### year_end is optional / implicit
Each segment's effective end = next segment's `date_start` (for same polity).
`date_end_*` is only set when territory explicitly disappears before the next segment
(e.g. a ceded region with no replacement polygon).

### Precision
Stored at whatever precision the historical record supports — day, month, or year.
Matches events table convention (`year_start`, `month_start`, `day_start` as separate
nullable INT columns). Some territory changes have exact treaty dates (Treaty of Tilsit:
July 7, 1807); those get day precision. Others just have a year.

---

## API

Uses the same encoded dateInt format the frontend timeline already speaks:
`encodeDate(year, month, day) = (year + 10000) * 10000 + month * 100 + day`

```
GET /api/territories?date_min=120070101&date_max=120150101&simplification=medium
```

SQL:
```sql
SELECT
  p.slug AS politySlug,
  p.polity_type AS polityType,
  pt.date_start_year, pt.date_start_month, pt.date_start_day,
  pt.date_end_year, pt.date_end_month, pt.date_end_day,
  pt.label,
  ST_AsGeoJSON(
    ST_SimplifyPreserveTopology(pt.boundary, :tolerance)
  ) AS geometry
FROM polity_territories pt
JOIN polities p ON p.id = pt.polity_id
WHERE encode_date(pt.date_start_year, pt.date_start_month, pt.date_start_day) <= :date_max
  AND (
    pt.date_end_year IS NULL
    OR encode_date(pt.date_end_year, pt.date_end_month, pt.date_end_day) >= :date_min
  )
```

Simplification tolerances:
- `coarse` → 1.0° (~100km) — overview mode, 100yr+ steps
- `medium` → 0.1° (~10km) — normal browsing, 1–10yr steps
- `fine`   → 0.01° (~1km) — zoomed in, month/day steps

---

## Sliding Window Architecture (shared with events)

Both events and territories use the same pattern:

```typescript
function computeWindow(currentYear: number, stepSize: number) {
  if (stepSize >= STEP_YEAR * 100) return { halfWidth: 500, simplification: 'coarse'  };
  if (stepSize >= STEP_YEAR * 10)  return { halfWidth: 100, simplification: 'medium'  };
  if (stepSize >= STEP_YEAR)       return { halfWidth:  25, simplification: 'medium'  };
  if (stepSize >= STEP_MONTH)      return { halfWidth:   3, simplification: 'fine'    };
  /* day */                        return { halfWidth:   1, simplification: 'fine'    };
}
```

On each `currentDateInt` change:
1. Still inside active window? → do nothing (just update MapLibre `setFilter()`)
2. Approaching edge (within ~20%)? → prefetch adjacent window in background
3. Jumped outside window? → fetch new window, replace source

### Boundary-crossing optimization
On window load, extract and sort all `date_start` encoded values from returned features.
Binary search this list on every tick. **Only call `map.setFilter()` when crossing a
boundary.** Between boundaries, skip all work. Especially important at day/month granularity.

---

## Rendering

- Separate MapLibre source from `seed.geojson` / events source
- `fill` + `line` layer pair (fill interior + border stroke)
- Layer toggle: "Show Territories" button (lazy-load on first enable)
- Time filter via `map.setFilter()` expression — GPU-side, no JS loop:
  ```js
  map.setFilter('territories-fill', [
    'all',
    ['<=', ['get', '_dateStartInt'], currentDateInt],
    ['any',
      ['!', ['has', '_dateEndInt']],
      ['>=', ['get', '_dateEndInt'], currentDateInt],
    ],
  ]);
  ```
  (where `_dateStartInt` / `_dateEndInt` are precomputed encoded integers stored as properties)

---

## What to build first

**Prototype with events** (see events API prototype doc) — validate the sliding window
pattern, settings toggle (GeoJSON mode vs API mode), window sizing, and boundary-crossing
optimization using the simpler point-feature case before tackling polygon geometry.

Once events API mode is proven, territories follow the same pattern with:
- Different source/layer types (fill instead of circle/symbol)
- PostGIS simplification at query time
- The `polity_territories` table populated via manual editing UI or historical GIS import
