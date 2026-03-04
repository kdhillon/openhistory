-- Track user-submitted corrections so the API can serve them as overrides
-- on top of the static seed.geojson baseline.

ALTER TABLE events ADD COLUMN IF NOT EXISTS manually_edited_at TIMESTAMPTZ;

COMMENT ON COLUMN events.manually_edited_at IS
  'Set to NOW() by the /api/features/:id PATCH endpoint when a user submits a correction. '
  'The /api/features/overrides endpoint returns all rows where this is non-null, '
  'so the frontend can merge corrections over the static seed.geojson on page load.';

CREATE INDEX IF NOT EXISTS idx_events_manually_edited
  ON events(manually_edited_at)
  WHERE manually_edited_at IS NOT NULL;
