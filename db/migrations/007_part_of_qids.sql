-- Migration 007: Add part_of_qids to events
--
-- Stores Wikidata P361 ("part of") QIDs for each event, enabling grouping
-- of related events into their parent conflicts/campaigns.
-- e.g. Battle of Cannae → part_of_qids = ['Q154430'] (Second Punic War)
--
-- Array allows an event to be "part of" multiple things
-- (e.g. part of both a specific campaign AND the broader war).
-- GIN index supports efficient containment queries:
--   WHERE 'Q154430' = ANY(part_of_qids)

ALTER TABLE events ADD COLUMN IF NOT EXISTS part_of_qids TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_events_part_of_qids
    ON events USING GIN(part_of_qids);
