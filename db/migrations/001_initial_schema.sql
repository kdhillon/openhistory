CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- Cities
-- ============================================================

CREATE TABLE cities (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  name              TEXT        NOT NULL,
  wikipedia_title   TEXT        NOT NULL,
  wikipedia_summary TEXT,
  wikipedia_url     TEXT        NOT NULL,

  lng               DOUBLE PRECISION NOT NULL,
  lat               DOUBLE PRECISION NOT NULL,

  founded_year      INTEGER,
  founded_is_fuzzy  BOOLEAN     NOT NULL DEFAULT FALSE,
  founded_range_min INTEGER,
  founded_range_max INTEGER,

  dissolved_year    INTEGER,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX cities_founded_year_idx ON cities (founded_year);

-- ============================================================
-- Events
-- ============================================================

CREATE TABLE events (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  title             TEXT        NOT NULL,
  wikipedia_title   TEXT        NOT NULL,
  wikipedia_summary TEXT,
  wikipedia_url     TEXT        NOT NULL,

  -- Temporal
  year_start        INTEGER     NOT NULL,
  year_end          INTEGER,
  date_is_fuzzy     BOOLEAN     NOT NULL DEFAULT FALSE,
  date_range_min    INTEGER,
  date_range_max    INTEGER,

  -- Spatial
  -- Exactly one of (lng/lat) or location_id is set, depending on location_level.
  location_level    TEXT        NOT NULL CHECK (location_level IN ('point', 'city', 'country', 'region')),
  lng               DOUBLE PRECISION,   -- set only when location_level = 'point'
  lat               DOUBLE PRECISION,   -- set only when location_level = 'point'
  location_id       UUID        REFERENCES cities (id),  -- set when location_level != 'point'
  location_name     TEXT        NOT NULL,

  categories        TEXT[]      NOT NULL DEFAULT '{}',

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT point_requires_coords CHECK (
    location_level != 'point' OR (lng IS NOT NULL AND lat IS NOT NULL)
  ),
  CONSTRAINT non_point_requires_location_id CHECK (
    location_level = 'point' OR location_id IS NOT NULL
  )
);

CREATE INDEX events_year_start_idx ON events (year_start);
