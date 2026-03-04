# OurStory — Data Pipeline Research & Plan
*Written: 2026-03-01*

---

## Research Summary

### SP-1: Histography — DEAD END

Histography.io is not usable as a bootstrap dataset:

- The creator (Matan Stauber) never open-sourced the data or code. His GitHub repo is empty.
- No API, no download, no license.
- Even if it were available, it would be the wrong starting point: **Histography has no coordinates or location data** — it is purely temporal. All events are year-positioned only.
- Categories: War, Inventions, Disasters, Politics, Riots, Literature, Art, Music, Women's Rights — these are useful as taxonomy inspiration but nothing more.

**Decision: Skip SP-1 entirely. Go directly to the primary pipeline.**

---

### What the Research Found

#### Wikidata: The Right Primary Source

Wikidata is the correct and complete primary data source. Key facts:

- **~2 million event-type entities** exist in Wikidata (items whose P31 "instance of" value is anywhere in the subclass tree of Q1190554 "occurrence").
- **Key event properties:**
  - `P31` — instance of (gives event category/type, e.g. "battle", "election")
  - `P585` — point in time (single-point events)
  - `P580` / `P582` — start time / end time (multi-day events)
  - `P276` — location (links to a place entity)
  - `P625` — coordinate location (direct lat/lon)
  - `sitelinks.enwiki.title` — the English Wikipedia article title
- **Key event class hierarchy** (root → subclasses):
  - `Q1190554` — occurrence (top-level, ~2M items)
  - `Q13418847` — historical event ("incident that brings about historical change")
  - `Q1656682` — event (scheduled/temporary happening)
  - `Q178561` — battle
  - `Q198` — war
  - `Q40231` — public election
  - `Q124490` — natural disaster
  - `Q273120` — protest
  - + thousands more subclasses

#### SPARQL Is Not Viable for Bulk Extraction

The Wikidata SPARQL public endpoint has a **hard 60-second timeout**. The query `?event wdt:P31/wdt:P279* wd:Q1190554` — which retrieves all ~2M events — reliably times out. OFFSET/LIMIT pagination doesn't work at this scale (the underlying query must complete before OFFSET applies).

**SPARQL is useful only for taxonomy queries** (enumerating event subclass QIDs), which are small and fast.

#### The Wikidata JSON Dump Is the Path Forward

- URL: `https://dumps.wikimedia.org/wikidatawiki/entities/latest-all.json.bz2`
- Size: ~100 GB compressed (bz2), ~1.2 TB uncompressed
- Updated **weekly**
- Format: one JSON entity per line, streamable without full decompression
- Process with `qwikidata` (Python) or `wikibase-dump-filter` (Node.js CLI)

#### Wikipedia Summaries: DBpedia Short Abstracts or CirrusSearch

Two options for getting clean article summaries (the `wikipedia_summary` field in our data model):

**Option A — DBpedia Short Abstracts (Recommended)**
- Pre-extracted first paragraph of every Wikipedia article, already plain text
- Available from DBpedia Databus as RDF/CSV, ~3.8 GB compressed
- No wikitext parsing required

**Option B — Wikipedia CirrusSearch Dumps**
- Pre-parsed Elasticsearch bulk-insert JSON from `dumps.wikimedia.org/other/cirrussearch/`
- Each document includes `source_text` (rendered plain text) and `category` (as a structured JSON array)
- Heavier than DBpedia abstracts but includes more metadata

**Decision: Use DBpedia short abstracts for summaries. CirrusSearch is a fallback if DBpedia coverage proves incomplete.**

**BigQuery Wikipedia Public Dataset — NOT Useful**
The `bigquery-public-data.wikipedia` dataset contains **no article text**. It is revision history metadata and pageview traffic only. Skip this path.

#### GCP Processing: Dataproc (Spark) over Dataflow (Beam)

For our batch processing workload:
- **Dataproc with PySpark** is the right choice: Spark-XML for structured XML reading, full Python NLP ecosystem access, preemptible VMs for 60-80% cost savings on one-off runs, NDJSON read natively via `spark.read.json()`.
- Dataflow (Beam) is better suited for real-time streaming pipelines. Not what we need.
- **Dataproc Serverless** (serverless Spark) is a good middle ground for infrequent bulk runs.

#### Reference Implementation: EventKG

EventKG (github.com/sgottsch/eventkg) is an 8-step open-source pipeline that extracts events from Wikidata, DBpedia, YAGO, and Wikipedia event lists. Its architecture is the closest existing analog to what we're building and should be studied before we write our own pipeline.

