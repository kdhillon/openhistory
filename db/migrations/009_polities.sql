-- Migration 009: polities table + polity_territories table
--
-- Polities are time-bounded sovereign political entities (kingdoms, empires,
-- republics, etc.) — a separate layer from the geographic `locations` table.
-- The locations table stays as-is for event coordinate resolution; polities
-- are a distinct first-class data type with their own filter UI and map layer.

CREATE TABLE IF NOT EXISTS polities (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wikidata_qid          TEXT UNIQUE,
  slug                  TEXT UNIQUE NOT NULL,
  name                  TEXT NOT NULL,
  short_name            TEXT,                     -- compact label, e.g. "France"
  polity_type           TEXT NOT NULL,            -- empire|kingdom|republic|confederation|sultanate|papacy|other
  wikipedia_title       TEXT,
  wikipedia_summary     TEXT,
  wikipedia_url         TEXT,
  year_start            INT,
  year_end              INT,
  date_is_fuzzy         BOOL DEFAULT FALSE,
  capital_name          TEXT,
  capital_wikidata_qid  TEXT,
  lng                   DOUBLE PRECISION,         -- representative point (capital or centroid)
  lat                   DOUBLE PRECISION,
  preceded_by_qid       TEXT,                     -- P1365 Wikidata QID
  succeeded_by_qid      TEXT,                     -- P1366 Wikidata QID
  location_wikidata_qid TEXT,                     -- soft ref to matching geo entity in locations
  territory_color       TEXT,
  p31_qids              TEXT[],
  data_version          INT DEFAULT 1,
  pipeline_run          TEXT,
  manually_edited_at    TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS polities_year_start_idx  ON polities(year_start);
CREATE INDEX IF NOT EXISTS polities_year_end_idx    ON polities(year_end);
CREATE INDEX IF NOT EXISTS polities_polity_type_idx ON polities(polity_type);
CREATE INDEX IF NOT EXISTS polities_p31_qids_idx    ON polities USING GIN(p31_qids);

-- polity_territories: time-varying polygon boundaries (Phase 2 — empty in Phase 1)
-- Polities render as hollow rings until this table has data; then they can
-- switch to filled polygons when hasTerritory=true.
CREATE TABLE IF NOT EXISTS polity_territories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  polity_id  UUID NOT NULL REFERENCES polities(id) ON DELETE CASCADE,
  year_start INT,
  year_end   INT,
  boundary   JSONB,   -- GeoJSON Polygon or MultiPolygon (null until editor populates)
  source     TEXT,    -- 'manual' | 'imported' | 'generated'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS polity_territories_polity_id_idx  ON polity_territories(polity_id);
CREATE INDEX IF NOT EXISTS polity_territories_years_idx      ON polity_territories(year_start, year_end);
