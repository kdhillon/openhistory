-- OurStory — canonical database schema
--
-- Use this file for a fresh setup. It is the authoritative single-file
-- equivalent of running all migrations in db/migrations/ in order.
--
-- Usage:
--   psql postgresql://ourstory:ourstory@localhost:5432/ourstory -f db/schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- locations  (formerly: cities)
-- ============================================================

CREATE TABLE IF NOT EXISTS locations (
  id                UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
  wikidata_qid      TEXT             UNIQUE,
  slug              TEXT             UNIQUE,
  name              TEXT             NOT NULL,
  wikipedia_title   TEXT             NOT NULL,
  wikipedia_summary TEXT,
  wikipedia_url     TEXT             NOT NULL,
  lng               DOUBLE PRECISION NOT NULL,
  lat               DOUBLE PRECISION NOT NULL,
  founded_year      INTEGER,
  founded_is_fuzzy  BOOLEAN          NOT NULL DEFAULT FALSE,
  founded_range_min INTEGER,
  founded_range_max INTEGER,
  dissolved_year    INTEGER,
  location_type     TEXT             NOT NULL DEFAULT 'city'
                    CONSTRAINT locations_location_type_check
                    CHECK (location_type IN ('city', 'region', 'country')),
  p31_qids          TEXT[]           NOT NULL DEFAULT '{}',
  data_version      INTEGER          NOT NULL DEFAULT 2,
  pipeline_run      TEXT,
  created_at        TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS locations_slug_idx          ON locations (slug);
CREATE INDEX IF NOT EXISTS locations_data_version_idx  ON locations (data_version);
CREATE INDEX IF NOT EXISTS idx_locations_p31_qids      ON locations USING GIN (p31_qids);

-- ============================================================
-- events
-- ============================================================

CREATE TABLE IF NOT EXISTS events (
  id                    UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
  wikidata_qid          TEXT             UNIQUE,
  slug                  TEXT             UNIQUE,
  title                 TEXT             NOT NULL,
  wikipedia_title       TEXT             NOT NULL,
  wikipedia_summary     TEXT,
  wikipedia_url         TEXT             NOT NULL,
  year_start            INTEGER,
  month_start           SMALLINT,
  day_start             SMALLINT,
  year_end              INTEGER,
  month_end             SMALLINT,
  day_end               SMALLINT,
  date_is_fuzzy         BOOLEAN          NOT NULL DEFAULT FALSE,
  date_range_min        INTEGER,
  date_range_max        INTEGER,
  -- location_level=NULL means no location resolved (stored for future enrichment)
  location_level        TEXT
                        CONSTRAINT events_location_level_check
                        CHECK (location_level IS NULL
                               OR location_level IN ('point', 'city', 'region', 'country')),
  location_name         TEXT,
  -- Soft reference to locations.wikidata_qid — intentionally no FK constraint
  -- so events with unresolved locations can still be stored.
  location_wikidata_qid TEXT,
  -- Only set when location_level = 'point' (exact coordinate on the event itself)
  lng                   DOUBLE PRECISION,
  lat                   DOUBLE PRECISION,
  categories            TEXT[]           NOT NULL DEFAULT '{}',
  p31_qids              TEXT[]           NOT NULL DEFAULT '{}',
  -- Wikidata P361 (part-of): parent events/conflicts this event belongs to.
  -- e.g. Battle of Cannae → ['Q154430'] (Second Punic War)
  part_of_qids          TEXT[]           NOT NULL DEFAULT '{}',
  -- Number of Wikipedia language editions covering this event (Wikidata sitelinks count).
  -- Higher = more globally significant. Used to compute zoom-based visibility thresholds.
  sitelinks_count       INT,
  data_version          INTEGER          NOT NULL DEFAULT 2,
  pipeline_run          TEXT,
  created_at            TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  -- Generated column for efficient interval overlap queries (GiST stabbing query).
  -- Allows O(log n) range lookups via the idx_events_year_range GiST index.
  year_range            int4range
    GENERATED ALWAYS AS (
      int4range(year_start, COALESCE(year_end, year_start), '[]')
    ) STORED
);

CREATE INDEX IF NOT EXISTS events_year_start_idx             ON events (year_start);
CREATE INDEX IF NOT EXISTS events_slug_idx                   ON events (slug);
CREATE INDEX IF NOT EXISTS events_data_version_idx           ON events (data_version);
CREATE INDEX IF NOT EXISTS idx_events_location_wikidata_qid  ON events (location_wikidata_qid);
CREATE INDEX IF NOT EXISTS idx_events_p31_qids               ON events USING GIN (p31_qids);
CREATE INDEX IF NOT EXISTS idx_events_part_of_qids           ON events USING GIN (part_of_qids);
CREATE INDEX IF NOT EXISTS idx_events_year_range             ON events USING GIST (year_range);