---

## Architecture Decision

**Primary extraction source:** Wikidata JSON dump
- Gives us: event identity, structured dates, coordinates, location FK, event type/category (via P31)
- This is the authoritative structured layer

**Summary source:** DBpedia short abstracts
- Gives us: pre-rendered first-paragraph summaries
- Joined to Wikidata events via shared Wikipedia article title

**Category source:** Wikidata P31 hierarchy
- We map Wikidata event types → our OurStory category taxonomy
- No separate categorization LLM pipeline needed for typed events
- LLM categorization fallback only for events using the generic Q1190554/Q13418847 class directly

**Location source:** Wikidata P625 (direct coords) + P276 (location entity → resolve to coords)
- LLM location assignment (SP-4) needed only for events missing both P625 and P276

---

## Data Pipeline Plan

### Pipeline Architecture: Two-Tier Design

The pipeline is split into two tiers to avoid re-scanning the 100 GB dump every time a new entity type is added (events now, people/kingdoms/cities later).

```
Tier 1 (expensive, weekly):  Dump (100 GB) → structural filter → spatiotemporal-entities (~10 GB, GCS)
Tier 2 (cheap, per-type):    spatiotemporal-entities → event filter   → events NDJSON
                              spatiotemporal-entities → people filter  → people NDJSON   (Phase 3)
                              spatiotemporal-entities → polity filter  → kingdoms NDJSON (Phase 2)
```

**Tier 1** filters by *having spatiotemporal properties* — not by entity type. This captures everything OurStory could ever need in a single dump scan. **Tier 2** applies entity-type-specific logic to the small intermediate file. Adding a new entity type = a new Tier 2 job, no new dump scan.

---

### Step 0: Taxonomy Enumeration (SPARQL, one-time, ~5 min)

Query Wikidata SPARQL to get every QID that is a subclass of Q1190554 (occurrence). Used by the Tier 2 event filter.

```sparql
SELECT ?class ?classLabel WHERE {
  ?class wdt:P279* wd:Q1190554 .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
```

Output: `event_classes.json` — a set of QIDs like `{Q178561, Q198, Q13418847, ...}`. Expected size: 5,000–50,000 class QIDs.

Re-run periodically (monthly) as new event subclasses are added to Wikidata.

---

### Step 1: Download Wikidata Dump (weekly, ~100 GB)

```bash
wget https://dumps.wikimedia.org/wikidatawiki/entities/latest-all.json.bz2 \
  -P gs://ourstory-data/wikidata/
```

On GCP: store directly in Cloud Storage (GCS). Do not download locally.

---

### Step 2: Download DBpedia Short Abstracts (~3.8 GB)

```bash
wget https://databus.dbpedia.org/dbpedia/text/short-abstracts/2022.09.01/short-abstracts_lang=en.ttl.bz2 \
  -P gs://ourstory-data/dbpedia/
```

Parse to produce a lookup table: `{ wikipedia_title → summary_text }` stored as NDJSON.

---

### Step 3: Tier 1 — Structural Filter (Dataproc, ~2–4 hours, weekly)

Stream the full dump; keep all entities that have **any spatiotemporal property** and an English Wikipedia sitelink. Entity-type-agnostic — captures events, people, cities, kingdoms, anything OurStory might ever need.

```python
# PySpark pseudocode
import json

TEMPORAL_PROPS = {'P585', 'P580', 'P582', 'P569', 'P570', 'P571', 'P576'}
# P585=point in time, P580=start, P582=end, P569=birth, P570=death,
# P571=inception, P576=dissolved

SPATIAL_PROPS = {'P625', 'P276'}
# P625=coordinate location, P276=location (entity)

def has_spatiotemporal_data(entity_json):
    entity = json.loads(entity_json)
    if entity.get('type') != 'item':
        return False
    if 'enwiki' not in entity.get('sitelinks', {}):
        return False  # no English Wikipedia article — skip
    claims = entity.get('claims', {})
    has_time = any(p in claims for p in TEMPORAL_PROPS)
    has_space = any(p in claims for p in SPATIAL_PROPS)
    return has_time or has_space

raw = spark.read.text("gs://ourstory-data/wikidata/latest-all.json.bz2")
filtered = raw.filter(lambda row: has_spatiotemporal_data(row.value))
filtered.write.mode("overwrite").parquet("gs://ourstory-data/intermediate/spatiotemporal-entities/")
```

