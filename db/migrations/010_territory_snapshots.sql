-- Migration 010: territory snapshot tables
--
-- Replaces the empty polity_territories table (interval-based) with a
-- snapshot-based model that maps 1:1 to the aourednik/historical-basemaps
-- project structure. Each snapshot year is a complete picture of the world
-- at that moment; polygons are imported per snapshot and optionally linked
-- to our polities table.
--
-- Three tables:
--   territory_snapshots    — one row per loaded snapshot year
--   snapshot_polygons      — one row per polygon per snapshot
--   territory_name_mappings — persistent HB name → polity_id lookup table

-- Drop the old (empty) polity_territories table
DROP TABLE IF EXISTS polity_territories;

-- ── territory_snapshots ────────────────────────────────────────────────────
-- Tracks which historical-basemaps snapshot years have been loaded.
CREATE TABLE IF NOT EXISTS territory_snapshots (
  snapshot_year   INT PRIMARY KEY,
  source          TEXT NOT NULL DEFAULT 'historical-basemaps',
                  -- 'historical-basemaps' | 'custom'
  hb_filename     TEXT,        -- e.g. 'world_1800.geojson'
  hb_commit_sha   TEXT,        -- git commit SHA of the historical-basemaps repo at import time
  polygon_count   INT NOT NULL DEFAULT 0,
  imported_count  INT NOT NULL DEFAULT 0,  -- accuracy = 'imported' (unreviewed)
  verified_count  INT NOT NULL DEFAULT 0,  -- accuracy = 'verified' (confirmed correct)
  edited_count    INT NOT NULL DEFAULT 0,  -- accuracy = 'edited' (geometry changed)
  loaded_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── snapshot_polygons ──────────────────────────────────────────────────────
-- One row per polygon per snapshot year. Directly mirrors the features in
-- the historical-basemaps GeoJSON files.
CREATE TABLE IF NOT EXISTS snapshot_polygons (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_year    INT NOT NULL REFERENCES territory_snapshots(snapshot_year) ON DELETE CASCADE,

  -- Fields from historical-basemaps
  hb_name          TEXT NOT NULL,   -- NAME property (the stable key for name mappings)
  hb_abbrevn       TEXT,            -- ABBREVN property
  hb_subjecto      TEXT,            -- SUBJECTO property
  hb_partof        TEXT,            -- PARTOF property
  border_precision INT,             -- BORDERPRECISION: 1=approx, 2=moderate, 3=legal

  -- Link to our polities table (nullable — unmatched polygons still render)
  polity_id        UUID REFERENCES polities(id) ON DELETE SET NULL,

  -- Geometry
  boundary         JSONB NOT NULL,  -- GeoJSON MultiPolygon geometry

  -- Provenance / accuracy tracking
  accuracy         TEXT NOT NULL DEFAULT 'imported',
                   -- 'imported'  = from HB, not independently reviewed
                   -- 'verified'  = human confirmed geometry is correct
                   -- 'edited'    = human modified the geometry
                   -- 'added'     = new polygon not in HB source

  edited_at        TIMESTAMPTZ,     -- set when accuracy changes to 'edited'
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS snapshot_polygons_snapshot_year_idx ON snapshot_polygons(snapshot_year);
CREATE INDEX IF NOT EXISTS snapshot_polygons_polity_id_idx     ON snapshot_polygons(polity_id);
CREATE INDEX IF NOT EXISTS snapshot_polygons_hb_name_idx       ON snapshot_polygons(hb_name);
CREATE INDEX IF NOT EXISTS snapshot_polygons_accuracy_idx      ON snapshot_polygons(accuracy);

-- ── territory_name_mappings ────────────────────────────────────────────────
-- Persistent lookup: (hb_name, snapshot_year) → our polity_id.
-- Keyed on both name AND snapshot_year because the same HB name can map to
-- different polities at different historical periods (e.g. "France" in 1800
-- = First French Republic; "France" in 1900 = Third French Republic).
-- Built up incrementally; manual corrections are never overwritten by the auto-matcher.
CREATE TABLE IF NOT EXISTS territory_name_mappings (
  hb_name       TEXT NOT NULL,              -- NAME from HB
  snapshot_year INT NOT NULL,              -- which snapshot year this mapping applies to
  polity_id     UUID REFERENCES polities(id) ON DELETE SET NULL,
  wikidata_qid  TEXT,                       -- redundant but useful for cross-referencing
  confidence    TEXT NOT NULL DEFAULT 'auto',
                -- 'auto'   = matched by name fuzzy logic
                -- 'manual' = human assigned (never overwritten by auto-matcher)
  notes         TEXT,                       -- e.g. "HB calls this 'Great Britain'"
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (hb_name, snapshot_year)
);

CREATE INDEX IF NOT EXISTS territory_name_mappings_polity_id_idx     ON territory_name_mappings(polity_id);
CREATE INDEX IF NOT EXISTS territory_name_mappings_wikidata_qid_idx  ON territory_name_mappings(wikidata_qid);
CREATE INDEX IF NOT EXISTS territory_name_mappings_snapshot_year_idx ON territory_name_mappings(snapshot_year);
