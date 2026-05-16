-- 023_drop_hb_territory_tables.sql
--
-- Drop the legacy historical-basemaps territory tables. The frontend, server
-- endpoints, and import/match scripts that used these were removed in the
-- May 2026 HB cleanup. Territory rendering is now OHM-only.
--
-- Confirmed safe via pg_constraint inspection: all foreign keys are outbound
-- (to `polities`) or self-referential within this cluster. Nothing outside
-- these four tables references them, and no views depend on them.
-- CASCADE is included for safety but is not strictly required.

DROP TABLE IF EXISTS territories                     CASCADE;
DROP TABLE IF EXISTS snapshot_polygons_archive       CASCADE;
DROP TABLE IF EXISTS territory_snapshots_archive     CASCADE;
DROP TABLE IF EXISTS territory_name_mappings_archive CASCADE;