Output: `spatiotemporal-entities.parquet` in GCS. Estimated **5–15 GB** (down from 100 GB). This file is the shared input for all Tier 2 jobs.

**Note on the enwiki filter:** Dropping entities without an English Wikipedia sitelink excludes Wikidata-only items (no article). This is acceptable for Phase 1 since we need `wikipedia_summary`. Remove this filter in a future pass if we want Wikidata-only events.

---

### Step 3b: Tier 2 — Event Filter (cheap, reads from Step 3 output)

Apply entity-type-specific logic to the small intermediate file:

```python
# Broadcast the event class set from Step 0
event_classes = spark.sparkContext.broadcast(load_event_classes())

def is_event_entity(entity_json):
    entity = json.loads(entity_json)
    claims = entity.get('claims', {})
    p31_values = {
        s['mainsnak']['datavalue']['value']['id']
        for s in claims.get('P31', [])
        if s.get('mainsnak', {}).get('snaktype') == 'value'
    }
    return bool(p31_values & event_classes.value)

entities = spark.read.parquet("gs://ourstory-data/intermediate/spatiotemporal-entities/")
events = entities.filter(lambda row: is_event_entity(row.value))
events.write.mode("overwrite").json("gs://ourstory-data/intermediate/events-raw/")
```

**Future Tier 2 jobs (same pattern, different filter):**
- **People** (Phase 3): `P31 = Q5` (human) + has P569 (birth date)
- **Kingdoms/Empires** (Phase 2): `P31 ∈ polity subclass tree` (Q6256=country, Q208176=kingdom, Q108762=empire, etc.) + has P571/P576
- **Cities** (Phase 1): `P31 ∈ city/settlement subclass tree` (Q515=city, Q1549591=big city, etc.) + has P625

Output: ~2M event entities as NDJSON in GCS. Estimated size: ~10–20 GB.

---

### Step 4: Structured Extraction (Dataproc, ~1–2 hours)

For each event entity, extract the fields our data model requires:

```python
def extract_event(entity_dict):
    claims = entity_dict.get('claims', {})
    sitelinks = entity_dict.get('sitelinks', {})

    def get_time(prop):
        """Returns (time_string, precision) or (None, None)"""
        stmts = claims.get(prop, [])
        for s in stmts:
            snak = s.get('mainsnak', {})
            if snak.get('snaktype') == 'value':
                v = snak['datavalue']['value']
                return v.get('time'), v.get('precision')
        return None, None

    def get_coord():
        stmts = claims.get('P625', [])
        for s in stmts:
            snak = s.get('mainsnak', {})
            if snak.get('snaktype') == 'value':
                v = snak['datavalue']['value']
                return v.get('latitude'), v.get('longitude')
        return None, None

    def get_item(prop):
        stmts = claims.get(prop, [])
        for s in stmts:
            snak = s.get('mainsnak', {})
            if snak.get('snaktype') == 'value':
                return snak['datavalue']['value'].get('id')
        return None

    point_time, point_prec = get_time('P585')
    start_time, start_prec = get_time('P580')
    end_time, end_prec = get_time('P582')
    lat, lon = get_coord()

    enwiki_title = sitelinks.get('enwiki', {}).get('title')
    p31_values = [s['mainsnak']['datavalue']['value']['id']
                  for s in claims.get('P31', [])
                  if s.get('mainsnak', {}).get('snaktype') == 'value']

    return {
        'wikidata_qid': entity_dict['id'],
        'label_en': entity_dict.get('labels', {}).get('en', {}).get('value'),
        'wikipedia_title': enwiki_title,
        'wikipedia_url': f"https://en.wikipedia.org/wiki/{enwiki_title.replace(' ', '_')}" if enwiki_title else None,
        'p31_qids': p31_values,              # raw type QIDs, mapped to categories in SP-3
        'point_in_time': point_time,          # ISO-like Wikidata time string e.g. "+1066-10-14T00:00:00Z"
        'point_in_time_precision': point_prec, # 9=year, 10=month, 11=day
        'start_time': start_time,
        'end_time': end_time,
        'lat': lat,
        'lon': lon,
        'location_qid': get_item('P276'),    # FK to a place entity (city, country, etc.)
        'country_qid': get_item('P17'),
    }
```

**Wikidata time string parsing:**
Wikidata encodes dates as strings like `+1066-10-14T00:00:00Z` (precision=11, day) or `-0480-00-00T00:00:00Z` (year only, precision=9). Negative year = BCE. Year 0 in Wikidata = 1 BCE in proleptic Gregorian.

