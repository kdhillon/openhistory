# Polity Parent Linkage & Color Cascade

How polities get colored on the map (and labeled in the InfoPanel) according to which umbrella entity they belong to at the current year — e.g. Saxony renders in German Confederation's color at 1820 because it was P150-linked to the Confederation between 1815–1866.

The system has two halves:

1. **Data side** — a Wikidata-driven backfill that populates a JSONB `parents` column on the `polities` table. Runs at build time (`scripts/backfill-polity-parents.py`) and inline at manual-import time (`POST /api/polities/import-from-wikidata`).
2. **Render side** — a recursive color cascade in `frontend/src/theme/polityPalettes.ts` (`getPolityColorAtYear`), called from both `MapView.tsx` (for polygon fill) and `InfoPanel.tsx` (for the polity-status tag).

Both halves share the same JSON shape on `polities.parents`.

---

## End-to-end data flow

```
   Wikidata SPARQL                        Railway DB                Static asset            Browser
        │                                      │                          │                     │
        │                                      │                          │                     │
   scripts/backfill-polity-parents.py ──writes──▶ polities.parents (JSONB) │                     │
        ▲                                      │                          │                     │
        │                                      │                          │                     │
   pipeline.polity_parents.fetch_parents()     │                          │                     │
                                               │                          │                     │
                              scripts/export_geojson.py ──reads──┐        │                     │
                                                                 ▼        │                     │
                                                  frontend/public/data/seed.geojson             │
                                                                          │                     │
                                                                          │  (Vite build/CDN)   │
                                                                          └────────────────────▶ /data/seed.geojson
                                                                                                │
                                              MapView.rebuildColors ◀──────────────────────────┤
                                              InfoPanel polityStatusTag ◀──────────────────────┤
                                                                                                │
                                              both call getPolityColorAtYear() from
                                              frontend/src/theme/polityPalettes.ts
```

Notes:
- `seed.geojson` is a static file bundled with the Vite build. **Frontend changes only become visible after a deploy.** DB writes alone aren't enough.
- There is one Railway DB; scripts run locally but write to production.

---

## The `parents` JSONB shape

Column added by `db/migrations/022_polity_parents.sql`:

```sql
ALTER TABLE polities ADD COLUMN IF NOT EXISTS parents JSONB;
CREATE INDEX IF NOT EXISTS polities_parents_gin ON polities USING GIN (parents);
```

Each entry:

```json
{
  "qid": "Q151624",
  "yearStart": 1815,
  "yearEnd": 1866,
  "source": "P150"
}
```

Multiple entries per polity are normal — Bavaria can have HRE-era, Confederation-era, and Empire-era links coexisting in the same array. The frontend filters them by current year at render time.

---

## Building `parents`: signals & rules

Implemented in `pipeline/polity_parents.py`. Two key functions:

- `_query_child_side(qids)` — runs one batched SPARQL query per chunk of 100 child QIDs, UNION-ing four signals.
- `fetch_parents(qids, polity_meta)` — orchestrates the batched fetch, applies the registry filter and year intersection, deduplicates by `(child, parent)`, returns the per-child parent list.

### Five Wikidata signals

| Property | Direction | Notes |
|---|---|---|
| **P150** "contains administrative territorial entity" | Parent has P150 → child | Highest priority. Reverse-direction signal; most reliable when curated (e.g. German Confederation Q151624 lists 45 member states). Often missing for poorly-curated parents. |
| **P361** "part of" | Child has P361 → parent | Common forward signal. Sparse for many historical states. |
| **P131** "located in the administrative territorial entity" | Child has P131 → parent | Used widely for historical subdivisions (eyalets, viceroyalties, German Reich states, etc.). |
| **P17** "country" | Child has P17 → parent | Re-included after initial removal — the noise (every coin/village tagged with a country) is eliminated by the registry filter (parent must be a polity). |
| **P127** "owned by" | Child has P127 → parent | Rare. Covers personal-union and ownership cases. |

**Not used:** P31 reverse-class queries (any hardcoded "state of X" umbrella classes) — the registry filter + year intersection achieves the same goal data-driven-ly.

### Source priority (used for dedup and InfoPanel chip selection)

Defined in `pipeline/polity_parents.py:43` and `frontend/src/theme/polityPalettes.ts:78`:

```
P150 (0) > P361 (1) > P131 (2) > P127 (3) > P17 (3 in pipeline / not in frontend ranks)
```

When the same `(child, parent)` pair appears from multiple signals, the highest-priority source wins. When tied, year ranges are widened (`min(starts), max(ends)`).

### Registry filter — the most important hygiene rule

Both child AND parent must be in our `polities` table. This is what eliminates:

- **Sweden → EU**: EU is in our DB (as `polity_type=confederation`), so this is allowed. Sweden has `P150 → Q458 EU` with the qualifier `pq:P580 = 1995`, so at year 1820 it's not active. At year 2020 it would render as "Part of European Union".
- **Coin / village / person noise via P17**: those entities aren't in our polities table, so their P17→country edges never get recorded.
- **Junk QIDs**: any P361/P131 statements pointing at non-polity entities are filtered out.

### Year intersection — the second important rule

Each parent-link entry's year range is the **intersection** of:

1. Parent's lifetime (from `polities.year_start` / `year_end`)
2. Child's lifetime (from `polities.year_start` / `year_end`, falling back to Wikidata's `wdt:P571` inception / `wdt:P576` dissolution if our DB has null)
3. Statement qualifiers `pq:P580` (start time) / `pq:P582` (end time), when present on the statement

If the intersection is empty (`year_start > year_end`), the link is dropped — the relationship can't actually exist at any year.

This rule fixes the "Hamburg → Holy Roman Empire at year 1820" bug: HRE dissolved in 1806, and our DB knows this (Q12548 year_end=1806). Even though Wikidata's `Q1209 Hamburg → P150 → Q7318 Holy Roman Empire` statement has no time qualifier, our intersection clips the parent-link to ≤1806.

---

## Where the backfill runs

| Trigger | What runs | Effect |
|---|---|---|
| Manual: `python3 scripts/backfill-polity-parents.py` | One-shot rewrite of every polity's `parents` column | Use after pipeline changes or when curating |
| `pipeline/post_process.py` | Runs `backfill-polity-parents.py` as a step (alongside sitelinks, category cleanup, export) | Standard post-pipeline workflow |
| `POST /api/polities/import-from-wikidata` (server/main.py) | When a single polity is imported on demand, calls `fetch_parents([qid])` inline so the response includes parents immediately | Avoids waiting for a full backfill |

The bulk script loads `polity_meta = { qid → { year_start, year_end } }` once for all polities and passes it to `fetch_parents`, enabling the registry filter and year intersection in one pass.

---

## GeoJSON export

`scripts/export_geojson.py` reads `polities.parents` and emits it as a property on each polity feature:

```python
"parents": row["parents"] or [],
```

**Important:** the export `WHERE` clause was historically `lng IS NOT NULL ... OR territory OR people` — a "renderable polity" filter. That filter was removed; now **every polity is exported regardless of coordinates**. Polities without `lng/lat` get `geometry: null` (no map dot) but are still in the GeoJSON as **registry entries** that the InfoPanel's twin lookup and the cascade resolver can find.

This is critical for the InfoPanel: when the user clicks an OHM polygon whose QID is a polity without coords (e.g. Colony of Queensland), the frontend needs to find that polity in `geojson.features` to read its parents.

---

## Color cascade (frontend)

Implementation: `frontend/src/theme/polityPalettes.ts:97-129`.

### `getPolityColor(polityKey, polityType, paletteId)` — leaf-level color

Hashes a string key into one of the palette's colors via FNV-1a. Two modes:

- **`polity-type` palette**: returns `CATEGORY_COLORS[polityType]` (deterministic by type — all empires red, all kingdoms blue, etc.).
- **All other palettes** (`muted-classic`, `saturated-retro`, `retro`, `earth-tones`): hashes `polityKey` to a palette index.

The `polityKey` is **the capital city's Wikidata QID when present**, otherwise the polity title. This is what makes Spain / Spanish Empire / Crown of Castile all share a color — they all have Madrid (Q2807) as capital, so they all hash to the same palette index.

### `getPolityColorAtYear(polity, year, paletteId, resolve, findCapitalSibling?, seen?)` — cascade resolution

For a given polity at a given year, recursively walks up the parent chain until it reaches a polity with no active parent, then returns that polity's `getPolityColor(...)`. So all members of a chain converge on the same color.

