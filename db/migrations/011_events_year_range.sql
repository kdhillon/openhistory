-- 011_events_year_range.sql
-- Add int4range generated column + GiST index for O(log n) interval overlap queries.
-- Used by GET /api/events to efficiently find events in a year window.

-- Fix any rows where year_end < year_start (data error — clear the bad year_end)
UPDATE events SET year_end = NULL WHERE year_end IS NOT NULL AND year_end < year_start;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS year_range int4range
    GENERATED ALWAYS AS (
      int4range(year_start, COALESCE(year_end, year_start), '[]')
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_events_year_range
  ON events USING GIST (year_range);