```python
def parse_wikidata_time(time_str, precision):
    """Returns (year, month, day, is_bce, is_fuzzy)"""
    if not time_str:
        return None, None, None, False, True
    sign = -1 if time_str.startswith('-') else 1
    parts = time_str.lstrip('+-').split('T')[0].split('-')
    year = sign * int(parts[0])
    month = int(parts[1]) if precision >= 10 else None
    day = int(parts[2]) if precision >= 11 else None
    is_fuzzy = precision < 9  # decade or century precision
    return year, month, day, year < 0, is_fuzzy
```

Output: `events-structured.parquet` in GCS. Schema matches our `HistoricalEvent` TypeScript interface.

---

### Step 5: Join with DBpedia Abstracts (Dataproc, ~30 min)

```python
# Join structured events with DBpedia short abstracts on wikipedia_title
events_df = spark.read.parquet("gs://ourstory-data/intermediate/events-structured/")
abstracts_df = spark.read.json("gs://ourstory-data/dbpedia/abstracts-en.ndjson")
    # columns: wikipedia_title, summary_text

enriched = events_df.join(abstracts_df, on="wikipedia_title", how="left")
```

After this step, events that have an English Wikipedia article will have a summary. Events that don't (Wikidata-only items with no Wikipedia article) will have `summary = null`.

---

### Step 6: Category Mapping (SP-3)

Map Wikidata P31 type QIDs → OurStory categories. Two-layer approach:

**Layer 1: Static mapping table** (covers ~90% of typed events):
```python
WIKIDATA_TO_CATEGORY = {
    # Military
    'Q178561': 'battle',      # battle
    'Q198':    'war',         # war
    'Q188055': 'battle',      # skirmish
    'Q831663': 'battle',      # naval battle
    # Politics
    'Q40231':  'politics',    # election
    'Q49773':  'politics',    # summit meeting
    'Q1781513':'politics',    # coup d'état
    'Q167466': 'politics',    # assassination
    # Natural disasters
    'Q124490': 'disaster',    # natural disaster
    'Q7944':   'disaster',    # earthquake
    'Q8092':   'disaster',    # flood
    'Q8928':   'disaster',    # volcanic eruption
    # Discovery / Exploration
    'Q43229':  'discovery',   # discovery (generic)
    'Q2678658':'discovery',   # scientific discovery
    'Q2685356':'exploration', # exploration
    # Religion / Culture
    'Q2085381':'religion',    # religious event
    'Q959583': 'culture',     # cultural event
    # Generic fallback
    'Q13418847': None,        # "historical event" — needs LLM (Layer 2)
    'Q1190554':  None,        # "occurrence" — needs LLM (Layer 2)
}
```

**Layer 2: LLM classification** for events where Layer 1 returns `None` (events typed only as generic "historical event" or "occurrence"):
- Input: event title + Wikipedia summary
- Classify into OurStory taxonomy (battle, war, politics, discovery, disaster, religion, culture, exploration, science, trade, migration)
- Run as batch job via Claude API; estimated ~100K–200K events need this

---

### Step 7: Location Enrichment (SP-4)

After Step 4, events fall into three location buckets:

| Bucket | Condition | Action |
|---|---|---|
| **Have coords** | `lat` and `lon` not null | ✓ Done |
| **Have location QID, no coords** | `location_qid` not null, no coords | Resolve QID → coordinates via Wikidata entity lookup (batch API calls) |
| **No location data** | Both null | LLM location assignment |

**Bucket 2 — Resolve location QIDs to coordinates:**
Most cities and place entities in Wikidata have P625 directly on them. Batch-fetch the coordinates for all distinct `location_qid` values via the Wikidata API.

```python
import requests

def resolve_location_batch(qids: list[str]) -> dict[str, tuple[float, float]]:
    """Returns {QID: (lat, lon)} for all QIDs that have P625."""
    qid_str = "|".join(qids[:50])  # API limit: 50 per request
    resp = requests.get("https://www.wikidata.org/w/api.php", params={
        "action": "wbgetentities",
        "ids": qid_str,
        "props": "claims",
        "format": "json"
    })
    result = {}
    for qid, entity in resp.json().get("entities", {}).items():
        p625 = entity.get("claims", {}).get("P625", [])
        if p625:
            v = p625[0]["mainsnak"]["datavalue"]["value"]
            result[qid] = (v["latitude"], v["longitude"])
    return result
```