Resolution order:

1. **Active parent in registry**: `activeParentAt(polity.parents, year)` returns the highest-priority parent active at this year. If `resolve(parent.qid)` finds the parent in the registry, recurse into it.
2. **Capital-sibling fallback** (if `findCapitalSibling` is provided): when the polity has no active direct parent, look for **another polity active at this year sharing the same capital**. If found, follow its cascade. This catches cases like "Fascist Italy" → "Kingdom of Italy" via shared Rome capital, when Wikidata doesn't have a direct P361 link between them.
3. **Cycle protection**: a `seen` set prevents infinite loops (A→B→A). If a cycle is detected, fall back to leaf color.
4. **Leaf**: `getPolityColor(polityKey ?? qid, polityType, paletteId)` — the polity's own color.

`activeParentAt` filters parents by `(yearStart == null || yearStart <= year) && (yearEnd == null || yearEnd >= year)`, sorts by source priority, returns the first match.

### Where the cascade is called

In `MapView.tsx`, the OHM tile color-builder (`rebuildColors`) builds a `polityByQid` registry from `geojson.features`, plus a `polityByCapital` index to support the sibling cascade. For each rendered OHM polygon, it joins via `osm_id → wikidata_qid → polity` and calls:

```ts
getPolityColorAtYear(polity, currentYear, polityPaletteRef.current, resolveByQid, findCapitalSibling)
```

The OHM `fill-color` paint is built as a `['match', name, fullName, color, ..., default]` expression and applied via `setPaintProperty`.

In `InfoPanel.tsx`, the polity-status tag uses the same cascade to compute its background color, so the tag and map fill always match.

### Why the closure-stale-ref pattern matters

`rebuildColors` is defined inside a `useEffect` with `[]` deps (registered once per component lifecycle). Without `currentDateIntRef`, every invocation would read the year from the **first render**, never updating as the timeline scrolls. The fix:

```ts
const currentDateIntRef = useRef(currentDateInt);
currentDateIntRef.current = currentDateInt;
// inside rebuildColors:
const currentYear = decodeDate(currentDateIntRef.current).year;
```

The InfoPanel doesn't need this trick — its body re-runs on every render, and `currentDateInt` is a prop, so the IIFE that computes `polityStatusTag` automatically sees the freshest value.

---

## InfoPanel tag

`frontend/src/components/InfoPanel.tsx` replaces the legacy "polity type" category tag (the `Kingdom` / `Empire` chip) with a year-aware status tag for polity features (and for region features that have a polity twin by `wikidataQid`).

Two states:

| State | Text | Color | Click |
|---|---|---|---|
| Has active parent in registry | "Part of {parent.title}" | Cascade-resolved color | Navigate to parent's card |
| No active parent | Polity type label ("Kingdom", "Empire", "Colony", etc.) | Own cascade color | Open category-reassign picker |

The cascade color is computed via the same `getPolityColorAtYear` path as the map, so they always agree.

### Region twin lookup

When the displayed feature is a `region` (e.g. clicking the Viceroyalty of Peru region card), the InfoPanel looks up a polity with the same `wikidataQid` — the "polity twin" — and reads parents from there. This is necessary because some entities (Viceroyalty of Peru, Colony of Queensland, etc.) end up in **both** tables: the `locations` table classifies them as `region`, and the `polities` table holds the actual political-entity data.

---

## Wiki-link click behavior

In `InfoPanel.tsx`, `handleBodyClick` intercepts wiki-content link clicks:

- Polity/event link with a match in our DB → navigate in-app to that feature.
- Region link with a polity twin → navigate to the polity twin (not the region).
- Region link **without** a polity twin → no intercept; the link opens Wikipedia in a new tab.
- No match → unchanged; opens Wikipedia.

The "region without polity twin → don't intercept" rule was added because navigating to a region card auto-adds the `region` category to `activeCategories`, cluttering the map with region markers the user didn't ask for.

---

## Known gaps & edge cases

### Wikidata curation gaps

- **Bavaria (Q154195) → German Confederation**: Bavaria was a founding Confederation member 1815–1866 but Wikidata has no P150/P361/P131 statement linking them. Renders as "Independent Polity" or "Kingdom" with its own color at 1820.
- **Union of South Africa (Q193619)**: no P17/P361/P131 statements at all on Wikidata. Renders parentless.

