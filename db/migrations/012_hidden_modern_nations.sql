-- Migration 012: hidden_modern_nations
-- Polities whose territory polygons are suppressed in pre-modern views to prevent
-- anachronistic modern borders from cluttering historical maps.
-- This table is never deleted from — it is a permanent editorial record.

CREATE TABLE IF NOT EXISTS hidden_modern_nations (
    polity_id       UUID PRIMARY KEY,
    hide_until_year INT NOT NULL DEFAULT 1900,
    hidden_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes           TEXT
);

COMMENT ON TABLE hidden_modern_nations IS
  'Polities whose territory polygons are hidden before hide_until_year to avoid cluttering '
  'historical views with anachronistic modern borders. Never delete rows from this table.';