**Bucket 3 — LLM location assignment:**
For events with no location data at all, use Claude to assign location from event title + summary text.

```
Prompt: "Given this historical event, provide the most specific geographic location where it occurred.
Event: {title}
Summary: {summary}

Return JSON: { "location_name": string, "lat": float, "lon": float, "confidence": "high|medium|low", "level": "point|city|country|region" }
If no location can be determined, return null."
```

Run as batch processing with Claude API. Estimate: ~500K–1M events need LLM assignment. At batch pricing, budget ~$50–200 depending on prompt/output token counts.

**Important:** Location QID resolution (Bucket 2) must run first, as it dramatically reduces the LLM workload.

---

### Step 8: Load to PostgreSQL

After all enrichment, write the final dataset to the OurStory Postgres database:

```sql
-- Final insert (simplified)
INSERT INTO events (
    wikidata_qid, title, wikipedia_title, wikipedia_summary, wikipedia_url,
    year_start, year_end, date_is_fuzzy,
    date_range_min, date_range_max,
    location_level, coordinates, location_id, location_name,
    categories
)
SELECT ...
FROM staging.events_enriched;
```

---

## Incremental Update Strategy

The full dump is ~100 GB and takes hours to process. For ongoing freshness:

- **Weekly full re-run:** Download the latest weekly dump, reprocess everything. Acceptable for an open-source project where data freshness is measured in weeks, not minutes.
- **Wikidata RecentChanges API:** Poll `https://www.wikidata.org/w/api.php?action=query&list=recentchanges` for new/edited event entities since last run. Process only changed items. Feasible as a daily Cloud Function.

---

## Scale Estimates

| Metric | Estimate |
|---|---|
| Total Wikidata event entities | ~2,000,000 |
| Events with English Wikipedia sitelink | ~1,200,000 |
| Events with dates (P585 or P580/P582) | ~800,000 |
| Events with direct coordinates (P625) | ~300,000 |
| Events with location QID (P276) | ~500,000 |
| Events needing LLM location assignment | ~600,000–1,000,000 |
| Events needing LLM categorization | ~200,000 |

After enrichment, expected deliverable:
- ~800K events with dates + locations in the database
- ~1.2M events with dates, some without location (shown on timeline, not on map)

---

## Tooling Summary

| Purpose | Tool |
|---|---|
| Event class taxonomy | SPARQL via Wikidata Query Service |
| Wikidata dump download | `wget` / `gsutil cp` |
| Wikidata dump processing | `qwikidata` (Python), or PySpark `spark.read.json()` |
| Bulk filtering | `wikibase-dump-filter` (Node.js CLI) |
| Wikipedia summaries | DBpedia short abstracts (pre-extracted) |
| GCP batch processing | Dataproc (PySpark), preemptible VMs |
| Category mapping | Static QID→category table + Claude API batch |
| Location assignment | Wikidata API batch + Claude API batch |
| Reference architecture | EventKG (github.com/sgottsch/eventkg) |

---

## Sub-Project Updates

Based on this research, the sub-projects in `ourstory-spec.md` should be updated:

- **SP-1 (Histography Research):** CLOSED. Dataset not available, no coordinates anyway.
- **SP-2 (Wikipedia Data Pipeline):** This document replaces SP-2's open questions. Architecture is: Wikidata dump → PySpark on Dataproc → Postgres.
- **SP-3 (Event Categorization):** Solved primarily by Wikidata P31 hierarchy mapping. LLM needed only for ~10–20% of events with generic types.
- **SP-4 (LLM Location Assignment):** Architecture confirmed. Location QID resolution (free, via Wikidata API) handles ~50% of cases; LLM handles the rest. Budget ~$50–200.

---

## Next Steps

1. **Finalize OurStory category taxonomy** (SP-3 part 1) — define the 10–15 categories before building the P31 mapping table. This is a design decision, not a code decision.
2. **Build the Dataproc pipeline** (SP-2) — Steps 0–5 above are purely mechanical and can be built before the taxonomy is finalized.
3. **Seed data for Phase 1 frontend** — While the full pipeline is being built, hand-curate ~50–100 Classical Antiquity events as a static GeoJSON seed file. (The other session's bootstrap worklog covers this.)
4. **Location QID resolution** (SP-4 Bucket 2) — Run after Dataproc extraction, before LLM assignment.
5. **LLM batch jobs** (SP-3 Layer 2 + SP-4 Bucket 3) — Run last; require date + summary data to already exist.