The fix is upstream — add the statement on Wikidata; the backfill will pick it up next run.

### Dupe entries (region + polity)

Many entities exist in both `polities` and `locations`. The InfoPanel's twin lookup handles this. The OHM click handler (`resolvePolity` in MapView.tsx) finds the first feature by QID — typically the region (locations are exported first). The InfoPanel then finds the polity twin by QID.

A cleanup pass to deduplicate would simplify this; not done yet.

### Wikidata stubs

When a user clicks an OHM polygon whose `wikidata` QID isn't in our `polities` table (e.g. Kingdom of Brazil Q3932042), MapView synthesizes a stub feature via `makeWikidataStub` and the InfoPanel live-fetches Wikidata for the summary. The stub has no `parents` field — so the cascade can't find a parent and the tag falls back to the polity-type default ("Other").

The fix: import the missing polity. Either via `POST /api/polities/import-from-wikidata`, or by expanding `POLITY_SPARQL_CATEGORIES` in `pipeline/run_polities.py` and re-running.

### Pipeline notability filter

`pipeline/run_polities.py:141-142` requires entities to have an English Wikipedia article (`?article schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>`). This drops ~10–15% of legitimate-but-undocumented entities (Q57676556 "Colony of Western Australia" has zero sitelinks and gets rejected). The manual-import endpoint bypasses this filter.

### Capital cascade is heuristic

The capital-sibling fallback (Fascist Italy → Kingdom of Italy via Rome) is opinionated. It assumes a shared capital implies political continuity. Edge cases:

- Russia / USSR / Russian Empire — Moscow capital for Russia + USSR, but Russian Empire was St. Petersburg. So USSR and modern Russia share color, but Russian Empire is separate.
- Multiple polities sharing a capital but on different political tracks — the resolver prefers the longest-running one.

---

## Operational commands

```bash
# Refresh parents for every polity (uses Railway DB)
source .env && python3 scripts/backfill-polity-parents.py

# Promote orphan dated regions to polities (Lower Canada, Congress Poland, etc.)
source .env && python3 scripts/promote-dated-regions-to-polities.py [--dry-run]

# Bulk import a polity class from Wikidata (e.g. crown colonies)
source .env && python3 -m pipeline.run_polities --categories "crown colony" --direct-p31

# Manual import of a single polity (bypasses pipeline notability filter)
curl -X POST http://localhost:8000/api/polities/import-from-wikidata \
  -H "Content-Type: application/json" \
  -d '{"qid":"Q18348382"}'

# Re-export GeoJSON (after any data change)
source .env && python3 scripts/export_geojson.py

# All-in-one post-pipeline workflow
source .env && python3 -m pipeline.post_process
```

After running any of these locally, deploy (or run your `/deploy` slash command) to make changes visible in production — the static `seed.geojson` is bundled at build time.

---

## File reference

| File | Role |
|---|---|
| `db/migrations/022_polity_parents.sql` | `parents` JSONB column + GIN index |
| `pipeline/polity_parents.py` | Wikidata fetcher: `fetch_parents()` |
| `scripts/backfill-polity-parents.py` | Bulk backfill runner |
| `scripts/promote-dated-regions-to-polities.py` | One-shot script to promote orphan dated regions |
| `pipeline/run_polities.py` | Bulk polity import via SPARQL; has `POLITY_SPARQL_CATEGORIES` |
| `pipeline/post_process.py` | Standard post-pipeline workflow; wires in the backfill |
| `server/main.py` `import_polity_from_wikidata` | Manual-import endpoint; calls `fetch_parents` inline |
| `scripts/export_geojson.py` | Reads `polities.parents`, writes `seed.geojson` |
| `frontend/src/theme/polityPalettes.ts` | `getPolityColor`, `getPolityColorAtYear`, cascade resolvers |
| `frontend/src/components/MapView.tsx` | OHM tile coloring; builds `polityByQid` + `polityByCapital`, calls cascade |
| `frontend/src/components/InfoPanel.tsx` | Polity-status tag; wiki-link click handler |
| `frontend/src/types/index.ts` | `FeatureProperties.parents` declaration |
