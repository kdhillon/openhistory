-- Migration 011: sub-interval polity associations for snapshot_polygons
--
-- Allows one snapshot polygon (geometry) to be associated with multiple
-- successive polities within a single inter-snapshot interval.
-- Example: the 1800 "France" polygon covers 1800-1814. Within that window,
-- France was the First Republic (1800-1804) then the First Empire (1804-1814).
-- Two rows share the same geometry with different polity_ids and sub-intervals.
--
-- sub_year_start / sub_year_end:
--   When set, these OVERRIDE the derived interval from snapshot ordering.
--   When NULL, the export falls back to the derived interval.
--   The original row usually has sub_year_end set (to close before successor);
--   duplicate rows always have both sub_year_start and sub_year_end set.
--
-- source_polygon_id:
--   NULL on the original imported row.
--   Points to the original row on all duplicates created by the expansion script.
--   Used to group rows that share the same geometry and to cascade edits.

ALTER TABLE snapshot_polygons
  ADD COLUMN IF NOT EXISTS sub_year_start     INT,
  ADD COLUMN IF NOT EXISTS sub_year_end       INT,
  ADD COLUMN IF NOT EXISTS source_polygon_id  UUID REFERENCES snapshot_polygons(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS snapshot_polygons_source_id_idx ON snapshot_polygons(source_polygon_id);
